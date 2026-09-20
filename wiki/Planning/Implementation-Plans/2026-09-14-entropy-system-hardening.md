---
title: Entropy System Hardening
date: 2026-09-14
status: proposed
tags: [entropy, reactive-intelligence, trace, kernel, plan]
---

# Entropy System Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the entropy signal honest about its own degradation, observable end-to-end in traces, and driven by a single coordinated loop-stuck authority instead of two competing ones.

**Architecture:** Three independent layers are broken and each is fixed in place rather than replaced. (1) The *domain* already models source unavailability as `number | null`; the *trace* layer silently coerces it to `0`, destroying the distinction — fix the schema and the mapper so unavailability survives to disk. (2) `confidence`/`trajectory`/`modelTier` are computed and bus-published but have no trace field and no consumer — carry them through and make the degraded case legible. (3) Two loop-stuck detectors (kernel streak counter, RI entropy loop-score) fire independently one iteration apart and stack guidance into the same context window — make the kernel the single trigger authority and demote RI's signal to a confirming input.

**Tech Stack:** TypeScript (strict, no `any`), Effect-TS, Bun test runner, `@reactive-agents/trace`, `@reactive-agents/reactive-intelligence`, `@reactive-agents/reasoning`.

**Spec:** No prior spec — this plan is grounded in empirical diagnosis from the 2026-09-14 audit session. Evidence is inline per task (trace runIds, file:line, live probe output). File a debrief at `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md` on completion.

## Evidence Base

Live probes, `qwen3.5:latest` via Ollama, tracing on:

| runId | Task shape | Iters | Outcome |
|---|---|---|---|
| `01M2GKEDSXXVGRFAGBC7CE2HEK` | 3-topic web-search synthesis | 10/12 | success, maxEntropy 0.635, 0 interventions |
| `01M2GKFRM9C5VJANHPK1VYP1DR` | FP-language-history research | 10/15 | success, maxEntropy 0.673, 0 interventions |
| `01M2GM1SZ0FVXDD3TNN0F9FZ5A` | adversarial: forced repeat `http-get` to blocked address | 7 | failed, `terminatedBy: "switching_exhausted"` |

Observed in all three: every `entropy-scored` event reports `token:0, semantic:0, contextPressure:0`. Only `structural` (~0.55, near-static) and `behavioral` (0.5→0.33) ever move.

## Root Causes (verified against source, 2026-09-14)

**RC-1 — Null-vs-zero conflation at the trace boundary.** `EntropyScore.sources.token` and `.semantic` are `number | null` in the domain type (`packages/reactive-intelligence/src/types.ts:84-90`). `packages/trace/src/normalize.ts:101,103` coerces both with `?? 0`. `EntropyScoredEvent.sources` (`packages/trace/src/events.ts:123-129`) types every source as non-nullable `number`. Consequence: "this source was structurally unavailable" and "this source measured exactly 0" are the same bytes on disk. This is precisely why the live probes could not distinguish degradation from genuine zeros.

**RC-2 — Confidence computed, published, discarded.** `computeCompositeEntropy` returns `confidence: "high" | "medium" | "low"` (`packages/reactive-intelligence/src/sensor/composite.ts`, and `types.ts:94`). `packages/reasoning/src/kernel/capabilities/reflect/reactive-observer.ts:144-147` publishes `confidence`, `trajectory`, `modelTier`, `iterationWeight` onto the event bus. `normalize.ts:93-108` maps none of them. `REQUIRED_FIELDS_BY_KIND["entropy-scored"]` (`events.ts:484`) is `["composite","sources"]`. No consumer anywhere reads entropy `confidence`.

**RC-3 — Two uncoordinated loop-stuck detectors.** Kernel-side: a repeated-identical-failure streak redirect in `packages/reasoning/src/kernel/loop/iterate-pass.ts` fired at iteration 2 (streak=2) in run `01M2GM1SZ0FVXDD3TNN0F9FZ5A`. RI-side: `evaluateStrategySwitch` (`packages/reactive-intelligence/src/controller/strategy-switch.ts:30,35`) fired at iteration 3 (`behavioralLoopScore` 0.63) and again at 6 (0.69). Both answer "is the agent stuck?" independently, on different cadences, and both inject guidance the model must reconcile in one context window. Two switches inside four iterations exhausted the switch budget.

**RC-4 — Weight and threshold tables asserted, never measured.** `CATEGORY_WEIGHTS` (`composite.ts:22-32` — 8 categories × 4 sources = 32 constants), `WEIGHTS_WITH_LOGPROBS` / `WEIGHTS_WITHOUT_LOGPROBS` (`composite.ts:5-20`), `strategy-switch.ts:30` (`flatEntropy < 0.35`) and `:35` (`behavioralLoopScore <= 0.45`), `ENTROPY_CONVERGENCE_THRESHOLDS` (`packages/reasoning/src/kernel/capabilities/decide/arbitrator.ts:274-279`). Several carry rationale comments; none cites an ablation run. Conformal calibration (`conformal.ts`) recalibrates *thresholds* only — it never touches these weight tables.

**RC-5 — `decision-evaluated.confidence` degenerates to 0 for strategy switches.** `normalize.ts:113,121` computes confidence as `hasImprovement ? Math.max(0, 1 - entropyAfter/entropyBefore) : 0`. `ReactiveDecision` bus events for `switch-strategy` carry no `entropyBefore`/`entropyAfter`, so the `: 0` fallback always wins — even though the decision's own `reason` string carries real magnitude (loop score 0.63 vs 0.69).

