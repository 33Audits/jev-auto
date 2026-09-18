// Everything that knows the shape of a Claude Code request. Isolated here because that
// shape is undocumented and moves: when it changes, this is the only file that is wrong.
import { createHash } from "node:crypto";

/**
 * Claude Code rewrites draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
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
 * The text of a genuinely new user turn, or null.
 *
 * A turn continues across many requests while the model works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-verdictFor
 * on every tool call and let the model flip mid-task, so only the opening request counts.
 * Claude Code also injects `<system-reminder>` blocks into the user message, which are noise
 * to a router and measurably distort the signal, so they are stripped.
 */
export function freshTurnText(body) {
  if (!Array.isArray(body?.tools) || !body.tools.length) return null; // auxiliary call
  // Hooks and plugins append their own `system` messages after the user's, so the last
  // message in the array is not reliably the last thing the conversation actually said.
  // Only user and assistant turns are part of that sequence.
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
}

/** Session id Claude Code embeds in request metadata (a JSON string), or "". */
export function sessionIdOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Identifies the conversation a request belongs to. Sub-agents run through the same
 * endpoint, so a single pinned tier would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used: Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is the session id plus the text of the
 * first message, which is fixed once a conversation starts and differs per sub-agent.
 */
export function threadKey(body) {
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b.type === "text").map((b) => b.text).join("")
        : "";
  return createHash("sha1").update(`${sessionIdOf(body)}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Rough size of everything that counts against the context window: messages, the system
 * prompt, and the tool definitions. Tool schemas alone are over a hundred thousand tokens in
 * a Claude Code session with several MCP servers attached, so estimating from `messages`
 * only understates the request badly enough to route into a model that cannot hold it.
 *
 * 3.6 characters per token, not the usual 4: measured against a real session the API counted
 * at 217,865 tokens for 784,816 characters of serialized body. The remaining error is
 * absorbed by the 10% headroom in `canHold`.
 */
export const weighRequest = (body) =>
  Math.round(JSON.stringify([body?.messages ?? [], body?.system ?? "", body?.tools ?? []]).length / 3.6);

/** Prompts that say the previous turn did not land. Ground truth for the ledger. */
const CORRECTION = [
  /^\s*(no|nope|wrong|incorrect)\b/i,
  /\bthat'?s (wrong|not right|not what)\b/i,
  /\b(didn'?t|does ?n'?t|still (does ?n'?t)?) ?(work|help|compile|pass)\b/i,
  /\bstill (fail|failing|broken|erroring|the same)\b/i,
  /\bsame (error|issue|problem)\b/i,
  /\b(revert|undo) (that|it|your)\b/i,
  /\byou (missed|forgot|broke|misunderstood)\b/i,
  /\btry again\b/i,
];

export const readsAsRetry = (prompt) => CORRECTION.some((re) => re.test(prompt ?? ""));

/**
 * Token usage from a response. Non-streaming responses carry one `usage` object; SSE
 * streams split it across `message_start` and `message_delta`. Both are found by scanning
 * for the field names, which survives either shape.
 *
 * ponytail: regex over the first frames rather than a full SSE parser — usage fields are
 * flat integers and appear once each. Parse properly if this ever needs deltas per block.
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
