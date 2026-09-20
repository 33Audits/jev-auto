# Building a Jev-first router in front of a coding agent

Notes from shipping one. Everything here was measured on a real machine against real CLIs, and
several items are things that cost us hours before they were understood. Code references are to
this repository.

---

## The four things that decide whether it works

### 1. Jev decides; it never generates

`POST api.typesafe.ai/v1/systemone` returns typed judgments — Choice, Noul, Score — in roughly
0.2–0.5s. It is not a chat endpoint and a client's `base_url` cannot point at it. You need a
proxy that asks Jev, then calls a real model with a real credential.

In this repo Jev appears in exactly three places, all decision-only:

| file | decision |
| --- | --- |
| `src/appraisers/typesafe.mjs` | which model tier serves this turn |
| `src/tools.mjs` | which MCP toolsets this turn needs |
| `src/triage.mjs` | what severity a finding would receive |

Generation goes to `api.anthropic.com` or `chatgpt.com/backend-api/codex`, never to Jev.

### 2. Do not provision serving credentials — forward the client's

The usual framing is "the decision key and the serving keys are different problems, and every
candidate model needs its own working server-held credential." That framing leads to a pool of
API keys to manage, dead keys that look exactly like a broken router, and OAuth-only backends
you have to drop.

Skip all of it. The CLI already holds a credential authorized for the account. Forward it
untouched (`src/relay.mjs`, `AUTH_HEADERS`) and the router needs no model credentials at all:

```js
const AUTH_HEADERS = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta",
                      "chatgpt-account-id", "openai-beta"];
```

Consequences worth having: it runs on a plain `claude login` / `codex login`; an OAuth-only
backend works rather than being excluded; and no key is ever read, stored, or logged. There is a
test asserting the headers arrive upstream unmodified.

`JEV_API_KEY` stays separate and buys only the decision.

### 3. Avoid protocol translation rather than solving it

Translating Anthropic Messages to OpenAI Responses (or vice versa) is where these projects
drown. Don't. Keep each CLI inside its own protocol family behind one adapter interface:

```
src/wire.mjs        platform=claude   POST /v1/messages   -> api.anthropic.com
src/wire-codex.mjs  platform=codex    POST /responses     -> chatgpt backend
```

Both expose the same 13 methods (`isTurnCall`, `freshTurnText`, `threadKey`, `weighRequest`,
`retarget`, `meterFrom`, …). The relay never looks inside a body, so a third CLI is a third
adapter and nothing else changes. A test asserts both adapters expose the identical interface,
so one cannot be half-implemented.