### Corrections to earlier session claims — do not propagate these

- **`switching_exhausted` with empty output is INTENTIONAL, not a bug.** `packages/reasoning/src/kernel/loop/runner-helpers/deliverable.ts:165-187` documents at length why the passthrough must stay falsy (a truthy sentinel would skip the `runner.ts` lastThought fallback and trip truthy-output verifier gates). Do not "fix" this.
- **`strategy-switch.ts` thresholds are at lines 30 and 35, not 45** (line 45 is the `reason` template string), and they *do* carry rationale comments explaining the chosen values. They lack ablation evidence, not documentation.
- **`trajectory` is NOT unused.** `strategy-switch.ts:23` reads `e.trajectory.shape === "flat"`. It is dropped only at the trace boundary.
- **Entropy `confidence` is a categorical enum** (`"high" | "medium" | "low"`), not a numeric score. It is a different concept from `DecisionEvaluatedEvent.confidence` (numeric) and from `arbitrator.ts`'s `verdict.confidence` (evaluator enum). Three distinct things; do not unify them.

## Global Constraints

- Strict TypeScript. No `any` casts; use `unknown` plus type guards. (Project rule.)
- No `Co-Authored-By` trailers on any commit.
- Run tests with an explicit timeout flag; never leave a dangling server.
- Under Bun, workspace packages resolve from `src/` via the `bun` exports condition — a src edit is live with zero rebuild. **Exception: `packages/reasoning` exports `dist`.** Rebuild that package (`cd packages/reasoning && bun run build`) before any probe that exercises Task 5.
- `packages/trace` test conventions are split: `test/normalize.test.ts` and `__tests__/*.test.ts` both exist. Add normalize assertions to the existing `test/normalize.test.ts`; put new files under `__tests__/`.
- `packages/reactive-intelligence` uses `tests/` for most suites and `__tests__/` for a few. New files go in `tests/`.
- Tasks 1–4 are behavior-preserving for the agent loop (observability only). Task 5 changes agent behavior and is therefore gated on an ablation run per project rule (≥3pp lift AND ≤15% token overhead across ≥2 tiers → default-on; else opt-in; else revert).

---

### Task 1: Make source unavailability survive to the trace

Fixes RC-1. Today `semantic: null` (unavailable) and `semantic: 0` (measured zero) are byte-identical on disk. This task makes them distinguishable, which every later diagnostic depends on.

**Files:**
- Modify: `packages/trace/src/events.ts:120-130` (widen `EntropyScoredEvent.sources`)
- Modify: `packages/trace/src/normalize.ts:93-108` (stop coercing `null` to `0`)
- Test: `packages/trace/test/normalize.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `EntropyScoredEvent.sources.token: number | null` and `.semantic: number | null`; a new `EntropyScoredEvent.sourcesPresent: number` (count of non-null sources, 0–5). Tasks 2 and 4 read `sourcesPresent`.

- [ ] **Step 1: Write the failing test**

Add to `packages/trace/test/normalize.test.ts`:

```typescript
test("EntropyScored preserves null sources rather than coercing to 0", () => {
  const raw = {
    _tag: "EntropyScored",
    taskId: "run-null-src",
    iteration: 4,
    composite: 0.52,
    sources: {
      token: null,
      structural: 0.55,
      semantic: null,
      behavioral: 0.33,
      contextPressure: 0.1,
    },
  };
  const ev = normalizeEvent(raw, 0) as EntropyScoredEvent;
  expect(ev.kind).toBe("entropy-scored");
  expect(ev.sources.token).toBeNull();
  expect(ev.sources.semantic).toBeNull();
  expect(ev.sources.structural).toBe(0.55);
  expect(ev.sourcesPresent).toBe(3);
});

test("EntropyScored keeps a genuine zero distinct from an absent source", () => {
  const raw = {
    _tag: "EntropyScored",
    taskId: "run-real-zero",
    iteration: 4,
    composite: 0.4,
    sources: {
      token: 0,
      structural: 0.5,
      semantic: null,
      behavioral: 0.2,
      contextPressure: 0,
    },
  };
  const ev = normalizeEvent(raw, 0) as EntropyScoredEvent;
  expect(ev.sources.token).toBe(0);
  expect(ev.sources.semantic).toBeNull();
  expect(ev.sourcesPresent).toBe(4);
});
```

Import `normalizeEvent` and the `EntropyScoredEvent` type the same way the existing tests in that file do — match the file's existing import style rather than adding a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/trace/test/normalize.test.ts --timeout 15000`
Expected: FAIL — `ev.sources.token` is `0`, not `null`; `ev.sourcesPresent` is `undefined`.

- [ ] **Step 3: Widen the event type**

In `packages/trace/src/events.ts`, replace the `EntropyScoredEvent` interface:

```typescript
export interface EntropyScoredEvent extends TraceEventBase {
  readonly kind: "entropy-scored"
  readonly composite: number
  readonly sources: {
    /** null = source structurally unavailable (e.g. no logprobs on Ollama), not a measured zero. */
    readonly token: number | null
    readonly structural: number
    /** null = no embedding available or no prior thought to compare against. */
    readonly semantic: number | null
    readonly behavioral: number
    readonly contextPressure: number
  }
  /** Count of non-null sources, 0-5. Below 5 means the composite is a partial signal. */
  readonly sourcesPresent: number
}
```

