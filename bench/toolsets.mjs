#!/usr/bin/env node
// Jev against every alternative at choosing toolsets, with labels nobody here wrote.
//
// The routing benchmark could not discriminate: every task in it passed on the cheapest rung,
// so always-fast won by construction and there was nothing for an appraiser to be right
// about. This measures the decision Jev is actually making in the product, on a question that
// HAS a ground truth.
//
// The labels come from the MCP servers themselves. Every tool ships a description written by
// its author; a request derived from that description necessarily needs that tool's server.
// Nothing here is hand-labelled.
//
//   recall   of the requests that needed a toolset, how often was it kept
//   savings  mean fraction of MCP tool tokens dropped
//
// keep-all scores 100% recall and 0% savings. drop-all scores 0% and 100%. Both are useless,
// and they bracket the only interesting question: how much can be dropped while keeping what
// the turn needs.
//
// Usage: node bench/toolsets.mjs [--dump <jev-dump.json>] [--n 40]
import { readFileSync } from "node:fs";
import { groupOf, groupsIn, selectToolsets } from "../src/tools.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
process.loadEnvFile(`${process.env.HOME}/.jev-auto.env`);

const body = JSON.parse(readFileSync(arg("dump"), "utf8"));
const tools = (body.tools ?? []).filter((t) => t?.name);
const groups = groupsIn(tools);
const N = Number(arg("n", 40));

/** A request derived from a tool's own description. Its server is the label. */
const cases = tools
  .filter((t) => groupOf(t.name) && typeof t.description === "string" && t.description.length > 30)
  .map((t) => ({
    prompt: t.description.split(/[.\n]/)[0].trim(),
    needs: groupOf(t.name),
    tool: t.name,
  }));

// Spread across servers rather than taking the first N, which would all be one server.
const bySrv = {};
for (const c of cases) (bySrv[c.needs] ??= []).push(c);
const sample = [];
let round = 0;
while (sample.length < N) {
  let added = false;
  for (const list of Object.values(bySrv)) {
    if (list[round]) {
      sample.push(list[round]);
      added = true;
      if (sample.length >= N) break;
    }
  }
  if (!added) break;
  round++;
}

const totalChars = groups.reduce((s, g) => s + g.chars, 0);
const charsOf = (name) => groups.find((g) => g.name === name)?.chars ?? 0;

/** My own creation, as the thing Jev has to beat: substring matching on server names. */
const keyword = ({ prompt }) => {
  const text = prompt.toLowerCase();
  const keep = new Set();
  for (const g of groups) {
    const words = g.name.toLowerCase().replace(/^(mcp|claude_ai)_+/, "").split(/[_-]/).filter((w) => w.length > 3);
    if (words.some((w) => text.includes(w))) keep.add(g.name);
  }
  return keep;
};

// Jev's raw probabilities are fetched ONCE per request and thresholded offline, so sweeping
// the operating point costs nothing and every threshold is scored on identical answers.
const rawScores = new Map();
for (const c of sample) {
  const r = await selectToolsets({ prompt: c.prompt, tools, threshold: -1, raw: true });
  rawScores.set(c.prompt, r?.scores ?? {});
}
const jevAt = (t) => async (c) => {
  const scores = rawScores.get(c.prompt) ?? {};
  const keep = new Set();
  for (const g of groups) {
    const v = scores[g.name];
    if (!Number.isFinite(v) || v >= t) keep.add(g.name);
  }
  return keep;
};

const SELECTORS = {
  "jev @0.50": jevAt(0.5),
  "jev @0.30": jevAt(0.3),
  "jev @0.15": jevAt(0.15),
  "jev @0.05": jevAt(0.05),
  "keyword (mine)": async (c) => keyword(c),
  "keep-all": async () => new Set(groups.map((g) => g.name)),
  "drop-all": async () => new Set(),
};

const pct = (x) => `${(x * 100).toFixed(0)}%`;
const out = [];

for (const [name, select] of Object.entries(SELECTORS)) {
  let kept = 0;
  let saved = 0;
  for (const c of sample) {
    const keep = await select(c);
    if (keep.has(c.needs)) kept++;
    const dropped = groups.filter((g) => !keep.has(g.name)).reduce((s, g) => s + g.chars, 0);
    saved += totalChars ? dropped / totalChars : 0;
  }
  out.push({ name, recall: kept / sample.length, savings: saved / sample.length });
}

console.log(`\n  ${sample.length} requests derived from ${Object.keys(bySrv).length} servers' own tool descriptions`);
console.log(`  ${groups.length} toolsets, ${Math.round(totalChars / 3600)}k tokens of MCP schema in play\n`);
console.log("  selector           recall   savings   verdict");
for (const r of out) {
  const verdict =
    r.recall >= 0.9 && r.savings > 0.5 ? "keeps what is needed AND drops most of the rest"
    : r.recall < 0.5 ? "drops what the turn needs"
    : r.savings < 0.1 ? "saves nothing"
    : "";
  console.log(`  ${r.name.padEnd(17)} ${pct(r.recall).padStart(6)}   ${pct(r.savings).padStart(7)}   ${verdict}`);
}

// Useful only if it keeps what is needed. Among those, most savings wins.
const usable = out.filter((r) => r.recall >= 0.9);
const best = usable.sort((a, b) => b.savings - a.savings)[0];
console.log(
  best
    ? `\n  Best at >=90% recall: ${best.name} (${pct(best.savings)} of MCP schema dropped)\n`
    : "\n  Nothing reached 90% recall.\n",
);
