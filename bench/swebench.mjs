#!/usr/bin/env node
// SWE-bench Lite: real GitHub issues, the repository's own tests deciding.
//
// The reason this exists: every earlier task set passed on the cheapest model, so
// always-cheapest won by construction and there was nothing for Jev to be right about. These
// are genuine Django bug reports with the maintainers' own regression tests attached. Some of
// them the cheap model will fail — that is the point, and it is the only way the tier question
// can be answered.
//
// Per instance: check out the repo at the issue's base commit, apply the maintainers' test
// patch, confirm the FAIL_TO_PASS tests fail, hand the model the issue text, then re-run. A fix
// counts only if FAIL_TO_PASS now passes AND PASS_TO_PASS still does — no breaking the suite to
// make a test green.
//
// Usage: node bench/swebench.mjs [--tiers fast,balanced] [--n 7] [--out bench/swebench.json]
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

const TASKS = JSON.parse(readFileSync(join(ROOT, "bench/tasks/swebench-django.json"), "utf8"))
  .slice(0, Number(arg("n", 7)));
const TIERS = arg("tiers", "fast,balanced").split(",");
const OUT = resolve(arg("out", join(ROOT, "bench/swebench.json")));
const WORK = join(ROOT, "bench", ".swe");
const CACHE = join(WORK, "django.git");

// Never pipe inside the command. `cmd | tail -25` reports tail's exit status, which is always
// 0 — so every test run looked like it passed, including the ones that had to fail, and all 14
// instances were skipped as "already passing". Truncate the output here instead.
const sh = (cmd, opts = {}) => {
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 128e6, timeout: 25 * 60e3, ...opts });
  return { ...r, tail: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n") };
};

// One bare clone, reused as worktrees. Django is ~500MB; cloning it 14 times is not the
// experiment.
function ensureCache() {
  if (existsSync(CACHE)) return true;
  mkdirSync(WORK, { recursive: true });
  process.stderr.write("  cloning django once (a few minutes)...\n");
  return sh(`git clone --bare https://github.com/django/django.git ${CACHE}`).status === 0;
}

/**
 * SWE-bench writes Django test ids as `test_name (module.Class)`, which is unittest's printed
 * form, not something a runner accepts. Django's own tests/runtests.py wants
 * `module.Class.test_name`. Feeding the printed form to pytest collected nothing.
 */
export const toDjangoId = (id) => {
  const m = /^(\S+)\s+\((.+?)\)\s*$/.exec(id);
  return m ? `${m[2]}.${m[1]}` : id;
};

const testCmd = (ids) =>
  `PYTHONPATH="$PWD" ./.venv/bin/python tests/runtests.py --parallel 1 --verbosity 0 ` +
  ids.map((i) => JSON.stringify(toDjangoId(i))).join(" ");

function prepare(task, dir) {
  rmSync(dir, { recursive: true, force: true });
  // Removing the directory does not deregister the worktree, so a rerun after an interrupted
  // run finds the path still claimed and every `worktree add` fails. Prune first.
  sh(`git --git-dir=${CACHE} worktree prune`);
  if (sh(`git --git-dir=${CACHE} worktree add --detach ${dir} ${task.base_commit}`).status !== 0) {
    // A detached worktree from a bare repo needs the commit present; fetch it if shallow.
    sh(`git --git-dir=${CACHE} fetch origin ${task.base_commit}`);
    if (sh(`git --git-dir=${CACHE} worktree add --detach ${dir} ${task.base_commit}`).status !== 0) {
      return { ok: false, why: "worktree failed" };
    }
  }
  // No editable install. These instances are 2019-2024 vintage and their setup.py does not
  // survive modern setuptools, which is why SWE-bench ships a Docker image per instance. Django
  // is pure Python, so putting the checkout on PYTHONPATH makes `import django` resolve to it
  // and only the runtime deps need installing.
  const install = sh(`python3 -m venv .venv && ./.venv/bin/pip -q install sqlparse asgiref pytz`, { cwd: dir });
  if (install.status !== 0) return { ok: false, why: `deps failed: ${install.tail.slice(-160)}` };
  // The maintainers' regression test, applied without touching source.
  writeFileSync(join(dir, "swe_test.patch"), task.test_patch);
  const applied = sh(`git apply swe_test.patch`, { cwd: dir });
  if (applied.status !== 0) return { ok: false, why: `test patch did not apply: ${applied.tail.slice(-160)}` };
  const fail = JSON.parse(task.FAIL_TO_PASS);
  const before = sh(testCmd(fail), { cwd: dir });
  if (before.status === 0) return { ok: false, why: "FAIL_TO_PASS already passing" };

  // Which PASS_TO_PASS tests actually pass on this untouched checkout.
  //
  // Not all of them do, and not because of anything the model does. These instances are from
  // 2019-2024 and run here on Python 3.11, which changed how unittest formats nested-class test
  // names — so a Django assertion about its own error string no longer matches. Holding the
  // model to a test that was already red marks a correct fix as "broke the suite", which is
  // exactly what happened to 4 of the first 5 runs.
  //
  // So the regression set is established empirically, per instance, before the model runs.
  const claimed = JSON.parse(task.PASS_TO_PASS).slice(0, 12);
  const green = [];
  for (const id of claimed) {
    if (sh(testCmd([id]), { cwd: dir }).status === 0) green.push(id);
  }
  return { ok: true, baseline: before.tail, green, dropped: claimed.length - green.length };
}

