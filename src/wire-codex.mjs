// OpenAI Responses, as Codex sends it.
//
// The second adapter behind the same interface as wire.mjs. Shape confirmed by capturing a
// real `codex exec` session against a loopback proxy, not inferred:
//
//   POST /responses  { model, instructions, input[], tools[], reasoning, stream,
//                      prompt_cache_key, include, client_metadata }
//   GET  /models?client_version=…   -> { models: [{ id, display_name, context_window }] }
//
// `input` is a flat list of `{type:"message", role, content:[{type:"input_text", text}]}`
// plus `function_call` / `function_call_output` items once a turn is under way. Tools are
// top level in this version, not nested inside `input`.
import { meterFrom, readsAsRetry } from "./wire.mjs";
import { rungFor } from "./ladder.mjs";

const textOf = (item) =>
  (Array.isArray(item?.content) ? item.content : [])
    .filter((b) => b?.type === "input_text" || b?.type === "output_text" || b?.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");

export const wire = {
  platform: "codex",
  // The ChatGPT backend Codex talks to when signed in with an account rather than a key.
  upstream: "https://chatgpt.com/backend-api/codex",

  isTurnCall: (url) => /^\/responses/.test(url ?? ""),
  isCatalogCall: (method, url) => method === "GET" && /^\/models(?:\?|$)/.test(url ?? ""),
  parseCatalog: (text) => {
    const d = JSON.parse(text);
    return Array.isArray(d) ? d : (d.models ?? d.data ?? []);
  },
  modelOf: (body) => body?.model,

  /**
   * The text of a genuinely new user turn, or null.
   *
   * Codex accumulates the whole conversation in `input`, so a tool-loop continuation is the
   * same shape as a fresh turn except that the tail is a `function_call_output`. Codex also
   * front-loads `developer` instructions and an AGENTS.md block as their own items; taking
   * the last user message alone skips both, which is what an appraiser should see.
   */
  freshTurnText(body) {
    const input = body?.input;
    if (!Array.isArray(input) || !input.length) return null;
    const last = input.findLast(
      (i) => i?.type === "function_call" || i?.type === "function_call_output" || i?.type === "message",
    );
    if (!last || last.type !== "message" || last.role !== "user") return null; // mid-turn
    return textOf(last).trim() || null;
  },

  /** Codex stamps its session id on every request of a conversation. */
  sessionIdOf: (body) => body?.prompt_cache_key ?? "",

  /**
   * `prompt_cache_key` is the session id and is already stable for the life of a
   * conversation, so unlike Claude Code nothing has to be hashed to identify a thread.
   */
  threadKey(body) {
    return this?.sessionIdOf ? this.sessionIdOf(body) || "codex" : (body?.prompt_cache_key ?? "codex");
  },

  /** Instructions plus the whole input list plus tool definitions, at the measured ratio. */
  weighRequest: (body) =>
    Math.round(JSON.stringify([body?.instructions ?? "", body?.input ?? [], body?.tools ?? []]).length / 3.6),

  prepare() {
    // Codex sends plain JSON Schema for its function tools; nothing to normalize.
  },

  /** Point the request at a rung, dropping fields that rung cannot accept. */
  retarget(body, tier, modelId) {
    const rung = rungFor(tier, "codex");
    if (!rung) return body;
    body.model = modelId ?? rung.id;
    if (!rung.think) {
      delete body.reasoning;
      // `include` asks for encrypted reasoning that a non-reasoning rung will not produce.
      if (Array.isArray(body.include)) {
        body.include = body.include.filter((i) => !/reasoning/i.test(i));
        if (!body.include.length) delete body.include;
      }
    }
    return body;
  },

  meterFrom,
};

export { readsAsRetry };
