// Renders the one line Claude Code shows at the bottom of the session. Kept out of the
// executable so it can be tested against the payloads Claude Code actually sends.
import { TIER_ORDER } from "./ladder.mjs";

const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const COLOR = { fast: "\x1b[32m", balanced: "\x1b[36m", strong: "\x1b[35m", long: "\x1b[33m" };

const dim = (text) => `${DIM}${text}${OFF}`;

/** Reasons worth the space: the ones where routing declined to do the obvious thing. */
const NOTABLE = /context-too-large|cache-rebuild|low-confidence|escalation-floor|unavailable/;

function routedPart(status, input) {
  if (!status) return dim("jev: waiting for first prompt");
  if (status.manual) {
    const model = input?.model?.display_name ?? status.model ?? "";
    return `${dim("⏸ manual")} ${model}`.trimEnd();
  }
  const tier = status.tier ?? "?";
  const color = COLOR[tier] ?? "";
  const confidence = Number.isFinite(status.confidence) ? ` ${dim(`p=${status.confidence.toFixed(2)}`)}` : "";
  const note = NOTABLE.test(status.reason ?? "") ? ` ${dim(`(${status.reason.split("/")[0].split("+").at(-1)})`)}` : "";
  return `${color}${tier}${OFF}${confidence}${note}`;
}

/**
 * @param {object} input   the session payload Claude Code pipes in on stdin
 * @param {?object} status the latest recorded decision for that session
 */
export function renderStatusLine(input = {}, status = null) {
  // A status line replaces Claude Code's own footer, so it has to carry the basics too.
  const dir = (input.workspace?.current_dir ?? input.cwd ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const used = Math.round(input.context_window?.used_percentage ?? 0);
  return [routedPart(status, input), dim("·"), dir, dim(`· ${used}% context`)].filter(Boolean).join(" ");
}

export const TIER_COLORS = Object.fromEntries(TIER_ORDER.map((t) => [t, COLOR[t] ?? ""]));
