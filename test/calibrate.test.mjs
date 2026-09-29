import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATION, MAX_DRIFT, SHIPPED_CUTOFFS } from "../src/tuning.mjs";
import { problemShapes, cutoffs } from "../src/calibrate.mjs";

const turns = (n, over) =>
  Array.from({ length: n }, () => ({
    t: 1, shape: "hard0/std/files1/mid", tier: "fast", backend: "local",
    score: 0.2, conf: 0.8, verdict: "ok", code: null,
    in: 100, out: 50, cacheRead: 0, cacheWrite: 0, ...over,
  }));

test("with no evidence the shipped boundaries are kept", () => {
  const t = cutoffs([]);
  assert.equal(t.cheap, SHIPPED_CUTOFFS.cheap);
  assert.equal(t.strong, SHIPPED_CUTOFFS.strong);
  assert.equal(t.calibrated, false);
});

test("a handful of turns is not enough evidence to move anything", () => {
  const t = cutoffs(turns(3, { verdict: "escalated", code: "redo" }));
  assert.equal(t.cheap, SHIPPED_CUTOFFS.cheap);
});

test("a tier that keeps getting escalated is given less work", () => {
  const n = CALIBRATION.minTrials + 5;
  const bad = [...turns(n, { verdict: "escalated", code: "redo" })];
  assert.ok(cutoffs(bad).cheap < SHIPPED_CUTOFFS.cheap);
});

test("a tier that never gets escalated is given more work", () => {
  const clean = turns(CALIBRATION.minTrials * 2 + 1, { verdict: "ok" });
  assert.ok(cutoffs(clean).cheap > SHIPPED_CUTOFFS.cheap);
});

test("no amount of evidence moves a boundary further than the drift cap", () => {
  const clean = turns(5000, { verdict: "ok" });
  const t = cutoffs(clean);
  assert.ok(Math.abs(t.cheap - SHIPPED_CUTOFFS.cheap) <= MAX_DRIFT + 1e-9);
});

test("the boundaries stay ordered with room between them", () => {
  const t = cutoffs([
    ...turns(200, { tier: "fast", verdict: "ok" }),
    ...turns(200, { tier: "balanced", verdict: "escalated", code: "redo" }),
  ]);
  assert.ok(t.strong - t.cheap >= 0.1 - 1e-9);
});

test("pinned boundaries are a decision, not a starting point", (t) => {
  process.env.JEV_THRESHOLDS = "0.4,0.7";
  t.after(() => delete process.env.JEV_THRESHOLDS);
  const out = cutoffs(turns(500, { verdict: "ok" }));
  assert.deepEqual([out.cheap, out.strong], [0.4, 0.7]);
  assert.equal(out.calibrated, false);
});

test("calibration can be switched off while measurement continues", (t) => {
  process.env.JEV_NO_CALIBRATION = "1";
  t.after(() => delete process.env.JEV_NO_CALIBRATION);
  assert.equal(cutoffs(turns(500, { verdict: "ok" })).cheap, SHIPPED_CUTOFFS.cheap);
});

test("request shapes that keep failing are reported, not acted on", () => {
  const records = turns(CALIBRATION.minTrials, { shape: "hard1/std/files2/long", verdict: "escalated", code: "redo" });
  const problems = problemShapes(records);
  assert.equal(problems[0].shape, "hard1/std/files2/long");
  assert.ok(problems[0].escalationRate > CALIBRATION.tooCheapRate);
});

test("every run explains itself", () => {
  assert.ok(cutoffs([]).notes.length > 0);
});
