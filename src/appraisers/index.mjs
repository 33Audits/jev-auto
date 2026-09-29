import { appraise as heuristic } from "./heuristic.mjs";
import { appraise as delegate } from "./delegate.mjs";
import { appraise as typesafe } from "./typesafe.mjs";

/**
 * The value of `JEV_ROUTER` a user types, mapped to the appraiser that answers.
 * `local` is the default because it needs nothing: no key, no account, no network,
 * no added latency.
 */
export const APPRAISERS = { local: heuristic, llm: delegate, jev: typesafe };

/**
 * With no explicit choice, use the decision model when a key is present and the local scorer
 * otherwise. Measured over 300 real prompts, the two agree only 26% of the time (kappa 0.03)
 * and the local scorer sends 91.7% of everything to one rung, so it is the fallback, not the
 * preference. Nothing breaks without a key: `local` needs no network and no account.
 */
const hasKey = () => Boolean(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY);

export const defaultBackend = () => (hasKey() ? "jev" : "local");

export const selectAppraiser = (name = process.env.JEV_ROUTER) =>
  APPRAISERS[name] ?? APPRAISERS[defaultBackend()];

export const appraiserName = (name = process.env.JEV_ROUTER) => (APPRAISERS[name] ? name : defaultBackend());
