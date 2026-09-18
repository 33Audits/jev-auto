import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictFor, explicitRequest } from "../src/verdict.mjs";

const ALL = ["fast", "balanced", "strong"];
const routed = (choice, confidence = 0.9) => ({ choice, confidence });

test("an explicit request in the prompt wins", () => {
  assert.equal(explicitRequest("use opus for this"), "strong");
  assert.equal(explicitRequest("switch to haiku"), "fast");
  assert.equal(explicitRequest("nothing here"), null);
  const d = verdictFor({ prompt: "use haiku", decision: routed("strong"), current: "balanced", available: ALL });
  assert.equal(d.tier, "fast");
  assert.equal(d.reason, "override");
});

test("a router failure holds the current tier", () => {
  const d = verdictFor({ prompt: "x", decision: null, current: "balanced", available: ALL });
  assert.equal(d.tier, "balanced");
  assert.equal(d.changed, false);
  assert.match(d.reason, /router-unavailable/);
});

test("a nonsense answer holds the current tier", () => {
  const d = verdictFor({ prompt: "x", decision: routed("gpt-9"), current: "strong", available: ALL });
  assert.equal(d.tier, "strong");
});

test("low confidence never downgrades", () => {
  const d = verdictFor({ prompt: "x", decision: routed("fast", 0.1), current: "strong", available: ALL });
  assert.equal(d.tier, "strong");
  assert.match(d.reason, /low-confidence-no-downgrade/);
});

test("low confidence caps an upgrade at the safe tier", () => {
  const d = verdictFor({ prompt: "x", decision: routed("strong", 0.1), current: "fast", available: ALL });
  assert.equal(d.tier, "balanced");
  assert.match(d.reason, /low-confidence-capped/);
});

test("any switch is refused once the prompt cache is worth more than it saves", () => {
  const cheap = verdictFor({ prompt: "x", decision: routed("fast"), current: "strong", available: ALL, contextTokens: 1000, hasCache: true });
  assert.equal(cheap.tier, "fast");
  const expensive = verdictFor({ prompt: "x", decision: routed("fast"), current: "strong", available: ALL, contextTokens: 120000, hasCache: true });
  assert.equal(expensive.tier, "strong");
  assert.match(expensive.reason, /cache-rebuild/);

  // Upgrades thrash the cache exactly as hard as downgrades do.
  const up = verdictFor({ prompt: "x", decision: routed("strong", 0.99), current: "fast", available: ALL, contextTokens: 120000, hasCache: true });
  assert.equal(up.tier, "fast", "a confident upgrade still loses to the cache it would discard");
  assert.match(up.reason, /cache-rebuild/);
});

test("the first turn is freely routable: a big context with no cache is not a cache to protect", () => {
  const d = verdictFor({ prompt: "x", decision: routed("fast"), current: "strong", available: ALL, contextTokens: 120000 });
  assert.equal(d.tier, "fast", "a large system prompt is not the same thing as a cache built on a model");
});

test("an unavailable tier steps up, never silently down", () => {
  const d = verdictFor({ prompt: "x", decision: routed("fast"), current: "strong", available: ["balanced", "strong"] });
  assert.equal(d.tier, "balanced");
  assert.match(d.reason, /unavailable/);
});

test("fable is never stepped up into unless it was asked for", () => {
  const d = verdictFor({ prompt: "x", decision: routed("strong"), current: "fast", available: ["fast", "long"] });
  assert.equal(d.tier, "fast");
});

test("an escalation floor holds the tier up for later turns", () => {
  const d = verdictFor({ prompt: "x", decision: routed("fast"), current: "fast", available: ALL, floor: "strong" });
  assert.equal(d.tier, "strong");
  assert.match(d.reason, /escalation-floor/);
});

test("the user still outranks an escalation floor", () => {
  const d = verdictFor({ prompt: "use haiku", decision: routed("strong"), current: "strong", available: ALL, floor: "strong" });
  assert.equal(d.tier, "fast");
});

test("the decision is total: garbage in, a runnable tier out", () => {
  for (const decision of [undefined, null, {}, { choice: null }, { choice: "strong" }]) {
    const d = verdictFor({ prompt: undefined, decision, current: "balanced", available: ALL });
    assert.ok(ALL.includes(d.tier));
  }
});

test("a conversation too large for a tier never routes there", () => {
  const d = verdictFor({ prompt: "x", decision: routed("fast"), current: "strong", available: ALL, contextTokens: 220000 });
  assert.notEqual(d.tier, "fast");
  assert.match(d.reason, /context-too-large/);
});

test("an explicit request still cannot pick a tier that cannot hold the request", () => {
  const d = verdictFor({ prompt: "use haiku", decision: routed("strong"), current: "strong", available: ALL, contextTokens: 220000 });
  assert.notEqual(d.tier, "fast");
});

// Climbing a rung costs ~5x what descending saves, so the directions need different evidence.
// Measured over 300 real prompts: 15% of turns routed up were 63% of spend.
test("routing up requires near-certainty; routing down does not", () => {
  const up = verdictFor({ prompt: "x", decision: routed("strong", 0.7), current: "balanced", available: ALL });
  assert.equal(up.tier, "balanced", "an unsure upgrade is refused");
  assert.match(up.reason, /upgrade-needs-certainty/);

  const sure = verdictFor({ prompt: "x", decision: routed("strong", 0.95), current: "balanced", available: ALL });
  assert.equal(sure.tier, "strong", "a confident upgrade still goes through");

  const down = verdictFor({ prompt: "x", decision: routed("fast", 0.7), current: "balanced", available: ALL });
  assert.equal(down.tier, "fast", "the same confidence is enough to descend");
});

test("the user can still climb by asking, whatever the confidence", () => {
  const d = verdictFor({ prompt: "use opus", decision: routed("fast", 0.99), current: "fast", available: ALL });
  assert.equal(d.tier, "strong");
});
