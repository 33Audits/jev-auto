import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoFallbacks,
  markdownPathFor,
  scoreArm,
  summarizeDecision,
} from "../bench/router-bakeoff-lib.mjs";

const missions = [
  { id: "a", split: "calibration", groundTruthTier: "fast" },
  { id: "b", split: "holdout", groundTruthTier: "balanced" },
  { id: "c", split: "holdout", groundTruthTier: "strong" },
  { id: "d", split: "holdout", groundTruthTier: "long" },
];

test("scores exact, under-, and over-routing separately", () => {
  const score = scoreArm({
    name: "candidate",
    missions,
    decisions: [
      { id: "a", effectiveTier: "fast", rawTier: "fast", ms: 10, backend: "jev" },
      { id: "b", effectiveTier: "fast", rawTier: "fast", ms: 20, backend: "jev" },
      { id: "c", effectiveTier: "long", rawTier: "long", ms: 30, backend: "jev" },
      { id: "d", effectiveTier: "long", rawTier: "long", ms: 40, backend: "jev/fallback-local" },
    ],
  });

  assert.equal(score.exact, 2);
  assert.equal(score.under, 1);
  assert.equal(score.over, 1);
  assert.equal(score.exactRate, 0.5);
  assert.equal(score.fallbacks, 1);
  assert.equal(score.medianLatencyMs, 30);
});

test("holdout metrics exclude calibration missions", () => {
  const score = scoreArm({
    name: "candidate",
    missions,
    decisions: [
      { id: "a", effectiveTier: "long", rawTier: "long" },
      { id: "b", effectiveTier: "balanced", rawTier: "balanced" },
      { id: "c", effectiveTier: "strong", rawTier: "strong" },
      { id: "d", effectiveTier: "long", rawTier: "long" },
    ],
  });

  assert.deepEqual(score.holdout, { n: 3, exact: 3, under: 0, over: 0, exactRate: 1, tierUnits: 33 });
});

test("fallback decisions invalidate a benchmark arm", () => {
  assert.doesNotThrow(() => assertNoFallbacks("jev", [{ backend: "jev" }]));
  assert.throws(
    () => assertNoFallbacks("jev", [{ backend: "jev/fallback-local" }]),
    /jev: 1 fallback decision/,
  );
});

test("benchmark output requires a JSON suffix and derives a separate Markdown path", () => {
  assert.equal(markdownPathFor("results/run.json"), "results/run.md");
  assert.throws(() => markdownPathFor("results/run"), /must end in \.json/);
});

test("decision summaries retain only closed-vocabulary routing metadata", () => {
  assert.deepEqual(
    summarizeDecision("m-001", { choice: "strong", confidence: 0.82, backend: "jev", ms: 42 }, "balanced"),
    { id: "m-001", rawTier: "strong", effectiveTier: "balanced", confidence: 0.82, backend: "jev", ms: 42 },
  );
});
