// Router backend that delegates to TypeSafe's Jev decision model, for users who already
// have a key. Raw fetch rather than the SDK so jev-auto keeps zero runtime dependencies.
//
// Fail-safe by construction: any error, timeout, missing key, or unexpected answer falls
// back to the local answer, so enabling this backend can never make routing worse.
import { NETWORK } from "../tuning.mjs";
import { TIER_ORDER } from "../ladder.mjs";
import { appraise as appraiseLocally } from "./heuristic.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

const CRITERIA = {
  fast: "Trivial, mechanical, or purely factual work. Not for design judgement or multi-file reasoning.",
  balanced: "Ordinary engineering with a clear, bounded shape. Not for open-ended architecture or unknown-cause debugging.",
  strong: "Hard reasoning, ambiguity, or high blast radius: debugging, cross-module design, security, concurrency, migrations.",
};

export async function appraise({ prompt, contextTokens = 0, toolCount = 0, cutoffs }) {
  const local = appraiseLocally({ prompt, contextTokens, toolCount, cutoffs });
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { ...local, backend: "jev/no-key" };

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
        state: { request: String(prompt).slice(0, 4000), session: { context_tokens: contextTokens } },
        questions: {
          tier: {
            type: "choice",
            instructions: "Which tier should serve this coding request, balancing cost and capability?",
            criteria: CRITERIA,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = (await res.json())?.answers?.tier;
    if (!TIER_ORDER.includes(answer?.choice)) throw new Error("unrecognised choice");
    return {
      ...local,
      choice: answer.choice,
      confidence: Number.isFinite(answer.confidence) ? answer.confidence : 0.7,
      backend: "jev",
      ms: Date.now() - started,
    };
  } catch {
    return { ...local, backend: "jev/fallback-local", ms: Date.now() - started };
  } finally {
    clearTimeout(deadline);
  }
}
