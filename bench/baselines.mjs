// Routers to measure ours against. A cost saving means nothing without these: any router
// that sends everything to the cheapest tier "saves" the most and is useless, and a scorer
// that only reads prompt length is a regex suit over a character count.
import { appraise } from "../src/appraisers/heuristic.mjs";

export const alwaysHaiku = () => ({ choice: "fast" });
export const alwaysSonnet = () => ({ choice: "balanced" });
export const alwaysOpus = () => ({ choice: "strong" });

/**
 * Length alone, with cutoffs chosen so its tier mix matches the router under test. Matching
 * the mix is what makes the comparison mean something: if the two agree on nearly every
 * prompt, the router is a length threshold and the rest of the scorer is decoration.
 */
export function lengthOnly(quantiles) {
  return ({ prompt }) => {
    const n = String(prompt ?? "").length;
    return { choice: n < quantiles.cheap ? "fast" : n < quantiles.strong ? "balanced" : "strong" };
  };
}

/** Coin flips with the same tier mix. The floor any real router must clear. */
export function randomMatched(mix, rng = Math.random) {
  const tiers = Object.entries(mix);
  return () => {
    let r = rng();
    for (const [tier, share] of tiers) if ((r -= share) <= 0) return { choice: tier };
    return { choice: tiers.at(-1)[0] };
  };
}

export const ours = (input) => appraise(input);
