// Triage a security finding with Jev, instead of asking a model to write an opinion.
//
// This is the shape of Jev use that pays: a fixed option set with written criteria and one
// decision per item, answered as a probability distribution rather than prose. Routing is
// bounded by the price spread between models; replacing a judgement call is not.
//
// Nothing here is authored. The severity definitions, the platform rules and the invalidation
// classes are read from the judging criteria that already exist on disk, so the answer follows
// the same rubric a human reviewer would apply and changes when that rubric changes.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NETWORK } from "./tuning.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export const CRITERIA_DIR =
  process.env.JEV_JUDGING_DIR ?? join(homedir(), "33Audits", "hooks-auditor", "rules", "hooks", "judging");

/** Severity rows out of the criteria table: `| **High** | definition |`. */
export function severityCriteria(dir = CRITERIA_DIR) {
  const file = join(dir, "severity-criteria.md");
  if (!existsSync(file)) return null;
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\|\s*\*\*(Critical|High|Medium|Low|Informational)\*\*\s*\|\s*(.+?)\s*\|/.exec(line);
    if (m && !out[m[1]]) out[m[1]] = m[2];
  }
  return Object.keys(out).length ? out : null;
}

/** Invalidation classes, each with the reasons filed under it. */
export function invalidationCriteria(dir = CRITERIA_DIR) {
  const file = join(dir, "invalidation-library.md");
  if (!existsSync(file)) return null;
  const out = {};
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const head = /^##\s+([A-Z_]+)\s*$/.exec(line);
    if (head) {
      current = head[1];
      out[current] = { reasons: [] };
      continue;
    }
    const reason = /^\*\*[A-Z]{2}-\d+:\s*(.+?)\*\*\s*$/.exec(line);
    if (reason && current && out[current].reasons.length < 6) out[current].reasons.push(reason[1]);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The automatic invalidators each platform publishes: `| AI-4 | Zero address check | INVALID |`.
 *
 * These decide the cases that judging actually turns on — admin misuse, zero-address checks,
 * approval race conditions — and leaving them out of the request was why a zero-address check
 * came back as High. The rule was on disk; it simply was not in the question.
 */
export function autoInvalidators(dir = CRITERIA_DIR) {
  const out = {};
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^criteria-.+\.md$/.test(f));
  } catch {
    return null;
  }
  for (const file of files) {
    const platform = file.replace(/^criteria-|\.md$/g, "");
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      const m = /^\|\s*AI-(\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/.exec(line);
      if (!m) continue;
      const [, num, rule, result] = m;
      if (/^-+$/.test(rule)) continue;
      const key = `${platform.toUpperCase()}_AI_${num}`;
      out[key] = { platform, rule, result };
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Which platforms have a criteria file, so the question only offers real ones. */
export const platforms = (dir = CRITERIA_DIR) => {
  try {
    return readdirSync(dir)
      .filter((f) => /^criteria-.+\.md$/.test(f))
      .map((f) => f.replace(/^criteria-|\.md$/g, ""));
  } catch {
    return [];
  }
};

/**
 * Ask Jev to triage a finding.
 *
 * @returns {Promise<?{severity: object, confidence: object, invalidation: object, wouldBeRejected: number, ms: number}>}
 */
export async function triage(finding, { dir = CRITERIA_DIR } = {}) {
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { error: "no JEV_API_KEY" };
  const severity = severityCriteria(dir);
  const invalidation = invalidationCriteria(dir);
  if (!severity) return { error: `no severity-criteria.md under ${dir}` };

  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), NETWORK.deadlineMs);

  const questions = {
    severity: {
      type: "choice",
      instructions: [
        "Assign the severity this finding would receive from a competent judge.",
        "Judge the worst outcome reachable by an unprivileged actor given the stated preconditions.",
        "Preconditions an attacker can satisfy are not mitigations.",
      ],
      criteria: severity,
    },
    exploit_confidence: {
      type: "choice",
      instructions: "How completely is the exploit path established by what is written here?",
      criteria: {
        High: "Traced end to end with concrete state; no assumption about unstated external conditions.",
        Medium: "Plausible but depends on pool state, configuration, or an unverified assumption.",
        Low: "Theoretical. Multiple unlikely preconditions, or no concrete path given.",
      },
    },
  };
  if (invalidation) {
    questions.invalidation = {
      type: "choice",
      instructions:
        "If a judge rejected or downgraded this finding, which class of reason would they cite? " +
        "Choose NONE when the finding would stand as written.",
      criteria: { NONE: { meaning: "The finding stands; no class of rejection applies." }, ...invalidation },
    };
  }
  // The published per-platform invalidators. Asked as its own question because these are
  // categorical: when one applies it overrides the severity table entirely, and a finding that
  // trips one is not a low-severity finding, it is not a finding.
  const autos = autoInvalidators(dir);
  if (autos) {
    questions.auto_invalidator = {
      type: "choice",
      instructions: [
        "Which published automatic invalidator does this finding trip, if any?",
        "These are categorical rules from the platforms' own judging guidelines and they override severity.",
        "Choose NONE only when no listed rule applies.",
      ],
      criteria: { NONE: { rule: "No published automatic invalidator applies to this finding." }, ...autos },
    };
  }

  questions.rejected = {
    type: "noul",
    instructions:
      "A competent judge applying the published guidelines would reject this finding as invalid, " +
      "or cap it at Low, rather than accept it at a rewardable severity.",
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: { finding: String(finding).slice(0, 12000) },
        questions,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = (await res.json())?.answers ?? {};
    return {
      severity: a.severity ?? null,
      exploitConfidence: a.exploit_confidence ?? null,
      invalidation: a.invalidation ?? null,
      autoInvalidator: a.auto_invalidator ?? null,
      wouldBeRejected: a.rejected?.noul ?? null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { error: err.message, ms: Date.now() - started };
  } finally {
    clearTimeout(deadline);
  }
}

/** Ranked probabilities, highest first, as `name p=0.NN` strings. */
export const ranked = (answer, n = 4) =>
  Object.entries(answer?.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`);
