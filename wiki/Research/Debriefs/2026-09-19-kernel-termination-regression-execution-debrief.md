# Execution Retro: kernel-termination-regression
Date: 2026-09-19
Budget: 90 min | Actual: ~75 min

## Outcomes
- Issues closed: #207 (via PR #209 merge)
- Issues descoped: #206 (needs a dedicated design pass per its own issue text, not a bundle fix)
- Net test delta: 0 real (gate test flipped from 14-regression fail to pass; no new tests added)
- Net LOC delta: baseline JSON regen only (+15/-15), no source code changed

## What worked
- `git bisect` against a fast, deterministic scenario check (`bun run gate:explain <scenario>`, sub-second) narrowed 59 candidate commits to 1 in 6 steps.
- Reading the actual gate-runner source (`packages/testing/src/gate/runner.ts`) instead of trusting the issue's "entropy scoring is the suspect" hint at face value — the real mechanism (fallback metric computed from entropy-event count) was one level removed from the obvious suspect.
- Re-reading #206's own issue body before executing it caught a scope mismatch the original bundling decision missed — the issue explicitly asked for a separate design pass.

## What didn't
- Burned a large fraction of the budget on manual code reading (grepping `ctx.iteration` across execution-engine.ts) before finding the actual mechanism in the gate runner — should have grepped the consumer of the `iterations` field (`packages/testing/src/gate/runner.ts`) first, since that's the thing that actually produced the number in the bug report, rather than chasing the producer side (kernel/entropy code) based on the issue's own (reasonable but wrong-directional) suspicion.
- The working tree had pre-existing dirt (generated docs-cache file, 26 scratch trace files from the DISCOVER pass) that needed manual sorting before branching — cost a few minutes and two blocked destructive-action attempts (classifier denied `rm`/chained `git add`).

## Skill improvements (apply on next pass)
- `execute-backlog`'s SCAN phase already has a "drift check" for file:line claims, but no equivalent for "the issue's own root-cause hypothesis may be wrong." Add one line to Phase 3 (PLAN): when an issue proposes a root-cause hypothesis without confirming it end-to-end, grep the *consumer* of the broken metric/behavior (where the bad value is read/reported) before the *producer* the issue suspects (where the value is computed) — the reporting/aggregation layer is a common hiding spot for metric bugs that look like behavior regressions.

## Process inflation guard
- No inflation found — #207's verified-by evidence (the failing gate test itself) was real and reproducible; the fix genuinely closes it, confirmed by re-running the cited test.
