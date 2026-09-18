import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictFor, explicitRequest } from "../src/verdict.mjs";

const ALL = ["haiku", "sonnet", "opus"];
const routed = (choice, confidence = 0.9) => ({ choice, confidence });

test("an explicit request in the prompt wins", () => {
  assert.equal(explicitRequest("use opus for this"), "opus");
  assert.equal(explicitRequest("switch to haiku"), "haiku");
  assert.equal(explicitRequest("nothing here"), null);
  const d = verdictFor({ prompt: "use haiku", decision: routed("opus"), current: "sonnet", available: ALL });
  assert.equal(d.tier, "haiku");
  assert.equal(d.reason, "override");
});

test("a router failure holds the current tier", () => {
  const d = verdictFor({ prompt: "x", decision: null, current: "sonnet", available: ALL });
  assert.equal(d.tier, "sonnet");
  assert.equal(d.changed, false);
  assert.match(d.reason, /router-unavailable/);
});

test("a nonsense answer holds the current tier", () => {
  const d = verdictFor({ prompt: "x", decision: routed("gpt-9"), current: "opus", available: ALL });
  assert.equal(d.tier, "opus");
});

test("low confidence never downgrades", () => {
  const d = verdictFor({ prompt: "x", decision: routed("haiku", 0.1), current: "opus", available: ALL });
  assert.equal(d.tier, "opus");
  assert.match(d.reason, /low-confidence-no-downgrade/);
});

test("low confidence caps an upgrade at the safe tier", () => {
  const d = verdictFor({ prompt: "x", decision: routed("opus", 0.1), current: "haiku", available: ALL });
  assert.equal(d.tier, "sonnet");
  assert.match(d.reason, /low-confidence-capped/);
});

test("a downgrade is refused once the prompt cache is worth more than it saves", () => {
  const cheap = verdictFor({ prompt: "x", decision: routed("haiku"), current: "opus", available: ALL, contextTokens: 1000, hasCache: true });
  assert.equal(cheap.tier, "haiku");
  const expensive = verdictFor({ prompt: "x", decision: routed("haiku"), current: "opus", available: ALL, contextTokens: 120000, hasCache: true });
  assert.equal(expensive.tier, "opus");
  assert.match(expensive.reason, /cache-rebuild/);
});

test("the first turn is freely routable: a big context with no cache is not a cache to protect", () => {
  const d = verdictFor({ prompt: "x", decision: routed("haiku"), current: "opus", available: ALL, contextTokens: 120000 });
  assert.equal(d.tier, "haiku", "a large system prompt is not the same thing as a cache built on a model");
});

test("an unavailable tier steps up, never silently down", () => {
  const d = verdictFor({ prompt: "x", decision: routed("haiku"), current: "opus", available: ["sonnet", "opus"] });
  assert.equal(d.tier, "sonnet");
  assert.match(d.reason, /unavailable/);
});

test("fable is never stepped up into unless it was asked for", () => {
  const d = verdictFor({ prompt: "x", decision: routed("opus"), current: "haiku", available: ["haiku", "fable"] });
  assert.equal(d.tier, "haiku");
});

test("an escalation floor holds the tier up for later turns", () => {
  const d = verdictFor({ prompt: "x", decision: routed("haiku"), current: "haiku", available: ALL, floor: "opus" });
  assert.equal(d.tier, "opus");
  assert.match(d.reason, /escalation-floor/);
});

test("the user still outranks an escalation floor", () => {
  const d = verdictFor({ prompt: "use haiku", decision: routed("opus"), current: "opus", available: ALL, floor: "opus" });
  assert.equal(d.tier, "haiku");
});

test("the decision is total: garbage in, a runnable tier out", () => {
  for (const decision of [undefined, null, {}, { choice: null }, { choice: "opus" }]) {
    const d = verdictFor({ prompt: undefined, decision, current: "sonnet", available: ALL });
    assert.ok(ALL.includes(d.tier));
  }
});

test("a conversation too large for a tier never routes there", () => {
  const d = verdictFor({ prompt: "x", decision: routed("haiku"), current: "opus", available: ALL, contextTokens: 220000 });
  assert.notEqual(d.tier, "haiku");
  assert.match(d.reason, /context-too-large/);
});

test("an explicit request still cannot pick a tier that cannot hold the request", () => {
  const d = verdictFor({ prompt: "use haiku", decision: routed("opus"), current: "opus", available: ALL, contextTokens: 220000 });
  assert.notEqual(d.tier, "haiku");
});
