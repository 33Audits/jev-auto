# jev-auto

Per-turn model routing for **Claude Code and OpenAI Codex**, on the accounts you already
have. Every turn goes to the cheapest tier that can actually do it, and the router keeps a
ledger of what happened next, so it gets better at that judgement instead of staying wrong
in the same way forever.

```bash
npm install -g jev-auto

jev              # Claude Code, routed
jev codex        # OpenAI Codex, routed
```

That is the whole setup. No API key, no account, no config file, no signup — it rides your
existing `claude login` / `codex login`.

```text
fast p=0.94 · my-project · 8% context
```

---

## What it does

`jev` launches the real CLI behind a loopback relay. Your login, tools, permissions,
keybindings, `/compact`, `/resume`, MCP servers and sessions are untouched — the only thing
the relay changes in a request is which model it names.

```text
you -> Claude Code -> jev relay -> Anthropic
you -> Codex       -> jev relay -> OpenAI
                         |
                         +-> which tier should serve this turn?
```

| command | CLI | authentication | model picker |
| --- | --- | --- | --- |
| `jev` | Claude Code | your existing `claude login` | **Jev Auto** in `/model` |
| `jev codex` | OpenAI Codex | your existing `codex login` | temporary `jevauto` provider |

Tiers are abstract, so one decision serves both:

| tier | Claude Code | Codex |
| --- | --- | --- |
| `fast` | Haiku | `gpt-5.6-luna` |
| `balanced` | Sonnet | `gpt-5.6-terra` |
| `strong` | Opus | `gpt-5.6-sol` |
| `long` (opt-in) | Fable | `gpt-6-astra` |

Codex support registers its provider on the command line rather than editing
`~/.codex/config.toml`, so nothing about your install is modified and an interrupted session
leaves no trace.

One decision per fresh user turn. Tool-loop continuations keep the tier the turn started on,
so the model never flips mid-task. The main conversation and every sub-agent are pinned
separately. Routing is fail-open at every level: a router that times out, throws, returns
nonsense, or is not configured at all keeps the current model and never blocks a prompt.

Pick **Jev Auto** in `/model` to route. Pick any real model to pause routing; pick Jev Auto
again to resume.

---

## The parts that are different