Then add `sourcesPresent` to the required-fields table at `events.ts:484`:

```typescript
  "entropy-scored": ["composite", "sources", "sourcesPresent"],
```

- [ ] **Step 4: Fix the mapper**

In `packages/trace/src/normalize.ts`, replace the `case "EntropyScored":` block body:

```typescript
    case "EntropyScored": {
      const src = raw.sources as {
        token: number | null
        structural: number
        semantic: number | null
        behavioral: number
        contextPressure: number
      }
      const sources = {
        token: src.token,
        structural: src.structural,
        semantic: src.semantic,
        behavioral: src.behavioral,
        contextPressure: src.contextPressure,
      }
      const sourcesPresent = Object.values(sources).filter((v) => v !== null).length
      const ev: EntropyScoredEvent = {
        kind: "entropy-scored",
        runId: raw.taskId,
        timestamp: Date.now(),
        iter: raw.iteration,
        seq,
        composite: raw.composite,
        sources,
        sourcesPresent,
      }
      return ev
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/trace/test/normalize.test.ts --timeout 15000`
Expected: PASS.

- [ ] **Step 6: Fix downstream type breakage**

Widening `sources.token`/`.semantic` to nullable will surface compile errors in any consumer doing arithmetic on them. Find them:

```bash
bun run --silent tsc --noEmit -p packages/trace 2>&1 | head -30
grep -rn "sources.token\|sources.semantic" packages/ --include="*.ts" | grep -v dist | grep -v node_modules
```

At each site, decide explicitly: skip null sources in an average, or treat them as 0 *with a comment saying why that is correct there*. Do not blanket-add `?? 0` — that reintroduces exactly the bug this task removes.

- [ ] **Step 7: Verify the package is green**

Run: `bun test packages/trace --timeout 30000`
Expected: no net-new failures versus the pre-edit baseline. If unsure of the baseline, capture it first with `git stash && bun test packages/trace --timeout 30000; git stash pop`.

- [ ] **Step 8: Commit**

```bash
git add packages/trace/src/events.ts packages/trace/src/normalize.ts packages/trace/test/normalize.test.ts
git commit -m "fix(trace): preserve entropy source nullability instead of coercing to zero

EntropyScore.sources.token/.semantic are number|null in the domain type
(reactive-intelligence types.ts:84-90), but normalize.ts coerced both with
?? 0 and EntropyScoredEvent typed them non-nullable. An unavailable source
and a measured zero were identical on disk.

Empirical: runs 01M2GKEDSXXVGRFAGBC7CE2HEK / 01M2GKFRM9C5VJANHPK1VYP1DR /
01M2GM1SZ0FVXDD3TNN0F9FZ5A (qwen3.5:latest, Ollama) all report
token:0, semantic:0, contextPressure:0 with no way to tell degradation
from genuine zeros.

Adds sourcesPresent (count of non-null sources) so a partial composite is
legible without reconstructing it from the source map."
```

---

### Task 2: Carry confidence, trajectory, and tier through to the trace

Fixes RC-2. `reactive-observer.ts:144-147` already publishes these on the bus; only the trace schema and mapper drop them.

**Files:**
- Modify: `packages/trace/src/events.ts` (`EntropyScoredEvent`, required-fields table)
- Modify: `packages/trace/src/normalize.ts` (`case "EntropyScored"`)
- Test: `packages/trace/test/normalize.test.ts`

**Interfaces:**
- Consumes: `EntropyScoredEvent` and `sourcesPresent` from Task 1.
- Produces: `EntropyScoredEvent.confidence: "high" | "medium" | "low"`, `.trajectoryShape: string`, `.modelTier: "frontier" | "local" | "unknown"`. Task 4 reads `confidence` and `sourcesPresent`.

- [ ] **Step 1: Write the failing test**

Add to `packages/trace/test/normalize.test.ts`:

```typescript
test("EntropyScored carries confidence, trajectory shape, and model tier", () => {
  const raw = {
    _tag: "EntropyScored",
    taskId: "run-rich",
    iteration: 5,
    composite: 0.61,
    sources: {
      token: null,
      structural: 0.55,
      semantic: null,
      behavioral: 0.33,
      contextPressure: 0.1,
    },
    trajectory: { history: [0.5, 0.58, 0.61], derivative: 0.03, momentum: 0.2, shape: "flat" },
    confidence: "low",
    modelTier: "local",
    iterationWeight: 0.42,
  };
  const ev = normalizeEvent(raw, 0) as EntropyScoredEvent;
  expect(ev.confidence).toBe("low");
  expect(ev.trajectoryShape).toBe("flat");
  expect(ev.modelTier).toBe("local");
});

test("EntropyScored defaults gracefully when rich fields are absent", () => {
  const raw = {
    _tag: "EntropyScored",
    taskId: "run-bare",
    iteration: 1,
    composite: 0.3,
    sources: { token: null, structural: 0.4, semantic: null, behavioral: 0.2, contextPressure: 0.05 },
  };
  const ev = normalizeEvent(raw, 0) as EntropyScoredEvent;
  expect(ev.confidence).toBe("low");
  expect(ev.trajectoryShape).toBe("unknown");
  expect(ev.modelTier).toBe("unknown");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/trace/test/normalize.test.ts --timeout 15000`
