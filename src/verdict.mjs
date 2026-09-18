// The decision layer: pure, total, and the only place a tier is actually chosen.
// Any missing, malformed, or unavailable input falls back to the tier already in use, so a
// broken router can never block a prompt.
import { TIER_ORDER, canHold, heightOf } from "./ladder.mjs";
import { RULES, EXPLICIT_REQUESTS } from "./tuning.mjs";

/** The tier the user named outright in the prompt, or null. */
export function explicitRequest(prompt) {
  return EXPLICIT_REQUESTS.find((p) => p.re.test(prompt ?? ""))?.tier ?? null;
}

/**
 * Nearest tier the account can run. Steps up rather than down, so an unavailable tier never
 * silently hands hard work to a weaker model — but never steps up into `fable`, which bills
 * extra usage credits, unless fable is what was asked for.
 */
function nearestRunnable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = heightOf(tier);
  const up = TIER_ORDER.filter((t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"));
  if (up.length) return up[0];
  const down = TIER_ORDER.filter((t, i) => i < rank && available.includes(t));
  return down.at(-1) ?? null;
}

/**
 * @param {object} input
 * @param {string}   input.prompt        raw prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.decision  null when the router failed
 * @param {string}   input.current       tier the prompt cache was built on
 * @param {string[]} input.available     tiers the account can run
 * @param {number}   input.contextTokens approximate conversation size
 * @param {boolean}  input.hasCache      whether a prompt cache has actually been built yet
 * @param {?string}  input.floor         sticky floor from a recent escalation, or null
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function verdictFor({ prompt, decision, current, available, contextTokens = 0, hasCache = false, floor = null }) {
  // A tier that cannot hold the conversation is not a choice, whoever picked it.
  const roomy = available.filter((t) => canHold(t, contextTokens));
  const usable = roomy.length ? roomy : available;

  const conclude = (tier, reason) => {
    // A sticky floor outranks everything except the user saying otherwise in this prompt:
    // the conversation has already demonstrated that cheaper does not work here.
    let target = tier;
    let why = reason;
    if (floor && !reason.startsWith("override") && heightOf(target) < heightOf(floor)) {
      target = floor;
      why = `${reason}+escalation-floor`;
    }
    if (!canHold(target, contextTokens)) {
      target = nearestRunnable(target, usable) ?? target;
      why = `${why}+context-too-large`;
    }
    const final = nearestRunnable(target, usable) ?? current;
    if (final !== target) why = `${why}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = explicitRequest(prompt);
  if (override) return conclude(override, "override");

  if (!decision || !TIER_ORDER.includes(decision.choice)) return conclude(current, "router-unavailable");

  const target = decision.choice;

  if (decision.confidence < RULES.minConfidence) {
    if (heightOf(target) < heightOf(current)) return conclude(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(heightOf(current), heightOf(RULES.uncertainCeiling));
    if (heightOf(target) > ceiling) return conclude(TIER_ORDER[ceiling], "low-confidence-capped");
  }

  // Only guard a cache that exists. On the first turn of a conversation the context is
  // large but nothing has been cached against a model yet, so there is nothing to discard —
  // and that first turn is where most of the available saving is.
  if (hasCache && heightOf(target) < heightOf(current) && contextTokens > RULES.downgradeMaxContextTokens) {
    return conclude(current, "downgrade-not-worth-cache-rebuild");
  }

  return conclude(target, "routed");
}
