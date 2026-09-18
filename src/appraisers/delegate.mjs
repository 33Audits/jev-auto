// Router backend that asks a model which model to use — using the CLI's own credentials.
//
// The important property is that this costs the user no extra account: the proxy already
// holds a request authorized for their Anthropic subscription, so the routing call is made
// with the same headers, against the same upstream, on the cheapest tier. No third-party
// key, no third-party seeing the prompt.
//
// Metrics still come from the local router so `jev why` renders the same four factors; only
// the tier choice is delegated.
import { NETWORK } from "../tuning.mjs";
import { TIER_ORDER, defaultIdFor } from "../ladder.mjs";
import { appraise as appraiseLocally } from "./heuristic.mjs";

const QUESTION = `You appraise coding requests to a model tier. Answer with exactly one word.

haiku  - mechanical work: rename, reformat, add a comment, run one obvious command, answer a factual question about the code.
sonnet - ordinary engineering with a clear shape: implement a specified function, write a test, fix an understood local bug.
opus   - hard reasoning: unknown-cause debugging, cross-module design, concurrency, security, migrations, anything ambiguous.

Pick the cheapest tier that can finish the request in one pass without needing a retry on a
stronger model. Judge the reasoning required, not the requested reply length.

Request:
`;

/**
 * @param {object} input
 * @param {string} input.prompt
 * @param {string} input.upstream    base URL the proxy forwards to
 * @param {object} input.auth        the CLI's own authorization headers, forwarded unread
 */
export async function appraise({ prompt, contextTokens = 0, toolCount = 0, cutoffs, upstream, auth = {} }) {
  const local = appraiseLocally({ prompt, contextTokens, toolCount, cutoffs });
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), NETWORK.deadlineMs);
  try {
    const res = await fetch(`${upstream.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      signal: abort.signal,
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        model: defaultIdFor("fast"),
        max_tokens: 4,
        temperature: 0,
        messages: [{ role: "user", content: `${QUESTION}${String(prompt).slice(0, 4000)}` }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const text = (body?.content ?? []).map((b) => b.text ?? "").join("").toLowerCase();
    const choice = TIER_ORDER.find((t) => text.includes(t));
    if (!choice) throw new Error(`unrecognised answer ${JSON.stringify(text.slice(0, 40))}`);
    return { ...local, choice, confidence: 0.75, backend: "llm", ms: Date.now() - started };
  } catch {
    // Any failure falls back to the local answer rather than to "no routing": the local
    // router is always available and is strictly better than holding the current tier.
    return { ...local, backend: "llm/fallback-local", ms: Date.now() - started };
  } finally {
    clearTimeout(deadline);
  }
}
