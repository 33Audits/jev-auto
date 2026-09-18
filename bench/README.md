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

## What is NOT measured, and it is the important one

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

## Benchmarking against jev-router head-to-head

Not possible today without a TypeSafe key: `jev-router` does not route at all without one, so
comparing to it now would be comparing to no-routing, which is a strawman. With a key, its
decision function can be driven over the same corpus and scored against the same oracle.

Until then, the honest head-to-head claims are the ones that do not need an oracle:

| | measured |
| --- | --- |
| decision latency | `profile.mjs` reports ours; theirs is 0.3–1.0 s per their own README |
| turns routed with no key | ours: all. theirs: none. |
| third-party dependency at decision time | ours: none by default. theirs: required. |

Decision *quality* is not on that list on purpose. A real model asked a real question may well
beat a regex scorer, which is why the `llm` and `jev` appraisers exist.

## Limits

- One developer's prompt distribution, skewed to their work. A different user's mix differs.
- `profile.mjs` assumes equal tokens per prompt across tiers when comparing spend. Directional,
  not an invoice.
- Context size is estimated from transcript characters, not from the live request, so it
  understates what the relay sees (tool schemas dominate a real request).