Expected: FAIL — `ev.confidence` is `undefined`.

- [ ] **Step 3: Extend the event type**

In `packages/trace/src/events.ts`, add to `EntropyScoredEvent` (keeping everything from Task 1):

```typescript
  /** Sensor's own self-assessment. "low" on short runs and degraded-source runs. */
  readonly confidence: "high" | "medium" | "low"
  /** EntropyTrajectory.shape, or "unknown" when no trajectory was supplied. */
  readonly trajectoryShape: string
  readonly modelTier: "frontier" | "local" | "unknown"
```

Update the required-fields entry at `events.ts:484`:

```typescript
  "entropy-scored": ["composite", "sources", "sourcesPresent", "confidence"],
```

Leave `trajectoryShape` and `modelTier` out of the required list — they default cleanly and should not invalidate an older trace.

- [ ] **Step 4: Extend the mapper**

In `normalize.ts`, inside `case "EntropyScored":`, before constructing `ev`:

```typescript
      const traj = raw.trajectory as { shape?: string } | undefined
      const confidence =
        raw.confidence === "high" || raw.confidence === "medium" || raw.confidence === "low"
          ? raw.confidence
          : "low"
      const modelTier =
        raw.modelTier === "frontier" || raw.modelTier === "local" ? raw.modelTier : "unknown"
```

and add to the `ev` object literal:

```typescript
        confidence,
        trajectoryShape: traj?.shape ?? "unknown",
        modelTier,
```

Defaulting an unrecognized confidence to `"low"` is deliberate: an unknown signal should never present as a confident one.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/trace/test/normalize.test.ts --timeout 15000`
Expected: PASS.

- [ ] **Step 6: Verify the package is green**

Run: `bun test packages/trace --timeout 30000`
Expected: no net-new failures.

- [ ] **Step 7: Commit**

```bash
git add packages/trace/src/events.ts packages/trace/src/normalize.ts packages/trace/test/normalize.test.ts
git commit -m "feat(trace): carry entropy confidence, trajectory shape, and model tier to disk

reactive-observer.ts:144-147 already publishes confidence/trajectory/
modelTier/iterationWeight on the event bus; normalize.ts mapped none of
them and EntropyScoredEvent had no fields for them, so rax-diagnose could
not see the sensor's own self-assessment.

Unrecognized confidence defaults to \"low\" so an unknown signal never
presents as a confident one."
```

---

### Task 3: Surface degraded-source runs in `rax:diagnose`

Fixes the operator-facing half of RC-1/RC-2. The data now reaches disk; this makes a degraded run visible without hand-grepping JSONL.

**Files:**
- Modify: `packages/trace/src/analyze.ts` (around the entropy aggregation near `analyze.ts:331-344`)
- Test: `packages/trace/__tests__/analyze.test.ts`

**Interfaces:**
- Consumes: `EntropyScoredEvent.sourcesPresent` and `.confidence` from Tasks 1–2.
- Produces: an `entropyDegradation` summary field on the analyze result: `{ minSourcesPresent: number; maxSourcesPresent: number; degradedIterations: number; lowConfidenceIterations: number }`. No later task consumes this.

- [ ] **Step 1: Read the existing aggregation shape**

Run: `sed -n '320,360p' packages/trace/src/analyze.ts` and `sed -n '420,440p' packages/trace/src/analyze.ts`

Match the surrounding naming and result-object conventions exactly rather than inventing a new style. If the entropy aggregate already has a home in that result object, extend it in place instead of adding a sibling.

- [ ] **Step 2: Write the failing test**

Add to `packages/trace/__tests__/analyze.test.ts`, following that file's existing event-fixture helper style:

```typescript
test("analyze reports entropy source degradation", () => {
  const events = [
    makeEntropyEvent({ iter: 3, composite: 0.5, sourcesPresent: 3, confidence: "low" }),
    makeEntropyEvent({ iter: 4, composite: 0.55, sourcesPresent: 3, confidence: "low" }),
    makeEntropyEvent({ iter: 5, composite: 0.6, sourcesPresent: 5, confidence: "high" }),
  ];
  const result = analyze(events);
  expect(result.entropyDegradation.minSourcesPresent).toBe(3);
  expect(result.entropyDegradation.maxSourcesPresent).toBe(5);
  expect(result.entropyDegradation.degradedIterations).toBe(2);
  expect(result.entropyDegradation.lowConfidenceIterations).toBe(2);
});
```

Write `makeEntropyEvent` as a local helper in that test file if no equivalent exists, producing a valid `EntropyScoredEvent` with the given overrides.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/trace/__tests__/analyze.test.ts --timeout 15000`
Expected: FAIL — `result.entropyDegradation` is `undefined`.

- [ ] **Step 4: Implement the aggregation**

In `analyze.ts`, alongside the existing entropy handling:

```typescript
const entropyEvents = events.filter(isEntropy)
const sourcesCounts = entropyEvents.map((e) => e.sourcesPresent)
const entropyDegradation = {
  minSourcesPresent: sourcesCounts.length > 0 ? Math.min(...sourcesCounts) : 0,
  maxSourcesPresent: sourcesCounts.length > 0 ? Math.max(...sourcesCounts) : 0,
  degradedIterations: entropyEvents.filter((e) => e.sourcesPresent < 5).length,
  lowConfidenceIterations: entropyEvents.filter((e) => e.confidence === "low").length,
}
```

