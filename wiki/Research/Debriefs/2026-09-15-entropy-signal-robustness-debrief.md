---
title: Entropy Signal Robustness — Debrief
date: 2026-09-15
status: complete
tags: [entropy, reactive-intelligence, composite, dashboard, debrief, failure-mode]
---

# Entropy Signal Robustness — Debrief

Root-cause fix for FM-C3 (phantom entropy divergence). Trigger: a successful,
efficient crypto-lookup run graded **D** with an "Entropy diverging" warning —
traced to four compounding sensor defects plus dashboard credulity.

## What was wrong (verified against run `01M2K7Q6JSAX0K2C0BYJ89HS79`)

1. **Double scoring.** Kernel-inline observer (iteration = `completedIteration`:
   0, 4, 7) and the runtime engine's inlined event collector (iteration =
   `ReasoningStepCompleted.step`: 0, 2) both pushed every thought into one
   shared per-task trajectory. The duplicate (same thought, 2 ms apart, +0.07
   composite from the bypass/category mismatch) tipped the recent-3 slope to
   +0.081 → final point classified "diverging" on a flat sequence. All five
   shape labels were reproduced exactly from the interleaved history.
2. **Inverted structural source.** `meanStructural` returned quality while the
   composite consumes disorder (behavioral explicitly inverts; structural did
   not). Well-structured, data-rich thoughts scored 0.85 "entropy".
3. **Bypass weight discontinuity.** Iteration ≤ 2 ignored `taskCategory` —
   the same thought scored 0.639 at label 0 vs 0.569 at label 4.
4. **Dead semantic source.** `taskAlignment` is always 0 (`taskEmbedding`
   hardcoded null).
5. **Dashboard hard-map.** `diverging → "D"` with no confidence gating, shapes
   trusted from polluted history.

The RI controller also acted on the phantom signal mid-run (`tool-inject`:
"Use the web-search tool…", staged in `pendingGuidance` after the task was
done). Post-Task-5 (`30be765a`), strategy-switch requires kernel
corroboration, so tool-inject was the remaining exposed actuator.

## What changed

| Area | Change |
|---|---|
| `core` | `KERNEL_INLINE_ENTROPY_STRATEGIES` + `scoresEntropyInline` (single source; avoids an RI→reasoning dep cycle) |
| `reasoning` | Re-export via `kernel-constants` + index; coverage predicate test |
| `runtime` | Engine collector skips kernel-scored strategies |
| `reactive-intelligence` | Subscriber skips kernel-scored strategies; sensor dedups consecutive identical thoughts per task; `meanStructural` → disorder; bypass ≡ normal weights (confidence still low); semantic source = `noveltyScore`; retry-safe NOTE updated |
| `observability` | Dashboard recomputes trajectory from deduped displayed points; low-confidence runs capped at C with degraded-signal note; divergence/loop alarms and recommendations gated on confidence |
| `wiki` | FM-C3 entry |

Validation corpus after the fix: high-signal 0.000–0.066, ambiguous
0.218–0.279, low-signal 0.344–0.580 — 100% / 100% / 100% at the retuned
thresholds, with real margins (previously overlapping). Reconstructed healthy
run under the fixed sensor: ~0.42 → ~0.26 → ~0.26, converging, grade A/B
instead of D.

## Verification

- `reactive-intelligence`: 532 pass / 0 fail
- `observability`: 234 pass / 0 fail
- `reasoning`: 2837 pass / 0 fail
- `runtime`: 1556 pass / 3 skip / 1 fail — the failure is WS-5b
  (`as unknown as` ceiling 78 vs 97 sites), verified pre-existing via
  `git stash` (97 sites with and without this change)
- `typecheck` clean: core, reasoning, reactive-intelligence, runtime,
  observability; `build` clean: core, reasoning, reactive-intelligence

## Open / not done

- Weight tables remain unvalidated (RC-4, still open on main) — this fix
  changes orientation/continuity, not weights.
- `ENTROPY_CONVERGENCE_THRESHOLDS` never firing is plausibly explained by the
  inversion (good runs sat at 0.55–0.70, above the 0.4 bar); worth re-checking
  now that well-structured runs score ~0.0–0.3.
- Pre-existing WS-5b ceiling breach (97 vs 78) is unrelated and untouched.
- Calibration samples recorded under the inverted orientation are
  incomparable with post-fix samples (drift event may fire once).
