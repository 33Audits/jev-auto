# Repeated Lisa + JEV end-to-end benchmark

**Run date:** 2026-09-30  
**Evidence:** 18 live Claude Code sessions using Lisa native MCP and a real Playwright browser against a deterministic local staging fixture.  
**Comparison:** fixed Sonnet vs TypeSafe-JEV-routed Claude Code.  
**Repetitions:** 3 per arm for each of 3 mission classes.

## Mission classes

1. **Smoke:** verify the page heading and working button; report only scoped issues.
2. **Detect:** exercise both buttons and report the seeded HTTP 500 and broken-button console defect.
3. **Full:** detect both defects, submit an initial Lisa report, patch the fixture source, start a fresh Lisa session, and submit a clean re-verification report.

Arm order alternated by repetition. Every run started from the same seeded source, used isolated Lisa state/artifact directories, and received the same mission-specific prompt and limits within its pair.

## Results

| Mission | Fixed Sonnet | JEV-routed | JEV tier | Fixed total cost | JEV total cost | Cost change | Fixed mean duration | JEV mean duration |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| Smoke | 3/3 | 3/3 | fast ×3 | $3.5006 | $3.2166 | -8.1% | 32.9s | 16.9s |
| Detect | 3/3 | 3/3 | balanced ×3 | $3.4239 | $3.4892 | +1.9% | 43.4s | 43.0s |
| Full fix/re-verify | 2/3 | 3/3 | balanced ×3 | $7.0378 | $4.6845 | -33.4% | 93.2s | 101.9s |
| **Overall** | **8/9** | **9/9** | — | **$13.9623** | **$11.3903** | **-18.4%** | **56.5s** | **53.9s** |

### Cost per verified success

- Fixed Sonnet: **$1.7453**
- JEV-routed: **$1.2656**
- Difference: **27.5% lower** for JEV in this sample

### Full mission details

- Fixed Sonnet completed 2/3 full QA → fix → re-verify missions.
- One fixed run correctly patched both defects but exhausted its turn limit before replacing the initial two-bug report with a clean re-verification report.
- JEV completed 3/3 full missions.
- JEV averaged 26.7 turns versus fixed Sonnet's 32.3 turns for full missions, a 17.5% reduction.
- Full-mission JEV cost was 33.4% lower in aggregate, while mean wall-clock duration was 9.4% higher because one routed run was slow despite using fewer turns.

## Routing behavior

TypeSafe JEV consistently distinguished the mission classes:

- All three narrow smoke checks → `fast`
- All three defect-detection missions → `balanced`
- All three fix-and-re-verify missions → `balanced`

The selected tier remained pinned for each mission. Subsequent per-step appraisals were shadow-only and did not switch the serving tier mid-mission.

## Verdict

This repeated fixture benchmark supports the claim that the architecture is functional and promising:

- JEV preserved or improved verified completion in all three mission classes.
- It selected the cheaper tier for every simple smoke mission.
- Across all attempted runs, it reduced total cost by 18.4% and cost per verified success by 27.5%.

It does **not** establish production superiority. The sample is small (three repetitions per arm), uses one deterministic toy application, and shows substantial run-to-run cost variance from model nondeterminism and caching. The next gate is a larger randomized benchmark across multiple real staging applications and mission types.

## Evidence included in this branch

Machine-readable aggregate: `bench/results/lisa-e2e-repeated-2026-09-30.json`.

The aggregate contains all 18 run summaries: mission, repetition, arm, pass/fail grade, CLI status, turns, cost, duration, routed tier, final report bug count, and timeout state. Raw browser screenshots and model transcripts remain local because they can contain environment-specific page content and are not required to reproduce the aggregate claims.