Add `entropyDegradation` to the returned result object and to its exported result type. Reuse the existing `isEntropy` guard if `analyze.ts` already defines one (it defines `isDecision` at `analyze.ts:344` — follow that pattern).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/trace/__tests__/analyze.test.ts --timeout 15000`
Expected: PASS.

- [ ] **Step 6: Verify against a real trace**

```bash
cd packages/diagnose && bun run build && cd ../..
bun run rax:diagnose replay 01M2GM1SZ0FVXDD3TNN0F9FZ5A --only=entropy-scored | head -20
```

Expected: `sourcesPresent: 3` on every iteration of that run (token/semantic null on Ollama), confirming the Task 1–3 chain end to end on real recorded data. If the CLI renders nothing new, `packages/diagnose` consumes `dist` — the rebuild above is required, not optional.

- [ ] **Step 7: Commit**

```bash
git add packages/trace/src/analyze.ts packages/trace/__tests__/analyze.test.ts
git commit -m "feat(trace): report entropy source degradation in analyze output

Makes a partial-source composite visible in rax:diagnose without
hand-grepping JSONL. Verified against recorded run
01M2GM1SZ0FVXDD3TNN0F9FZ5A (qwen3.5:latest): sourcesPresent=3 on every
iteration, token and semantic null throughout."
```

---

### Task 4: Give `decision-evaluated.confidence` a real value for strategy switches

Fixes RC-5. Today `switch-strategy` decisions always normalize to `confidence: 0` because they carry no `entropyBefore`/`entropyAfter` pair, even though the decision's own reason string carries the driving loop score.

**Files:**
- Modify: `packages/reactive-intelligence/src/controller/strategy-switch.ts` (add a numeric confidence to the returned decision)
- Modify: `packages/trace/src/normalize.ts:110-125` (`case "ReactiveDecision"`)
- Test: `packages/trace/test/normalize.test.ts`
- Test: `packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts` (create)

**Interfaces:**
- Consumes: nothing structural from Tasks 1–3.
- Produces: `ControllerDecision & { decision: "switch-strategy" }` gains an optional `confidence?: number` (0–1). `normalize.ts` prefers an explicit `raw.confidence` over the entropy-delta formula.

- [ ] **Step 1: Write the failing RI test**

Create `packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { evaluateStrategySwitch } from "../src/controller/strategy-switch.js";

const flatEntry = (composite: number) => ({
  composite,
  trajectory: { history: [], derivative: 0, momentum: 0.1, shape: "flat" as const },
});

describe("evaluateStrategySwitch confidence", () => {
  test("emits a confidence scaled by how far the loop score exceeds the bar", () => {
    const decision = evaluateStrategySwitch({
      entropyHistory: [flatEntry(0.6), flatEntry(0.61), flatEntry(0.62)],
      config: { flatIterationsBeforeSwitch: 3 },
      strategy: "plan-execute-reflect",
      iteration: 4,
      behavioralLoopScore: 0.69,
    } as never);
    expect(decision).not.toBeNull();
    expect(decision!.confidence).toBeGreaterThan(0);
    expect(decision!.confidence).toBeLessThanOrEqual(1);
  });

  test("a barely-over-threshold loop score yields lower confidence than a high one", () => {
    const mk = (loop: number) =>
      evaluateStrategySwitch({
        entropyHistory: [flatEntry(0.6), flatEntry(0.61), flatEntry(0.62)],
        config: { flatIterationsBeforeSwitch: 3 },
        strategy: "plan-execute-reflect",
        iteration: 4,
        behavioralLoopScore: loop,
      } as never);
    expect(mk(0.46)!.confidence).toBeLessThan(mk(0.9)!.confidence);
  });
});
```

The `as never` cast on the params object is a test-only shortcut for `ControllerEvalParams`. If that type is exported and cheap to construct fully, build it properly instead — do not introduce `as never` into source.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts --timeout 15000`
Expected: FAIL — `decision.confidence` is `undefined`.

- [ ] **Step 3: Emit confidence from the evaluator**

In `packages/reactive-intelligence/src/controller/strategy-switch.ts`, replace the return block (currently at lines 41-46):

```typescript
  // Scale confidence by headroom above the 0.45 bar: a score of 0.46 is a weak
  // signal, 0.9 is a strong one. Consumers need to tell these apart — the
  // decision alone does not say how sure the controller was.
  const LOOP_SCORE_BAR = 0.45;
  const confidence = Math.max(
    0,
    Math.min(1, (params.behavioralLoopScore - LOOP_SCORE_BAR) / (1 - LOOP_SCORE_BAR)),
  );

  return {
    decision: "switch-strategy",
    from: strategy,
    to,
    confidence,
    reason: `Entropy flat for ${flatCount} iterations with high loop score (${params.behavioralLoopScore.toFixed(2)}), switching from ${strategy} to ${to}`,
  };
```

Replace the bare `0.45` at line 35 with the same `LOOP_SCORE_BAR` constant so the bar is defined once. Add `readonly confidence?: number` to the `switch-strategy` variant of `ControllerDecision` in `packages/reactive-intelligence/src/types.ts` (near line 223, alongside the other decision variants).

