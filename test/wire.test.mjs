import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weighRequest, threadKey, readsAsRetry, freshTurnText, normalizeToolSchema, sessionIdOf, meterFrom,
} from "../src/wire.mjs";

const agentTurn = (content) => ({ tools: [{ name: "Read" }], messages: [{ role: "user", content }] });

test("a fresh typed turn is routable", () => {
  assert.equal(freshTurnText(agentTurn("fix the parser")), "fix the parser");
  assert.equal(freshTurnText(agentTurn([{ type: "text", text: "fix the parser" }])), "fix the parser");
});

test("a tool-loop continuation is not a new turn", () => {
  const body = agentTurn([{ type: "tool_result", tool_use_id: "x", content: "ok" }]);
  assert.equal(freshTurnText(body), null);
});

test("an auxiliary call with no tools is not a turn", () => {
  assert.equal(freshTurnText({ tools: [], messages: [{ role: "user", content: "summarise" }] }), null);
});

test("injected system reminders are not part of the prompt", () => {
  const body = agentTurn("<system-reminder>lots of noise</system-reminder>\nfix the parser");
  assert.equal(freshTurnText(body), "fix the parser");
});

test("a turn that is only a system reminder is not a turn", () => {
  assert.equal(freshTurnText(agentTurn("<system-reminder>noise</system-reminder>")), null);
});

test("draft-04 boolean exclusive bounds are converted, not passed through", () => {
  const schema = { properties: { n: { type: "number", minimum: 0, exclusiveMinimum: true } } };
  normalizeToolSchema(schema);
  assert.deepEqual(schema.properties.n, { type: "number", exclusiveMinimum: 0 });

  const off = { properties: { n: { minimum: 0, exclusiveMinimum: false } } };
  normalizeToolSchema(off);
  assert.deepEqual(off.properties.n, { minimum: 0 });
});

test("sanitising reaches nested schemas and arrays", () => {
  const schema = { items: [{ properties: { n: { maximum: 5, exclusiveMaximum: true } } }] };
  normalizeToolSchema(schema);
  assert.equal(schema.items[0].properties.n.exclusiveMaximum, 5);
});

test("sub-agents are separate conversations from the main one", () => {
  const meta = { user_id: JSON.stringify({ session_id: "s1" }) };
  const main = { metadata: meta, messages: [{ role: "user", content: "main task" }] };
  const sub = { metadata: meta, messages: [{ role: "user", content: "sub task" }] };
  assert.notEqual(threadKey(main), threadKey(sub));
});

test("the conversation key survives the fields Claude Code rewrites between requests", () => {
  const meta = { user_id: JSON.stringify({ session_id: "s1" }) };
  const first = { metadata: meta, messages: [{ role: "user", content: "task" }] };
  const later = {
    metadata: meta,
    messages: [{ role: "user", content: "task", cache_control: { type: "ephemeral" } }, { role: "assistant", content: "..." }],
  };
  assert.equal(threadKey(first), threadKey(later));
});

test("a missing or malformed session id is not fatal", () => {
  assert.equal(sessionIdOf({}), "");
  assert.equal(sessionIdOf({ metadata: { user_id: "not json" } }), "");
  assert.equal(sessionIdOf({ metadata: { user_id: JSON.stringify({ session_id: "abc" }) } }), "abc");
});

test("corrections are recognised as the previous turn having missed", () => {
  for (const p of ["no, that's wrong", "that didn't work", "still failing", "try again", "revert that"]) {
    assert.ok(readsAsRetry(p), p);
  }
  for (const p of ["now add the tests", "looks good, ship it", "next, wire up the CLI"]) {
    assert.ok(!readsAsRetry(p), p);
  }
});

test("usage is read from both response shapes", () => {
  const plain = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 } });
  assert.deepEqual(meterFrom(plain), { in: 10, out: 20, cacheRead: 5, cacheWrite: 0 });

  const sse = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":7,"cache_creation_input_tokens":3}}}\n';
  assert.equal(meterFrom(sse).in, 7);
  assert.equal(meterFrom(sse).cacheWrite, 3);
});

test("the estimate counts the tool definitions, not just the messages", () => {
  const messagesOnly = { messages: [{ role: "user", content: "x".repeat(400) }] };
  const withTools = { ...messagesOnly, tools: [{ name: "Read", input_schema: { type: "object", x: "y".repeat(4000) } }] };
  assert.ok(weighRequest(messagesOnly) > 50);
  assert.ok(weighRequest(withTools) > weighRequest(messagesOnly) + 500, "tool schemas dominate a real request");
  assert.ok(Number.isFinite(weighRequest({})));
});

test("a system message appended by a hook does not hide the user's turn", () => {
  const body = {
    tools: [{ name: "Read" }],
    messages: [
      { role: "user", content: "fix the parser" },
      { role: "system", content: [{ type: "text", text: "hook output" }] },
    ],
  };
  assert.equal(freshTurnText(body), "fix the parser");
});

test("a hook message after a tool result is still not a new turn", () => {
  const body = {
    tools: [{ name: "Read" }],
    messages: [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
      { role: "system", content: "hook output" },
    ],
  };
  assert.equal(freshTurnText(body), null);
});
