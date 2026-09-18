// The model catalog and everything that depends on which tier a request is pointed at.
// One file so the whole cost/capability model is reviewable at a glance.

/**
 * Tiers, cheapest first.
 *
 * `id`      goes into the API request body.
 * `family`  substring used to recognise whatever model the CLI asked for, which may be an
 *           older version inside the same tier (`claude-sonnet-4-6` is still `sonnet`).
 * `thinking`/`effort` come from the model catalog: Haiku accepts neither, so those request
 *           fields have to be stripped when routing down to it.
 * `system`  whether the tier accepts `role: "system"` entries inside `messages`. Hooks and
 *           plugins append those; Haiku rejects the request outright.
 * `window`  usable context. Routing a 300k-token conversation down to a 200k model is a
 *           hard 400, so the policy layer refuses a tier that cannot hold the request.
 * `in`/`out` are USD per million tokens, used only for the savings ledger. They are a
 *           display default, not a billing source of truth — override with JEV_PRICES.
 */
export const LADDER = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false, system: false, window: 200000, in: 1, out: 5 },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true, system: true, window: 1000000, in: 3, out: 15 },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true, system: true, window: 1000000, in: 15, out: 75 },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true, system: true, window: 1000000, in: 15, out: 75 },
];

export const TIER_ORDER = LADDER.map((t) => t.name);
export const heightOf = (name) => TIER_ORDER.indexOf(name);
export const rungFor = (name) => LADDER.find((t) => t.name === name);
export const defaultIdFor = (name) => rungFor(name)?.id;

/** Tier name for a model string the CLI sent, or null when unrecognised. */
export const tierOfModel = (model) =>
  LADDER.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Sentinel offered as an extra row in the CLI's /model picker. Claude Code forwards it
 * verbatim because it does not validate model names behind a custom base URL, which is
 * exactly what lets the proxy tell "route this turn" apart from "the user picked a model".
 */
export const SENTINEL = "jev-auto";
export const isSentinel = (model) => model === SENTINEL;

/** Fable bills extra usage credits, so it stays opt-in. */
export const enabledTiers = () =>
  TIER_ORDER.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

/**
 * Points a request body at a tier, dropping fields that tier cannot accept. The CLI
 * composes the body for whatever model it believes it is talking to, so downgrading to
 * Haiku while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function retarget(body, tierName, model = defaultIdFor(tierName)) {
  const tier = rungFor(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (!body.context_management.edits.length) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (!Object.keys(body.output_config).length) delete body.output_config;
  }
  if (!tier.system && Array.isArray(body.messages)) body.messages = absorbSystemTurns(body.messages);
  return body;
}

/**
 * Hooks and plugins append `role: "system"` entries to `messages`. Some tiers reject those
 * outright, so their content is folded into the neighbouring user turn instead — the same
 * place the CLI would have put it. Dropping them would silently discard hook output.
 */
export function absorbSystemTurns(messages) {
  const out = [];
  for (const message of messages) {
    if (message?.role !== "system") {
      out.push(message);
      continue;
    }
    const blocks = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (message.content ?? []).filter((b) => b?.type === "text");
    if (!blocks.length) continue;
    const host = out.findLast?.((m) => m.role === "user");
    if (host) {
      host.content = typeof host.content === "string" ? [{ type: "text", text: host.content }] : [...(host.content ?? [])];
      host.content.push(...blocks);
    } else {
      out.push({ role: "user", content: blocks });
    }
  }
  return out;
}

/** Whether a tier can hold this conversation. 10% headroom for the estimate's own error. */
export const canHold = (tierName, tokens) => tokens <= (rungFor(tierName)?.window ?? Infinity) * 0.9;

/**
 * Exact models the signed-in account reports, newest first. Static ids are the cold-start
 * fallback so routing works before the CLI has fetched its catalog.
 */
export function accountModels(catalog = []) {
  const models = catalog
    .filter((m) => tierOfModel(m?.id))
    .map((m) => ({
      id: m.id,
      tier: tierOfModel(m.id),
      description: [m.display_name, m.created_at && `released ${m.created_at.slice(0, 10)}`]
        .filter(Boolean)
        .join("; "),
    }));
  return models.length ? models : LADDER.map((t) => ({ id: t.id, tier: t.name, description: t.id }));
}

export const modelIdFor = (models, tier) => models.find((m) => m.tier === tier)?.id ?? defaultIdFor(tier);
