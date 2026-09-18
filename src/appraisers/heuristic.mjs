// Zero-key, zero-latency router. This is the default backend and the reason jev-auto works
// the moment it is installed: routing a turn is a judgement about the *shape* of a request,
// and most of that shape is legible without a model in the loop.
//
// It produces the same {choice, confidence, metrics} shape as the network backends, so the
// policy layer, the status line, and `jev why` cannot tell which backend answered.
import { CONTEXT_WINDOW_TOKENS, FACTOR_WEIGHTS, shippedCutoffs } from "../tuning.mjs";

/** Work that is mechanical: the answer is known before the model starts thinking. */
const TRIVIAL = [
  /\b(rename|renaming)\b/i,
  /\b(reformat|format|prettier|lint|indent)\b/i,
  /\badd (a )?(comment|docstring|jsdoc|type annotation)/i,
  /\b(typo|spelling|wording)\b/i,
  /\bbump (the )?version\b/i,
  /^\s*(what|where) (is|are|does) \b/i,
  /^\s*(list|show|print|cat|echo|run|open)\b/i,
  /\b(git status|git log|git diff)\b/i,
];

/** Work whose difficulty is in the reasoning, not the typing. */
const HARD = [
  /\bwhy\b[^.?]{0,80}\b(fail|break|wrong|not work|happen|revert|crash|hang)/i,
  /\b(root cause|debug\w*|diagnos\w*|intermittent\w*|flaky|nondeterministic)\b/i,
  /\b(race condition|concurren\w*|deadlock|livelock|thread.?safe\w*|atomicity|lock contention)\b/i,
  /\b(architect\w*|redesign\w*|rewrit\w*|restructur\w*|refactor\w*)\b/i,
  /\b(migrat\w*|backfill\w*|schema change|breaking change)\b/i,
  /\b(security|auth\w*|permission\w*|vulnerab\w*|exploit\w*|csrf|xss|injection|reentran\w*)\b/i,
  /\b(performance|optimi[sz]\w*|bottleneck|memory leak|profil\w*|latency)\b/i,
  /\b(distributed|consensus|idempoten\w*|eventual consistency|invariant\w*)\b/i,
  /\bacross\b[^.?]{0,48}\b(codebase|repo|repository|services|modules|files|contracts|packages|components)\b/i,
  /\b(trade.?offs?|design doc|rfc|proposal|strategy)\b/i,
  /\b(design|plan|choose)\b[^.?]{0,64}\b(migration|architecture|schema|rollout|rollback|integration|protocol|system)\b/i,
];

/** Language that says the request is under-specified — the model has to verdictFor, not obey. */
const AMBIGUOUS = [
  /\b(figure out|work out|verdictFor|best way|should (i|we)|what do you think|somehow|not sure)\b/i,
  /\b(investigat\w*|explor\w*|look into|audit\w*|review\w*)\b/i,
];

const STACK_TRACE =
  /(^\s+at .+\(.+:\d+:\d+\))|Traceback \(most recent call last\)|\bpanic:|^\s*[A-Za-z.]*(Error|Exception):/m;

const clamp = (x) => Math.min(1, Math.max(0, x));
/** Saturating 0..1 ramp: half-way at `k`. Keeps very long prompts from dominating. */
const sat = (x, k) => x / (x + k);
const hits = (patterns, text) => patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);

