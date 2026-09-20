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
      out[`${platform.toUpperCase()}_AI_${num}`] = { platform, rule, result };
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The ceiling a published invalidator imposes, read from its own result column.
 * "INVALID" means not a finding at all; "Low at most" is a cap, not a rejection.
 */
export function ceilingOf(result = "") {
  const text = String(result).toLowerCase();
  if (/invalid/.test(text)) return "INVALID";
  if (/informational at most/.test(text)) return "Informational";
  if (/low at most|qa\/low|capped low/.test(text)) return "Low";
  if (/capped medium/.test(text)) return "Medium";
  if (/downgrade/.test(text)) return "DOWNGRADE";
  return null;
}

/**
 * A decidable option set.
 *
 * 96 flat invalidators makes Jev choose between near-identical neighbours — it picked
 * "AI-generated finding without manual validation" for an admin-misuse finding at p=0.46,
 * when the right answer was the adjacent "requires admin/owner access" rule.
 *
 * So the options are the twelve semantic classes the invalidation library already defines,
 * plus the two categorical buckets the per-platform tables add: a finding that needs a trusted
 * actor to misbehave, and one on the published "not a finding" list. Each carries the ceiling
 * its own source states, so a caller can apply it rather than re-deciding.
 *
 * The classes are read from the library's own headings. Only the routing of per-platform rules
 * into the two categorical buckets is done here, by matching the rule text.
 */
const CATEGORICAL = {
  TRUSTED_ACTOR_REQUIRED: {
    ceiling: "Low",
    matches: /admin|owner|privileged|governance|centrali/i,
    meaning: "Requires a trusted role to act against the protocol. Published as Low at most, or invalid.",
  },
  CATEGORICALLY_EXCLUDED: {
    ceiling: "INVALID",
    matches: /zero address|approval|race condition|event|gas optimi|view function|storage gap|front.?run|best practice|user (error|input)/i,
    meaning: "On the published list of things that are not findings regardless of framing.",
  },
};

export function triageOptions(dir = CRITERIA_DIR) {
  const library = invalidationCriteria(dir);
  const autos = autoInvalidators(dir) ?? {};
  const options = { NONE: { meaning: "The finding stands as written; no class of rejection applies.", ceiling: null } };

  for (const [name, spec] of Object.entries(library ?? {})) {
    options[name] = { meaning: spec.reasons.slice(0, 4), ceiling: name === "DUST_IMPACT" ? "Low" : null };
  }
  for (const [name, spec] of Object.entries(CATEGORICAL)) {
    const examples = Object.values(autos)
      .filter((a) => spec.matches.test(a.rule))
      .map((a) => a.rule);
    if (!examples.length) continue;
    options[name] = {
      meaning: spec.meaning,
      ceiling: spec.ceiling,
      examples: [...new Set(examples)].slice(0, 6),
    };
  }
  return options;
}

/** The ceiling an option imposes, for callers applying it rather than re-deciding. */
export const ceilingFor = (option, dir = CRITERIA_DIR) => triageOptions(dir)[option]?.ceiling ?? null;

/** Which platforms have a criteria file/** Which platforms have a criteria file, so the question only offers real ones. */
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
  // The published per-platform invalidators. Asked as its own question because these are
  // categorical: when one applies it overrides the severity table entirely, and a finding that
  // trips one is not a low-severity finding, it is not a finding.
  questions.rejection_class = {
    type: "choice",
    instructions: [
      "If a judge rejected or capped this finding, which class of reason would they cite?",
      "These come from the platforms' own published guidelines and override the severity table.",
      "Choose NONE only when the finding would stand as written at a rewardable severity.",
    ],
    criteria: triageOptions(dir),
  };

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
    // The rejection class is categorical: when one applies it caps severity, and the cap is
    // stated by the source rather than re-decided here. Two independent answers were
    // contradicting each other — a zero-address check came back High while simultaneously
    // flagging the rule that says it is not a finding.
    const chosen = a.rejection_class?.choice ?? "NONE";
    const cap = chosen === "NONE" ? null : ceilingFor(chosen, dir);
    const ORDER = ["INVALID", "Informational", "Low", "Medium", "High", "Critical"];
    const raw = a.severity?.choice ?? null;
    const capped =
      cap && raw && ORDER.indexOf(raw) > ORDER.indexOf(cap) ? cap : raw;

    return {
      severity: a.severity ?? null,
      assessed: raw,
      final: capped,
      cappedBy: capped !== raw ? chosen : null,
      rejectionClass: a.rejection_class ?? null,
      ceiling: cap,
      exploitConfidence: a.exploit_confidence ?? null,
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
