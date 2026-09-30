# JEV router bake-off aggregate

Runs: 3
Run IDs: 2026-09-29T19:35:32.546Z, 2026-09-29T19:35:39.414Z, 2026-09-29T19:35:48.165Z
Corpus SHA-256: `dcab52be97b734d46c4bc6d5b387edb42d4cc9b275a44740ac9980f5af330a3c`
Implementation SHA-256: `e645d66cc0f55cdddf15bbd502222b1fab0b0865d87faa3c9ad9b0face3967c6`
Models: TypeSafe `jev-latest`; LLM `claude-haiku-4-5-20251001`
Origins: TypeSafe `https://api.typesafe.ai`; LLM `https://api.anthropic.com`
Enabled tiers: fast, balanced, strong
Policy: current=balanced, context=0, tools=0, cache=false, floor=null, cutoffs={"cheap":0.28,"strong":0.58}

> Routing-label agreement only. No selected model executed a mission. Fixed controls are pinned and bypass policy.

Holdout cells are exact / under / over for each run.

| arm | raw runs | policy runs | fallbacks | median routing latency |
| --- | --- | --- | --- | --- |
| local | 8/9/4 · 8/9/4 · 8/9/4 | 9/9/3 · 9/9/3 · 9/9/3 | 0 · 0 · 0 | 0 ms · 0 ms · 0 ms |
| jev | 9/6/6 · 10/5/6 · 11/5/5 | 8/11/2 · 7/12/2 · 8/11/2 | 0 · 0 · 0 | 156 ms · 148 ms · 148 ms |
| llm | 13/3/5 · 13/3/5 · 13/3/5 | 10/9/2 · 10/9/2 · 10/9/2 | 0 · 0 · 0 | 446 ms · 442 ms · 448 ms |
| fixed-fast | 5/16/0 · 5/16/0 · 5/16/0 | n/a (pinned control) | 0 · 0 · 0 | 0 ms · 0 ms · 0 ms |
| fixed-balanced | 7/9/5 · 7/9/5 · 7/9/5 | n/a (pinned control) | 0 · 0 · 0 | 0 ms · 0 ms · 0 ms |
| fixed-strong | 6/3/12 · 6/3/12 · 6/3/12 | n/a (pinned control) | 0 · 0 · 0 | 0 ms · 0 ms · 0 ms |
| fixed-long | 3/0/18 · 3/0/18 · 3/0/18 | n/a (pinned control) | 0 · 0 · 0 | 0 ms · 0 ms · 0 ms |

The arms are intentionally not ranked. These labels are a screening proxy, not a production promotion gate.
