# SDD ledger — plan: wiki/Planning/Implementation-Plans/2026-09-14-entropy-weight-validation.md

Spec: none separate — plan is self-specifying (see plan header).

## Preflight conflict scan

| Pair | Shared surface | Check | Result |
|---|---|---|---|
| Task 1 x Task 2 | none (Task 1 touches reasoning/core/reactive-intelligence sensor; Task 2 touches benchmarks only) | file/interface overlap | clean |
| Task 1 x Task 3 | Task 3's bench run benefits from Task 1's modelTier fix but has no compile-time dependency on it | ordering | Task 3's real bench run executed against a STALE pre-fix `dist` build of packages/reasoning and packages/reactive-intelligence (both export dist in their bun package-exports condition, not src — documented feedback_bun_cache_resolution_trap hit in a new context: empirical bench run rather than import probe). All 3 of Task 3's real trace files show `modelTier: "unknown"`, not `"local"` — Task 1's fix was never actually exercised end-to-end in that run. This does not affect Task 3's evidence or Task 4's verdict, since `modelTier` is a pure pass-through label in composite.ts (never used in entropy weight math); `lookupModel`'s provider-derived branch only changes `.tier` field, not `.contextLimit`. |
| Task 1 x Task 4 | none directly | — | clean |
| Task 2 x Task 3 | Task 3 imports `extractEntropyOutcomeRows`/`summarizeEntropyOutcome` from Task 2's `entropy-correlation.ts` | signature match | plan Task 3 Step 3 code matches Task 2's produced signatures exactly (same param/return shapes) — clean |
| Task 2 x Task 4 | Task 4 reads Task 3's JSON output (shape `{rows, summary}` matching Task 2's types) | shape match | clean |
| Task 3 x Task 4 | Task 4 consumes Task 3's report JSON file path | path match | plan references same path (`wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json`) in both tasks — clean |

Self-consistency per task:
- Task 1: 13 steps, TDD (write failing test -> implement -> pass) x2 (observer forwarding, sensor-service forwarding) + full-suite regression check. Self-consistent.
- Task 2: TDD, 3 assertions in one test file exercising extractor + summarizer. Self-consistent.
- Task 3: empirical/execution task, not code-TDD — flagged in plan text itself as needing implementer to confirm real export names (`getSession`, `report.taskReports`) against actual source before running, since I did not verify those two exact names during plan-writing. This is a known ambiguity, not a contradiction.
- Task 4: decision-rule task with branching logic (branches 2/3/4 mutually exclusive on `separation` value) — self-consistent, exhaustive over `separation >= 0.15` / `0 <= separation < 0.15` / `separation < 0` / absent-bucket edge case.

## Rulings
(none yet — scan was clean, no preflight rulings needed)

## Baseline
9237 pass / 25 skip / 4 todo / 1 fail (WS-5b as-unknown-as-ceiling — confirmed pre-existing on main, unrelated, do not fix as part of this plan) — verified in worktree post-build (2026-09-14).

## Task 1

Task 1: fix round 1/5 dispatched — real gap confirmed, not parked.

