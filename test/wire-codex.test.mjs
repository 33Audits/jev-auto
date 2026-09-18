import { test } from "node:test";
import assert from "node:assert/strict";
import { wire } from "../src/wire-codex.mjs";

// Shaped from a real `codex exec` request captured off the wire (Codex 0.154.0): a developer
// message, an AGENTS.md block, then the prompt — with tools at top level, not inside `input`.
const codexTurn = (prompt, extra = {}) => ({
  model: "jev-auto",
  instructions: "You are Codex…".repeat(50),
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>…" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n…" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
  ],
  tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
  reasoning: { effort: "xhigh", summary: "auto" },
  include: ["reasoning.encrypted_content"],
  stream: true,
  prompt_cache_key: "01a0b639-0e8f-7661-970f-ec102a6175cc",
  ...extra,
});

test("the prompt is the last user message, not the injected preamble", () => {
  assert.equal(wire.freshTurnText(codexTurn("fix the parser")), "fix the parser");
});

test("a tool-loop continuation is not a new turn", () => {
  const body = codexTurn("start");
  body.input.push({ type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" });
  body.input.push({ type: "function_call_output", call_id: "c1", output: "done" });
  assert.equal(wire.freshTurnText(body), null);
});

test("an empty or malformed input is not a turn", () => {
  for (const b of [{}, { input: [] }, { input: "nope" }, { input: [{ type: "message", role: "assistant" }] }]) {
    assert.equal(wire.freshTurnText(b), null);
  }
});

test("Codex stamps a stable session id, so nothing has to be hashed", () => {
  const body = codexTurn("x");
  assert.equal(wire.sessionIdOf(body), "01a0b639-0e8f-7661-970f-ec102a6175cc");
  assert.equal(wire.threadKey(body), wire.sessionIdOf(body));
  // The same conversation later still resolves to the same thread.
  assert.equal(wire.threadKey(codexTurn("a later turn")), wire.threadKey(body));
});

test("different conversations are different threads", () => {
  assert.notEqual(wire.threadKey(codexTurn("x", { prompt_cache_key: "other" })), wire.threadKey(codexTurn("x")));
});

test("the estimate counts instructions and tools, not just the conversation", () => {
  const bare = { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] };
  assert.ok(wire.weighRequest(codexTurn("hi")) > wire.weighRequest(bare) + 100);
});

test("its own endpoints are recognised, and Claude's are not", () => {
  assert.ok(wire.isTurnCall("/responses"));
  assert.ok(!wire.isTurnCall("/v1/messages"));
  assert.ok(wire.isCatalogCall("GET", "/models?client_version=0.154.0"));
  assert.ok(!wire.isCatalogCall("POST", "/models"));
});

test("the catalog parses both shapes the backend returns", () => {
  assert.equal(wire.parseCatalog(JSON.stringify({ models: [{ id: "gpt-5.6-sol" }] }))[0].id, "gpt-5.6-sol");
  assert.equal(wire.parseCatalog(JSON.stringify([{ id: "gpt-5.6-luna" }]))[0].id, "gpt-5.6-luna");
});

test("retargeting names a real model for the rung", () => {
  const body = codexTurn("x");
  wire.retarget(body, "fast");
  assert.equal(body.model, "gpt-5.6-luna");
  wire.retarget(body, "strong");
  assert.equal(body.model, "gpt-5.6-sol");
});

test("an explicit model id wins over the rung default", () => {
  const body = codexTurn("x");
  wire.retarget(body, "balanced", "gpt-5.5");
  assert.equal(body.model, "gpt-5.5");
});

test("usage is read from the Responses stream", () => {
  const sse = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":1234,"output_tokens":56}}}\n';
  assert.equal(wire.meterFrom(sse).in, 1234);
  assert.equal(wire.meterFrom(sse).out, 56);
});

test("the two adapters agree on the interface the relay calls", async () => {
  const { wire: claude } = await import("../src/wire.mjs");
  for (const key of [
    "platform", "upstream", "isTurnCall", "isCatalogCall", "parseCatalog", "modelOf",
    "freshTurnText", "sessionIdOf", "threadKey", "weighRequest", "prepare", "retarget", "meterFrom",
  ]) {
    assert.ok(key in claude, `claude adapter missing ${key}`);
    assert.ok(key in wire, `codex adapter missing ${key}`);
  }
  assert.notEqual(claude.platform, wire.platform);
});
