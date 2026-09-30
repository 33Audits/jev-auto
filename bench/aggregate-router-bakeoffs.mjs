#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdownPathFor } from "./router-bakeoff-lib.mjs";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex < 0 || !args[outIndex + 1]) {
  throw new Error("usage: node bench/aggregate-router-bakeoffs.mjs --out report.json run1.json run2.json ...");
}
const outputPath = resolve(args[outIndex + 1]);
const inputPaths = args
  .filter((value, index) => index !== outIndex && index !== outIndex + 1)
  .map((value) => resolve(value));
if (inputPaths.length < 2) throw new Error("at least two run artifacts are required");

const runs = inputPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const first = runs[0];
for (const run of runs.slice(1)) {
  if (run.corpus?.sha256 !== first.corpus?.sha256) throw new Error("corpus hash mismatch across runs");
  if (run.implementationSha256 !== first.implementationSha256) throw new Error("implementation hash mismatch across runs");
  if (JSON.stringify(run.methodology) !== JSON.stringify(first.methodology)) throw new Error("methodology mismatch across runs");
}

const names = first.rawScores.map((score) => score.name);
const armOf = (run, field, name) => run[field].find((score) => score.name === name);
const aggregate = Object.fromEntries(names.map((name) => {
  const raw = runs.map((run) => armOf(run, "rawScores", name));
  const policy = runs.map((run) => armOf(run, "scores", name)).filter(Boolean);
  return [name, {
    rawHoldout: raw.map((score) => score.holdout),
    policyHoldout: policy.map((score) => score.holdout),
    fallbackCounts: raw.map((score) => score.fallbacks),
    medianLatencyMs: raw.map((score) => score.medianLatencyMs),
  }];
}));

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  runCount: runs.length,
  runIds: runs.map((run) => run.generatedAt),
  corpus: first.corpus,
  implementationSha256: first.implementationSha256,
  methodology: first.methodology,
  arms: aggregate,
};
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

const rows = names.map((name) => {
  const arm = aggregate[name];
  const raw = arm.rawHoldout.map((score) => `${score.exact}/${score.under}/${score.over}`).join(" · ");
  const policy = arm.policyHoldout.length
    ? arm.policyHoldout.map((score) => `${score.exact}/${score.under}/${score.over}`).join(" · ")
    : "n/a (pinned control)";
  const latency = arm.medianLatencyMs.map((ms) => `${ms} ms`).join(" · ");
  return `| ${name} | ${raw} | ${policy} | ${arm.fallbackCounts.join(" · ")} | ${latency} |`;
});
const markdown = [
  "# JEV router bake-off aggregate",
  "",
  `Runs: ${artifact.runCount}`,
  `Run IDs: ${artifact.runIds.join(", ")}`,
  `Corpus SHA-256: \`${artifact.corpus.sha256}\``,
  `Implementation SHA-256: \`${artifact.implementationSha256}\``,
  `Models: TypeSafe \`${artifact.methodology.models.jev}\`; LLM \`${artifact.methodology.models.llm}\``,
  `Origins: TypeSafe \`${artifact.methodology.endpoints.jev}\`; LLM \`${artifact.methodology.endpoints.llm}\``,
  `Enabled tiers: ${artifact.methodology.policy.available.join(", ")}`,
  `Policy: current=balanced, context=${artifact.methodology.contextTokens}, tools=${artifact.methodology.toolCount}, cache=false, floor=null, cutoffs=${JSON.stringify(artifact.methodology.policy.cutoffs)}`,
  "",
  "> Routing-label agreement only. No selected model executed a mission. Fixed controls are pinned and bypass policy.",
  "",
  "Holdout cells are exact / under / over for each run.",
  "",
  "| arm | raw runs | policy runs | fallbacks | median routing latency |",
  "| --- | --- | --- | --- | --- |",
  ...rows,
  "",
  "The arms are intentionally not ranked. These labels are a screening proxy, not a production promotion gate.",
  "",
].join("\n");
writeFileSync(markdownPathFor(outputPath), markdown);
process.stdout.write(`${markdown}\nJSON: ${outputPath}\n`);
