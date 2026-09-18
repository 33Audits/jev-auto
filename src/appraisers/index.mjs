import { appraise as heuristic } from "./heuristic.mjs";
import { appraise as delegate } from "./delegate.mjs";
import { appraise as typesafe } from "./typesafe.mjs";

/**
 * The value of `JEV_ROUTER` a user types, mapped to the appraiser that answers.
 * `local` is the default because it needs nothing: no key, no account, no network,
 * no added latency.
 */
export const APPRAISERS = { local: heuristic, llm: delegate, jev: typesafe };

export const selectAppraiser = (name = process.env.JEV_ROUTER) => APPRAISERS[name] ?? heuristic;

export const appraiserName = (name = process.env.JEV_ROUTER) => (APPRAISERS[name] ? name : "local");
