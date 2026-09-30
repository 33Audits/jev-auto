#!/usr/bin/env node
// JEV-specific router bake-off over a frozen, labeled mission corpus.
//
// This measures agreement with frozen authored tier labels that are independent of the live
// router outputs, NOT whether a model actually
// completes a mission. It is a cheap routing-quality screen before the expensive execution
// oracle in bench/oracle.mjs.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appraise as local } from "../src/appraisers/heuristic.mjs";
import { appraise as jev, TYPESAFE_ENDPOINT, TYPESAFE_MODEL } from "../src/appraisers/typesafe.mjs";
import { appraise as llm, DELEGATE_MODEL, DELEGATE_ORIGIN } from "../src/appraisers/delegate.mjs";
import { enabledTiers, TIER_ORDER } from "../src/ladder.mjs";
import { RULES, shippedCutoffs } from "../src/tuning.mjs";
import { verdictFor } from "../src/verdict.mjs";
import { assertNoFallbacks, markdownPathFor, scoreArm, summarizeDecision } from "./router-bakeoff-lib.mjs";

try {
  process.loadEnvFile(`${process.env.HOME}/.jev-auto.env`);
} catch {
  // All credentials may instead be supplied by the invoking environment.
}
if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
  throw new Error("JEV_API_KEY or TYPESAFE_API_KEY is required for the TypeSafe Jev arm");
}

const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

const corpusPath = resolve(arg("corpus", "bench/tasks/lisa-missions.json"));
const outputPath = resolve(arg("out", "bench/results/jev-router-bakeoff-latest.json"));
const markdownPath = markdownPathFor(outputPath);
const corpusBytes = readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes.toString("utf8"));
const missions = corpus.missions;
const available = enabledTiers();
const contextTokens = Number(arg("context-tokens", "0"));
const toolCount = Number(arg("tool-count", "0"));
const concurrency = Math.max(1, Number(arg("concurrency", "4")));
const cutoffs = shippedCutoffs();

const inputFor = (mission) => ({
  prompt: mission.mission,
  contextTokens,
  toolCount,
  cutoffs,
  available,
});

const effectiveTier = (mission, decision) =>
  verdictFor({
    prompt: mission.mission,
    decision,
    current: "balanced",
    available,
    contextTokens,
    hasCache: false,
  }).tier;

async function mapConcurrent(items, worker) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await worker(items[index], index);
      }
    }),
  );
  return output;
}

async function runAppraiser(name, appraise) {
  process.stderr.write(`running ${name} over ${missions.length} missions…\n`);
  const decisions = await mapConcurrent(missions, async (mission) => {
    const decision = await appraise(inputFor(mission));
    return summarizeDecision(mission.id, decision, effectiveTier(mission, decision));
  });
  assertNoFallbacks(name, decisions);
  return {
    name,
    decisions,
    effectiveScore: scoreArm({ name, missions, decisions }),
    rawScore: scoreArm({ name, missions, decisions, tierField: "rawTier" }),
  };
}

function fixedArm(tier) {
  const name = `fixed-${tier}`;
  const decisions = missions.map((mission) =>
    summarizeDecision(mission.id, { choice: tier, confidence: 1, backend: name, ms: 0 }, tier),
  );
  return {
    name,
    decisions,
    effectiveScore: null,
    rawScore: scoreArm({ name, missions, decisions, tierField: "rawTier" }),
  };
}

const arms = [];
arms.push(await runAppraiser("local", local));
arms.push(await runAppraiser("jev", jev));

