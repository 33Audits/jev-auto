// The cost ladder, and everything that depends on which rung a request is pointed at.
//
// Tiers are abstract — `fast`, `balanced`, `strong`, `long` — because the same decision has
// to serve two CLIs with different catalogs. An appraiser answers "how hard is this turn",
// never "which model": the platform decides what `strong` is called this week.

/** Rungs, cheapest first. The vocabulary every appraiser, rule, and report speaks. */
export const TIER_ORDER = ["fast", "balanced", "strong", "long"];
export const heightOf = (tier) => TIER_ORDER.indexOf(tier);

/**
 * `family`  substring that recognises whatever model the CLI asked for, including older
 *           versions inside the same rung (`claude-sonnet-4-6` is still `balanced`).
 * `think`   whether the rung accepts a thinking/reasoning block. Sending one to a rung that
 *           does not is a hard 400, so it is stripped on the way down.
 * `system`  whether the rung accepts `role: "system"` entries inside the conversation.
 * `window`  usable context. Routing a 300k-token conversation onto a 200k model is a 400.
 * `in`/`out` USD per million tokens, for the savings ledger only. A display default, not a
 *           billing source of truth.
 */
const CLAUDE = [
  { tier: "fast", id: "claude-haiku-4-5-20251001", family: "haiku", think: false, effort: false, system: false, window: 200000, in: 1, out: 5 },
  { tier: "balanced", id: "claude-sonnet-5", family: "sonnet", think: true, effort: true, system: true, window: 1000000, in: 3, out: 15 },
  { tier: "strong", id: "claude-opus-5", family: "opus", think: true, effort: true, system: true, window: 1000000, in: 15, out: 75 },
  { tier: "long", id: "claude-fable-5-1", family: "fable", think: true, effort: true, system: true, window: 1000000, in: 15, out: 75 },
];

// Verified against the live catalog this account can reach
// (GET /backend-api/codex/models), not assumed. All four report a 272k window.
const CODEX = [
  { tier: "fast", id: "gpt-5.6-luna", family: "luna", think: true, effort: true, system: true, window: 272000, in: 1, out: 5 },
  { tier: "balanced", id: "gpt-5.6-terra", family: "terra", think: true, effort: true, system: true, window: 272000, in: 3, out: 15 },
  { tier: "strong", id: "gpt-5.6-sol", family: "sol", think: true, effort: true, system: true, window: 272000, in: 15, out: 75 },
  { tier: "long", id: "gpt-6-astra", family: "astra", think: true, effort: true, system: true, window: 272000, in: 15, out: 75 },
];

/**
 * The sentinel each CLI is told to offer. It is not a real model: the CLI forwards it
 * verbatim because a custom base URL turns off client-side model validation, which is what
 * lets the relay tell "route this turn" from "the user picked a model themselves".
 */
export const SENTINEL = "jev-auto";
export const isSentinel = (model) => model === SENTINEL;

export const PLATFORMS = { claude: CLAUDE, codex: CODEX };

export const ladderFor = (platform = "claude") => PLATFORMS[platform] ?? CLAUDE;

export const rungFor = (tier, platform) => ladderFor(platform).find((r) => r.tier === tier);
export const defaultIdFor = (tier, platform) => rungFor(tier, platform)?.id;

/** Rung a model string belongs to, or null when unrecognised. */
export const tierOfModel = (model, platform) =>
  ladderFor(platform).find((r) => typeof model === "string" && model.includes(r.family))?.tier ?? null;

/** The long rung bills extra usage credits everywhere, so it stays opt-in. */
export const enabledTiers = () =>
  TIER_ORDER.filter((t) => t !== "long" || process.env.JEV_ALLOW_FABLE === "1" || process.env.JEV_ALLOW_LONG === "1");

/** Whether a rung can hold this conversation. 10% headroom for the estimate's own error. */
export const canHold = (tier, tokens, platform) => tokens <= (rungFor(tier, platform)?.window ?? Infinity) * 0.9;

/** Models the account actually reports, newest first; static ids are the cold-start fallback. */
export function accountModels(catalog = [], platform = "claude") {
  const models = catalog
    .filter((m) => tierOfModel(m?.id, platform))
    .map((m) => ({ id: m.id, tier: tierOfModel(m.id, platform), description: m.display_name ?? m.id }));
  return models.length ? models : ladderFor(platform).map((r) => ({ id: r.id, tier: r.tier, description: r.id }));
}

export const modelIdFor = (models, tier, platform) =>
  models.find((m) => m.tier === tier)?.id ?? defaultIdFor(tier, platform);
