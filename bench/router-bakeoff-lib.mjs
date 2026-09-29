import { TIER_ORDER, heightOf } from "../src/ladder.mjs";

const TIER_UNITS = { fast: 1, balanced: 3, strong: 15, long: 15 };

const compact = (rows) => {
  let exact = 0;
  let under = 0;
  let over = 0;
  for (const row of rows) {
    if (row.actual === row.expected) exact++;
    else if (heightOf(row.actual) < heightOf(row.expected)) under++;
    else over++;
  }
  return {
    n: rows.length,
    exact,
    under,
    over,
    exactRate: rows.length ? exact / rows.length : 0,
    tierUnits: rows.reduce((sum, row) => sum + TIER_UNITS[row.actual], 0),
  };
};

export function summarizeDecision(id, decision, effectiveTier) {
  return {
    id,
    rawTier: TIER_ORDER.includes(decision?.choice) ? decision.choice : null,
    effectiveTier: TIER_ORDER.includes(effectiveTier) ? effectiveTier : null,
    confidence: Number.isFinite(decision?.confidence) ? decision.confidence : null,
    backend: typeof decision?.backend === "string" ? decision.backend : "unknown",
    ms: Number.isFinite(decision?.ms) ? decision.ms : null,
  };
}

export function scoreArm({ name, missions, decisions, tierField = "effectiveTier" }) {
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const rows = missions.map((mission) => {
    if (!TIER_ORDER.includes(mission.groundTruthTier)) {
      throw new Error(`${name}: invalid groundTruthTier for ${mission.id}`);
    }
    const decision = byId.get(mission.id);
    const selectedTier = decision?.[tierField];
    if (!decision || !TIER_ORDER.includes(selectedTier)) {
      throw new Error(`${name}: missing valid ${tierField} decision for ${mission.id}`);
    }
    return {
      id: mission.id,
      split: mission.split,
      expected: mission.groundTruthTier,
      actual: selectedTier,
    };
  });
  const overall = compact(rows);
  const holdout = compact(rows.filter((row) => row.split === "holdout"));
  const latencies = decisions.map((row) => row.ms).filter(Number.isFinite).sort((a, b) => a - b);

  return {
    name,
    ...overall,
    holdout,
    fallbacks: decisions.filter((row) => String(row.backend).includes("fallback") || String(row.backend).includes("no-key")).length,
    medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
  };
}

export function assertNoFallbacks(name, decisions) {
  const count = decisions.filter(
    (row) => String(row.backend).includes("fallback") || String(row.backend).includes("no-key"),
  ).length;
  if (count) throw new Error(`${name}: ${count} fallback decision${count === 1 ? "" : "s"}; run is invalid`);
}

export function markdownPathFor(outputPath) {
  if (!outputPath.endsWith(".json")) throw new Error("benchmark --out path must end in .json");
  return outputPath.slice(0, -5) + ".md";
}
