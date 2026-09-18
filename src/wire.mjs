// Anthropic Messages, as Claude Code sends it.
//
// One of two adapters behind the same interface (see wire-codex.mjs). Everything that knows
// a request's shape lives in an adapter; the relay, the appraisers, the rules, and the
// ledger never look inside a body. That is what makes a second CLI a new file rather than a
// second product.
import { createHash } from "node:crypto";
import { rungFor } from "./ladder.mjs";

/**
 * Claude Code rewrites draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when a custom base URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function normalizeToolSchema(node) {
  if (Array.isArray(node)) return void node.forEach(normalizeToolSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) normalizeToolSchema(v);
}

/**
 * Hooks and plugins append `role: "system"` entries to `messages`. Some rungs reject those
 * outright, so their content is folded into the neighbouring user turn instead — the same
 * place the CLI would have put it. Dropping them would silently discard hook output.
 */
export function absorbSystemTurns(messages) {
  const out = [];
  for (const message of messages) {
    if (message?.role !== "system") {
      out.push(message);
      continue;
    }
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content ?? []).filter((b) => b?.type === "text");
    if (!blocks.length) continue;
    const host = out.findLast?.((m) => m.role === "user");
    if (host) {
      host.content =
        typeof host.content === "string" ? [{ type: "text", text: host.content }] : [...(host.content ?? [])];
      host.content.push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  }
  return out;
}

export const wire = {
  platform: "claude",
  upstream: "https://api.anthropic.com",

  isTurnCall: (url) => /^\/v1\/messages/.test(url ?? ""),
  isCatalogCall: (method, url) => method === "GET" && /^\/v1\/models(?:\?|$)/.test(url ?? ""),
  parseCatalog: (text) => JSON.parse(text).data ?? [],
  modelOf: (body) => body?.model,

  /**
   * The text of a genuinely new user turn, or null.
   *
   * A turn continues across many requests while the model works through tool calls, and
   * those continuations end in a `tool_result` rather than typed text. Routing them would
   * re-decide on every tool call and let the model flip mid-task, so only the opening
   * request counts. Claude Code also injects `<system-reminder>` blocks, which are noise to
   * an appraiser, so they are stripped.
   */
  freshTurnText(body) {
    if (!Array.isArray(body?.tools) || !body.tools.length) return null; // auxiliary call
    // Hooks append their own `system` messages after the user's, so the last element of the
    // array is not reliably the last thing the conversation said.
    const last = body?.messages?.findLast?.((m) => m?.role === "user" || m?.role === "assistant");
    if (last?.role !== "user") return null;
    let text;
    if (typeof last.content === "string") {
      text = last.content;
    } else if (Array.isArray(last.content)) {
      if (last.content.some((b) => b.type === "tool_result")) return null;
      text = last.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    } else {
      return null;
    }
    return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
  },

  /** Session id Claude Code embeds in request metadata (a JSON string), or "". */
  sessionIdOf(body) {
    try {
      return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
    } catch {
      return "";
    }
  },

  /**
   * Which conversation a request belongs to. Sub-agents run through the same endpoint, so a
   * single pinned rung would let a sub-agent's choice leak into the main conversation. Only
   * stable fields may be used: Claude Code moves its `cache_control` breakpoint between
   * requests, so the key is the session id plus the first message's text.
   */
  threadKey(body) {
    const content = body?.messages?.[0]?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((b) => b.type === "text").map((b) => b.text).join("")
          : "";
    return createHash("sha1").update(`${this.sessionIdOf(body)}|${text}`).digest("hex").slice(0, 12);
  },

  /**
   * Everything that counts against the context window: messages, system prompt, tool
   * definitions. Tool schemas alone exceed a hundred thousand tokens with several MCP
   * servers attached, so estimating from `messages` only understates the request badly
   * enough to route into a model that cannot hold it.
   *
   * 3.6 characters per token, not the usual 4: measured against a real session the API
   * counted at 217,865 tokens for 784,816 characters of serialized body.
   */
  weighRequest: (body) =>
    Math.round(JSON.stringify([body?.messages ?? [], body?.system ?? "", body?.tools ?? []]).length / 3.6),

  prepare(body) {
    body.tools?.forEach((t) => normalizeToolSchema(t.input_schema));
  },

  /** Point the request at a rung, dropping fields that rung cannot accept. */
  retarget(body, tier, modelId) {
    const rung = rungFor(tier, "claude");
    if (!rung) return body;
    body.model = modelId ?? rung.id;
    if (!rung.think) {
      delete body.thinking;
      // A context strategy that prunes thinking blocks is itself rejected once thinking is
      // gone, so it has to go with it.
      const edits = body.context_management?.edits;
      if (Array.isArray(edits)) {
        body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
        if (!body.context_management.edits.length) delete body.context_management;
      }
    }
    if (!rung.effort && body.output_config) {
      delete body.output_config.effort;
      if (!Object.keys(body.output_config).length) delete body.output_config;
    }
    if (!rung.system && Array.isArray(body.messages)) body.messages = absorbSystemTurns(body.messages);
    return body;
  },

  meterFrom,
};

/**
 * Token usage from a response. Non-streaming carries one `usage` object; SSE splits it
 * across frames. Both are found by scanning for the field names, which survives either
 * shape and is shared by both platforms.
 *
 * ponytail: regex rather than a full SSE parser — usage fields are flat integers and appear
 * once each. Parse properly if this ever needs per-block deltas.
 */
export function meterFrom(text) {
  const pick = (field) => {
    const m = new RegExp(`"${field}"\\s*:\\s*(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    in: pick("input_tokens"),
    out: pick("output_tokens"),
    cacheRead: pick("cache_read_input_tokens"),
    cacheWrite: pick("cache_creation_input_tokens"),
  };
}

/** Prompts that say the previous turn did not land. Ground truth for the ledger. */
const RETRY = [
  /^\s*(no|nope|wrong|incorrect)\b/i,
  /\bthat'?s (wrong|not right|not what)\b/i,
  /\b(didn'?t|does ?n'?t|still (does ?n'?t)?) ?(work|help|compile|pass)\b/i,
  /\bstill (fail|failing|broken|erroring|the same)\b/i,
  /\bsame (error|issue|problem)\b/i,
  /\b(revert|undo) (that|it|your)\b/i,
  /\byou (missed|forgot|broke|misunderstood)\b/i,
  /\btry again\b/i,
];

export const readsAsRetry = (prompt) => RETRY.some((re) => re.test(prompt ?? ""));
