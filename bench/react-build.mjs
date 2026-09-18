#!/usr/bin/env node
// End-to-end A/B: build the same small React app with each CLI, routed and unrouted, and
// measure what it cost and how long it took.
//
// The control arm is not "no relay" — it is the relay with JEV_PIN set, so both arms share
// the same proxy, the same accounting, and the same overhead. The only difference between
// them is who picks the model. Anything else would be comparing two setups, not two routers.
//
// Usage: node bench/react-build.mjs [--arms claude-vanilla,claude-jev] [--out bench/results]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read as readLedger, stats as summarize } from "../src/ledger.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JEV = join(ROOT, "bin", "jev.mjs");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = resolve(arg("out", join(ROOT, "bench", "results")));

/**
 * A fixed script, replayed identically against every arm. Deliberately mixed: two turns that
 * genuinely need a strong model, four that any model can do. A benchmark of only-hard turns
 * shows routing in its worst light and a benchmark of only-trivial turns flatters it; real
 * sessions are mostly the second kind with a few of the first.
 */
const SCRIPT = [
  "Create a minimal React app in this directory using Vite and plain JavaScript (no TypeScript). Use npm. Do not start a dev server.",
  "Add a TodoList component with an input, an add button, and a list. Store todos in useState. Render it from App.",
  "Add filter buttons for All / Active / Completed, and a checkbox on each todo to toggle completion.",
  "Rename the variable `t` to `todo` everywhere it appears.",
  "Add an <h1> that says My Todos above the list.",
  "Write a Vitest test that adds a todo and asserts it appears in the list. Install whatever you need, run the test, and fix anything that fails.",
];

/**
 * "Vanilla" means the rung the CLI would actually have used on this machine with jev absent,
 * not a neutral mid-tier — that is the spend routing claims to beat. Claude Code defaults to
 * Sonnet. This Codex install is configured for gpt-6-astra in config.toml, so its control is
 * the long rung, and both Codex arms get the same ladder to choose from.
 */
const ARMS = {
  "claude-vanilla": { cli: "claude", env: { JEV_PIN: "balanced" } },
  "claude-jev": { cli: "claude", env: { JEV_ROUTER: "jev" } },
  "codex-vanilla": { cli: "codex", env: { JEV_PIN: "long", JEV_ALLOW_LONG: "1" } },
  "codex-jev": { cli: "codex", env: { JEV_ROUTER: "jev", JEV_ALLOW_LONG: "1" } },

  // Same task, same CLI, with the MCP servers left out. Not a trick: a project that does not
  // need 227 tool schemas should not pay to send them, and whether the cheapest rung is even
  // reachable is decided entirely by that. These arms measure what routing is worth once it
  // has more than one legal choice.
  "claude-clean-vanilla": { cli: "claude", env: { JEV_PIN: "balanced" }, flags: ["--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"] },
  "claude-clean-jev": { cli: "claude", env: { JEV_ROUTER: "jev" }, flags: ["--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}"] },
};

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 15 * 60e3, ...opts });

/** One turn of a session. The first opens it; the rest continue the same conversation. */
function turn(arm, dir, prompt, first, env) {
  const { cli, flags = [] } = ARMS[arm];
  const args =
    cli === "claude"
      ? [JEV, ...flags, ...(first ? [] : ["--continue"]), "-p", prompt]
      : [JEV, "codex", ...(first ? ["exec"] : ["exec", "resume", "--last"]), "--skip-git-repo-check", ...flags, prompt];
  const started = Date.now();
  const r = run(process.execPath, args, { cwd: dir, env });
  return { ms: Date.now() - started, status: r.status, stderr: (r.stderr ?? "").slice(-2000) };
}

/** Did the arm actually produce a working app? Cost without this number is meaningless. */
function verify(dir) {
  if (!existsSync(join(dir, "package.json"))) return { built: false, tested: false, why: "no package.json" };
  const install = run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
  if (install.status !== 0) return { built: false, tested: false, why: "npm install failed" };
  const build = run("npm", ["run", "build", "--if-present"], { cwd: dir });
  const test = run("npx", ["vitest", "run", "--passWithNoTests"], { cwd: dir });
  return { built: build.status === 0, tested: test.status === 0, why: "" };
}

mkdirSync(OUT, { recursive: true });
const arms = (arg("arms", Object.keys(ARMS).join(",")) || "").split(",").filter(Boolean);
const results = [];

for (const arm of arms) {
  const dir = join(OUT, arm);
  const ledger = join(OUT, `${arm}.jsonl`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(ledger, { force: true });
  mkdirSync(dir, { recursive: true });

  const env = { ...process.env, ...ARMS[arm].env, JEV_LEDGER: ledger, JEV_DEBUG: "1" };
  process.stderr.write(`\n=== ${arm} ===\n`);

  const turns = [];
  let wall = 0;
  for (const [i, prompt] of SCRIPT.entries()) {
    const t = turn(arm, dir, prompt, i === 0, env);
    wall += t.ms;
    turns.push(t);
    process.stderr.write(`  turn ${i + 1}/${SCRIPT.length}  ${(t.ms / 1000).toFixed(0)}s  exit=${t.status}\n`);
  }

  const check = verify(dir);
  const s = summarize(readLedger(ledger));
  const row = {
    arm,
    wallSeconds: Math.round(wall / 1000),
    spend: s.spend,
    turns: s.turns,
    mix: Object.fromEntries(Object.entries(s.byTier).map(([k, v]) => [k, v.turns])),
    built: check.built,
    tested: check.tested,
    why: check.why,
  };
  results.push(row);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
  process.stderr.write(`  -> ${row.wallSeconds}s  $${row.spend.toFixed(4)}  built=${row.built} tested=${row.tested}\n`);
}

const usd = (x) => `$${x.toFixed(4)}`;
console.log(`\n  arm              wall    spend      turns  mix                       built  tested`);
for (const r of results) {
  console.log(
    `  ${r.arm.padEnd(16)} ${String(r.wallSeconds).padStart(4)}s  ${usd(r.spend).padStart(9)}  ` +
      `${String(r.turns).padStart(5)}  ${JSON.stringify(r.mix).padEnd(24)}  ${String(r.built).padEnd(5)}  ${r.tested}`,
  );
}
for (const cli of ["claude", "codex"]) {
  const v = results.find((r) => r.arm === `${cli}-vanilla`);
  const j = results.find((r) => r.arm === `${cli}-jev`);
  if (!v || !j) continue;
  const cheaper = v.spend > 0 ? (1 - j.spend / v.spend) * 100 : 0;
  const faster = v.wallSeconds > 0 ? (1 - j.wallSeconds / v.wallSeconds) * 100 : 0;
  console.log(`\n  ${cli}: routed is ${cheaper.toFixed(0)}% cheaper and ${faster.toFixed(0)}% faster than pinned`);
}
console.log("");
