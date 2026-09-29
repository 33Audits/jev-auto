#!/usr/bin/env node
// Scores a router against the oracle. Strict accuracy beside cost, in that order —
// the column that can invalidate the other one goes first.
//
// Usage: node bench/score.mjs [--oracle bench/oracle.json] [--router bench/router-run.json]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TIER_ORDER, heightOf } from "../src/ladder.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

const { results, oracle } = JSON.parse(readFileSync(resolve(arg("oracle", "bench/oracle.json")), "utf8"));
const router = JSON.parse(readFileSync(resolve(arg("router", "bench/router-run.json")), "utf8"));

const costAt = (task, tier) => {
  const rows = results.filter((r) => r.task === task && r.tier === tier && !r.skipped);
  return rows.length ? rows.reduce((s, r) => s + r.spend, 0) / rows.length : null;
};

let strictErrors = 0;
let spend = 0;
let perfect = 0;
let waste = 0;
const rows = [];

for (const pick of router) {
  const want = oracle[pick.task];
  if (!want) continue; // no rung solved it; not scoreable
  const tooCheap = heightOf(pick.tier) < heightOf(want);
  if (tooCheap) strictErrors++;
  waste += Math.max(0, heightOf(pick.tier) - heightOf(want));
  spend += costAt(pick.task, pick.tier) ?? 0;
  perfect += costAt(pick.task, want) ?? 0;
  rows.push({ task: pick.task, chose: pick.tier, oracle: want, tooCheap });
}

const n = rows.length || 1;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`\n  ${rows.length} scoreable tasks\n`);
console.log("  task                 chose      oracle     verdict");
for (const r of rows) {
  console.log(`  ${r.task.padEnd(20)} ${r.chose.padEnd(10)} ${r.oracle.padEnd(10)} ${r.tooCheap ? "TOO CHEAP — task failed" : "ok"}`);
}
console.log(`\n  Strict errors (routed below what the task needed)   ${strictErrors}/${rows.length}  ${pct(strictErrors / n)}`);
console.log(`  Over-routing waste (mean rungs above the oracle)    ${(waste / n).toFixed(2)}`);
console.log(`  Spend                                              $${spend.toFixed(4)}`);
console.log(`  A perfect router would have spent                  $${perfect.toFixed(4)}`);
console.log(`  Cost regret                                        ${perfect > 0 ? (spend / perfect).toFixed(2) : "n/a"}x`);
console.log(`\n  Strict errors are the number that can invalidate the cost column. A router that`);
console.log(`  routes everything to the cheapest rung wins on spend and loses here.\n`);
