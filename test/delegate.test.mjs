import test from "node:test";
import assert from "node:assert/strict";
import { appraise, DELEGATE_ORIGIN } from "../src/appraisers/delegate.mjs";

const input = {
  prompt: "fix a typo",
  contextTokens: 0,
  toolCount: 0,
  cutoffs: { cheap: 0.28, strong: 0.58 },
  upstream: DELEGATE_ORIGIN,
  auth: { authorization: "Bearer test" },
};

test("maps the model-family words requested by the classifier onto JEV tiers", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  for (const [answer, expected] of [
    ["haiku", "fast"],
    ["sonnet", "balanced"],
    ["opus", "strong"],
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: answer }] }),
    });
    const decision = await appraise(input);
    assert.equal(decision.backend, "llm");
    assert.equal(decision.choice, expected);
  }
});

test("rejects explanatory or multi-tier responses instead of misrouting", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ type: "text", text: "not haiku; use sonnet" }] }),
  });

  const decision = await appraise(input);
  assert.equal(decision.backend, "llm/fallback-local");
});

test("never forwards credentials to a non-Anthropic upstream", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("must not call");
  };

  const decision = await appraise({ ...input, upstream: "http://127.0.0.1:9999" });
  assert.equal(called, false);
  assert.equal(decision.backend, "llm/fallback-local");
});
