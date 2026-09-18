import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, signals, factorsOf, appraise, difficultyOf } from "../src/appraisers/heuristic.mjs";

const at = (prompt, extra = {}) => appraise({ prompt, ...extra }).choice;

test("mechanical work goes to the cheapest tier", () => {
  for (const p of [
    "rename the foo variable to bar",
    "run the tests",
    "fix the typo in the README",
    "what does this function return?",
    "reformat src/app.ts",
  ]) {
    assert.equal(at(p), "haiku", p);
  }
});

test("ordinary bounded engineering goes to the middle tier", () => {
  for (const p of [
    "add a test for parseConfig in src/config.ts",
    "implement the retry helper with exponential backoff",
    "fix the off-by-one in the pagination cursor",
  ]) {
    assert.equal(at(p), "sonnet", p);
  }
});

test("ambiguity, debugging, and blast radius go to the strongest tier", () => {
  for (const p of [
    "why does the withdrawal path intermittently revert under concurrent liquidations across the vault and router modules?",
    "investigate the flaky CI failure in test/e2e and figure out the root cause",
    "design the migration from the single-tenant schema to per-tenant databases including the rollback plan",
  ]) {
    assert.equal(at(p), "opus", p);
  }
});

test("stem words are matched, not just exact forms", () => {
  assert.ok(signals("this is intermittently failing under concurrent load").hard >= 2);
  assert.ok(signals("we should investigate the migrations").hard >= 1);
});

test("difficulty is monotonic in the signals", () => {
  const base = signals("update the handler");
  const harder = signals("debug why the handler deadlocks under concurrent writes");
  assert.ok(difficultyOf(factorsOf(harder)) > difficultyOf(factorsOf(base)));
});

test("a bigger conversation never scores lower", () => {
  const small = appraise({ prompt: "update the handler", contextTokens: 0 });
  const large = appraise({ prompt: "update the handler", contextTokens: 150000 });
  assert.ok(large.score >= small.score);
});

test("metrics stay inside 0..1", () => {
  const extreme = signals(`${"security migration deadlock refactor ".repeat(50)}\n\`\`\`${"x".repeat(5000)}\`\`\``);
  for (const v of Object.values(factorsOf({ ...extreme, contextTokens: 1e9 }))) {
    assert.ok(v >= 0 && v <= 1, `${v} out of range`);
  }
});

test("the shape is content-free and stable across different wording", () => {
  const a = shapeOf(signals("rename the widget in src/a.ts"));
  const b = shapeOf(signals("rename the gadget in src/b.ts"));
  assert.equal(a, b);
  assert.ok(!/widget|gadget|src/.test(a), a);
});

test("confidence is highest far from a boundary", () => {
  const clear = appraise({ prompt: "run the tests" });
  const borderline = appraise({ prompt: "add a test for parseConfig in src/config.ts" });
  assert.ok(clear.confidence > borderline.confidence);
});

test("moving a boundary moves the decision", () => {
  const prompt = "add a test for parseConfig in src/config.ts";
  assert.equal(appraise({ prompt, cutoffs: { cheap: 0.28, strong: 0.58 } }).choice, "sonnet");
  assert.equal(appraise({ prompt, cutoffs: { cheap: 0.5, strong: 0.8 } }).choice, "haiku");
});

test("an empty prompt does not throw", () => {
  for (const p of [undefined, null, "", "   "]) assert.ok(appraise({ prompt: p }).choice);
});