/** Cheap, explainable signals of a prompt. Exported so the tests can pin them. */
export function signals(prompt, { contextTokens = 0, toolCount = 0 } = {}) {
  const text = String(prompt ?? "");
  const code = [...text.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join("");
  const prose = text.replace(/```[\s\S]*?```/g, " ");
  return {
    words: prose.trim() ? prose.trim().split(/\s+/).length : 0,
    codeChars: code.length,
    // Path-ish tokens: `src/thing.ts`, `Vault.sol`, `./bin/run`. A request naming several
    // files is almost always a multi-file change, whatever its wording.
    files: new Set(prose.match(/(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[a-z]{1,5}\b/gi) ?? []).size,
    hard: hits(HARD, prose),
    trivial: hits(TRIVIAL, prose),
    ambiguous: hits(AMBIGUOUS, prose),
    trace: STACK_TRACE.test(text) ? 1 : 0,
    // Conjunctions and enumerations are the most reliable signal of a multi-step turn.
    steps: (prose.match(/^\s*(?:\d+[.)]|[-*])\s+/gm) ?? []).length + (prose.match(/\b(?:then|after that|and also)\b/gi) ?? []).length,
    question: /^\s*(what|where|which|who|when|is|are|does|do|can|could|how)\b/i.test(prose) ? 1 : 0,
    contextTokens,
    toolCount,
  };
}

/**
 * Features -> the same four 0..1 metrics the network backends report.
 *
 * The baseline is deliberately mid-scale: ordinary bounded engineering is the default case,
 * so trivial markers pull a request down out of it and difficulty markers push it up. A
 * scorer whose baseline is near zero routes everything to the cheapest tier and looks great
 * on a cost report while quietly making the tool worse.
 */
export function factorsOf(f) {
  const task = clamp(
    0.36 + 0.2 * Math.min(f.hard, 2) + 0.12 * sat(f.files, 3) + 0.14 * sat(f.words, 110) +
      0.1 * sat(f.steps, 2) - 0.3 * Math.min(f.trivial, 1) - 0.06 * f.question,
  );
  const reasoning = clamp(
    0.34 + 0.22 * Math.min(f.hard, 2) + 0.12 * Math.min(f.ambiguous, 2) + 0.12 * f.trace +
      0.12 * sat(f.words, 140) - 0.32 * Math.min(f.trivial, 1) - 0.14 * f.question * (f.hard ? 0 : 1),
  );
  const tool = clamp(
    0.24 + 0.18 * sat(f.files, 3) + 0.2 * sat(f.steps, 2) + 0.1 * sat(f.codeChars, 900) +
      0.16 * Math.min(f.hard, 1) + 0.1 * (f.toolCount > 20 ? 1 : 0) - 0.22 * Math.min(f.trivial, 1),
  );
  return {
    taskComplexity: task,
    reasoningRequired: reasoning,
    toolComplexity: tool,
    contextSize: Math.min(f.contextTokens / CONTEXT_WINDOW_TOKENS, 1),
  };
}

export const difficultyOf = (m) =>
  clamp(
    FACTOR_WEIGHTS.task * m.taskComplexity + FACTOR_WEIGHTS.reasoning * m.reasoningRequired +
      FACTOR_WEIGHTS.tool * m.toolComplexity + FACTOR_WEIGHTS.context * m.contextSize,
  );

/**
 * A stable, content-free label for the kind of request this was. The ledger records this
 * instead of the prompt, so calibration can learn per request-shape without ever storing
 * what the user typed. See src/ledger.mjs.
 */
export const shapeOf = (f) =>
  [
    `hard${Math.min(f.hard, 2)}`,
    f.trivial ? "triv" : "std",
    `files${f.files === 0 ? 0 : f.files <= 2 ? 1 : 2}`,
    f.words < 25 ? "short" : f.words < 120 ? "mid" : "long",
    f.trace ? "trace" : "notrace",
  ].join("/");

/**
 * Picks a tier from the score using two boundaries. `cutoffs` are the calibrated pair
 * from the ledger, defaulting to the shipped constants when there is no evidence yet.
 */
export function appraise({ prompt, contextTokens = 0, toolCount = 0, cutoffs = shippedCutoffs() }) {
  const f = signals(prompt, { contextTokens, toolCount });
  const metrics = factorsOf(f);
  const score = difficultyOf(metrics);
  const { cheap, strong } = cutoffs;
  const choice = score < cheap ? "haiku" : score < strong ? "sonnet" : "opus";
  // Confidence is distance from whichever boundary this score is nearest: a request sitting
  // right on a boundary genuinely could go either way, and the policy layer is built to
  // refuse downgrades on exactly that signal.
  const margin = Math.min(Math.abs(score - cheap), Math.abs(score - strong));
  return {
    choice,
    model: null,
    confidence: Math.min(0.99, Math.max(0.25, 0.25 + margin * 2.5)),
    metrics,
    score,
    shape: shapeOf(f),
    signals: f,
    backend: "local",
    ms: 0,
  };
}
