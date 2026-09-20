import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEDGER_FILE } from "./tuning.mjs";
import { read as readLedger, stats as ledgerStats } from "./ledger.mjs";
import { cutoffs as calibratedThresholds, problemShapes } from "./calibrate.mjs";
import { renderDecision } from "./report.mjs";
import { latestDecision, DIR as SESSION_DIR } from "./journal.mjs";
import { spawnSync } from "node:child_process";
import { hasOwnStatusLine, runClaude, runCodex, loadEnvFiles } from "./runner.mjs";
import { appraiserName } from "./appraisers/index.mjs";
import { appraise as appraiseLocally } from "./appraisers/heuristic.mjs";
import { TIER_ORDER, canHold, PRICES_VERIFIED } from "./ladder.mjs";
import { explorationReport } from "./explore.mjs";
import { listParked, listRules, park, unpark, PARKED, RULES } from "./context.mjs";
import { ranked, triage, triageOptions, CRITERIA_DIR } from "./triage.mjs";
import { CALIBRATION } from "./tuning.mjs";

const usd = (x) => `$${x < 0.01 && x > 0 ? x.toFixed(4) : x.toFixed(2)}`;
const out = (s) => process.stdout.write(`${s}\n`);

const version = () => {
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  try {
    return JSON.parse(readFileSync(pkg, "utf8")).version;
  } catch {
    return "unknown";
  }
};

const HELP = `jev — per-turn model routing for Claude Code

  jev [claude args...]   Launch Claude Code with routing (this is the whole setup)
  jev codex [args...]    Launch OpenAI Codex with routing, on your existing codex login
  jev stats              What routing has cost, saved, and learned
  jev why [session-id]   The last routing decision, in full
  jev try "<prompt>"     Show where a prompt would appraise, without running anything
  jev triage <file>      Severity + rejection class for a finding, via Jev
  jev context            What is injected into every session, and park what you are not using
  jev doctor             Check the install
  jev reset              Delete the learning ledger and session state
  jev help               This

Environment
  JEV_ROUTER=local|llm|jev|off   Routing backend. Default: local (no key, no network)
  JEV_ALLOW_FABLE=1              Allow the long tier (bills extra usage credits)
  JEV_THRESHOLDS=0.28,0.58       Pin the tier boundaries and stop calibrating
  JEV_NO_CALIBRATION=1           Keep the shipped boundaries, keep measuring
  JEV_NO_STATUSLINE=1            Do not install the status line
  JEV_DEBUG=1                    Log every decision to ~/.jev-auto/jev.log
  JEV_DUMP=<prefix>              Dump request bodies when the wire format changes
`;

function cmdStats() {
  const records = readLedger();
  if (!records.length) {
    out("No turns recorded yet. Run `jev` and come back after a few prompts.");
    return;
  }
  const s = ledgerStats(records);
  const t = calibratedThresholds(records);

  out(`\n  ${s.turns} routed turns since ${new Date(s.since).toLocaleDateString()}\n`);
  out(`  Spent        ${usd(s.spend)}`);
  out(`  All-Opus     ${usd(s.baseline)}`);
  out(`  Saved        ${usd(s.saved)}  (${Math.round(s.savedPct * 100)}%)`);
  // Never present a dollar figure as fact when the rate behind it was guessed.
  const unpriced = Object.entries(PRICES_VERIFIED).filter(([, ok]) => !ok).map(([p]) => p);
  if (unpriced.length && Object.keys(s.byTier).length) {
    out(`\n  NOTE: ${unpriced.join(", ")} rates are placeholders, not published prices.`);
    out(`        Token counts are measured; the dollar conversion is not. Set JEV_PRICES to fix.`);
  }
  out("");

  out("  tier      turns   escalated   spend");
  for (const name of TIER_ORDER) {
    const row = s.byTier[name];
    if (!row) continue;
    out(
      `  ${name.padEnd(9)} ${String(row.turns).padStart(5)}   ` +
        `${`${Math.round(row.escalationRate * 100)}%`.padStart(9)}   ${usd(row.spend)}`,
    );
  }

  // A rung the conversation cannot fit into is not a routing choice the appraiser declined
  // — it was never on the table. Say so, rather than let it read as the router doing nothing.
  const unreachable = TIER_ORDER.filter((t) => !canHold(t, s.medianContext, "claude"));
  if (unreachable.length && s.medianContext) {
    out(`\n  Typical turn ${(s.medianContext / 1000).toFixed(0)}k tokens — too large for ${unreachable.join(", ")}`);
    out(`    Routing can only choose between ${TIER_ORDER.filter((t) => !unreachable.includes(t)).join(", ")}.`);
    out(`    Trimming CLAUDE.md or disabling unused MCP servers is what unlocks the cheaper rungs.`);
  }

  out(`\n  Boundaries   ${t.cheap} / ${t.strong}${t.calibrated ? "  (calibrated)" : "  (shipped defaults)"}`);
  for (const note of t.notes) out(`    · ${note}`);

  // What trying the cheaper rung has actually established. This is the loop that turns a
  // proven-but-unclaimed saving into a claimed one, so it is worth showing its progress.
  const explored = explorationReport(records);
  if (explored.length) {
    out("\n  Cheaper-rung trials");
    for (const e of explored.slice(0, 6)) {
      const verdict =
        e.verdict === "sufficient" ? "PROVEN — now the default for this shape"
        : e.verdict === "insufficient" ? "no — keeps needing the bigger model"
        : `${e.trials}/${CALIBRATION.minTrials} trials so far`;
      out(`    ${e.tier.padEnd(9)} ${e.shape.padEnd(30)} ${Math.round(e.rate * 100)}% escalated  ${verdict}`);
    }
  }

  const problems = problemShapes(records);
  if (problems.length) {
    out("\n  Request shapes that keep needing a stronger model:");
    for (const b of problems.slice(0, 5)) {
      out(`    · ${b.shape} routed to ${b.tier} — escalated ${Math.round(b.escalationRate * 100)}% of ${b.turns}`);
    }
    out("    (these are reported, not acted on — tune JEV_THRESHOLDS if you disagree with the router)");
  }
  out("");
}

