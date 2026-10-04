import { NETWORK } from "../tuning.mjs";
import { TIER_ORDER } from "../ladder.mjs";
import { appraise as appraiseLocally } from "./heuristic.mjs";

/**
 * Hosted Bizzy decision-model adapter.
 *
 * The installed client sends only routing features by default. Clef's model,
 * thresholds, calibration data, and policy stay server-side. Any transport or
 * schema failure falls back to the local appraiser and never blocks a request.
 *
 * Contract:
 *   POST BIZZY_DECISION_URL
 *   Authorization: Bearer BIZZY_API_TOKEN
 *   { version, features, available }
 *   -> { choice, confidence?, reasonCodes?, policyVersion? }
 */
export const CLEF_ENDPOINT = "";

const endpoint = () => process.env.BIZZY_DECISION_URL || "";

const finite = (value, fallback = null) => Number.isFinite(value) ? value : fallback;

export async function appraise({
  prompt,
  contextTokens = 0,
  toolCount = 0,
  cutoffs,
  available = TIER_ORDER,
  step = null,
}) {
  const local = appraiseLocally({ prompt, contextTokens, toolCount, cutoffs });
  const token = process.env.BIZZY_API_TOKEN;
  if (!endpoint() || !token) return { ...local, backend: "clef/no-key" };

  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), NETWORK.deadlineMs);

  // Deliberately content-free. The hosted decision service receives shape and
  // state signals, not prompts, answers, filenames, tool arguments, or results.
  const features = {
    contextTokens,
    toolCount,
    stepKind: step?.kind ?? "turn",
    stepCount: step?.steps ?? 0,
    toolOutputWasError: step?.hadError === true,
    localChoice: local.choice,
    localConfidence: finite(local.confidence, 0),
    metrics: local.metrics,
  };

  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      signal: abort.signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ version: 1, features, available }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const result = await res.json();
    if (!TIER_ORDER.includes(result?.choice) || !available.includes(result.choice)) {
      throw new Error("unrecognised Clef choice");
    }

    return {
      ...local,
      choice: result.choice,
      confidence: finite(result.confidence, 0.7),
      reasonCodes: Array.isArray(result.reasonCodes) ? result.reasonCodes.slice(0, 8) : [],
      policyVersion: typeof result.policyVersion === "string" ? result.policyVersion : null,
      backend: "clef",
      ms: Date.now() - started,
    };
  } catch {
    return { ...local, backend: "clef/fallback-local", ms: Date.now() - started };
  } finally {
    clearTimeout(deadline);
  }
}
