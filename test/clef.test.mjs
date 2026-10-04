import { test } from "node:test";
import assert from "node:assert/strict";
import { appraise } from "../src/appraisers/clef.mjs";

const saved = {
  url: process.env.BIZZY_DECISION_URL,
  token: process.env.BIZZY_API_TOKEN,
  fetch: globalThis.fetch,
};

test.afterEach(() => {
  if (saved.url === undefined) delete process.env.BIZZY_DECISION_URL;
  else process.env.BIZZY_DECISION_URL = saved.url;
  if (saved.token === undefined) delete process.env.BIZZY_API_TOKEN;
  else process.env.BIZZY_API_TOKEN = saved.token;
  globalThis.fetch = saved.fetch;
});

test("Clef receives content-free routing features and returns a tier", async () => {
  process.env.BIZZY_DECISION_URL = "https://clef.test/decide";
  process.env.BIZZY_API_TOKEN = "test-token";
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ choice: "balanced", confidence: 0.91, reasonCodes: ["bounded"], policyVersion: "p1" }) };
  };

  const result = await appraise({
    prompt: "do not send this prompt to Clef",
    contextTokens: 1200,
    toolCount: 3,
    available: ["fast", "balanced", "strong"],
  });

  assert.equal(result.choice, "balanced");
  assert.equal(result.backend, "clef");
  assert.equal(request.url, "https://clef.test/decide");
  assert.equal(request.options.headers.authorization, "Bearer test-token");
  assert.equal(request.body.version, 1);
  assert.equal(request.body.features.contextTokens, 1200);
  assert.equal(request.body.features.toolCount, 3);
  assert.equal("prompt" in request.body, false);
  assert.equal(JSON.stringify(request.body).includes("do not send this prompt"), false);
});

test("Clef transport failure fails open to the local appraiser", async () => {
  process.env.BIZZY_DECISION_URL = "https://clef.test/decide";
  process.env.BIZZY_API_TOKEN = "test-token";
  globalThis.fetch = async () => { throw new Error("offline"); };
  const result = await appraise({ prompt: "run the tests" });
  assert.equal(result.choice, "fast");
  assert.equal(result.backend, "clef/fallback-local");
});
