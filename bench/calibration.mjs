#!/usr/bin/env node
// Is Jev's confidence meaningful, or just a number?
//
// Two policy rules depend on it: an upgrade needs p >= 0.9 because routing up costs ~5x, and
// "no opinion" below minConfidence triggers the cheap path. Together they are the difference
// between +19% and -30% cost. A fabricated confidence cannot carry that — and the local
// scorer's confidence IS fabricated, being distance from a threshold someone chose.
//
// The test: for each task, ask Jev for a tier and record the probability it assigns the
// cheapest rung. Then actually run the task on the cheapest rung. If the confidence means
// anything, p(fast) should be higher on the tasks fast handles than on the ones it fails.
//
// Only the cheap rung is executed, so this costs a few dollars rather than tens.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { read as readLedger, stats as summarize } from "../src/ledger.mjs";
import { appraise as jev } from "../src/appraisers/typesafe.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JEVBIN = join(ROOT, "bin", "jev.mjs");
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
process.loadEnvFile(`${process.env.HOME}/.jev-auto.env`);

const TASKS = JSON.parse(readFileSync(resolve(arg("tasks", join(ROOT, "bench/tasks/tasks.json"))), "utf8"));
const OUT = resolve(arg("out", join(ROOT, "bench/calibration.json")));
const WORK = join(ROOT, "bench", ".calib");
const AVAILABLE = ["fast", "balanced", "strong"];
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64e6, timeout: 15 * 60e3, ...opts });

function prepare(task, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (run("git", ["clone", "--depth", "1", "--branch", task.ref, task.repo, dir]).status !== 0) {
    return { ok: false, why: "clone failed" };
  }
  if (run("sh", ["-c", task.install], { cwd: dir }).status !== 0) return { ok: false, why: "install failed" };
  if (run("sh", ["-c", task.test], { cwd: dir }).status !== 0) return { ok: false, why: "already failing" };

  const file = join(dir, task.break);
  if (!existsSync(file)) return { ok: false, why: `missing ${task.break}` };
  const lines = readFileSync(file, "utf8").split("\n");
  if ((task.mutation ?? "guard") === "operator") {
    const FLIPS = [[" <= ", " < "], [" >= ", " > "], [" < ", " <= "], [" > ", " >= "], [" + 1", " + 2"], [" - 1", " - 2"]];
    let done = false;
    for (let i = Math.floor(lines.length / 3); i < lines.length && !done; i++) {
      if (/^\s*\/\//.test(lines[i])) continue;
      for (const [from, to] of FLIPS) {
        if (lines[i].includes(from)) { lines[i] = lines[i].replace(from, to); done = true; break; }
      }
    }
    if (!done) return { ok: false, why: "nothing to flip" };
  } else {
    const idx = lines.findIndex((l) => /^\s*(if\s*\(|return |throw )/.test(l) && !/^\s*\/\//.test(l));
    if (idx < 0) return { ok: false, why: "no guard" };
    lines.splice(idx, 1);
  }
  writeFileSync(file, lines.join("\n"));

  const after = run("sh", ["-c", task.test], { cwd: dir });
  if (after.status === 0) return { ok: false, why: "mutation harmless" };
  const failure = `${after.stdout ?? ""}\n${after.stderr ?? ""}`
    .replace(ANSI, "").split("\n").filter((l) => l.trim()).slice(0, 40).join("\n");
  return { ok: true, failure };
}

mkdirSync(WORK, { recursive: true });
const rows = [];

for (const task of TASKS) {
  const dir = join(WORK, task.id);
  const prep = prepare(task, dir);
  if (!prep.ok) { process.stderr.write(`  SKIP ${task.id}: ${prep.why}\n`); continue; }
  const prompt =
    `The test suite in this repository is failing:\n\n${prep.failure}\n\n` +
    `Fix the source so every test passes. Do not modify the tests.`;

  const d = await jev({ prompt, contextTokens: 130000, available: AVAILABLE });
  const pFast = d.probabilities?.fast ?? null;

  const ledger = join(WORK, `${task.id}.jsonl`);
  rmSync(ledger, { force: true });
  const env = { ...process.env, JEV_PIN: "fast", JEV_LEDGER: ledger, JEV_THREADS: `${ledger}.threads` };
  run(process.execPath, [JEVBIN, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "-p", prompt], { cwd: dir, env });
  const fastPassed = run("sh", ["-c", task.test], { cwd: dir }).status === 0;

  rows.push({ task: task.id, mutation: task.mutation ?? "guard", jevChoice: d.choice,
    jevConfidence: d.confidence, pFast, fastPassed, spend: summarize(readLedger(ledger)).spend });
  process.stderr.write(`  ${task.id.padEnd(16)} jev=${d.choice.padEnd(9)} p(fast)=${pFast?.toFixed(2) ?? "n/a"}  fast ${fastPassed ? "PASSED" : "FAILED"}\n`);
  writeFileSync(OUT, JSON.stringify(rows, null, 2));
}

const withP = rows.filter((r) => Number.isFinite(r.pFast));
const passed = withP.filter((r) => r.fastPassed);
const failed = withP.filter((r) => !r.fastPassed);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

console.log("\n  task             jev says    p(fast)   fast actually");
for (const r of rows) {
  console.log(`  ${r.task.padEnd(16)} ${r.jevChoice.padEnd(10)} ${(r.pFast?.toFixed(2) ?? " n/a").padStart(7)}   ${r.fastPassed ? "passed" : "FAILED"}`);
}
console.log(`\n  mean p(fast) where fast passed:  ${mean(passed.map((r) => r.pFast))?.toFixed(3) ?? "n/a"}  (${passed.length} tasks)`);
console.log(`  mean p(fast) where fast failed:  ${mean(failed.map((r) => r.pFast))?.toFixed(3) ?? "n/a"}  (${failed.length} tasks)`);

if (!failed.length || !passed.length) {
  console.log("\n  Cannot judge calibration: the cheap rung had the same outcome everywhere.");
  console.log("  With no variance in the result there is nothing for a probability to predict.\n");
} else {
  let better = 0, ties = 0;
  for (const p of passed) for (const f of failed) {
    if (p.pFast > f.pFast) better++; else if (p.pFast === f.pFast) ties++;
  }
  const auc = (better + ties / 2) / (passed.length * failed.length);
  console.log(`\n  AUC ${auc.toFixed(2)} — chance a task fast handled scored higher than one it failed.`);
  console.log(`  0.5 is a coin flip; 1.0 is perfect separation.`);
  console.log(auc >= 0.7
    ? "\n  Jev's confidence carries real signal about whether the cheap rung suffices.\n"
    : "\n  Jev's confidence does not predict cheap-rung sufficiency on this set.\n");
}
