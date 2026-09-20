# Bundle: kernel-termination-regression
Date: 2026-09-19
Budget: 90 min
Issues: #207 (fixed), #206 (descoped — see below)

## Acceptance criteria
- #207: North Star gate (`packages/testing/tests/gate/north-star-gate.test.ts`) passes; root cause documented, not just patched around.

## What actually happened

#207 turned out not to be a kernel regression. Bisected `c8b8b418..dev` (git bisect,
6 steps) to `d43de304` ("single scorer per thought") as first-bad. Traced the
mechanism: `packages/testing/src/gate/runner.ts:65-74` computes the gate's
`iterations` metric as `Math.max(...entropy-scored event.iter) + 1` — a fallback,
because `run-completed` trace events never carry an explicit `iterations` field
(`packages/trace/src/normalize.ts:70-91`). Before `d43de304`, kernel-strategy
thoughts were scored twice per thought (once by the kernel's inline observer,
once by `execution-engine.ts`'s `ReasoningStepCompleted` subscriber) — two
`entropy-scored` events per one real LLM call inflated the fallback count from 1
to 2. `d43de304` gated the duplicate (`scoresEntropyInline`) as its stated fix;
the "regression" was the metric correctly dropping back to 1 for a genuinely
single-iteration run. Baseline was stale, not the kernel.

Fixed by regenerating the baseline (`bun run gate:update --reason ...`,
commit `c6db724a`) rather than touching kernel/decide code — the kernel's
1-iteration behavior is correct; forcing it back to 2 would have reintroduced
the double-count.

## #206 — descoped, not executed this pass

Re-read the issue before starting: its own "Suggested direction" section states
this is "a larger, riskier change than [the] sweep bar allows" and should be
"scope[d] as its own design pass rather than a quick patch" — it's asking for a
new user-facing abstention-message design, not a mechanical fix. Bundling it
into a 90-min TDD pass would mean inventing that UX under time pressure, which
contradicts the issue's own explicit guidance. Left open with a comment
explaining the descope; recommend a dedicated design pass, not a re-bundle.

## Verification
- `bun test packages/testing/tests/gate/north-star-gate.test.ts` — 1 pass, 0 fail (was 14 regressions)
- `bun run build` — 37/37
- `bunx turbo run typecheck` — 66/66
- `bun test` (full) — 9429 pass / 25 skip / 4 todo / 1 fail (the known pre-existing `as-unknown-as` ceiling gap, unrelated to this bundle)

## Out of scope
- #206 — needs its own design pass (see above).
- #31/#32/#33 (observability exporters, Sprint 4) — not part of this bundle.