- [ ] **Step 4: Run the RI test to verify it passes**

Run: `bun test packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts --timeout 15000`
Expected: PASS.

- [ ] **Step 5: Write the failing normalize test**

Add to `packages/trace/test/normalize.test.ts`:

```typescript
test("ReactiveDecision prefers an explicit confidence over the entropy-delta formula", () => {
  const raw = {
    _tag: "ReactiveDecision",
    taskId: "run-switch",
    iteration: 3,
    decision: "switch-strategy",
    confidence: 0.44,
    reason: "Entropy flat for 3 iterations with high loop score (0.69)",
  };
  const ev = normalizeEvent(raw, 0) as DecisionEvaluatedEvent;
  expect(ev.confidence).toBeCloseTo(0.44, 5);
});

test("ReactiveDecision still derives confidence from entropy delta when none is given", () => {
  const raw = {
    _tag: "ReactiveDecision",
    taskId: "run-delta",
    iteration: 3,
    decision: "compress",
    entropyBefore: 0.8,
    entropyAfter: 0.4,
    reason: "compressed",
  };
  const ev = normalizeEvent(raw, 0) as DecisionEvaluatedEvent;
  expect(ev.confidence).toBeCloseTo(0.5, 5);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test packages/trace/test/normalize.test.ts --timeout 15000`
Expected: FAIL on the first test — confidence is `0`, not `0.44`.

- [ ] **Step 7: Prefer the explicit confidence in the mapper**

In `normalize.ts`, inside `case "ReactiveDecision":`, replace the confidence computation:

```typescript
      const hasImprovement =
        typeof raw.entropyAfter === "number" &&
        typeof raw.entropyBefore === "number" &&
        raw.entropyAfter < raw.entropyBefore
      // An explicit controller-supplied confidence wins: switch-strategy decisions
      // carry no entropyBefore/After pair, so the delta formula always fell to 0.
      const confidence =
        typeof raw.confidence === "number"
          ? Math.max(0, Math.min(1, raw.confidence))
          : hasImprovement
            ? Math.max(0, 1 - (raw.entropyAfter as number) / (raw.entropyBefore as number))
            : 0
```

and use `confidence` in the `ev` literal in place of the old inline ternary.

- [ ] **Step 8: Run both suites to verify they pass**

Run: `bun test packages/trace/test/normalize.test.ts packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts --timeout 20000`
Expected: PASS.

- [ ] **Step 9: Confirm the bus actually forwards the field**

The evaluator now returns `confidence`, but the `ReactiveDecision` bus publish site must include it or the mapper will never see it. Find and inspect the publish site:

```bash
grep -rn "ReactiveDecision" packages/ --include="*.ts" | grep -v dist | grep -v test
```

If the publish site spreads the decision object wholesale, no change is needed. If it enumerates fields, add `confidence`. **This step is load-bearing — without it Tasks 4's value dies before the mapper, which is the same class of bug as RC-2.**

- [ ] **Step 10: Verify both packages are green**

Run: `bun test packages/trace packages/reactive-intelligence --timeout 60000`
Expected: no net-new failures.

- [ ] **Step 11: Commit**

```bash
git add packages/reactive-intelligence/src/controller/strategy-switch.ts packages/reactive-intelligence/src/types.ts packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts packages/trace/src/normalize.ts packages/trace/test/normalize.test.ts
git commit -m "fix(reactive-intelligence,trace): emit real confidence on switch-strategy decisions

normalize.ts derived decision confidence from an entropyBefore/entropyAfter
pair that switch-strategy events never carry, so every strategy switch
recorded confidence 0 despite its reason string carrying the driving loop
score (0.63 and 0.69 in run 01M2GM1SZ0FVXDD3TNN0F9FZ5A).

evaluateStrategySwitch now scales confidence by headroom above the 0.45
loop-score bar, and normalize prefers an explicit confidence over the
delta formula. The 0.45 bar is now a single named constant rather than
two separate literals."
```

---

### Task 5: Make the kernel the single loop-stuck trigger authority

Fixes RC-3. **This task changes agent behavior** and is gated on ablation (see Task 6). Do not merge it default-on without that verdict.

Today the kernel's repeated-identical-failure streak redirect fired at iteration 2 and RI's `evaluateStrategySwitch` fired independently at iteration 3 in run `01M2GM1SZ0FVXDD3TNN0F9FZ5A`, stacking two separate pieces of guidance into one context window and burning the switch budget in four iterations.

**Files:**
- Modify: `packages/reactive-intelligence/src/controller/strategy-switch.ts` (require kernel corroboration)
- Modify: `packages/reactive-intelligence/src/types.ts` (`ControllerEvalParams` gains the kernel signal)
- Modify: `packages/reasoning/src/kernel/loop/iterate-pass.ts` (thread the existing streak count into controller params)
- Test: `packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts` (extend)

**Interfaces:**
- Consumes: `LOOP_SCORE_BAR` and the `confidence` field from Task 4.
- Produces: `ControllerEvalParams.kernelLoopSignal?: { redirectsIssued: number }`. `evaluateStrategySwitch` returns `null` when the kernel has issued no redirect yet.

- [ ] **Step 1: Locate the kernel's existing streak counter**