This is a rewrite of [`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router),
which is a good idea executed carefully. Five things are done differently here.

### 1. It works with no key

The original routes only when `JEV_API_KEY` is set, and starts Claude Code with routing
disabled otherwise. A cost-saving tool that requires a third-party account and a network
round trip before it saves anything has a hard floor on how many people use it.

The default backend here is local: a scorer that reads the shape of the request — stem-aware
difficulty markers, file references, enumerated steps, pasted stack traces, ambiguity
language, conversation size — and combines them into one number. No key, no network, no
added latency, nothing leaves the machine.

```bash
jev try "why does the withdrawal path intermittently revert under concurrent liquidations?"
```

```text
┌──────────────────────────────────────────────┐
│ jev-auto — last routing decision             │
│                                              │
│ Prompt: why does the withdrawal path         │
│ intermittently revert under concurrent       │
│ liquidations?                                │
│                                              │
│ Task complexity      77%                     │
│ Reasoning required   79%                     │
│ Tool complexity      40%                     │
│ Context size          0%                     │
│                                              │
│ haiku ┊ sonnet    ┊ opus                     │
│ ──────┊─────┊●──────  0.63                   │
│                                              │
│ Routed to:  opus                             │
│ Confidence: 37%                              │
│ Decided by: local (dry run)                  │
│ Why: router recommendation                   │
└──────────────────────────────────────────────┘
```

A model in the loop is still available — as an option, not a prerequisite:

| `JEV_ROUTER` | What decides | Needs |
| --- | --- | --- |
| `local` *(default)* | the local scorer | nothing |
| `llm` | one Haiku call **through your own Claude subscription** | nothing extra |
| `jev` | TypeSafe's Jev model | `JEV_API_KEY` |
| `off` | nothing; plain Claude Code | — |

Every non-local backend falls back to the local answer on any failure, so turning one on can
never make routing worse than not having it.

### 2. It learns from what actually happened

Borrowed from `bizzy-core`'s champion/challenger routing optimizer, which samples real calls,
re-runs them on the next-cheaper model, has a judge score the substitute, and keeps the
verdicts in a trial log until a tier has enough evidence to be promoted or rejected.

The mechanics carry over. The judge does not — because for an interactive coding CLI the
ground truth is already in the session, and it is better than a judge:

| What you did next | What it means |
| --- | --- |
| moved on to the next thing | the tier was enough |
| `no, that didn't work` / `still failing` / `try again` | the tier was not enough |
| switched to a stronger model in `/model` | the tier was not enough, explicitly |
| the API rejected the request | the tier could not serve it at all |

Each finished turn is graded against the next one and appended to `~/.jev-auto/turns.jsonl`.
Tiers that keep getting escalated are given less work; a tier that goes a long stretch
without a single escalation is given more, and the next batch of turns tests that. Boundaries
move by 0.03 at a time, are capped at 0.12 from the shipped defaults, and are always
reversible with `jev reset`.

Two rules are kept verbatim from `bizzy-core`, because they are the ones that make a loop
like this safe to leave running:

- **Rejections are automatic, promotions are reported.** Request shapes that keep needing a
  stronger model are surfaced by `jev stats` for you to act on. The calibrator never edits
  its own configuration past the drift cap.
- **The ledger never sees your content.** A record is a content-free feature bucket
  (`hard1/std/files2/long/trace`), the tier, one verdict, one reason code from a closed
  vocabulary, and token counts. No prompt text, no file names, no model output — enforced by
  a schema, and by a test that asserts the schema.

An escalation also sets a floor on the conversation for the next few turns, so a session that
has become hard does not get handed back down to a cheap model on the next prompt.

### 3. It tells you the number

The entire premise is cost, so the tool reports cost.

```bash
jev stats
```

```text
  142 routed turns since 9/2/2026

  Spent        $8.41
  All-Opus     $31.02
  Saved        $22.61  (73%)

  tier      turns   escalated   spend
  haiku        61          3%   $0.34
  sonnet       58          9%   $2.91
  opus         23          0%   $5.16

  Boundaries   0.31 / 0.58  (calibrated)
    · cheap boundary: haiku clean over 61 turns — trying it on more work
    · strong boundary: sonnet at 9% over 58 turns — converged
```

Token counts come off the wire, from the response the API actually returned, not from an
estimate of what was sent.

> **What is measured, and what was withdrawn.**
>
> An earlier version of this README claimed 75% cheaper and 18% faster on a React build. That
> number is withdrawn. It came from a mode that fires when Jev's confidence falls below
> `minConfidence` — and Jev's confidence was only that low because the request being sent to it
> was malformed: flat one-line criteria, one question, no rubric. Asked properly, Jev is
> confident on the same prompts (0.61-0.94), the mode never triggers, and the saving is gone.
> It measured a bad request, not routing.
>
> What survives, measured on the same build with every arm meeting all seven requirements of
> the brief (`bench/grade.mjs` checks them):
>
> | | wall | spend | requirements |
> | --- | --- | --- | --- |
> | vanilla Claude Code (Sonnet) | 114s | $1.9383 | 7/7 |
> | pinned to the cheapest rung | 77s | $0.4601 | 7/7 |
>
> The cheapest rung did the whole task for a quarter of the price. That is the headroom
> routing is aiming at, and default routing captured almost none of it (+3%) because the
> prompt-cache guard correctly pins a conversation to whatever its first turn chose.
>
> **The larger measured win is not routing at all.** A real session here sent 207 tool
> definitions, ~100k tokens, of which built-ins were 23k. Asking Jev which toolsets the turn
> needs dropped 11 of them:
>
> | | context |
> | --- | --- |
> | before | ~217,790 tokens |
> | after | **~126,870 tokens** — 42% smaller, ~91k dropped in 451ms |
>
> A tool schema nobody calls is waste at every rung, so this has no price-spread ceiling — and
> it is what makes the cheapest rung reachable here at all.
>
> **And this is the one place Jev measurably beats every alternative.** 24 requests derived
> from the MCP servers' own tool descriptions, so the labels are not hand-written — a request
> built from a tool's description necessarily needs that tool's server (`bench/toolsets.mjs`):
>
> | selector | recall | savings |
> | --- | --- | --- |
> | **jev @0.15** | **100%** | **87%** |
> | jev @0.30 | 96% | 91% |
> | jev @0.50 | 79% | 92% |
> | a local keyword heuristic | 33% | 97% |
> | keep everything | 100% | 0% |
> | drop everything | 0% | 100% |
>
> Jev at 0.15 strictly dominates keeping everything: identical recall, an eighth of the tokens.
> Not a trade-off. The keyword heuristic — written here, for comparison — gives up 67 points of
> recall to save 10 more, which is the wrong side of that trade when a dropped toolset means a
> capability is simply absent.
>
> Caveats: n=1 per arm; cost is deterministic, wall-clock is not (the same vanilla arm has
> measured 84-147s). Codex dollar figures use placeholder rates and are not comparable.

### 4. It survives contact with a real session

Three things a proxy has to get right that only show up against a live CLI, all of them found
by running this one:

- **Hooks append `role: "system"` messages after your turn.** Any router that reads
  `messages.at(-1)` sees a system message, decides this is not a user turn, and silently
  stops routing. `jev` looks for the last *conversational* turn instead.
- **Haiku rejects in-message system roles outright** (`role 'system' is not supported on this
  model`). Their content is folded into the neighbouring user turn rather than dropped, so
  hook output still reaches the model.
- **Tool definitions are most of the context.** A session with a few MCP servers attached
  carries 200k+ tokens of tool schemas before you type anything. Estimating context from
  `messages` alone understates the request by more than half and routes it into a model that
  cannot hold it — a hard 400. `jev` counts messages, system prompt and tools, at a
  characters-per-token ratio measured against the API's own count, and refuses any tier whose
  window cannot hold the request.

The first-turn cache rule is also fixed: a downgrade is only refused when a prompt cache
*exists*. A large system prompt on turn one is not a cache to protect, and turn one is where
most of the available saving is.

### 5. It is one command, and no dependencies

`jev`, `jev stats`, `jev why`, `jev try`, `jev doctor`, `jev reset`. Anything else is
forwarded to Claude Code untouched, so `jev --resume` and `jev -p "fix the test"` work.

`"dependencies": {}`. Node 20.12+, nothing else.

---

## Building one of these

[`INTEGRATING.md`](INTEGRATING.md) — the four things that decide whether a Jev-first router
works, where Jev pays and where it does not, and the benchmark traps that produced a wrong
number here first.

## Commands

| Command | What it does |
| --- | --- |
| `jev [claude args...]` | Launch Claude Code with routing |
| `jev codex [args...]` | Launch OpenAI Codex with routing |
| `jev stats` | What routing has cost, saved, and learned |
| `jev why` | The last routing decision, in full |
| `jev try "<prompt>"` | Where a prompt would route, without running anything |
| `jev doctor` | Check the install |
| `jev reset` | Delete the ledger and session state |

`/jev-why` inside a session does the same as `jev why` — the skill ships with the package.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_ROUTER` | `jev` when a key is present, else `local`. Or `llm`, or `off`. |
| `JEV_ALLOW_FABLE=1` | Allow the long tier, which bills extra usage credits |
| `JEV_THRESHOLDS=0.28,0.58` | Pin the boundaries and stop calibrating |
| `JEV_NO_CALIBRATION=1` | Keep the shipped boundaries, keep measuring |
| `JEV_NO_STATUSLINE=1` | Do not install the status line |
| `JEV_CHEAP_WHEN_UNSURE=0` | Keep the current rung when Jev has no opinion, instead of going cheapest |
| `JEV_PIN=<tier>` | Meter a session without routing it — the control arm for an A/B |
| `JEV_LEDGER=<path>` | Point the ledger elsewhere so an experiment cannot disturb calibration |
| `JEV_DEBUG=1` | Log every decision, and every upstream error body, to `~/.jev-auto/jev.log` |
| `JEV_DUMP=<prefix>` | Dump request bodies when the wire format moves |

Existing environment variables win, then `.env` in the launch directory, then
`~/.jev-auto.env`.

A status line you configured yourself is always kept — `jev` only installs its own when there
isn't one. Choosing a picker row with `Enter` saves it as Claude Code's default; `jev`
restores your previous default on exit so plain `claude` keeps working.

Tiers, prices, boundaries, and every decision rule are in `src/ladder.mjs`, `src/tuning.mjs`,
and `src/verdict.mjs`.

## What it sends where

- **`local` (default):** nothing leaves the machine. The prompt is scored in-process.
- **`llm`:** the prompt goes to Anthropic, on your own subscription, in one Haiku call.
- **`jev`:** the prompt goes to TypeSafe.
- **The ledger:** never leaves the machine, and never contains prompt text.

The proxy forwards Claude Code's own authorization headers without reading, storing, or
modifying them, and there is a test that asserts it.

## Limitations

- Two CLIs, verified against Claude Code 2.1.263 and Codex 0.154.0. A third would be a third
  adapter next to `src/wire.mjs` and `src/wire-codex.mjs`; nothing else would change.
- Claude Code's request format is not a public contract. `JEV_DUMP` exists for when it moves.
- Prices in `src/tiers.mjs` are a display default for the savings estimate, not a billing
  source of truth.
- The local scorer reads English. It degrades to the middle tier on text it cannot read,
  which is the safe direction.

## How the code is laid out

| | |
| --- | --- |
| `src/relay.mjs` | the loopback proxy: one decision per fresh turn, rewrite, forward |
| `src/wire.mjs` | Claude Code's Messages shape |
| `src/wire-codex.mjs` | Codex's Responses shape — the only file that differs per CLI |
| `src/appraisers/` | who answers "how hard is this turn": `heuristic`, `delegate`, `typesafe` |
| `src/verdict.mjs` | turns an appraisal plus the constraints into the tier that actually runs |
| `src/ladder.mjs` | the tiers, their capabilities, prices, and context windows |
| `src/ledger.mjs` | graded turns, content-free, append-only |
| `src/calibrate.mjs` | moves the cutoffs from what the ledger shows |
| `src/journal.mjs` | per-session decisions, for the status line and `jev why` |
| `src/tuning.mjs` | every constant worth arguing about |

## Development

```bash
npm install
npm test          # 126 tests, no network, no API key
node bin/jev.mjs doctor
node bin/jev.mjs try "refactor the auth middleware"
```

The suite covers both wire adapters against real captured request bodies, the scorer's tier assignments and monotonicity, every policy branch,
ledger privacy and cost math, calibration gates and drift caps, request-shape parsing
against real Claude Code bodies, and the proxy end-to-end against a stand-in API —
including that a synchronous router, a throwing router, an unreachable upstream, and a
hook-injected system message all still produce a working request.

## Credit

The idea and the integration surface are from
[`gargpratyush/jev-router`](https://github.com/gargpratyush/jev-router) (MIT): routing a
coding CLI per turn by putting a sentinel model in the `/model` picker and a proxy behind it.
That is a good idea, and this is an independent implementation of it rather than a fork —
but the parts below are close to theirs because the interface leaves little room, and it is
worth saying which:

- the `ANTHROPIC_CUSTOM_MODEL_OPTION*` environment contract and the capability string that
  goes with it — Claude Code's names, not a design choice
- the draft-04 `exclusiveMinimum`/`exclusiveMaximum` schema fix that a custom base URL makes
  necessary
- restoring the saved `model` key on exit so the sentinel cannot break plain `claude`
- keying conversations on the session id plus the first message, so sub-agents route
  separately
- treating a `tool_result` tail as a continuation rather than a new turn

Everything the routing decision is actually made of — the local scorer, the policy rules, the
turn ledger, calibration, cost accounting, the CLI, and the tests — is written here.

The ledger design is from `bizzy-core`'s `agent/routing_optimizer.py`: evidence gates,
automatic rejection of converged failures, human-gated promotion, and the closed reason
vocabulary that keeps content out of the log. Its judge is replaced by the session's own
ground truth.

## License

MIT