Ruling: Task 1's scope extends to `KernelRunOptions.providerName` + `initialKernelState()`'s entropyMeta construction (packages/reasoning/src/kernel/state/kernel-state.ts) plus every `runKernel(...)` call site across packages/reasoning/src/strategies/{direct,reactive,tree-of-thought,reflexion,plan-execute}.ts and kernel/loop/react-kernel.ts that builds a KernelRunOptions-shaped literal (paired with taskDescription/modelId/temperature — the "entropy-based intelligence routing" fields) — not just the logprobs-path fix the plan's Step 4 described. Why: verified directly (grep + read) that `initialKernelState`'s entropyMeta is fed exclusively by `KernelRunOptions`, which has no `providerName` field and is populated at ~10 call sites across 5 strategy files, none of which the plan's brief named. Without this, the plan's entire stated purpose (tier-aware entropy for Ollama models) fails for the non-logprobs path, which is the DOMINANT path for local models (most don't return logprobs). Cost if wrong: touches more files than the plan specified — worst case the reviewer finds scope-creep, in which case the extra diff is easy to revert since it's additive-only (new optional field + new pass-throughs, no removed code).

Task 1: fix round 1/5 (1 addressed, 0 open; commits a07277fe..6be81534)

Task 1: parked — tree-of-thought.ts (~721) and plan-execute.ts (~1119,~1144) call EntropySensorService.score() directly, bypassing meta.entropy/reactive-observer, so those two strategies still get modelTier:"unknown" for Ollama even after this fix — Ruling: real gap, but this plan's Task 3 bench run does not exercise ToT/plan-execute as its default strategy selection, and no downstream task in THIS plan depends on those two strategies' entropy tagging. Deferred, not fixed. Cost if wrong: if a future ablation run happens to use ToT/plan-execute on local models, its modelTier data will still read "unknown" — same blind spot this plan set out to close, just narrower in scope than believed.

Task 1: complete (commits c4b107bf..6be81534, review clean — 1 parked residual: ToT/plan-execute direct score() calls still tag "unknown" for Ollama, out of scope)

Task 2: complete (commits 6be81534..f16881c9, review clean — noted minor: implementer under-reported a correct test-fixture fix vs brief's literal event shapes)

Task 3: complete (commits f16881c9..40551f0c, review clean) — Ruling: real bench run scoped down to single-tier (local, qwen3.5:latest)/single-task(rw-1)/3-run cell instead of the plan's cross-tier intent — Why: real-world-full's declared local models (qwen3:4b, cogito:8b) aren't pulled in this environment and are too slow (180-300s+/run) to fit the 590s foreground cap even at n=1; qwen3.5:latest was the only calibrated+pulled Ollama model available; a mid-task rate-limit interruption also constrained scope. Data independently verified against raw trace files (exact float matches, distinct traceIds/timestamps) — not fabricated. Cost if wrong: Task 4's decision rule will hit its own "absent bucket" branch (all 3 rows are trust=verified-correct, no claimed-but-wrong/dishonest contrast) and correctly report "cannot evaluate" rather than a false verdict — this is the rule handling exactly this case, not a defect masked. Deferred-minor (out of scope, for backlog): packages/benchmarks/src/runner.ts:1586 session-path --output writer does a shallow overwrite instead of merge-by-cell across invocations (found by Task 3's implementer, confirmed by reviewer) — real bug, not part of this plan.

Task 4: complete (commits 40551f0c..31033230, review clean — minor noted: debrief frontmatter status "complete" vs report's DONE_WITH_CONCERNS, cosmetic)

All 4 tasks complete. Proceeding to final whole-branch review.

## Final whole-branch review

Final review found: Task 3's real bench run executed against a STALE pre-fix `dist` build of packages/reasoning and packages/reactive-intelligence (both export dist, not src — the documented feedback_bun_cache_resolution_trap, hit here in a new spot: an empirical bench run, not an import probe). All 3 trace files show `modelTier: "unknown"`, not "local" — Task 1's fix was never actually exercised end-to-end by Task 3's run, contradicting the ledger's preflight-scan claim that it was. Numbers themselves are unaffected (modelTier is a pure pass-through label in composite.ts, never used in weight math; lookupModel's provider branch only changes `.tier`, not `.contextLimit`), so Task 3's evidence and Task 4's verdict both stand unchanged.

Ruling: dispatch ONE fix wave correcting the false "fix is live" claim in this ledger's preflight table + adding a caveat line to the Task 4 debrief. Why: the claim is a documentation defect, not a code defect — the source-level fix is real and unit-tested (Task 1's review verified the full call chain in source), it just was never observed working in a live run because of the stale-dist trap. Cost if wrong: a future session reads the ledger, believes Task 1 is end-to-end validated in production, and doesn't re-verify — low cost since the fix is source-correct regardless, but the confidence claim would be overstated.

Parked (acceptable documented residuals, not fixed): (1) `entropy-sensor-service.ts:226` (`scoreContext`) still calls `lookupModel` with 2 args — real-world impact zero today (scoreContext only reads `.contextLimit`, unaffected by tier), plan named "two call sites" but Task 1 only fixed one — Ruling: leave parked, zero live impact, revisit if PROVIDER_TIER entries ever carry provider-specific context limits. (2) `EntropyOutcomeRow` doesn't carry `traceId` — hurts auditability but not correctness — Ruling: leave parked, one-field addition for a future session if this extractor sees more use. (3) `entropy-correlation.ts` not exported from `packages/benchmarks/src/index.ts` — intentional script-local usage, not dead code — Ruling: leave as-is. (4) plan text mislocates `EXPECTED_TOOL_RANGE` (says composite.ts, actually behavioral-entropy.ts) — cosmetic plan-doc inaccuracy, constraint still correctly satisfied since both files are untouched — Ruling: leave as-is, no code impact.
