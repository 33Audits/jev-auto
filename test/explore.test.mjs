import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLearned, cheaperThan, explorationReport, shouldExplore, verdictForShape } from "../src/explore.mjs";
import { CALIBRATION } from "../src/tuning.mjs";

const trials = (n, over = {}) =>
  Array.from({ length: n }, () => ({
    explored: true, shape: "hard0/std/files1/mid", tier: "fast", verdict: "ok",
    t: 1, backend: "jev", platform: "claude", in: 0, out: 0, cacheRead: 0, cacheWrite: 0, ...over,
  }));

test("the cheaper rung is one step down, and nothing below the floor", () => {
  assert.equal(cheaperThan("strong"), "balanced");
  assert.equal(cheaperThan("balanced"), "fast");
  assert.equal(cheaperThan("fast"), null);
});

test("exploration happens sometimes, and not always", () => {
  const args = { tier: "balanced", shape: "s", contextTokens: 1000, floor: null, records: [] };
  assert.equal(shouldExplore({ ...args, rng: () => 0.01 }), true);
  assert.equal(shouldExplore({ ...args, rng: () => 0.99 }), false);
});

test("never explores against a conversation that already escalated", () => {
  assert.equal(
    shouldExplore({ tier: "balanced", shape: "s", contextTokens: 1000, floor: "strong", records: [], rng: () => 0 }),
    false,
    "the floor means cheap has already been shown not to work here",
  );
});

test("never explores into a rung that cannot hold the request", () => {
  assert.equal(
    shouldExplore({ tier: "balanced", shape: "s", contextTokens: 900000, floor: null, records: [], rng: () => 0 }),
    false,
  );
});

test("never explores at the cheapest rung — there is nothing below it", () => {
  assert.equal(
    shouldExplore({ tier: "fast", shape: "s", contextTokens: 1000, floor: null, records: [], rng: () => 0 }),
    false,
  );
});

test("a decided shape is not explored again", () => {
  const settled = trials(CALIBRATION.minTrials);
  assert.equal(
    shouldExplore({ tier: "balanced", shape: "hard0/std/files1/mid", contextTokens: 1000, floor: null, records: settled, rng: () => 0 }),
    false,
    "evidence is in; spending more trials on it is waste",
  );
});

test("a verdict needs enough evidence before it is anything but unknown", () => {
  assert.equal(verdictForShape(trials(3), "hard0/std/files1/mid", "fast"), "unknown");
  assert.equal(verdictForShape(trials(CALIBRATION.minTrials), "hard0/std/files1/mid", "fast"), "sufficient");
});

test("a shape that keeps failing on the cheaper rung is marked insufficient", () => {
  const bad = trials(CALIBRATION.minTrials, { verdict: "escalated", code: "redo" });
  assert.equal(verdictForShape(bad, "hard0/std/files1/mid", "fast"), "insufficient");
});

test("what exploration proved is actually applied — this is the payoff", () => {
  const proven = trials(CALIBRATION.minTrials);
  const args = { tier: "balanced", shape: "hard0/std/files1/mid", contextTokens: 1000, floor: null, records: proven };
  assert.equal(applyLearned(args), "fast", "a shape proven cheap enough is routed cheap by default");
  assert.equal(applyLearned({ ...args, records: [] }), "balanced", "without evidence, the appraiser's call stands");
});

test("a proven-insufficient shape is never demoted", () => {
  const bad = trials(CALIBRATION.minTrials, { verdict: "escalated", code: "redo" });
  assert.equal(
    applyLearned({ tier: "balanced", shape: "hard0/std/files1/mid", contextTokens: 1000, floor: null, records: bad }),
    "balanced",
  );
});

test("an escalation floor outranks anything exploration learned", () => {
  const proven = trials(CALIBRATION.minTrials);
  assert.equal(
    applyLearned({ tier: "balanced", shape: "hard0/std/files1/mid", contextTokens: 1000, floor: "strong", records: proven }),
    "balanced",
  );
});

test("only explored turns count as trials, not ordinary routing", () => {
  // The selection-bias trap this whole module exists to avoid: turns the appraiser already
  // sent to `fast` say nothing about turns it sent to `balanced`.
  const ordinary = trials(100, { explored: false });
  assert.equal(verdictForShape(ordinary, "hard0/std/files1/mid", "fast"), "unknown");
});

test("the report summarises each shape's trials", () => {
  const r = explorationReport(trials(CALIBRATION.minTrials));
  assert.equal(r[0].trials, CALIBRATION.minTrials);
  assert.equal(r[0].verdict, "sufficient");
});

// Exploration is weighted by the appraiser's own uncertainty: a trial buys the most
// information exactly where the appraiser has no opinion, and the status quo there is not a
// better guess than cheaper, only a dearer one.
test("uncertainty raises the exploration rate, certainty lowers it", async () => {
  const { exploreRateFor } = await import("../src/explore.mjs");
  const { RULES } = await import("../src/tuning.mjs");
  const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (${a} vs ${b})`);
  close(exploreRateFor(0.1), RULES.uncertainExploreRate, "no opinion -> explore freely");
  close(exploreRateFor(1), RULES.exploreRate, "certain -> the baseline trickle");
  assert.ok(exploreRateFor(0.5) > exploreRateFor(0.9), "monotonic in confidence");
  assert.ok(exploreRateFor(0.9) >= RULES.exploreRate);
});

test("a missing confidence falls back to the baseline rate, never to certainty", async () => {
  const { exploreRateFor } = await import("../src/explore.mjs");
  const { RULES } = await import("../src/tuning.mjs");
  assert.ok(Math.abs(exploreRateFor(undefined) - RULES.exploreRate) < 1e-9);
  assert.ok(Math.abs(exploreRateFor(NaN) - RULES.exploreRate) < 1e-9);
});

test("an unconfident appraisal explores where a confident one would not", () => {
  const args = { tier: "balanced", shape: "s", contextTokens: 1000, floor: null, records: [] };
  // A draw that sits above the baseline rate but below the uncertain rate.
  const rng = () => 0.4;
  assert.equal(shouldExplore({ ...args, confidence: 0.2, rng }), true);
  assert.equal(shouldExplore({ ...args, confidence: 1.0, rng }), false);
});

test("uncertainty never overrides the floor or a rung that cannot hold the request", () => {
  const rng = () => 0;
  assert.equal(shouldExplore({ tier: "balanced", shape: "s", contextTokens: 1000, floor: "strong", confidence: 0.1, rng }), false);
  assert.equal(shouldExplore({ tier: "balanced", shape: "s", contextTokens: 900000, floor: null, confidence: 0.1, records: [], rng }), false);
});
