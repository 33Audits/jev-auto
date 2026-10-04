import { appraise as heuristic } from "./heuristic.mjs";
import { appraise as delegate } from "./delegate.mjs";
import { appraise as typesafe } from "./typesafe.mjs";
import { appraise as clef } from "./clef.mjs";

/**
 * Provider-neutral decision-model seam. The installed client can use a local
 * scorer, a hosted Clef service, or a legacy compatible backend; the relay and
 * policy engine do not depend on which decision model answered.
 */
export const APPRAISERS = { local: heuristic, llm: delegate, clef, jev: typesafe };

/**
 * With no explicit choice, use the decision model when a key is present and the local scorer
 * otherwise. Measured over 300 real prompts, the two agree only 26% of the time (kappa 0.03)
 * and the local scorer sends 91.7% of everything to one rung, so it is the fallback, not the
 * preference. Nothing breaks without a key: `local` needs no network and no account.
 */
const hasKey = () => Boolean(
  process.env.BIZZY_API_TOKEN || process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY,
);

export const defaultBackend = () => {
  if (process.env.BIZZY_DECISION_URL && process.env.BIZZY_API_TOKEN) return "clef";
  return hasKey() ? "jev" : "local";
};

export const selectAppraiser = (name = process.env.JEV_ROUTER) =>
  APPRAISERS[name] ?? APPRAISERS[defaultBackend()];

export const appraiserName = (name = process.env.JEV_ROUTER) => (APPRAISERS[name] ? name : defaultBackend());
