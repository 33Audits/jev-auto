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
import { TIER_ORDER } from "./ladder.mjs";

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
  out(`  Saved        ${usd(s.saved)}  (${Math.round(s.savedPct * 100)}%)\n`);

  out("  tier      turns   escalated   spend");
  for (const name of TIER_ORDER) {
    const row = s.byTier[name];
    if (!row) continue;
    out(
      `  ${name.padEnd(9)} ${String(row.turns).padStart(5)}   ` +
        `${`${Math.round(row.escalationRate * 100)}%`.padStart(9)}   ${usd(row.spend)}`,
    );
  }

  out(`\n  Boundaries   ${t.cheap} / ${t.strong}${t.calibrated ? "  (calibrated)" : "  (shipped defaults)"}`);
  for (const note of t.notes) out(`    · ${note}`);

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

function cmdDoctor() {
  loadEnvFiles();
  const checks = [];
  const add = (ok, label, detail = "") => checks.push({ ok, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20, `Node ${process.versions.node}`, major >= 20 ? "" : "needs >= 20.12");

  // Asking the CLI itself is the only check that cannot disagree with how it gets launched.
  const probe = spawnSync("claude", ["--version"], { shell: process.platform === "win32", encoding: "utf8" });
  const installed = !probe.error && probe.status === 0;
  add(installed, "Claude Code", installed ? probe.stdout.trim() : "not on PATH — https://code.claude.com/docs/en/setup");

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
  const [command, ...rest] = argv;
  switch (command) {
    case "stats":
      return cmdStats();
    case "why":
    case "explain":
      return cmdWhy(rest[0]);
    case "try":
      return cmdTry(rest.join(" "));
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
