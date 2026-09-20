// Jev — TypeSafe's System One decision model — asked the way it is meant to be asked.
//
// Jev returns a probability distribution over options rather than text, and the docs are
// explicit that it is trained to read STRUCTURE: "Instructions, Choice options, Score levels
// and Noul criteria all accept JSON structure", and "a Choice option description can be a
// structured object as well".
//
// So each rung is described as an object — what it is for, the signals that indicate it, and
// what it is explicitly not for — rather than a one-line string. The rubric questions are
// asked of Jev as Score primitives instead of being computed locally and presented as if they
// came from the model: the factors `jev why` displays are Jev's own, and the choice is made
// with the same rubric in view.
//
// Fail-safe by construction: any error, timeout, missing key, or unexpected answer falls back
// to the local appraiser, so this can never make routing worse than not having a key.
import { NETWORK } from "../tuning.mjs";
import { TIER_ORDER } from "../ladder.mjs";
import { appraise as appraiseLocally } from "./heuristic.mjs";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Structured option descriptions. Jev reads these fields, not a sentence. */
const RUNGS = {
  fast: {
    for: "Mechanical work where the answer is known before the model starts thinking.",
    signals: [
      "rename, reformat, add a comment or a type annotation",
      "a single obvious command to run",
      "a factual question about code that is already in front of you",
      "a failure whose cause is stated in the error itself",
    ],
    not_for: "Design judgement, multi-file reasoning, or any cause that has to be found.",
  },
  balanced: {
    for: "Ordinary engineering with a clear, bounded shape.",
    signals: [
      "implement a function to a stated spec",
      "write or fix a test for understood behaviour",
      "a local bug whose mechanism is already understood",
      "a change confined to one or two files",
    ],
    not_for: "Open-ended architecture, subtle concurrency, or debugging with no candidate cause.",
  },
  strong: {
    for: "Hard reasoning, genuine ambiguity, or a large blast radius.",
    signals: [
      "the cause is unknown and has to be located",
      "cross-module design, migrations, schema or protocol changes",
      "concurrency, race conditions, ordering, atomicity",
      "security, authentication, authorisation, fund movement",
      "the failure surfaces far from its cause",
    ],
    not_for: "Routine work whose implementation is already clear.",
  },
  long: {
    for: "Work beyond a single focused session.",
    signals: ["whole-repository migration", "unusually large context", "multi-hour autonomous execution"],
    not_for: "Anything a strong model finishes in one sitting.",
  },
};

/** Score rubric. Levels are objects because Jev reads the structure. */
const LEVELS = [
  { level: 0, means: "none at all" },
  { level: 2, means: "trivial — mechanical, no judgement" },
  { level: 4, means: "moderate — bounded and understood" },
  { level: 6, means: "high — requires real reasoning or several coordinated steps" },
  { level: 8, means: "severe — ambiguous, or the cause must be discovered" },
  { level: 10, means: "extreme — open-ended with a large blast radius" },
];
const MAX_LEVEL = 10;

const scoreQuestion = (instructions) => ({ type: "score", instructions, criteria: LEVELS });

export async function appraise({
  prompt, contextTokens = 0, toolCount = 0, cutoffs, available = TIER_ORDER,
  // A tool-step continuation is judged on what just happened, not on the prompt that opened
  // the turn. Most model calls are these, and they carry most of the spend.
  step = null,
}) {
  const local = appraiseLocally({ prompt, contextTokens, toolCount, cutoffs });
  const apiKey = process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) return { ...local, backend: "jev/no-key" };

  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), NETWORK.deadlineMs);

  const criteria = Object.fromEntries(available.filter((t) => RUNGS[t]).map((t) => [t, RUNGS[t]]));

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: abort.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state: step?.kind === "tool_step"
          ? {
              // Judge THIS step. The original ask is context; the tool output is the subject.
              turn_started_with: String(step.text ?? "").slice(0, 600),
              last_tool_output: String(step.digest ?? "").slice(0, 1200),
              tool_output_was_an_error: step.hadError === true,
              steps_taken_so_far: step.steps ?? 0,
              session: { context_tokens: contextTokens, tools_available: toolCount },
              environment: { available_rungs: Object.keys(criteria) },
            }
          : {
              request: String(prompt).slice(0, 8000),
              session: { context_tokens: contextTokens, tools_available: toolCount },
              environment: { available_rungs: Object.keys(criteria) },
            },
        questions: {
          task_complexity: scoreQuestion("How complex is this coding task overall — its ambiguity, scope, and blast radius?"),
          reasoning_required: scoreQuestion("How much reasoning is needed to get this right in one pass, without a retry on a stronger model?"),
          tool_complexity: scoreQuestion("How complex is the tool use — from none, to many coordinated or stateful operations?"),
          rung: {
            type: "choice",
            instructions: step?.kind === "tool_step"
              ? [
                  "Pick the cheapest rung that can decide the NEXT action after this tool output.",
                  "A clean result that only needs the obvious next step is mechanical work.",
                  "An error, an unexpected result, or many steps already taken without progress needs real reasoning.",
                  "Judge this step, not the difficulty of the request that started the turn.",
                ]
              : [
                  "Pick the cheapest rung that can fully complete this request in one pass, without needing a retry on a stronger one.",
                  "Judge the reasoning required, not the length of the reply.",
                  "A failure whose cause is stated in the error is cheaper than one whose cause must be found.",
                ],
            criteria,
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answers = (await res.json())?.answers;
    const choice = answers?.rung?.choice;
    if (!TIER_ORDER.includes(choice)) throw new Error("unrecognised rung");

    // Jev's own rubric, not a local estimate wearing its name.
    const factor = (key) =>
      Number.isFinite(answers?.[key]?.score) ? answers[key].score / MAX_LEVEL : null;
    const metrics = {
      taskComplexity: factor("task_complexity"),
      reasoningRequired: factor("reasoning_required"),
      toolComplexity: factor("tool_complexity"),
      contextSize: local.metrics.contextSize,
    };

    return {
      ...local,
      choice,
      confidence: Number.isFinite(answers.rung.confidence) ? answers.rung.confidence : 0.7,
      probabilities: answers.rung.probabilities ?? null,
      metrics,
      backend: "jev",
      ms: Date.now() - started,
    };
  } catch {
    return { ...local, backend: "jev/fallback-local", ms: Date.now() - started };
  } finally {
    clearTimeout(deadline);
  }
}
