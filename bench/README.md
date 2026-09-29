# Benchmarks

Claims about a router are worth what they are measured against. This directory exists so the
claims in the top-level README can be checked, including the ones that turn out to be wrong.

## What is measured today, for free

```bash
node bench/extract.mjs        # build a corpus from real Claude Code sessions on this machine
node bench/profile.mjs        # what the router does with it, against trivial baselines
```

No API key, no network, no cost. The corpus stays local and is gitignored: it is your own
prompt history.

### Why a corpus of real sessions

A prompt set written to exercise a scorer will always flatter that scorer. Session history
is the distribution the router actually faces, and it was recorded before the router existed,
so it cannot have been chosen to make it look good. It is still one person's distribution —
see Limits.

### The baselines

A saving means nothing on its own: a router that sends everything to the cheapest tier saves
the most and is useless. Every number is reported against:

| baseline | what it tests |
| --- | --- |
| `alwaysSonnet` | the thing a sensible person does instead of installing this. **The bar.** |
| `alwaysOpus` | what the top-level README compares against. Flattering, and nobody runs it. |
| `lengthOnly` | a character count with our tier mix. If we agree with it, the scorer is decoration. |
| `randomMatched` | coin flips with our tier mix. The floor. Kappa here should be ~0. |

Raw agreement is misleading when one tier holds most of the mass, so agreement is also
reported as Cohen's kappa, which subtracts what you would get by chance at those base rates.
Kappa against a constant baseline is degenerate and is reported as n/a.

## The oracle (implemented)

```bash
node bench/oracle.mjs --tasks bench/tasks/tasks.json --runs 1   # costs real money, run once
node bench/score.mjs  --router bench/router-run.json            # free, repeatable
```

