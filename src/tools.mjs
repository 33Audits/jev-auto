// Ask Jev which toolsets a turn actually needs, and send only those.
//
// This is Jev replacing work rather than choosing who does the work, which is where the large
// wins live: routing is bounded by the price spread between rungs, but a tool schema that is
// never called is waste at any rung.
//
// Measured on a real session: 207 tools, ~100k tokens. Built-ins were 23k of that; the rest
// was specialised MCP servers — an advertising API at 30k, Gmail at 16k, a calendar at 6k —
// shipped on every coding turn whether or not anything reaches for them. That is not a
// routing problem and no model choice fixes it.
//
// Jev's Noul primitive answers "is this statement true?" with a probability, which is exactly
// the shape of "does this turn need the Gmail toolset". One request, one question per toolset.
//
// Built-in tools are never dropped. They are what the agent works with, they are a fifth of
// the cost, and guessing wrong about them breaks the session rather than slowing it.
import { NETWORK } from "./tuning.mjs";
import { debug } from "./diag.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Toolset a tool belongs to. `mcp__<server>__<tool>` is the MCP convention. */
export const groupOf = (name) =>
  typeof name === "string" && name.startsWith("mcp__") ? (name.split("__")[1] ?? "unknown") : null;

/** Toolsets present in a request, with what they cost and what they can do. */
export function groupsIn(tools = []) {
  const groups = new Map();
  for (const tool of tools) {
    const g = groupOf(tool?.name);
    if (!g) continue;
    const entry = groups.get(g) ?? { name: g, tools: [], chars: 0 };
    entry.tools.push(tool.name.split("__").slice(2).join("__"));
    entry.chars += JSON.stringify(tool).length;
    groups.set(g, entry);
  }
  return [...groups.values()];
}

/**
 * A Noul question is a STATEMENT to judge, and the statement carries the distinguishing
 * information. Putting the toolset in `criteria` while leaving every question's instructions
 * identical returned the same probability for every toolset — 0.39 for a vulnerability
 * database and for Gmail, on a Solidity audit. Phrased as a claim about necessity, the same
 * model separates them cleanly: github 0.89 on "open a pull request" against 0.02-0.08 for
 * everything else.
 *
 * The operation names come from the tools themselves; nothing here is hand-written per server.
 */
const questionFor = (group) => ({
  type: "noul",
  instructions:
    `Completing this request requires the "${group.name}" toolset, which provides: ` +
    `${group.tools.slice(0, 20).join(", ")}. ` +
    `Reading, editing and searching files and running shell commands are always available ` +
    `without it, so answer only for what this toolset uniquely provides.`,
});

/**
 * Which toolsets to keep. Returns null when the question should not be asked at all, so the
 * caller forwards the request untouched.
 *
 * @returns {Promise<?{keep: Set<string>, dropped: number, savedChars: number, ms: number}>}
 */
/**
 * Default threshold 0.15, not a guess. Swept offline over one set of Jev answers on 24
 * requests derived from the servers' own tool descriptions (bench/toolsets.mjs):
 *
 *   jev @0.15   100% recall   87% savings   <- strictly dominates keep-all
 *   jev @0.30    96%          91%
 *   jev @0.50    79%          92%
 *   keep-all    100%           0%
 *   keyword      33%          97%           <- a local heuristic, for comparison
 *
 * 0.15 keeps everything the request needed while dropping 87% of the schema, so it is not a
 * trade against keep-all — it is the same recall for an eighth of the tokens. Raising it to
 * 0.30 buys four more points of saving for four of recall; a dropped toolset the turn needed
 * is a capability that is simply absent, so recall is worth more than that.
 */
export async function selectToolsets({ prompt, tools, threshold = 0.15, raw = false }) {
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey || !prompt) return null;
  const groups = groupsIn(tools);
  // Nothing to win, and every question costs a little latency.
  if (groups.length < 2) return null;

  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), NETWORK.deadlineMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: { request: String(prompt).slice(0, 8000) },
        questions: Object.fromEntries(groups.map((g) => [g.name, questionFor(g)])),
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answers = (await res.json())?.answers ?? {};

    const keep = new Set();
    let savedChars = 0;
    for (const g of groups) {
      const score = answers[g.name]?.noul;
      // An unanswered toolset is kept. Dropping on a missing answer would turn a malformed
      // response into a broken session.
      if (!Number.isFinite(score) || score >= threshold) keep.add(g.name);
      else savedChars += g.chars;
    }
    const result = { keep, dropped: groups.length - keep.size, savedChars, ms: Date.now() - started };
    // The benchmark thresholds offline so one set of answers scores every operating point.
    if (raw) result.scores = Object.fromEntries(groups.map((g) => [g.name, answers[g.name]?.noul]));
    return result;
  } catch (err) {
    debug(`toolset selection failed, sending all tools: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/** Drop the toolsets not selected. Built-ins and anything unrecognised always stay. */
export function pruneTools(tools = [], keep) {
  if (!keep) return tools;
  return tools.filter((t) => {
    const g = groupOf(t?.name);
    return g === null || keep.has(g);
  });
}
