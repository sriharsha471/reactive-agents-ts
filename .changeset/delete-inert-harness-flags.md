---
"@reactive-agents/reasoning": minor
"@reactive-agents/tools": minor
"@reactive-agents/runtime": patch
---

Removed three experimental harness mechanisms that the 2026-09-15 ablation-warden pass (`wiki/Decisions/2026-09-15-experimental-flag-verdicts.md`) found INERT on the golden corpus with no accuracy lift on the one live tier measured, and — for two of them — a large live token cost: `RA_OVERHAUL` (the `write_result_to_file` meta-tool), `RA_THOUGHT_CONTINUITY` (replaying the model's own prior thought on assistant turns), and `RA_TOOL_OBSERVE_SYMMETRY` (attaching a `VerificationResult` to the single-tool-call observation path). Each was default OFF and never promoted; this deletes the dead opt-in surface rather than leaving it unmeasured.

Breaking for direct importers of `@reactive-agents/reasoning`'s `overhaulEnabled`, `thoughtContinuityEnabled`, and `toolObserveSymmetryEnabled`, and of `@reactive-agents/tools`'s `writeResultToFileTool` / `makeWriteResultToFileHandler` — all five exports are removed. `HarnessConfig`/`ResolvedHarness` lose the `thoughtContinuity` and `toolObserveSymmetry` fields. No default behavior changes: every mechanism was already OFF by default.

`RA_TOOL_INDEX` and `RA_RATIONALE_AUDIT` were also assessed in the same pass and verdicted KEEP-OPT-IN (insufficient measurement power / non-accuracy audit purpose respectively) — no code change, only a JSDoc pointer to the decision doc.
