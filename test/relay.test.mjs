import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "../src/relay.mjs";
import { SENTINEL } from "../src/ladder.mjs";
import { fakeUpstream, post } from "./stub-api.mjs";

const SESSION = { user_id: JSON.stringify({ session_id: "test-session" }) };

const turn = (text, over = {}) => ({
  model: SENTINEL,
  metadata: SESSION,
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: text }],
  ...over,
});

/**
 * A real conversation: history accumulates and the first message never changes, which is
 * what makes every turn belong to the same conversation. `texts` are the user turns.
 */
const convo = (texts, over = {}) => {
  const messages = [];
  for (const [i, text] of texts.entries()) {
    if (i) messages.push({ role: "assistant", content: "..." });
    messages.push({ role: "user", content: text });
  }
  return turn(texts[0], { ...over, messages });
};

/** Boot a proxy with a stub router and a captured ledger. */
async function harness({ choice = "haiku", confidence = 0.9, status = 200, usage } = {}) {
  const up = await fakeUpstream({ status, usage });
  const calls = [];
  const ledger = [];
  const proxy = await startRelay({
    upstreamURL: up.url,
    appraise: async (input) => {
      calls.push(input);
      return { choice, confidence, metrics: {}, score: 0.2, shape: "test/shape", backend: "stub", ms: 0 };
    },
    ledger: (r) => ledger.push(r),
  });
  const base = `http://127.0.0.1:${proxy.port}`;
  return { up, base, calls, ledger, proxy, stop: () => (proxy.close(), up.close()) };
}

test("the sentinel is rewritten to the routed model before it leaves the machine", async (t) => {
  const h = await harness({ choice: "haiku" });
  t.after(h.stop);
  await post(h.base, turn("rename the thing"));
  const sent = h.up.seen.at(-1).body;
  assert.notEqual(sent.model, SENTINEL);
  assert.match(sent.model, /haiku/);
});

test("fields the routed tier cannot accept are removed, not forwarded", async (t) => {
  const h = await harness({ choice: "haiku" });
  t.after(h.stop);
  await post(h.base, turn("rename the thing", {
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    context_management: { edits: [{ type: "clear_thinking_20250101" }] },
  }));
  const sent = h.up.seen.at(-1).body;
  assert.equal(sent.thinking, undefined);
  assert.equal(sent.output_config, undefined);
  assert.equal(sent.context_management, undefined);
});

test("a model the user picked is passed through untouched and pauses routing", async (t) => {
  const h = await harness();
  t.after(h.stop);
  await post(h.base, turn("anything", { model: "claude-opus-5" }));
  assert.equal(h.up.seen.at(-1).body.model, "claude-opus-5");
  assert.equal(h.calls.length, 0, "the router is not consulted for an explicit choice");
});

test("the tier chosen for a turn is reused by the tool loop, not re-decided", async (t) => {
  const h = await harness({ choice: "haiku" });
  t.after(h.stop);
  await post(h.base, turn("do the thing"));
  await post(h.base, turn("", {
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] },
    ],
  }));
  assert.equal(h.calls.length, 1, "one routing decision per user turn");
  assert.match(h.up.seen.at(-1).body.model, /haiku/, "the continuation still runs on the turn's tier");
});

test("the authorization headers are forwarded unread and unmodified", async (t) => {
  const h = await harness();
  t.after(h.stop);
  await post(h.base, turn("hello"), { authorization: "Bearer secret-token", "anthropic-version": "2023-06-01" });
  const headers = h.up.seen.at(-1).headers;
  assert.equal(headers.authorization, "Bearer secret-token");
  assert.equal(headers["anthropic-version"], "2023-06-01");
});

test("a finished turn is recorded once the next turn starts", async (t) => {
  const h = await harness();
  t.after(h.stop);
  await post(h.base, convo(["first"]));
  assert.equal(h.ledger.length, 0, "nothing is graded until there is evidence");
  await post(h.base, convo(["first", "now add the tests"]));
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].verdict, "ok");
  assert.equal(h.ledger[0].shape, "test/shape");
});

