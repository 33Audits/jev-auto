// The turn ledger: what the router decided, and what happened next.
//
// Adapted from bizzy-core's champion/challenger trial log (agent/routing_optimizer.py).
// That design runs a cheaper model in the shadow and has a judge score it; here the ground
// truth is better than a judge, because the user is already providing it — escalating the
// model, correcting the answer, or simply moving on. So the ledger keeps bizzy-core's
// mechanics (append-only trials, a closed reason vocabulary, minimum-evidence gates,
// automatic rejection of converged-failed candidates) and drops the shadow call.
//
// Privacy, kept from the same source: a record NEVER contains prompt text, file names, or
// model output. Only a content-free feature shape, the tier, the verdict, one reason code,
// and token counts. Delete the file at any time; nothing depends on its history.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { LEDGER_FILE } from "./tuning.mjs";
import { PLATFORMS, TIER_ORDER, ladderFor, rungFor } from "./ladder.mjs";

/** Closed vocabulary. Anything outside this list is recorded as `other`. */
export const REASON_CODES = ["manual_escalate", "prompt_escalate", "redo", "api_error", "other"];

export const VERDICTS = ["ok", "escalated"];

/** Append one graded turn. Best-effort: a broken ledger must never affect a session. */
export function append(record, file = LEDGER_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Newlines on both sides, not just a terminator. A process killed mid-write leaves a
    // fragment; this keeps it from gluing onto the record before or after it, so a crash
    // costs the one truncated line. Blank lines are skipped on read.
    appendFileSync(file, `\n${JSON.stringify(toSchema(record))}\n`);
  } catch {
    // Measurement is a nice-to-have; a full disk is not a routing failure.
  }
}

/** Strips anything that is not on the allowed schema. The privacy promise, enforced. */
export function toSchema(r) {
  const num = (x) => (Number.isFinite(x) ? Math.round(x) : 0);
  return {
    t: num(r.t ?? Date.now()),
    shape: typeof r.shape === "string" ? r.shape.slice(0, 64) : "unknown",
    tier: TIER_ORDER.includes(r.tier) ? r.tier : "unknown",
    backend: typeof r.backend === "string" ? r.backend.slice(0, 16) : "unknown",
    platform: r.platform in PLATFORMS ? r.platform : "claude",
    explored: r.explored === true,
    // Which arm of a live A/B this turn belonged to, and what the decisions saved, so a real
    // session can be compared against itself rather than against a synthetic task.
    arm: r.arm === "control" ? "control" : r.arm === "routed" ? "routed" : null,
    prunedTokens: num(r.prunedTokens),
    score: Number.isFinite(r.score) ? Number(r.score.toFixed(3)) : null,
    conf: Number.isFinite(r.conf) ? Number(r.conf.toFixed(3)) : null,
    verdict: VERDICTS.includes(r.verdict) ? r.verdict : "ok",
    code: REASON_CODES.includes(r.code) ? r.code : null,
    in: num(r.in),
    out: num(r.out),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
  };
}

export function read(file = LEDGER_FILE) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** USD for one record, at the tier it actually ran on. */
export function costOf(record, tier = record.tier, platform = record.platform ?? "claude") {
  const spec = rungFor(tier, platform);
  if (!spec) return 0;
  // Cache reads bill at a tenth of input; cache writes at 1.25x. Close enough for a
  // savings estimate, and the only numbers that would make it exact are on the invoice.
  return (
    (record.in * spec.in + record.cacheWrite * spec.in * 1.25 + record.cacheRead * spec.in * 0.1 + record.out * spec.out) /
    1e6
  );
}

/**
 * Aggregate view used by `jev stats` and by the calibrator.
 * `baseline` is what the same traffic would have cost pinned to the strongest tier —
 * the honest comparison, since that is what a user routes away from.
 */
export function stats(records = read()) {
  const strongest = "strong";
  const byTier = {};
  const byShape = {};
  let spend = 0;
  let baseline = 0;

  for (const r of records) {
    const cost = costOf(r);
    spend += cost;
    baseline += costOf(r, strongest, r.platform);

    const t = (byTier[r.tier] ??= { turns: 0, escalated: 0, tokensIn: 0, tokensOut: 0, spend: 0 });
    t.turns++;
    t.escalated += r.verdict === "escalated" ? 1 : 0;
    t.tokensIn += r.in + r.cacheRead + r.cacheWrite;
    t.tokensOut += r.out;
    t.spend += cost;

    const key = `${r.shape}|${r.tier}`;
    const b = (byShape[key] ??= { shape: r.shape, tier: r.tier, turns: 0, escalated: 0 });
    b.turns++;
    b.escalated += r.verdict === "escalated" ? 1 : 0;
  }

  for (const t of Object.values(byTier)) t.escalationRate = t.turns ? t.escalated / t.turns : 0;
  for (const b of Object.values(byShape)) b.escalationRate = b.turns ? b.escalated / b.turns : 0;

  // How big a turn actually is, which decides which rungs were even eligible. A session
  // whose context exceeds the cheapest rung's window can never be routed down, and without
  // this the user just sees "no savings" with no reason attached.
  const sizes = records.map((r) => r.in + r.cacheRead + r.cacheWrite).sort((a, b) => a - b);
  const medianContext = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;

  return {
    medianContext,
    turns: records.length,
    spend,
    baseline,
    saved: baseline - spend,
    savedPct: baseline > 0 ? (baseline - spend) / baseline : 0,
    byTier,
    byShape: Object.values(byShape),
    since: records[0]?.t ?? null,
  };
}