function verify(task, dir, green) {
  const fail = JSON.parse(task.FAIL_TO_PASS);
  const fixed = sh(testCmd(fail), { cwd: dir }).status === 0;
  // Only the tests that were green before the model touched anything.
  const intact = green.length === 0 || sh(testCmd(green), { cwd: dir }).status === 0;
  return { fixed, intact, resolved: fixed && intact, regressionSet: green.length };
}

if (process.env.JEV_SWE_IMPORT_ONLY === "1") {
  // Imported for `toDjangoId`; do not start a run.
} else if (!ensureCache()) {
  process.stderr.write("  could not clone django\n");
  process.exit(1);
}

const results = [];
for (const task of TASKS) {
  // What Jev thinks, from the issue text alone, before anything runs.
  const d = await jev({
    prompt: task.problem_statement.slice(0, 6000),
    contextTokens: 130000,
    available: ["fast", "balanced", "strong"],
  });

  for (const tier of TIERS) {
    const dir = join(WORK, `${task.instance_id}-${tier}`);
    const prep = prepare(task, dir);
    if (!prep.ok) {
      process.stderr.write(`  SKIP ${task.instance_id}/${tier}: ${prep.why}\n`);
      results.push({ task: task.instance_id, tier, skipped: prep.why });
      writeFileSync(OUT, JSON.stringify(results, null, 2));
      continue;
    }

    const ledger = join(WORK, `${task.instance_id}-${tier}.jsonl`);
    rmSync(ledger, { force: true });
    const env = { ...process.env, JEV_PIN: tier, JEV_LEDGER: ledger, JEV_THREADS: `${ledger}.threads` };
    const prompt =
      `This repository has a reported bug. Fix it.\n\n${task.problem_statement.slice(0, 6000)}\n\n` +
      `A regression test for it is already present and currently failing. Do not modify any test.\n` +
      `Run it with:\n  ${testCmd(JSON.parse(task.FAIL_TO_PASS))}`;

    const started = Date.now();
    spawnSync(process.execPath, [JEVBIN, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "-p", prompt],
      { cwd: dir, env, encoding: "utf8", maxBuffer: 64e6, timeout: 25 * 60e3 });
    const v = verify(task, dir, prep.green);

    const row = {
      task: task.instance_id, tier, jevChoice: d.choice, pFast: d.probabilities?.fast ?? null,
      seconds: Math.round((Date.now() - started) / 1000),
      spend: summarize(readLedger(ledger)).spend, ...v,
    };
    results.push(row);
    process.stderr.write(
      `  ${task.instance_id.padEnd(26)} ${tier.padEnd(9)} ` +
        `${v.resolved ? "RESOLVED" : v.fixed ? "broke-regression" : "unresolved"}  ` +
        `${row.seconds}s $${row.spend.toFixed(3)} (guard ${v.regressionSet}${prep.dropped ? `, ${prep.dropped} already red` : ""})\n`,
    );
    writeFileSync(OUT, JSON.stringify(results, null, 2));
  }
}

const done = results.filter((r) => !r.skipped);
console.log("\n  instance                   jev says  p(fast)   fast        balanced");
for (const task of [...new Set(done.map((r) => r.task))]) {
  const at = (t) => done.find((r) => r.task === task && r.tier === t);
  const mark = (r) => (r ? (r.resolved ? "RESOLVED" : "no") : "-");
  const f = at("fast"), b = at("balanced");
  console.log(`  ${task.padEnd(26)} ${String(f?.jevChoice ?? b?.jevChoice).padEnd(9)} ${(f?.pFast ?? b?.pFast)?.toFixed(2) ?? " n/a"}    ${mark(f).padEnd(11)} ${mark(b)}`);
}
for (const tier of TIERS) {
  const rows = done.filter((r) => r.tier === tier);
  const solved = rows.filter((r) => r.resolved).length;
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  console.log(`\n  ${tier}: ${solved}/${rows.length} resolved, $${spend.toFixed(2)}`);
}
console.log("");
