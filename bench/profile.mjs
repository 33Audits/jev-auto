#!/usr/bin/env node
// What the router actually does on a real prompt distribution, and whether it is doing
// anything a trivial baseline does not. No API key, no network, no cost.
//
// Usage: node bench/profile.mjs [bench/corpus.jsonl]
import { readFileSync } from "node:fs";
import { appraise } from "../src/appraisers/heuristic.mjs";
import { shippedCutoffs } from "../src/tuning.mjs";
import { ladderFor } from "../src/ladder.mjs";
import { alwaysOpus, alwaysSonnet, lengthOnly, randomMatched, ours } from "./baselines.mjs";

const corpus = readFileSync(process.argv[2] ?? "bench/corpus.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

const inputFor = (row) => ({
  prompt: row.text,
  // The transcript gives characters before this prompt; the relay's own ratio turns that
  // into the token estimate the context rules key off.
  contextTokens: Math.round((row.priorChars ?? 0) / 3.6),
  toolCount: 0,
  cutoffs: shippedCutoffs(),
});

const decisions = corpus.map((row) => appraise(inputFor(row)).choice);
const mix = {};
for (const d of decisions) mix[d] = (mix[d] ?? 0) + 1;
const share = Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, v / corpus.length]));

// Length cutoffs placed at our own tier boundaries by quantile, so the length baseline is
// given the same tier mix and the comparison isolates "does the scorer read anything else".
const lengths = corpus.map((r) => r.text.length).sort((a, b) => a - b);
const q = (p) => lengths[Math.floor(p * (lengths.length - 1))];
const quantiles = { cheap: q(share.fast ?? 0), strong: q((share.fast ?? 0) + (share.balanced ?? 0)) };

const ROUTERS = {
  ours,
  lengthOnly: lengthOnly(quantiles),
  randomMatched: randomMatched(share),
  alwaysSonnet,
  alwaysOpus,
};

const out = Object.fromEntries(
  Object.entries(ROUTERS).map(([name, fn]) => [name, corpus.map((row) => fn(inputFor(row)).choice)]),
);

const agreement = (a, b) => a.filter((x, i) => x === b[i]).length / a.length;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

console.log(`\n  corpus: ${corpus.length} real prompts from ${new Set(corpus.map((r) => r.project)).size} projects\n`);

console.log("  tier mix");
for (const [name, list] of Object.entries(out)) {
  const m = {};
  for (const d of list) m[d] = (m[d] ?? 0) + 1;
  console.log(
    `    ${name.padEnd(14)} ${["fast", "balanced", "strong"].map((t) => `${t} ${pct((m[t] ?? 0) / corpus.length).padStart(6)}`).join("   ")}`,
  );
}

// Raw agreement is misleading when one tier holds most of the mass: two routers that both
// say "balanced" almost always will agree almost always, having decided nothing. Cohen's kappa
// subtracts the agreement you would get by chance at these base rates.
// 0 = no information beyond the tier mix. 1 = identical decisions.
const kappa = (a, b) => {
  const tiers = [...new Set([...a, ...b])];
  const observed = agreement(a, b);
  const rate = (list, t) => list.filter((x) => x === t).length / list.length;
  const expected = tiers.reduce((sum, t) => sum + rate(a, t) * rate(b, t), 0);
  return (observed - expected) / (1 - expected);
};

console.log("\n  agreement with ours        raw     kappa  (kappa 0 = decides nothing the baseline doesn't)");
for (const name of ["lengthOnly", "randomMatched", "alwaysSonnet", "alwaysOpus"]) {
  // Kappa against a constant predictor is degenerate (no variance to correct for), so it is
  // reported as n/a rather than as a meaningful zero.
  const constant = new Set(out[name]).size === 1;
  const k = constant ? "  n/a" : kappa(out.ours, out[name]).toFixed(2).padStart(6);
  console.log(`    ${name.padEnd(14)} ${pct(agreement(out.ours, out[name])).padStart(10)}  ${k}`);
}

// Relative spend, holding tokens per prompt equal across tiers. Crude, but it answers the
// only question that matters: against the baseline a sensible user actually runs, does
// routing cost less or more?
const PRICE = Object.fromEntries(ladderFor("claude").map((r) => [r.tier, (r.in + r.out) / 2]));
const spend = (list) => list.reduce((sum, t) => sum + PRICE[t], 0) / list.length;
console.log("\n  relative spend (equal tokens per prompt)");
const sonnetSpend = spend(out.alwaysSonnet);
for (const [name, list] of Object.entries(out)) {
  const v = spend(list) / sonnetSpend;
  const flag = name === "ours" ? (v > 1 ? "   <-- MORE than just using sonnet" : "   <-- cheaper than sonnet") : "";
  console.log(`    ${name.padEnd(14)} ${v.toFixed(2)}x all-sonnet${flag}`);
}

// Latency: the whole premise of the local appraiser is that it is free to run.
const sample = corpus.slice(0, 500).map(inputFor);
const started = process.hrtime.bigint();
for (const input of sample) appraise(input);
const perCall = Number(process.hrtime.bigint() - started) / 1e6 / sample.length;
console.log(`\n  decision latency   ${perCall.toFixed(3)} ms/prompt  (network routers: 0.3-1.0 s, per their own README)`);

console.log("\n  prompts where we disagree with the length baseline:");
let shown = 0;
for (let i = 0; i < corpus.length && shown < 6; i++) {
  if (out.ours[i] === out.lengthOnly[i]) continue;
  console.log(`    ours=${out.ours[i].padEnd(6)} length=${out.lengthOnly[i].padEnd(6)} | ${corpus[i].text.replace(/\s+/g, " ").slice(0, 88)}`);
  shown++;
}
console.log("");