function cmdWhy(sessionId) {
  if (sessionId) return out(renderDecision(latestDecision(sessionId)));
  // No id given: use the most recently written session file.
  let newest = null;
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      const p = join(SESSION_DIR, f);
      const m = statSync(p).mtimeMs;
      if (!newest || m > newest.m) newest = { id: f.replace(/\.jsonl$/, ""), m };
    }
  } catch {
    // No sessions yet.
  }
  out(renderDecision(newest ? latestDecision(newest.id) : null));
}

function cmdTry(prompt) {
  if (!prompt) return out('Usage: jev try "add a comment to the parser"');
  const t = calibratedThresholds(readLedger());
  const d = appraiseLocally({ prompt, cutoffs: t });
  out(
    renderDecision({
      prompt,
      tier: d.choice,
      model: d.choice,
      reason: "routed",
      confidence: d.confidence,
      metrics: d.metrics,
      score: d.score,
      backend: "local (dry run)",
      cutoffs: t,
    }),
  );
}

/**
 * What is injected into every session, and a switch for it. The heavy entries here are
 * symlinks owned by other tools, which read them back through this exact path — so they are
 * parked, never deleted, and restored by name.
 */
function cmdContext(action, name) {
  const loaded = listRules();
  const parked = listParked();

  if (action === "off" || action === "on") {
    const targets = name ? [name] : (action === "off" ? loaded : parked).map((e) => e.name);
    if (!name) {
      out(`Refusing to ${action} everything at once — name an entry, or use --heavy.`);
      out(`  jev context ${action} phase6-report-prompts.md`);
      return;
    }
    const r = action === "off" ? park(targets[0]) : unpark(targets[0]);
    out(r.ok ? `${action === "off" ? "parked" : "restored"} ${targets[0]}` : `${targets[0]}: ${r.why}`);
    return;
  }

  const total = loaded.reduce((s, e) => s + e.tokens, 0);
  out(`\n  ${total}k tokens injected into every session, from ${RULES.replace(process.env.HOME ?? "", "~")}\n`);
  out("  entry                                tokens  owned by");
  for (const e of loaded) {
    out(`  ${e.name.slice(0, 34).padEnd(34)} ${String(e.tokens).padStart(5)}k  ${(e.target ?? "(plain file)").replace(process.env.HOME ?? "", "~")}`);
  }
  if (parked.length) {
    out(`\n  parked (${parked.reduce((s, e) => s + e.tokens, 0)}k, not injected):`);
    for (const e of parked) out(`    ${e.name}`);
  }
  out(`\n  These are read back by the tools that own them, so they are parked rather than deleted.`);
  out(`  Park one:    jev context off <entry>`);
  out(`  Restore one: jev context on <entry>`);
  out(`  A parked entry must be restored before the tool that owns it will work.\n`);
}

/**
 * Triage a finding against the judging criteria already on disk. Jev returns a severity and a
 * rejection class; the class is categorical, so its ceiling is applied here rather than hoping
 * two independent answers agree — they did not, and a zero-address check came back High while
 * flagging the rule that says it is not a finding.
 */
