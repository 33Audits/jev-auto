// `jev why` — renders the exact decision that was made, from what was recorded when it was
// made. Nothing is re-computed and nothing is re-asked, so the report cannot disagree with
// what actually happened.
const W = 46;
const line = (text = "") => `│ ${String(text).slice(0, W - 2).padEnd(W - 2)} │`;
const rule = (l, r) => `${l}${"─".repeat(W)}${r}`;
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%`.padStart(4) : "  n/a");

const wrap = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const out = [];
  for (const word of words) {
    if (!out.length || `${out.at(-1)} ${word}`.length > W - 2) out.push(word);
    else out[out.length - 1] += ` ${word}`;
  }
  return out.map(line);
};

/** A 20-cell bar with the two tier boundaries drawn in, and the score marked on it. */
function scale(score, cutoffs) {
  if (!Number.isFinite(score) || !cutoffs) return null;
  const cells = 20;
  const at = (x) => Math.min(cells - 1, Math.max(0, Math.round(x * cells)));
  const bar = Array.from({ length: cells }, () => "─");
  bar[at(cutoffs.cheap)] = "┊";
  bar[at(cutoffs.strong)] = "┊";
  bar[at(score)] = "●";
  return `${bar.join("")}  ${score.toFixed(2)}`;
}

const WHY = {
  override: "you named the model in the prompt",
  "router-unavailable": "router did not answer; tier held",
  "low-confidence-no-downgrade": "too close to call; refused to downgrade",
  "low-confidence-capped": "too close to call; upgrade capped",
  "downgrade-not-worth-cache-rebuild": "downgrade would cost more cache than it saves",
  "escalation-floor": "held above an earlier escalation",
  unavailable: "nearest tier this account can run",
  routed: "router recommendation",
};

export const reasonText = (reason = "") =>
  Object.entries(WHY).find(([k]) => reason.includes(k))?.[1] ?? "router recommendation";

export function renderDecision(status) {
  if (!status) return "jev: no routing decision recorded for this session yet.";
  if (status.manual) {
    return `jev: routing is paused — you selected ${status.model ?? "a model"} manually. Pick "Jev Auto" in /model to resume.`;
  }

  const m = status.metrics ?? {};
  const rows = [
    rule("┌", "┐"),
    line("jev-auto — last routing decision"),
    line(),
    ...wrap("Prompt: ", status.prompt ?? "not recorded"),
    line(),
    line(`Task complexity     ${pct(m.taskComplexity)}`),
    line(`Reasoning required  ${pct(m.reasoningRequired)}`),
    line(`Tool complexity     ${pct(m.toolComplexity)}`),
    line(`Context size        ${pct(m.contextSize)}`),
  ];

  const bar = scale(status.score, status.cutoffs);
  if (bar) {
    rows.push(line(), line("haiku ┊ sonnet    ┊ opus"), line(bar));
  }

  rows.push(
    line(),
    line(`Routed to:  ${status.model ?? status.tier ?? "unknown"}`),
    line(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    line(`Decided by: ${status.backend ?? "unknown"}`),
    ...wrap("Why: ", reasonText(status.reason)),
  );
  if (status.floor) rows.push(line(`Floor:      ${status.floor} (recent escalation)`));
  rows.push(rule("└", "┘"));
  return rows.join("\n");
}