const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
if (has("include-llm")) {
  if (!authToken) throw new Error("--include-llm requires ANTHROPIC_AUTH_TOKEN");
  const auth = {
    authorization: `${["Be", "arer"].join("")} ${authToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
  };
  arms.push(await runAppraiser("llm", (input) => llm({ ...input, upstream: DELEGATE_ORIGIN, auth })));
}

for (const tier of TIER_ORDER) arms.push(fixedArm(tier));
const scores = arms.map((arm) => arm.effectiveScore).filter(Boolean);
const rawScores = arms.map((arm) => arm.rawScore);
const implementationFiles = [
  import.meta.filename,
  resolve(import.meta.dirname, "router-bakeoff-lib.mjs"),
  resolve(import.meta.dirname, "../src/appraisers/delegate.mjs"),
  resolve(import.meta.dirname, "../src/appraisers/heuristic.mjs"),
  resolve(import.meta.dirname, "../src/appraisers/typesafe.mjs"),
  resolve(import.meta.dirname, "../src/verdict.mjs"),
  resolve(import.meta.dirname, "../src/tuning.mjs"),
  resolve(import.meta.dirname, "../src/ladder.mjs"),
];
const implementationHash = createHash("sha256");
for (const file of implementationFiles) {
  implementationHash.update(file.replace(`${resolve(import.meta.dirname, "..")}\/`, ""));
  implementationHash.update(readFileSync(file));
}
const implementationSha256 = implementationHash.digest("hex");
const artifact = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  corpus: {
    version: corpus.corpus_version,
    frozen: corpus.frozen,
    missions: missions.length,
    holdout: missions.filter((mission) => mission.split === "holdout").length,
    sha256: createHash("sha256").update(corpusBytes).digest("hex"),
  },
  implementationSha256,
  methodology: {
    evidence: "authored-label agreement only; no model execution",
    currentTier: "balanced",
    contextTokens,
    toolCount,
    toolCountLimitation: "fixed CLI input; use --tool-count to match the target harness catalog",
    policyAppliedTo: ["local", "jev", ...(has("include-llm") ? ["llm"] : [])],
    fixedControlsBypassPolicy: true,
    policy: {
      available,
      cutoffs,
      minConfidence: RULES.minConfidence,
      upgradeMinConfidence: RULES.upgradeMinConfidence,
      uncertainCeiling: RULES.uncertainCeiling,
      switchMaxContextTokens: RULES.switchMaxContextTokens,
      cheapWhenUnsure: RULES.cheapWhenUnsure(),
      hasCache: false,
      floor: null,
      platform: "claude",
    },
    armsAreNotRanked: true,
    endpoints: {
      jev: new URL(TYPESAFE_ENDPOINT).origin,
      llm: has("include-llm") ? DELEGATE_ORIGIN : null,
    },
    models: {
      jev: TYPESAFE_MODEL,
      llm: has("include-llm") ? DELEGATE_MODEL : null,
    },
    tierUnits: "relative proxy only: fast=1, balanced=3, strong=15, long=15",
  },
  scores,
  rawScores,
  decisions: Object.fromEntries(arms.map((arm) => [arm.name, arm.decisions])),
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

const lines = [
  "# JEV router bake-off",
  "",
  `Generated: ${artifact.generatedAt}`,
  "",
  "> This is a routing-label screen, not an execution-quality benchmark. The corpus uses frozen",
  "> authored tier labels independent of live router outputs. No model attempted these missions.",
  "",
  `Corpus: ${missions.length} frozen synthetic Lisa missions (${artifact.corpus.holdout} holdout).`,
  "",
  "| arm | raw exact | raw under | policy exact | policy under | policy over | fallback | median latency | holdout tier units* |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
];
const policyByName = new Map(scores.map((score) => [score.name, score]));
for (const raw of rawScores) {
  const score = policyByName.get(raw.name);
  lines.push(
    `| ${raw.name} | ${raw.holdout.exact}/${raw.holdout.n} (${(raw.holdout.exactRate * 100).toFixed(1)}%) | ` +
      `${raw.holdout.under} | ${score ? `${score.holdout.exact}/${score.holdout.n} (${(score.holdout.exactRate * 100).toFixed(1)}%)` : "n/a (pinned)"} | ` +
      `${score ? score.holdout.under : "n/a"} | ${score ? score.holdout.over : "n/a"} | ${raw.fallbacks} | ` +
      `${raw.medianLatencyMs === null ? "n/a" : `${raw.medianLatencyMs} ms`} | ${raw.holdout.tierUnits} |`,
  );
}
lines.push(
  "",
  "\\* Tier units are a relative selection-cost proxy, not billed dollars: fast=1, balanced=3, strong=15, long=15.",
  "",
  "`raw` is the appraiser's answer. `policy` is the effective JEV decision after confidence,",
  "availability, and cache-safety rules. Fixed-tier controls are pinned and intentionally bypass policy.",
  "The arm order is diagnostic, not a ranking.",
  "",
  "Do not change the production default from this result alone. Promote a router only after the",
  "execution oracle confirms verified task success at lower actual cost on an untouched holdout.",
  "",
);
writeFileSync(markdownPath, `${lines.join("\n")}\n`);

process.stdout.write(`${lines.join("\n")}\n\nJSON: ${outputPath}\nMarkdown: ${markdownPath}\n`);
