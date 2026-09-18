---
name: jev-why
description: Explain why jev-auto routed the last turn to the model it chose. Use when the user asks why a turn went to haiku/sonnet/opus, asks about routing, or types /jev-why.
---

# jev-why

Show the routing decision for the most recent turn in this session.

Run exactly this, and print the output verbatim inside a code block:

```bash
jev why "$CLAUDE_SESSION_ID"
```

If `jev` is not on PATH, run `node <repo>/bin/jev.mjs why "$CLAUDE_SESSION_ID"` instead.

The report is rendered from what was recorded at the moment the decision was made. Do not
recompute it, do not re-score the prompt, and do not guess at any field it does not show.

If the user asks what it would cost, or how routing is doing overall, run `jev stats` and
show that too.