Methodology taken from a benchmark that does this properly —
[kyotofin/tax-doc-classifier](https://github.com/kyotofin/tax-doc-classifier), which reports
1,067 externally-sourced pages with a strict-error column beside its cost column and a named
baseline measured in the same session. Three things copied from it:

1. **The work is not authored here.** Each task is a real repository at a pinned commit with
   its own test suite. A mechanical mutation removes the first guard in a target file; the
   model is asked to make the tests pass without touching them. The repo's tests decide, not
   a checklist of mine. The suite is verified green *before* the mutation and verified broken
   *after* it, so a task that measures nothing is skipped rather than scored.
2. **Strict accuracy sits beside cost, and comes first.** `score.mjs` leads with strict
   errors — tasks routed below what they needed, and therefore failed. Without that column
   "cheaper" is unfalsifiable: a router that always picks the cheapest rung wins on spend.
3. **The baseline is named and measured in the same run**, never quoted from elsewhere.

`oracle[task]` is the cheapest rung that actually passed every run it was given. Once built,
any router is scored against it offline, free, forever.

## What was NOT measured before this

**Whether a routing decision was correct.** Nothing above knows that. It measures what the
router does and what it costs, not whether the tier it picked could do the job.

That needs an oracle: the cheapest tier that actually succeeds at a task.

### Building the oracle (costs real money, run once)

1. Take tasks with mechanical pass/fail — SWE-bench Lite instances, or repo tasks whose
   tests decide the outcome. Corpus prompts mostly will not work: they depend on session
   state and have no independent success criterion.
2. Run each task at haiku, sonnet, and opus. Record pass/fail and actual token cost.
3. `oracle[task] = cheapest tier that passed`.

Once it exists, any router is scored against it offline, free, forever:

- **under-routing rate** — chose below the oracle tier; the task fails. The number that matters.
- **over-routing waste** — mean tiers above the oracle; money burnt for nothing.
- **cost regret** — spend ÷ what a perfect router would have spent.
- The headline: **cost at equal success rate**, or success rate at equal cost.

Rough cost: ~150 tasks × 3 tiers ≈ 450 runs. Budget $25–250 depending on task size.

**Hold out a test split before tuning anything.** We write the scorer; if we also tune it on
the set we report, the benchmark measures nothing. Tune on train, report on test, touch test
once.

## JEV-specific router bake-off

```bash
# One screening run (JEV_API_KEY is required).
npm run bench:routers

# Add the Haiku appraiser through the authenticated Anthropic endpoint.
ANTHROPIC_AUTH_TOKEN=... npm run bench:routers -- --include-llm

# Reproduce the committed three-run aggregate.
for run in 1 2 3; do
  ANTHROPIC_AUTH_TOKEN=... npm run bench:routers -- \
    --include-llm --out "bench/results/router-run-${run}.json"
done
npm run bench:aggregate -- --out bench/router-bakeoff-aggregate.json \
  bench/results/router-run-1.json bench/results/router-run-2.json bench/results/router-run-3.json
```

`mission-router-bakeoff.mjs` drives the local heuristic, TypeSafe Jev API, optional Haiku
appraiser, and all four fixed-tier controls over the same frozen 30-mission corpus. It reports
both the raw appraiser choice and the effective choice after JEV's policy. Fixed controls are
pinned and intentionally bypass policy. Raw artifacts are content-minimized and ignored under
`bench/results/`; `aggregate-router-bakeoffs.mjs` emits a reviewable aggregate without prompts.

Use `--tool-count N` and `--context-tokens N` to match the target harness snapshot. The
committed screen used zero for both and records that limitation in the artifact.

The current three-run result is in [`router-bakeoff-2026-09-29.md`](router-bakeoff-2026-09-29.md).
TypeSafe Jev beat the local heuristic before policy, but did not beat the Haiku appraiser. The
current upgrade-confidence policy materially changed both network appraisers: TypeSafe's
holdout under-routes rose from 5–6 raw to 11–12 after policy, and Haiku's rose from 3 to 9.
This is label agreement, not execution quality; the oracle remains the promotion gate.

## Limits

- One developer's prompt distribution, skewed to their work. A different user's mix differs.
- `profile.mjs` assumes equal tokens per prompt across tiers when comparing spend. Directional,
  not an invoice.
- Context size is estimated from transcript characters, not from the live request, so it
  understates what the relay sees (tool schemas dominate a real request).

---

## Results: building a React app (2026-09-18)

Six-turn scripted build of a Vite + React todo app, replayed identically against each arm.
Every arm was graded against the brief by `grade.mjs`, not just "did it compile".
n=1 per arm; the harness reproduces to ~0.2% on cost, so the deltas are signal, but
wall-clock differences under ~10% are not.

### Claude Code, MCP servers disabled (~130k context)

| arm | wall | spend | requirements |
| --- | --- | --- | --- |
| vanilla (all balanced) | 119s | $1.8749 | 7/7 |
| routed (jev) | 123s | $1.7257 | 7/7 |
| **ceiling (all cheapest)** | **104s** | **$0.4279** | **7/7** |

The ceiling arm is the finding. The cheapest rung built the complete app — every
requirement, tests passing — **77% cheaper and 13% faster** than the tier the CLI would
have used, with zero escalations. The task never needed the bigger model.

Routing captured **10% of that available saving**. The appraiser sent half the turns to the
middle rung, and at 130k context each switch costs a prompt-cache rebuild that eats what the
cheaper rung saves.

So: the headroom is real and large, and the router is not yet finding it. The mechanism that
should close the gap is the calibration loop — six clean `fast` turns are now in the ledger,
and `CALIBRATION.minTrials` needs 50 of them before it will widen the cheap boundary. That
is the system working as designed, slowly, rather than a missing feature.

### Claude Code, MCP servers enabled (~308k context)

Routing is a no-op. 227 tool schemas push every turn past the cheapest rung's 200k window,
so `canHold` removes it before the appraiser is consulted and the only legal choice is the
one the CLI would have picked anyway. Cost identical to the cent. `jev stats` says so.

### Codex (~31-48k context)

| arm | wall | spend | requirements |
| --- | --- | --- | --- |
| vanilla (all long) | 286s | $2.3724 | 7/7 |
| routed (jev) | 227s | $0.7038 | 7/7 |

**21% faster.** The cost column reads -70%, but the Codex rates are placeholders — the
backend exposes no pricing field, and routed actually used MORE tokens (478k vs 330k). The
entire dollar delta is the assumed price gap between `gpt-6-astra` and `gpt-5.6-luna/terra`.
Set `JEV_PRICES` to make that number real. The wall-clock and the 7/7 are measured.

### What this says about routing

1. **Quality parity is real.** Seven arms, every one 7/7. Routing down did not ship less.
2. **The saving is real and mostly unclaimed** — 77% available, 10% captured on Claude.
3. **Context size decides everything.** Below ~50k routing wins; at 130k the prompt cache
   eats it; above 200k the cheap rung is not reachable at all.
4. **The honest headline is not "jev makes it cheaper."** It is "the cheap model was enough,
   and something has to notice." Today that something captures a tenth of it.