```bash
grep -n "failureRecoveryRedirects\|repeated-identical\|requiredToolRedirects" packages/reasoning/src/kernel/loop/iterate-pass.ts | head -20
```

`failureRecoveryRedirects` is already tracked and reset across strategy switches (visible in the reset-counters destructure near `iterate-pass.ts:1035-1042`). Reuse it — do not add a parallel counter, which would recreate RC-3 one layer down.

- [ ] **Step 2: Write the failing test**

Append to `packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts`:

```typescript
describe("evaluateStrategySwitch kernel corroboration", () => {
  const stuckParams = (kernelRedirects: number | undefined) => ({
    entropyHistory: [flatEntry(0.6), flatEntry(0.61), flatEntry(0.62)],
    config: { flatIterationsBeforeSwitch: 3 },
    strategy: "plan-execute-reflect",
    iteration: 4,
    behavioralLoopScore: 0.69,
    ...(kernelRedirects === undefined ? {} : { kernelLoopSignal: { redirectsIssued: kernelRedirects } }),
  });

  test("does not switch when the kernel has issued no loop redirect", () => {
    expect(evaluateStrategySwitch(stuckParams(0) as never)).toBeNull();
  });

  test("switches once the kernel has already redirected", () => {
    expect(evaluateStrategySwitch(stuckParams(1) as never)).not.toBeNull();
  });

  test("absent kernel signal is treated as no corroboration", () => {
    expect(evaluateStrategySwitch(stuckParams(undefined) as never)).toBeNull();
  });
});
```

The third case matters: a caller that has not been updated to pass the signal must fail closed (no switch), not fall back to the old independent behavior.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts --timeout 15000`
Expected: FAIL — all three switch regardless of the kernel signal.

- [ ] **Step 4: Require corroboration in the evaluator**

Add to `ControllerEvalParams` in `packages/reactive-intelligence/src/types.ts`:

```typescript
  /**
   * Kernel-side loop evidence. The kernel's repeated-identical-failure streak
   * counter is the single trigger authority for "the agent is stuck"; this
   * evaluator only escalates a stall the kernel has already acted on.
   */
  readonly kernelLoopSignal?: { readonly redirectsIssued: number };
```

In `strategy-switch.ts`, after the existing `if (iteration < 3) return null;` guard:

```typescript
  // Single-authority rule: the kernel's redirect is the trigger, entropy is the
  // escalation. Without kernel corroboration this evaluator would fire one
  // iteration behind the kernel and stack a second, unrelated piece of guidance
  // into the same context window (observed: run 01M2GM1SZ0FVXDD3TNN0F9FZ5A,
  // kernel redirect at iter 2, entropy switch at iter 3).
  if ((params.kernelLoopSignal?.redirectsIssued ?? 0) < 1) return null;
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun test packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts --timeout 15000`
Expected: PASS, including the two confidence tests from Task 4.

- [ ] **Step 6: Thread the signal from the kernel**

In `packages/reasoning/src/kernel/loop/iterate-pass.ts`, find where controller evaluation params are assembled (search for `behavioralLoopScore`) and add:

```typescript
        kernelLoopSignal: { redirectsIssued: failureRecoveryRedirects },
```

If `behavioralLoopScore` is assembled in a different module, follow it there rather than duplicating the params object.

- [ ] **Step 7: Rebuild reasoning and verify the wiring is live**

`packages/reasoning` exports `dist`, so a src edit is NOT live without a rebuild:

```bash
cd packages/reasoning && bun run build && cd ../..
grep -rn "kernelLoopSignal" packages/reasoning/dist/index.js | head -3
```

Expected: at least one hit. An empty result means the build did not pick up the edit — resolve that before probing.

- [ ] **Step 8: Re-run the adversarial probe**

Recreate the adversarial task from the audit session (force repeated `http-get` against a blocked address, forbid giving up or changing URL), run it FOREGROUND against the same model:

```bash
timeout 590 bun run <your-adversarial-probe>.ts
bun run rax:diagnose list | head -3
bun run rax:diagnose replay <newRunId> --only=entropy-scored,decision-evaluated,intervention-dispatched,strategy-switched
```

Expected shape versus the `01M2GM1SZ0FVXDD3TNN0F9FZ5A` baseline: at most one `strategy-switched` event rather than two, no switch before the kernel's first redirect, switch budget not exhausted inside four iterations, and `decision-evaluated.confidence` now non-zero. If the after-trace does not show this shape, the fix does not do what this plan claims — diagnose before proceeding to Task 6.

- [ ] **Step 9: Compare before and after structurally**

Run: `bun run rax:diagnose diff 01M2GM1SZ0FVXDD3TNN0F9FZ5A <newRunId>`

Record the deltas in the commit message.

- [ ] **Step 10: Verify the affected packages are green**

Run: `bun test packages/reactive-intelligence packages/reasoning --timeout 120000`
Expected: no net-new failures versus baseline. Strategy-switching tests asserting the old independent-trigger behavior may legitimately need updating — if so, update them with a comment explaining why the new behavior is correct, and say so in the commit.

- [ ] **Step 11: Commit**

```bash
git add packages/reactive-intelligence/src/controller/strategy-switch.ts packages/reactive-intelligence/src/types.ts packages/reactive-intelligence/tests/strategy-switch-confidence.test.ts packages/reasoning/src/kernel/loop/iterate-pass.ts
git commit -m "fix(kernel,reactive-intelligence): single authority for loop-stuck detection

