---
aliases: [FM-C1, FM-C2, Reasoning Quality]
tags: [failure-mode, reasoning, empirical]
category: FM-C
---

# FM-C: Reasoning Quality

**Category:** Reasoning & Strategy Selection

**Status:** ✅ Phase 1 Complete (strategy switching validated)

**Evidence Base:** 30+ runs with varying task complexity across 4 models

---

## FM-C1: Red-Herring Reasoning

**Manifestation:** Agent pursues irrelevant directions, reasoning diverges from task goal.

### Symptom

- Task: "Summarize the healing pipeline mechanism"
- Agent response: "The healing pipeline works with tools. Let me first research what a tool is in software..." (diverges into unrelated tangent)
- Token waste on irrelevant exploration
- Task incompleteness or wrong answer

### Reproduction

**Frequency:** ~12% of runs on open-ended tasks

### Root Cause

- **Lack of task focus:** Agent doesn't maintain tight constraint on goal
- **Curiosity-driven exploration:** Model explores interesting tangents
- **No mid-run adjustment:** Continues down wrong path without correction

### Mitigations

- ✅ M2: Strategy Switching — Select "todo" or "plan-execute" for complex tasks (enforces planning)
- ✅ M1: RI Dispatcher — Entropy spike triggers intervention on divergence
- 🔄 Phase 1.5: M7 Calibration activation (reasoning-depth field)

---

## FM-C2: Long-Form Regression

**Manifestation:** Accuracy drops as response length increases (loses details mid-response).

### Symptom

- Short response: "The healing pipeline has 4 stages" — 100% accurate
- Long response: "The healing pipeline... [300 tokens later] ...and the final stage is [hallucinated details]" — accuracy drops to 40%

### Reproduction

**Frequency:** ~8% of runs on responses >500 tokens

### Root Cause

- **Context window pressure:** Model loses earlier context as response grows
- **Attention decay:** Model attends more to recent tokens, forgets constraints
- **No periodic grounding:** Doesn't re-validate against original task midway

### Mitigations

- ✅ M3: Verifier + Retry — Detects low-confidence sections (semantic entropy)
- ✅ M5: Context Curation — Compression keeps context window healthy
- 🔄 Phase 1.5: M3 improved retry context (data specificity signals)

## FM-C3: Phantom Entropy Divergence (double-scored trajectory)

**Manifestation (observed 2026-09-15, run `01M2K7Q6JSAX0K2C0BYJ89HS79`):** a
successful, efficient run (5.8s, 7 steps, 2 tool calls) graded **D** with an
"Entropy diverging" warning and a tool-inject nudge to call web-search *after*
the deliverable was written.

**Root causes (all fixed 2026-09-15):**

1. **Double scoring.** The kernel observer (`runReactiveObserver`,
   iteration = kernel `completedIteration`) and the runtime engine's event
   collector (`execution-engine.ts`, iteration = `ReasoningStepCompleted.step`)
   both scored every thought into one shared per-task trajectory with
   incompatible labels. The duplicate's phantom composite tipped the
   recent-3 slope over +0.05, so the final point classified "diverging" on a
   flat sequence. Fix: `scoresEntropyInline` gate
   (`@reactive-agents/core`) — engine/RI collectors skip kernel-scored
   strategies; sensor also dedups consecutive identical thoughts per task.
2. **Inverted structural source.** `meanStructural` returned quality
   (high = well-formed) while the composite consumes disorder (high = bad) —
   unlike `meanBehavioral`, which explicitly inverts. Well-structured runs
   read as high, rising entropy. Fix: `meanStructural` now returns disorder.
   Post-fix validation corpus: high-signal 0.000–0.066, ambiguous
   0.218–0.279, low-signal 0.344–0.580 (was: overlapping).
3. **Weight discontinuity at the short-run bypass.** Iteration ≤ 2 ignored
   `taskCategory`, so the same thought scored ~0.07 higher under iter-0/2
   labels than under iter-3+ labels. Fix: one `resolveWeights` path; the
   bypass now differs only in `confidence: "low"`.
4. **Dead semantic source.** `taskEmbedding` is always null on the sensor
   path, so `taskAlignment` was a constant 0. Fix: source uses
   `noveltyScore` (disorder-oriented).
5. **Dashboard trusted baked labels.** Grade D and the divergence alert came
   from per-point shapes computed against the polluted history, with no
   confidence gating. Fix: the console exporter recomputes trajectory shape
   from the deduplicated displayed composites, caps low-confidence runs at C,
   and reports a degraded-signal note instead of a confident divergence.

**Regression tests:** `entropy-history-dedup`, subscriber skip test,
`kernel-entropy-coverage`, composite continuity, validation thresholds,
dashboard recompute test (`exporters.test.ts`).

---

## Integration Testing (Phase 2)

**Composition to test:** M2 + M1 + M3

- Scenario: FM-C1 red-herring detected by M1 entropy spike → M2 strategy adjustment
- Scenario: FM-C2 regression detected by M3 verifier → retry with specificity signals

---

## References

- [[Failure-Modes/00 FM Catalog|FM Catalog]] — All failure modes
- [[Experiments/M2 Strategy Switching|M2 Strategy Switching]]
- [[Experiments/M3 Verifier and Retry|M3 Verifier & Retry]]

---

**Last Updated:** 2026-05-04  
**Phase:** Phase 1 Complete  
**Confidence:** MEDIUM (20+ runs; real LLM validation Phase 1.5)
