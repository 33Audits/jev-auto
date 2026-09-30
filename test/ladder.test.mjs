import { test } from "node:test";
import assert from "node:assert/strict";
import { SENTINEL, accountModels, canHold, isSentinel, modelIdFor, heightOf, tierOfModel } from "../src/ladder.mjs";
import { wire } from "../src/wire.mjs";

const retarget = (body, tier, id) => wire.retarget(body, tier, id);

test("older model versions inside a tier are still recognised", () => {
  assert.equal(tierOfModel("claude-sonnet-4-6"), "balanced");
  assert.equal(tierOfModel("claude-opus-4-8"), "strong");
  assert.equal(tierOfModel("claude-haiku-4-5-20251001"), "fast");
  assert.equal(tierOfModel("gpt-9"), null);
  assert.equal(tierOfModel(undefined), null);
});

test("tiers are ordered cheapest first", () => {
  assert.ok(heightOf("fast") < heightOf("balanced"));
  assert.ok(heightOf("balanced") < heightOf("strong"));
});

test("only the sentinel means route this", () => {
  assert.ok(isSentinel(SENTINEL));
  assert.ok(!isSentinel("claude-opus-5"));
});

test("an unknown tier leaves the body alone rather than corrupting it", () => {
  const body = { model: SENTINEL, thinking: { type: "adaptive" } };
  retarget(body, "nonsense");
  assert.equal(body.model, SENTINEL);
  assert.deepEqual(body.thinking, { type: "adaptive" });
});

test("a tier that supports thinking keeps it", () => {
  const body = { thinking: { type: "adaptive" }, output_config: { effort: "high" } };
  retarget(body, "strong");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.output_config.effort, "high");
});

test("the account catalog is preferred, with static ids as the cold-start fallback", () => {
  const empty = accountModels([]);
  assert.ok(empty.length >= 3);
  const live = accountModels([{ id: "claude-sonnet-4-6", display_name: "Sonnet 4.6" }, { id: "gpt-9" }]);
  assert.deepEqual(live.map((m) => m.id), ["claude-sonnet-4-6"]);
  assert.equal(modelIdFor(live, "balanced"), "claude-sonnet-4-6");
  assert.match(modelIdFor(live, "strong"), /opus/, "a tier missing from the catalog falls back to a static id");
});

test("hook system messages are folded into the user turn for tiers that reject them", () => {
  const body = {
    messages: [
      { role: "user", content: "fix it" },
      { role: "system", content: [{ type: "text", text: "hook output" }] },
    ],
  };
  retarget(body, "fast");
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(body.messages[0].content, [{ type: "text", text: "fix it" }, { type: "text", text: "hook output" }]);
});

test("hook output is never silently dropped, even with no user turn to fold it into", () => {
  const body = { messages: [{ role: "system", content: "hook output" }] };
  retarget(body, "fast");
  assert.equal(body.messages[0].role, "user");
  assert.deepEqual(body.messages[0].content, [{ type: "text", text: "hook output" }]);
});

test("tiers that accept system messages keep them untouched", () => {
  const body = { messages: [{ role: "user", content: "fix it" }, { role: "system", content: "hook" }] };
  retarget(body, "strong");
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[1].role, "system");
});

test("a tier that cannot hold the conversation is not a candidate", () => {
  assert.ok(canHold("fast", 100000));
  assert.ok(!canHold("fast", 220000));
  assert.ok(canHold("strong", 220000));
});