async function cmdTriage(source) {
  const text = source === "-" || !source ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  if (!text.trim()) return out('Usage: jev triage <file>   (or pipe the finding on stdin)');

  const r = await triage(text);
  if (r.error) {
    out(`triage unavailable: ${r.error}`);
    if (/criteria/.test(r.error)) out(`  set JEV_JUDGING_DIR, or place criteria under ${CRITERIA_DIR}`);
    return;
  }

  const bar = (a) => ranked(a, 3).join("   ");
  out("");
  out(`  Severity assessed   ${String(r.assessed).padEnd(14)} ${bar(r.severity)}`);
  out(`  Exploit path        ${String(r.exploitConfidence?.choice).padEnd(14)} ${bar(r.exploitConfidence)}`);
  out(`  Rejection class     ${r.rejectionClass?.choice ?? "n/a"}`);
  if (r.cappedBy) out(`                      capped by this rule, which states: ${r.ceiling}`);
  out("");
  out(`  FINAL               ${r.final}${r.cappedBy ? `   (assessed ${r.assessed}, capped by ${r.cappedBy})` : ""}`);
  out(`  Would be rejected   ${r.wouldBeRejected == null ? "n/a" : `${Math.round(r.wouldBeRejected * 100)}%`}`);
  out(`\n  ${r.ms}ms · criteria from ${CRITERIA_DIR.replace(process.env.HOME ?? "", "~")} · ${Object.keys(triageOptions()).length} classes\n`);
}

function cmdDoctor() {
  loadEnvFiles();
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20, `Node ${process.versions.node}`, major >= 20 ? "" : "needs >= 20.12");

  // Asking each CLI itself is the only check that cannot disagree with how it gets launched.
  // Either one is enough to be useful, so a missing CLI is only a failure if both are gone.
  const found = {};
  for (const [cli, url] of [
    ["claude", "https://code.claude.com/docs/en/setup"],
    ["codex", "https://developers.openai.com/codex/cli"],
  ]) {
    const probe = spawnSync(cli, ["--version"], { shell: process.platform === "win32", encoding: "utf8" });
    found[cli] = !probe.error && probe.status === 0;
    add(true, `${cli === "claude" ? "Claude Code" : "Codex"}: ${found[cli] ? probe.stdout.trim() : "not installed"}`,
        found[cli] ? `jev ${cli === "claude" ? "" : "codex"}`.trim() : url);
  }
  add(found.claude || found.codex, "At least one CLI available",
      found.claude || found.codex ? "" : "install Claude Code or Codex to use jev");

  add(true, `Routing backend: ${appraiserName()}`, appraiserName() === "local" ? "no key required" : "");

  if (appraiserName() === "jev") {
    const key = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
    add(Boolean(key), "JEV_API_KEY", key ? "set" : "missing — will fall back to the local router");
  }

  add(
    !process.env.ANTHROPIC_BASE_URL,
    "ANTHROPIC_BASE_URL unset",
    process.env.ANTHROPIC_BASE_URL ? "already set; jev will not override an existing gateway" : "",
  );

  const mine = !process.env.JEV_NO_STATUSLINE && !hasOwnStatusLine();
  add(true, `Status line: ${mine ? "jev's will be installed" : "yours is kept"}`);

  const records = readLedger();
  const t = calibratedThresholds(records);
  add(true, `Ledger: ${records.length} turns`, LEDGER_FILE);
  add(true, `Boundaries: ${t.cheap} / ${t.strong}`, t.calibrated ? "calibrated from your turns" : "shipped defaults");

  out("");
  for (const c of checks) {
    out(`  ${c.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${c.label}${c.detail ? `  \x1b[2m${c.detail}\x1b[0m` : ""}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  out(failed ? `\n  ${failed} problem(s) above.\n` : "\n  Ready. Run `jev`.\n");
  process.exitCode = failed ? 1 : 0;
}

function cmdReset() {
  for (const target of [LEDGER_FILE, SESSION_DIR]) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
  out(`Cleared. Boundaries are back to the shipped defaults.`);
}

export async function main(argv = process.argv.slice(2)) {
  // Every subcommand may need the key, not just the launchers — `triage` and the `jev`
  // appraiser both read it, and loading it per-command meant `jev triage` reported no key
  // while `jev` itself worked.
  loadEnvFiles();
  const [command, ...rest] = argv;
  switch (command) {
    case "stats":
      return cmdStats();
    case "why":
    case "explain":
      return cmdWhy(rest[0]);
    case "try":
      return cmdTry(rest.join(" "));
    case "triage":
      return cmdTriage(rest[0]);
    case "context":
      return cmdContext(rest[0], rest[1]);
    case "doctor":
      return cmdDoctor();
    case "reset":
      return cmdReset();
    case "help":
    case "--help":
    case "-h":
      return out(HELP);
    case "version":
    case "--version":
    case "-v":
      return out(version());
    case "claude":
      return runClaude(rest);
    case "codex":
      return runCodex(rest);
    default:
      // Everything else is Claude Code's, forwarded untouched: `jev --resume`, `jev -p "..."`.
      return runClaude(argv);
  }
}
