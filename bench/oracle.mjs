#!/usr/bin/env node
// The oracle: for each task, the cheapest rung that ACTUALLY passes.
//
// Everything else in bench/ measures what routing costs. Only this measures whether the
// choice was right, and without it "cheaper" is unfalsifiable — a router that sends
// everything to the cheapest rung wins on cost and loses on the only thing that matters.
//
// Method, copied from a benchmark that does this properly (kyotofin/tax-doc-classifier):
// externally-authored work, graded by tests nobody here wrote, with a strict-error column
// beside the cost column and a named baseline measured in the same session.
//
// A task is a real repository at a real commit with its own test suite. A mutation is applied
// to break it; the model is asked to make the tests pass again without touching them. The
// repo's own tests decide pass or fail — not a checklist of mine.
//
// Usage: node bench/oracle.mjs [--tasks bench/tasks/tasks.json] [--tiers fast,balanced,strong]
//                              [--runs 1] [--out bench/oracle.json]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read as readLedger, stats as summarize } from "../src/ledger.mjs";
import { TIER_ORDER, heightOf } from "../src/ladder.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JEV = join(ROOT, "bin", "jev.mjs");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const TASKS = JSON.parse(readFileSync(resolve(arg("tasks", join(ROOT, "bench/tasks/tasks.json"))), "utf8"));
const TIERS = arg("tiers", "fast,balanced,strong").split(",");
const RUNS = Number(arg("runs", 1));
const OUT = resolve(arg("out", join(ROOT, "bench/oracle.json")));
const WORK = join(ROOT, "bench", ".work");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 15 * 60e3, ...opts });

/** Clone at a pinned ref so a task cannot change under the benchmark. */
function prepare(task, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const clone = run("git", ["clone", "--depth", "1", "--branch", task.ref, task.repo, dir]);
  if (clone.status !== 0) return { ok: false, why: `clone failed: ${clone.stderr.slice(-200)}` };
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: dir }).stdout.trim();
  const install = run("sh", ["-c", task.install], { cwd: dir });
  if (install.status !== 0) return { ok: false, why: "install failed" };

  // Confirm the suite passes BEFORE breaking it. A task whose tests already fail measures
  // nothing, and silently scoring it would poison the oracle.
  const before = run("sh", ["-c", task.test], { cwd: dir });
  if (before.status !== 0) return { ok: false, why: "suite already failing upstream" };

  // The mutation: drop the first early-return/guard in the target file. Mechanical, so it is
  // the same break for every tier, and recorded so the task is reproducible.
  const file = join(dir, task.break);
  if (!existsSync(file)) return { ok: false, why: `missing ${task.break}` };
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => /^\s*(if\s*\(|return |throw )/.test(l) && !/^\s*\/\//.test(l));
  if (idx < 0) return { ok: false, why: "no mutable guard found" };
  const removed = lines[idx];
  lines.splice(idx, 1);
  writeFileSync(file, lines.join("\n"));

  const after = run("sh", ["-c", task.test], { cwd: dir });
  if (after.status === 0) return { ok: false, why: "mutation did not break the suite" };
  return { ok: true, sha, removed: removed.trim(), brokeAt: idx + 1 };
}

const attempt = (dir, task, tier, ledger) => {
  const env = { ...process.env, JEV_PIN: tier, JEV_LEDGER: ledger, JEV_THREADS: `${ledger}.threads`, JEV_DEBUG: "1" };
  rmSync(ledger, { force: true });
  const started = Date.now();
  const r = run(process.execPath, [JEV, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "-p", task.prompt], { cwd: dir, env });
  const verify = run("sh", ["-c", task.test], { cwd: dir });
  return {
    passed: verify.status === 0,
    seconds: Math.round((Date.now() - started) / 1000),
    spend: summarize(readLedger(ledger)).spend,
    cliStatus: r.status,
  };
};

mkdirSync(dirname(OUT), { recursive: true });
const results = [];

for (const task of TASKS) {
  for (let runIdx = 0; runIdx < RUNS; runIdx++) {
    for (const tier of TIERS) {
      const dir = join(WORK, `${task.id}-${tier}-${runIdx}`);
      const prep = prepare(task, dir);
      if (!prep.ok) {
        process.stderr.write(`  SKIP ${task.id}/${tier}: ${prep.why}\n`);
        results.push({ task: task.id, tier, run: runIdx, skipped: prep.why });
        continue;
      }
      const r = attempt(dir, task, tier, join(WORK, `${task.id}-${tier}-${runIdx}.jsonl`));
      results.push({ task: task.id, tier, run: runIdx, sha: prep.sha, removed: prep.removed, ...r });
      process.stderr.write(`  ${task.id.padEnd(20)} ${tier.padEnd(9)} run${runIdx} ${r.passed ? "PASS" : "FAIL"} ${r.seconds}s $${r.spend.toFixed(4)}\n`);
      writeFileSync(OUT, JSON.stringify(results, null, 2));
    }
  }
}

// oracle[task] = cheapest rung that passed every run it was given
const oracle = {};
for (const task of TASKS) {
  for (const tier of TIER_ORDER.filter((t) => TIERS.includes(t))) {
    const rows = results.filter((r) => r.task === task.id && r.tier === tier && !r.skipped);
    if (rows.length && rows.every((r) => r.passed)) {
      oracle[task.id] = tier;
      break;
    }
  }
}
writeFileSync(OUT, JSON.stringify({ results, oracle }, null, 2));

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log("\n  task                 tier       pass   time    spend");
for (const r of results.filter((x) => !x.skipped)) {
  console.log(`  ${r.task.padEnd(20)} ${r.tier.padEnd(9)} ${r.passed ? " ok " : "FAIL"}  ${String(r.seconds).padStart(4)}s  $${r.spend.toFixed(4)}`);
}
console.log("\n  oracle (cheapest rung that actually passed)");
for (const [t, tier] of Object.entries(oracle)) console.log(`    ${t.padEnd(20)} ${tier}`);
const undecided = TASKS.filter((t) => !oracle[t.id]).map((t) => t.id);
if (undecided.length) console.log(`    no rung passed: ${undecided.join(", ")}`);
console.log(`\n  written to ${OUT}\n`);