Two independent detectors answered 'is the agent stuck' on different
cadences. Empirical: run 01M2GM1SZ0FVXDD3TNN0F9FZ5A (qwen3.5:latest),
kernel repeated-identical-failure redirect at iter 2 (streak=2), RI
entropy switch-strategy at iter 3 (loop 0.63) and iter 6 (loop 0.69).
Both injected guidance into the same context window; two switches in four
iterations exhausted the switch budget.

Structural fix: the kernel's redirect streak is the sole trigger; entropy
escalates a stall the kernel already acted on. evaluateStrategySwitch now
requires kernelLoopSignal.redirectsIssued >= 1 and fails closed when the
signal is absent.

Verification: <fill in rax:diagnose diff deltas from Step 9>"
```

---

### Task 6: Ablate Task 5 before it ships default-on

Applies the project lift rule to the only behavior-changing task in this plan. Per project rule this is not optional for a default-on harness mechanism.

**Files:**
- Modify: `wiki/Research/Harness-Reports/improvement-ledger.json` (via `--ledger`)
- Create: `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md`

**Interfaces:**
- Consumes: the Task 5 behavior change.
- Produces: a gate verdict (`default-on` | `opt-in` | `reject`) and a ledger entry.

- [ ] **Step 1: Start the judge with a non-SUT model**

```bash
JUDGE_LAYER=live JUDGE_PROVIDER=openai JUDGE_MODEL=gpt-4o-mini PORT=8910 \
  bun run packages/judge-server/src/index.ts
```

**Without `JUDGE_LAYER=live` a silent stub scores 0.95 on everything.** Health-check with a real `/judge` POST, not `/version` — `/version` stays up when the LLM backend is dead.

- [ ] **Step 2: Confirm your SUT models are calibrated**

```bash
grep -n "ollama/" packages/llm-provider/src/capability.ts | head -20
ollama list
```

The bench refuses to score any model absent from `STATIC_CAPABILITIES`. `qwen3.5:latest` is both calibrated and pulled. The cross-tier requirement needs a second tier — pull a second calibrated local model, or add a frontier tier via `--provider anthropic --model claude-haiku-4-5-20251001`.

- [ ] **Step 3: Run the bench, foreground, runs≥3**

```bash
JUDGE_URL=http://127.0.0.1:8910 timeout 590 bun run apps/cli/src/index.ts bench \
  --session cross-tier-stress --runs 3 --output /tmp/entropy-after.json
```

`--output` is mandatory — without it per-cell evidence is unrecoverable, and it overwrites per invocation, so use a distinct file per cell. Never run a bench cell as a background task; it gets SIGKILLed mid-run.

- [ ] **Step 4: Gate it and record the ledger entry**

```bash
rax eval gate --report /tmp/entropy-after.json --baseline bare-llm --candidate ra-full \
  --ledger wiki/Research/Harness-Reports/improvement-ledger.json \
  --weakness "Two uncoordinated loop-stuck detectors stack guidance and exhaust the switch budget in 4 iterations" \
  --hypothesis "Kernel redirect streak is the sole trigger; entropy loop score escalates only a stall the kernel already acted on"
```

- [ ] **Step 5: Act on the verdict honestly**

- `default-on` (≥3pp lift AND ≤15% token overhead across ≥2 tiers): keep as shipped.
- `opt-in`: gate Task 5 behind a config flag rather than leaving it unconditional.
- `reject`: revert Task 5. Tasks 1–4 are observability-only and stand on their own regardless.

Per-run scores are Bernoulli. A gap under roughly 26pp at small n is noise, not a result. A structurally correct fix can still gate `reject` on lift — record both facts in the ledger rather than re-running until the number cooperates.

- [ ] **Step 6: Write the debrief**

Create `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md` covering: the four confirmed root causes, the three probe runIds as evidence, the four corrections to earlier session claims (listed in this plan), what Tasks 1–5 changed, the gate verdict, and what remains open (RC-4).

- [ ] **Step 7: Commit**

```bash
git add wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md wiki/Research/Harness-Reports/improvement-ledger.json
git commit -m "docs(wiki): entropy system audit debrief and ablation verdict"
```

---

## Deferred — RC-4, deliberately not in this plan

Ablating the weight tables (`CATEGORY_WEIGHTS`, `WEIGHTS_WITH/WITHOUT_LOGPROBS`, `ENTROPY_CONVERGENCE_THRESHOLDS`, the 0.35 flat-entropy bar) is **blocked on Tasks 1–3**, not merely lower priority. You cannot meaningfully tune 32 category-weight constants while the trace cannot distinguish an unavailable source from a zero one — every measurement would be confounded by RC-1.

Once Tasks 1–3 land and `sourcesPresent` is recorded across a corpus of runs, the right follow-up question is narrower than "tune the weights": on local models only three sources are ever present, so the local-tier weight table is effectively a three-term expression wearing a five-term coat. The honest fix may be a dedicated local-tier weighting rather than redistribution of absent sources' weight. That is a separate spec.

Also deferred: `ENTROPY_CONVERGENCE_THRESHOLDS` never engaged in any of the three probe runs — the derivative never converged. Before tuning those constants, establish whether that evaluator ever fires in practice on any tier. An evaluator that never fires is a different problem from one that fires wrongly.
