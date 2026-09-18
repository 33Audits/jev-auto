// Occasionally take the cheaper rung the appraiser did not choose, and see what happens.
//
// This is bizzy-core's champion/challenger trial, restored. It was dropped on the argument
// that the session's own ground truth beats a judge — true, but incomplete: escalation data
// only covers decisions actually taken. "fast never escalated" says nothing about the turns
// that were sent to balanced, so inferring from it is selection bias. The only way to learn
// whether a cheaper rung would have sufficed is to sometimes use it.
//
// Measured motivation: on a six-turn React build the cheapest rung met every requirement
// 77% cheaper and 13% faster, while the appraiser called half those turns balanced. The
// headroom was real and nothing in the system could discover it.
//
// The bet is deliberately asymmetric. Being wrong costs one re-do, which the escalation
// ledger records and the sticky floor immediately corrects. Being right is a 3-5x price cut
// for every future turn of that shape.
import { TIER_ORDER, canHold, heightOf } from "./ladder.mjs";
import { CALIBRATION, RULES } from "./tuning.mjs";
import { stats } from "./ledger.mjs";

/** The rung one step cheaper, or null at the floor. */
export const cheaperThan = (tier) => (heightOf(tier) > 0 ? TIER_ORDER[heightOf(tier) - 1] : null);

/**
 * Whether to try the cheaper rung on this turn.
 *
 * Never while a floor is set (the conversation has already shown cheap does not work here),
 * never when the cheaper rung cannot hold the request, and never when the evidence is
 * already in — a shape that has been explored enough is decided, not still a question.
 */
export function shouldExplore({
  tier, shape, contextTokens, floor, records, confidence = 1,
  rate = RULES.exploreRate, rng = Math.random,
}) {
  if (floor) return false;
  const cheaper = cheaperThan(tier);
  if (!cheaper) return false;
  if (!canHold(cheaper, contextTokens)) return false;
  if (verdictForShape(records, shape, cheaper) !== "unknown") return false;
  return rng() < exploreRateFor(confidence, rate);
}

/**
 * Exploration is weighted by the appraiser's own uncertainty, because that is where a trial
 * buys the most information. Below `RULES.minConfidence` the appraiser is not expressing a
 * preference at all — the policy already treats that as "no opinion" — and holding the
 * status quo there is not a better guess than trying cheaper, merely a more expensive one.
 *
 * This is the same asymmetry `upgradeMinConfidence` already encodes, applied consistently:
 * being wrong cheap costs one re-do that the floor corrects, while being wrong expensive
 * costs the whole session, because the cache guard pins a conversation to its first choice.
 */
export function exploreRateFor(confidence, base = RULES.exploreRate) {
  if (!Number.isFinite(confidence)) return base;
  if (confidence < RULES.minConfidence) return RULES.uncertainExploreRate;
  // Between "no opinion" and certainty, scale smoothly from the uncertain rate to the base.
  const span = 1 - RULES.minConfidence;
  const t = Math.min(1, Math.max(0, (confidence - RULES.minConfidence) / (span || 1)));
  return RULES.uncertainExploreRate + t * (base - RULES.uncertainExploreRate);
}

/**
 * What the accumulated explorations say about running `shape` on `tier`.
 * "unknown" until there is enough evidence either way.
 */
export function verdictForShape(records, shape, tier) {
  const trials = records.filter((r) => r.explored && r.shape === shape && r.tier === tier);
  if (trials.length < CALIBRATION.minTrials) return "unknown";
  const escalated = trials.filter((r) => r.verdict === "escalated").length / trials.length;
  if (escalated > CALIBRATION.tooCheapRate) return "insufficient";
  if (escalated <= CALIBRATION.convergedRate) return "sufficient";
  return "unknown";
}

/**
 * The rung to actually use, given what exploration has already established. A shape proven
 * to run fine on the cheaper rung is routed there by default — that is the payoff, and the
 * only place exploration turns into saving.
 */
export function applyLearned({ tier, shape, contextTokens, floor, records }) {
  if (floor) return tier;
  const cheaper = cheaperThan(tier);
  if (!cheaper || !canHold(cheaper, contextTokens)) return tier;
  return verdictForShape(records, shape, cheaper) === "sufficient" ? cheaper : tier;
}

/** Per-shape exploration summary, for `jev stats`. */
export function explorationReport(records = []) {
  const byShape = {};
  for (const r of records.filter((x) => x.explored)) {
    const key = `${r.shape}|${r.tier}`;
    const e = (byShape[key] ??= { shape: r.shape, tier: r.tier, trials: 0, escalated: 0 });
    e.trials++;
    e.escalated += r.verdict === "escalated" ? 1 : 0;
  }
  return Object.values(byShape).map((e) => ({
    ...e,
    rate: e.trials ? e.escalated / e.trials : 0,
    verdict: verdictForShape(records, e.shape, e.tier),
  }));
}

export { stats };
