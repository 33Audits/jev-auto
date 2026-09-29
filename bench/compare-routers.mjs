#!/usr/bin/env node
// Every router against the oracle, on the same tasks, with the same prompts.
//
// This is the question that matters: does Jev — the decision model, not any heuristic written
// here — choose better than the alternatives? "Better" is cost at equal strict accuracy, so a
// router that always picks the cheapest rung cannot win by being reckless.
//
// Free and repeatable: the oracle already recorded what each rung cost and whether it passed,
// so scoring a router needs only its choice per task, not another execution.
//
// Usage: node bench/compare-routers.mjs [--oracle bench/oracle.json]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TIER_ORDER, heightOf } from "../src/ladder.mjs";
import { verdictFor } from "../src/verdict.mjs";
import { appraise as local } from "../src/appraisers/heuristic.mjs";
import { appraise as jev } from "../src/appraisers/typesafe.mjs";
import { shippedCutoffs } from "../src/tuning.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
process.loadEnvFile(`${process.env.HOME}/.jev-auto.env`);

const { results, oracle } = JSON.parse(readFileSync(resolve(arg("oracle", "bench/oracle.json")), "utf8"));
const TIERS = [...new Set(results.filter((r) => !r.skipped).map((r) => r.tier))];
const AVAILABLE = TIER_ORDER.filter((t) => TIERS.includes(t));

/** One row per task: the prompt it presented, what each rung cost, and what actually passed. */
const tasks = [...new Set(results.filter((r) => !r.skipped).map((r) => r.task))]
  .map((id) => {
    const rows = results.filter((r) => r.task === id && !r.skipped);
    const cost = {};
    const passed = {};
    for (const tier of AVAILABLE) {
      const at = rows.filter((r) => r.tier === tier);
      if (!at.length) continue;
      cost[tier] = at.reduce((s, r) => s + r.spend, 0) / at.length;
      passed[tier] = at.every((r) => r.passed);
    }
    return { id, prompt: rows[0].prompt, oracle: oracle[id], cost, passed };
  })
  .filter((t) => t.oracle); // a task no rung solved cannot score a router

// Every router is asked for a tier, then put through the SAME policy the product uses, so the
// comparison is of appraisers rather than of policies.
const decide = async (appraiseFn, task) => {
  const d = await appraiseFn({ prompt: task.prompt, contextTokens: 130000, cutoffs: shippedCutoffs(), available: AVAILABLE });
  return verdictFor({
    prompt: task.prompt, decision: d, current: "balanced",
    available: AVAILABLE, contextTokens: 130000,
  }).tier;
};

const ROUTERS = {
  jev: (t) => decide(jev, t),
  "local (heuristic)": (t) => decide(local, t),
  "always-fast": async () => AVAILABLE[0],
  "always-balanced": async () => "balanced",
  "always-strong": async () => AVAILABLE.at(-1),
};

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const rows = [];

for (const [name, pick] of Object.entries(ROUTERS)) {
  let strict = 0;
  let spend = 0;
  let waste = 0;
  const picks = [];
  for (const task of tasks) {
    const tier = await pick(task);
    picks.push({ task: task.id, tier });
    // A strict error is routing to a rung that did NOT pass this task — measured, not inferred.
    if (task.passed[tier] === false) strict++;
    waste += Math.max(0, heightOf(tier) - heightOf(task.oracle));
    spend += task.cost[tier] ?? 0;
  }
  const perfect = tasks.reduce((s, t) => s + (t.cost[t.oracle] ?? 0), 0);
  rows.push({ name, strict, n: tasks.length, spend, waste: waste / tasks.length, regret: perfect ? spend / perfect : 0, picks });
}

console.log(`\n  ${tasks.length} tasks, ${AVAILABLE.length} rungs, oracle built from real test runs\n`);
console.log("  router               strict errors   spend      regret   over-routing");
for (const r of rows.sort((a, b) => a.strict - b.strict || a.spend - b.spend)) {
  console.log(
    `  ${r.name.padEnd(20)} ${`${r.strict}/${r.n}`.padStart(8)} ${pct(r.strict / r.n).padStart(6)}   ` +
      `$${r.spend.toFixed(4)}   ${r.regret.toFixed(2)}x     ${r.waste.toFixed(2)}`,
  );
}

const perfect = tasks.reduce((s, t) => s + (t.cost[t.oracle] ?? 0), 0);
console.log(`\n  perfect router (the oracle itself)        $${perfect.toFixed(4)}   1.00x     0.00`);
console.log("\n  Sorted by strict errors first: a router is only allowed to be cheap if it works.");

const best = rows.filter((r) => r.strict === Math.min(...rows.map((x) => x.strict))).sort((a, b) => a.spend - b.spend)[0];
console.log(`\n  Cheapest router with the fewest strict errors: ${best.name}\n`);

console.log("  per-task picks");
console.log(`  task            oracle     ${Object.keys(ROUTERS).map((n) => n.slice(0, 9).padEnd(10)).join("")}`);
for (const task of tasks) {
  const line = rows.map((r) => (r.picks.find((p) => p.task === task.id)?.tier ?? "?").slice(0, 9).padEnd(10));
  console.log(`  ${task.id.padEnd(15)} ${String(task.oracle).padEnd(10)} ${line.join("")}`);
}
console.log("");