**Capture the wire format; do not infer it.** Run the CLI through a logging proxy once. Doing
that for Codex found two things no amount of reading would have: `prompt_cache_key` carries a
stable session id (so Codex threads need no hashing, unlike Claude Code's), and usage comes back
as `cached_tokens` / `cache_write_tokens`, not Anthropic's names.

### 4. The prompt cache dominates the price spread — this is the one that will fool you

Routing's whole upside is the gap between rungs, about 15x from cheapest to dearest. Switching
model mid-conversation discards the prompt cache; the next turn re-sends the conversation as
cache *writes* billed at 1.25x input, where a read would have been 0.1x. **One switch costs
roughly twelve turns of reading.**

Measured on a six-turn React build at ~130k context:

| | cache writes | outcome |
| --- | --- | --- |
| pinned to one rung | ~161k | baseline |
| routed, switching freely | ~571k | **57% MORE expensive** |

The routed arm spent half its turns on the cheaper rung and still lost. Guard a change in
**either** direction (`src/verdict.mjs`, `switchMaxContextTokens`): above ~20k context a
conversation stays on whatever its first turn chose. Routing's value is concentrated in the
first turn and in short sessions, not in switching mid-flight.

Ship a per-turn router without this and you will measure routing as a loss and conclude Jev does
not work.

---

## Where Jev actually pays, and where it does not

Measured here, separated because the answers differ:

| decision | result |
| --- | --- |
| **which toolsets a turn needs** | Jev at threshold 0.15: **100% recall, 87% of schema dropped** — strictly dominates sending everything. A keyword heuristic: 33% recall. |
| **which model tier** | **unproven.** Jev is confident and conservative; a free local heuristic was not measurably worse. Four attempts to show otherwise died on benchmarks that could not discriminate. |

The lesson: **routing is the lowest-ceiling application of Jev.** It is bounded by the price
spread, and the cache takes part of that. Replacing a judgement call has no such ceiling — which
is why a classification workload elsewhere reports 34x while a router reports single digits. If
you want the large number, find the LLM calls in your pipeline that are really classifications.

On this machine the real cost was not the model at all. A session shipped 207 tool definitions,
~100k tokens, of which built-ins were 23k; the rest was specialised MCP servers sent on every
turn regardless. One Jev Noul question per toolset dropped ~91k of it in 451ms and took context
from ~217,790 to ~126,870 — which is also what made the cheapest rung reachable.

### Asking Jev properly is most of the work

Two mistakes, both of which looked like Jev being weak:

**Structured criteria, not one-liners.** The docs are explicit that System One models are trained
to read structure and that a Choice option description may be an object. Three flat strings and
one question produced 0.27 confidence on a decision; the same question with per-option
`{for, signals, not_for}` objects plus Score rubric questions produced 0.61–0.94 on the same
prompts. Compare `src/appraisers/typesafe.mjs`.

**A Noul question *is* the statement.** Putting the distinguishing detail in `criteria` while
every question carried identical `instructions` returned **0.39 for every option** — the same
number for a vulnerability database and for Gmail. Phrased as a claim about necessity, the same
model separated them cleanly: `github 0.89` on "open a pull request", everything else 0.02–0.08.

Also: only offer options the caller can actually use. Leaving a disabled rung in the list had Jev
spending 0.17 of its probability mass on it.

---

## Benchmark, not vibes — and the traps in doing it

Reusable as-is:

| file | what it does |
| --- | --- |
| `bench/toolsets.mjs` | gold set **derived from the MCP servers' own tool descriptions** — no hand labelling; recall + savings; thresholds swept offline from one set of answers |
| `bench/grade.mjs` | per-requirement scoring of a built app, so cost is never compared between arms that built different things |
| `bench/dashboard.mjs` | A/B where the arms differ by exactly one environment variable, through the same relay |
| `bench/oracle.mjs` | cheapest rung that *actually passes* a real repository's own test suite |
| `src/ledger.mjs` | metering that never stores prompt text — schema-enforced, with a test |
| `bizzy-core/evals/jev_routing/` | the same three suites in bizzy-core's eval convention (`run`/`report`, resume-safe JSONL) |

Four traps, each of which produced a wrong number here first:

1. **A turn is many requests.** Every tool call is another round trip. Keeping the first
   response's usage undercounted a six-turn session that built a whole app as ~20 output tokens —
   about 47% low overall, and unevenly, because arms that work harder make more calls. Sum usage
   across the turn.
2. **Persistent router state contaminates arms.** Once conversation state survives a process,
   arm 2 resumes arm 1's conversation if they share a first prompt — starting with a rung already
   chosen. Give each arm its own store.
3. **Nondeterministic features break assertions.** An exploration feature that sometimes takes the
   cheaper rung made a test fail ~1 run in 5. It read as a flake for two sessions. Inject the
   rate so a test can switch it off.
4. **A task set the cheap model always passes measures nothing.** If every task passes at the
   cheapest rung, always-cheapest wins by construction and the appraiser has nothing to be right
   about. Include tasks the cheap rung demonstrably fails, and grade `build` separately from
   `test` — a cheap rung shipped code whose tests passed and whose types did not compile.

And state the baseline. Against all-Opus a result reads ~94% cheaper; against the tier the CLI
would actually have used, the same run reads a few percent. Only the second is honest.
