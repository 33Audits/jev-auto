// Turns the ledger into the two score boundaries the local router uses.
//
// The loop bizzy-core's optimizer describes as "keep trying cheaper until there's no way":
// a tier whose turns keep getting escalated is being handed work it cannot do, so the
// boundary moves away from it; a tier that has gone a long stretch without a single
// escalation has headroom, so the boundary moves toward it and the next batch of turns
// tests that. Movement is bounded, evidence-gated, and always reversible.
import { CALIBRATION, MAX_DRIFT, SHIPPED_CUTOFFS, shippedCutoffs } from "./tuning.mjs";
import { stats } from "./ledger.mjs";

const withinDrift = (value, shipped) =>
  Math.min(shipped + MAX_DRIFT, Math.max(shipped - MAX_DRIFT, value));

/**
 * @returns {{cheap:number, strong:number, notes:string[], calibrated:boolean}}
 */
export function cutoffs(records) {
  const base = shippedCutoffs();
  // An explicitly pinned pair is a decision, not a starting point: do not calibrate over it.
  if (process.env.JEV_THRESHOLDS || process.env.JEV_NO_CALIBRATION === "1") {
    return { ...base, notes: ["calibration disabled"], calibrated: false };
  }

  const s = stats(records);
  const { minTrials, tooCheapRate, convergedRate, step } = CALIBRATION;
  const notes = [];
  let { cheap, strong } = base;

  // `boundary` moves toward the tier it gates when that tier proves it has headroom, and
  // away from it when the escalations say otherwise. `sign` encodes which way is "toward".
  const tune = (tier, value, sign, label) => {
    const t = s.byTier[tier];
    if (!t || t.turns < minTrials) {
      notes.push(`${label}: ${t?.turns ?? 0}/${minTrials} turns — holding at ${value.toFixed(2)}`);
      return value;
    }
    if (t.escalationRate > tooCheapRate) {
      notes.push(`${label}: ${tier} escalated ${(t.escalationRate * 100).toFixed(0)}% of ${t.turns} turns — routing less to it`);
      return value - sign * step;
    }
    if (t.escalationRate < convergedRate && t.turns >= minTrials * 2) {
      notes.push(`${label}: ${tier} clean over ${t.turns} turns — trying it on more work`);
      return value + sign * step;
    }
    notes.push(`${label}: ${tier} at ${(t.escalationRate * 100).toFixed(0)}% over ${t.turns} turns — converged`);
    return value;
  };

  cheap = withinDrift(tune("haiku", cheap, 1, "cheap boundary"), SHIPPED_CUTOFFS.cheap);
  strong = withinDrift(tune("sonnet", strong, 1, "strong boundary"), SHIPPED_CUTOFFS.strong);
  // The boundaries must stay ordered with room between them, whatever the evidence says.
  if (strong - cheap < 0.1) strong = cheap + 0.1;

  return {
    cheap: Number(cheap.toFixed(3)),
    strong: Number(strong.toFixed(3)),
    notes,
    calibrated: cheap !== base.cheap || strong !== base.strong,
  };
}

/**
 * Buckets that have failed often enough, over enough turns, that the tier they were routed
 * to is the wrong one for that shape of request. Surfaced by `jev stats` for a human; the
 * calibrator does not act on these itself, matching bizzy-core's rule that promotions are
 * human-gated while only rejections are automatic.
 */
export function problemShapes(records) {
  return stats(records)
    .byShape.filter((b) => b.turns >= CALIBRATION.minTrials / 2 && b.escalationRate > CALIBRATION.tooCheapRate)
    .sort((a, b) => b.escalationRate - a.escalationRate);
}