test("a correction grades the previous turn as escalated and holds the tier up", async (t) => {
  const h = await harness({ choice: "haiku" });
  t.after(h.stop);
  await post(h.base, convo(["first"]));
  await post(h.base, convo(["first", "no, that didn't work"]));
  assert.equal(h.ledger[0].verdict, "escalated");
  assert.equal(h.ledger[0].code, "redo");
  // The router still says haiku; the floor is what moves the request up.
  assert.ok(!/haiku/.test(h.up.seen.at(-1).body.model), "the retry does not run on the tier that just failed");
});

test("switching to a stronger model by hand is recorded as an escalation", async (t) => {
  const h = await harness({ choice: "haiku" });
  t.after(h.stop);
  await post(h.base, convo(["first"]));
  await post(h.base, convo(["first", "same thing but properly"], { model: "claude-opus-5" }));
  assert.equal(h.ledger[0].verdict, "escalated");
  assert.equal(h.ledger[0].code, "manual_escalate");
});

test("an upstream error is recorded against the turn that caused it", async (t) => {
  const h = await harness({ status: 400 });
  t.after(h.stop);
  await post(h.base, turn("first"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.ledger.at(-1)?.code, "api_error");
});

test("token usage is captured from the response", async (t) => {
  const h = await harness({ usage: { input_tokens: 1234, output_tokens: 567, cache_read_input_tokens: 89 } });
  t.after(h.stop);
  await post(h.base, convo(["first"]));
  await post(h.base, convo(["first", "second"]));
  assert.equal(h.ledger[0].in, 1234);
  assert.equal(h.ledger[0].out, 567);
  assert.equal(h.ledger[0].cacheRead, 89);
});

test("a router that throws does not block the request", async (t) => {
  const up = await fakeUpstream();
  const proxy = await startRelay({
    upstreamURL: up.url,
    appraise: async () => {
      throw new Error("router exploded");
    },
    ledger: () => {},
  });
  t.after(() => (proxy.close(), up.close()));
  const res = await post(`http://127.0.0.1:${proxy.port}`, turn("hello"));
  assert.equal(res.status, 200);
  assert.notEqual(up.seen.at(-1).body.model, SENTINEL, "the sentinel is still resolved to a real model");
});

test("an unreachable upstream returns an error, not a hang", async (t) => {
  const proxy = await startRelay({ upstreamURL: "http://127.0.0.1:1", appraise: async () => null, ledger: () => {} });
  t.after(proxy.close);
  const res = await post(`http://127.0.0.1:${proxy.port}`, turn("hello"));
  assert.equal(res.status, 502);
});

test("the base-URL probe is answered", async (t) => {
  const h = await harness();
  t.after(h.stop);
  assert.equal((await fetch(h.base, { method: "HEAD" })).status, 200);
});

test("the account's own model catalog is used once it is fetched", async (t) => {
  const h = await harness({ choice: "sonnet" });
  t.after(h.stop);
  await fetch(`${h.base}/v1/models`);
  await post(h.base, turn("implement the thing"));
  assert.equal(h.up.seen.at(-1).body.model, "claude-sonnet-5");
});

test("open turns are flushed when the session ends", async (t) => {
  const h = await harness();
  t.after(h.up.close);
  await post(h.base, turn("only turn"));
  h.proxy.close();
  assert.equal(h.ledger.length, 1);
});

test("a synchronous router works, and so does one that throws synchronously", async (t) => {
  const up = await fakeUpstream();
  const ledger = [];
  const sync = await startRelay({
    upstreamURL: up.url,
    appraise: () => ({ choice: "haiku", confidence: 0.9, metrics: {}, score: 0.1, shape: "b", backend: "sync" }),
    ledger: (r) => ledger.push(r),
  });
  const boom = await startRelay({
    upstreamURL: up.url,
    appraise: () => {
      throw new Error("sync explosion");
    },
    ledger: () => {},
  });
  t.after(() => (sync.close(), boom.close(), up.close()));

  await post(`http://127.0.0.1:${sync.port}`, turn("rename it"));
  assert.match(up.seen.at(-1).body.model, /haiku/);

  const res = await post(`http://127.0.0.1:${boom.port}`, turn("rename it"));
  assert.equal(res.status, 200);
  assert.notEqual(up.seen.at(-1).body.model, SENTINEL);
});
