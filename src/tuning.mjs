// Every tunable in one place. Anything a user might reasonably want to change is here or
// in an environment variable; nothing is buried in the proxy.
import { homedir } from "node:os";
import { join } from "node:path";
import { TIER_ORDER } from "./ladder.mjs";

export const STATE_DIR = join(homedir(), ".jev-auto");
// JEV_LEDGER points the ledger somewhere else, so an experiment can be metered in isolation
// without disturbing the ledger that calibrates real sessions.
export const LEDGER_FILE = process.env.JEV_LEDGER || join(STATE_DIR, "turns.jsonl");
export const LOG_FILE = join(STATE_DIR, "jev.log");

export const CONTEXT_WINDOW_TOKENS = 200000;

/** How the four metrics combine into one 0..1 difficulty score. */
export const FACTOR_WEIGHTS = { task: 0.3, reasoning: 0.4, tool: 0.2, context: 0.1 };

/**
 * Score boundaries between tiers. These are starting points, not beliefs: the calibration
 * loop moves them based on what actually happened (src/calibrate.mjs). `JEV_THRESHOLDS`
 * pins them to a fixed pair, which is how you turn calibration off.
 */
export const SHIPPED_CUTOFFS = { cheap: 0.28, strong: 0.58 };
export const MAX_DRIFT = 0.12;

export function shippedCutoffs() {
  const pinned = process.env.JEV_THRESHOLDS;
  if (pinned) {
    const [cheap, strong] = pinned.split(",").map(Number);
    if (Number.isFinite(cheap) && Number.isFinite(strong) && cheap < strong) return { cheap, strong };
  }
  return { ...SHIPPED_CUTOFFS };
}

export const RULES = {
  /** Below this confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /**
   * Routing up costs roughly five times what routing down saves, so the two directions do
   * not deserve the same evidence. Measured over 300 real prompts: the 15% of turns an
   * appraiser sent up accounted for 63% of spend, and only 5 of those 45 were above 0.9
   * confidence. Requiring near-certainty to climb turned the same decisions from 19% more
   * expensive than doing nothing into 34% cheaper.
   */
  upgradeMinConfidence: 0.9,
  uncertainCeiling: "balanced",
  /**
   * Switching models discards the prompt cache and the next turn re-sends the conversation
   * as cache writes, billed at 1.25x input where a read would have been 0.1x. One switch
   * therefore costs roughly twelve turns of reading, so past this size a conversation should
   * stay where it is regardless of which direction the appraiser wants to move.
   */
  switchMaxContextTokens: 20000,
  /**
   * After the router is caught routing too cheap (the user escalated, or the turn errored),
   * the conversation holds a floor for this many turns. Without it the router can oscillate
   * on a conversation that has simply become hard.
   */
  escalationStickyTurns: 3,
  /**
   * Fraction of turns that take the cheaper rung the appraiser did not choose, to find out
   * whether it would have sufficed. Escalation data alone cannot answer that — it only
   * covers decisions already taken. Set JEV_EXPLORE=0 to turn it off.
   */
  exploreRate: process.env.JEV_EXPLORE === undefined ? 0.15 : Number(process.env.JEV_EXPLORE),
};

/** How much evidence the calibrator needs before it will move a boundary. */
export const CALIBRATION = {
  minTrials: 25,
  /** Above this escalation rate a tier is being handed work it cannot do -> route up. */
  tooCheapRate: 0.15,
  /** Below this, over twice the evidence, the tier has headroom -> try cheaper. */
  convergedRate: 0.04,
  step: 0.03,
};

export const NETWORK = {
  /** Per-attempt and total budget for network backends. Local answers in microseconds. */
  timeoutMs: 1500,
  deadlineMs: 3000,
};

/** Phrases that mean the human already decided, checked against the raw prompt. */
// Both platforms' nicknames, so "use opus" and "use sol" mean the same rung.
const ALIASES = {
  fast: "fast|cheap|haiku|luna",
  balanced: "balanced|medium|sonnet|terra",
  strong: "strong|smart|best|opus|sol",
  long: "long|fable|astra",
};

export const EXPLICIT_REQUESTS = TIER_ORDER.map((tier) => ({
  tier,
  re: new RegExp(`\\b(?:use|switch to|with|on|route to)\\s+(?:${ALIASES[tier]})\\b`, "i"),
}));
