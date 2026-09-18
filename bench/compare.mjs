#!/usr/bin/env node
// Head-to-head: the free local scorer vs the Jev decision model, over the same real prompts.
//
// Answers what can be answered without an oracle — how the two spread work across tiers,
// what that costs, how much they agree, and what the decision latency is. It does NOT answer
// whether a cheap route was sufficient; that needs the oracle in bench/README.md.
//
// Usage: node bench/compare.mjs [--n 300] [--cache bench/jev-cache.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { appraise as local } from "../src/appraisers/heuristic.mjs";
import { appraise as jev } from "../src/appraisers/typesafe.mjs";
import { shippedCutoffs } from "../src/tuning.mjs";
import { ladderFor, TIER_ORDER } from "../src/ladder.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const N = Number(arg("n", 300));
const CACHE = arg("cache", "bench/jev-cache.json");
const CONCURRENCY = 6;

process.loadEnvFile(`${process.env.HOME}/.jev-auto.env`);

const corpus = readFileSync("bench/corpus.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// Every k-th prompt rather than the first N: the corpus is ordered by project and session,
// so the head of it is one slice of work, not a sample of the distribution.
const step = Math.max(1, Math.floor(corpus.length / N));
const sample = corpus.filter((_, i) => i % step === 0).slice(0, N);

const inputOf = (row) => ({
  prompt: row.text,
  contextTokens: Math.round((row.priorChars ?? 0) / 3.6),
  cutoffs: shippedCutoffs(),
});

// Jev answers are cached so re-running the comparison costs nothing and cannot drift.
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
const key = (t) => t.slice(0, 300);

let calls = 0;
let failures = 0;
const latencies = [];

async function jevFor(row) {
  const k = key(row.text);
  if (cache[k]) return cache[k];
  const started = Date.now();
  const d = await jev(inputOf(row));
  latencies.push(Date.now() - started);
  calls++;
  if (String(d.backend).includes("fallback")) failures++;
  return (cache[k] = { choice: d.choice, confidence: d.confidence, backend: d.backend });
}

process.stderr.write(`comparing on ${sample.length} prompts (cache: ${Object.keys(cache).length} warm)…\n`);
const jevOut = new Array(sample.length);
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < sample.length) {
      const i = next++;
      jevOut[i] = await jevFor(sample[i]);
      if (i % 50 === 0) process.stderr.write(`  ${i}/${sample.length}\n`);
    }
  }),
);
writeFileSync(CACHE, JSON.stringify(cache));

const localStart = process.hrtime.bigint();
const localOut = sample.map((r) => local(inputOf(r)));
const localMs = Number(process.hrtime.bigint() - localStart) / 1e6 / sample.length;

const PRICE = Object.fromEntries(ladderFor("claude").map((r) => [r.tier, (r.in + r.out) / 2]));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mixOf = (list) => {
  const m = {};
  for (const c of list) m[c] = (m[c] ?? 0) + 1;
  return m;
};
const spendOf = (list) => list.reduce((s, t) => s + PRICE[t], 0) / list.length;
const kappa = (a, b) => {
  const tiers = [...new Set([...a, ...b])];
  const obs = a.filter((x, i) => x === b[i]).length / a.length;
  const rate = (l, t) => l.filter((x) => x === t).length / l.length;
  const exp = tiers.reduce((s, t) => s + rate(a, t) * rate(b, t), 0);
  return (obs - exp) / (1 - exp);
};

const L = localOut.map((d) => d.choice);
const J = jevOut.map((d) => d.choice);
const allBalanced = L.map(() => "balanced");

console.log(`\n  ${sample.length} real prompts | ${calls} live Jev calls | ${failures} failed\n`);
console.log("  tier mix");
for (const [name, list] of [["local", L], ["jev", J]]) {
  const m = mixOf(list);
  console.log(`    ${name.padEnd(7)} ${TIER_ORDER.map((t) => `${t} ${pct((m[t] ?? 0) / list.length).padStart(6)}`).join("  ")}`);
}

console.log("\n  relative spend (equal tokens per prompt)");
const base = spendOf(allBalanced);
for (const [name, list] of [["local", L], ["jev", J], ["all-balanced", allBalanced]]) {
  const v = spendOf(list) / base;
  console.log(`    ${name.padEnd(13)} ${v.toFixed(2)}x all-balanced${v > 1 ? "   <-- more than doing nothing" : ""}`);
}

console.log(`\n  local vs jev agreement   ${pct(L.filter((x, i) => x === J[i]).length / L.length)}  kappa ${kappa(L, J).toFixed(2)}`);
const lat = latencies.sort((a, b) => a - b);
console.log(
  `\n  decision latency   local ${localMs.toFixed(3)} ms  |  jev ` +
    (lat.length ? `${lat[Math.floor(lat.length / 2)]} ms median, ${lat.at(-1)} ms worst` : "cached"),
);

console.log("\n  where they disagree:");
let shown = 0;
for (let i = 0; i < sample.length && shown < 8; i++) {
  if (L[i] === J[i]) continue;
  console.log(`    local=${L[i].padEnd(8)} jev=${J[i].padEnd(8)} | ${sample[i].text.replace(/\s+/g, " ").slice(0, 76)}`);
  shown++;
}
console.log("");
