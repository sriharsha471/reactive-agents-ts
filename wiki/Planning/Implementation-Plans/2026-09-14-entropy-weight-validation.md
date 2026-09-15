# Entropy Weight Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine whether the entropy composite's hand-picked weights (`CATEGORY_WEIGHTS`, `EXPECTED_TOOL_RANGE`) and the conformal `convergenceThreshold` actually separate good task outcomes from bad ones, using real bench data instead of intuition — and fix the one bug (`modelTier` always "unknown" for Ollama) blocking that measurement from being tier-aware.

**Architecture:** (1) Fix `providerName` threading so `lookupModel()` gets a real 3rd argument and local models resolve to `tier: "local"` instead of `"unknown"`. (2) Add a pure correlation-extraction module in `packages/benchmarks` that joins a `SessionReport`'s `RunScore` (outcome: `trust`, `status`) with its trace's `ReasoningTrajectory` (entropy: `entropyFirst`, `entropyLast`, `entropyShape`, `entropyDegradation`, whether `early-stop` fired). (3) Run a real cross-tier bench session with tracing on, feed the report through the extractor, and read the actual numbers. (4) Apply a fixed decision rule to the numbers — keep the current weights (documented) or land one specific, re-verified adjustment. No step 4 judgment call is deferred to "whoever reads this" — the rule is written out in Task 4.

**Tech Stack:** TypeScript, Bun test runner, Effect-TS (service layer only, not touched by this plan), existing `@reactive-agents/trace` (`loadTrace`, `analyzeRun`) and `@reactive-agents/benchmarks` (`runSession`, session presets) packages.

**Spec:** None pre-exists; this plan is self-specifying, informed by `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md` (RC-4, left explicitly blocked on the `modelTier` bug this plan's Task 1 fixes).

## Global Constraints

- Never fabricate or round a correlation number to look better than it is. Every number this plan asks for must come from an actual test/bench run; the ledger keeps the raw evidence.
- Bench cells are Bernoulli at low `n`. Use `runs>=3` for any bench session this plan runs for its own verdict (per project memory `feedback_bench_foreground_not_bg` / prior sessions' "Bernoulli" note); a single-run report is exploratory only, not evidence for Task 4's decision.
- Judge server MUST run with `JUDGE_LAYER=live` and a non-SUT model (Rule 4). Without `JUDGE_LAYER=live` the judge silently stubs 0.95 on everything and every number in this plan becomes worthless.
- Use ONLY calibrated models (present in `STATIC_CAPABILITIES`, `packages/llm-provider/src/capability.ts`) as SUTs — an uncalibrated model gets scored `inconclusive` at fallback context and produces zero usable rows.
- Run any bench cell in the FOREGROUND with `timeout <=590`, never as a background task (reaper SIGKILLs silent long-running bg bench cells).
- ALWAYS pass `--output <path>` on any bench CLI invocation — without it, the run's evidence is unrecoverable.
- No `Co-Authored-By` trailers in any commit this plan produces.
- Do not touch `EXPECTED_TOOL_RANGE`, `CATEGORY_WEIGHTS`, or `convergenceThreshold` computation until Task 3's data exists — Task 4's changes (if any) must cite the specific numbers that justify them.

---

### Task 1: Fix `modelTier` resolution for Ollama models (thread `providerName` end-to-end)

**Files:**
- Modify: `packages/reasoning/src/kernel/state/kernel-state.ts` (`KernelEntropyMeta` interface, ~line 90-108)
- Modify: `packages/reasoning/src/kernel/capabilities/reason/think.ts` (~line 1212, the `entropyMeta` write)
- Modify: `packages/reasoning/src/kernel/capabilities/reflect/reactive-observer.ts` (~line 109-119, the `.score({...})` call)
- Modify: `packages/core/src/services/entropy-sensor-tag.ts` (~line 78-88, the `score` params type)
- Modify: `packages/reactive-intelligence/src/sensor/entropy-sensor-service.ts` (~line 114, the `lookupModel` call inside `score`)
- Test: `packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts` (new)
- Test: `packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts` (new)

**Interfaces:**
- Consumes: `lookupModel(id: string, overrides?: Record<string, ModelRegistryEntry>, providerName?: string): ModelRegistryEntry` — already implemented and fully tested in `packages/reactive-intelligence/src/calibration/model-registry.ts`; this task only fixes its CALLERS. Do not modify `model-registry.ts` itself.
- Produces: `KernelEntropyMeta.providerName?: string` — read by `reactive-observer.ts` and forwarded to `EntropySensorService.score()`. `EntropySensorService`'s `score` params gain an optional `providerName?: string` field, forwarded by `entropy-sensor-service.ts` into `lookupModel(modelId, config.models, providerName)`.

**Root cause:** `packages/reasoning/src/kernel/capabilities/reason/think.ts` already has `input.providerName` in scope (used at lines ~1051 and ~1151 for error messages) at the exact point it writes `state.meta.entropy` (line ~1212), but never copies it in. Two `lookupModel(...)` call sites in `entropy-sensor-service.ts` (the `score` implementation, ~line 114) call it with only 2 args, so branch 4 of `lookupModel` (provider-derived tier) can never activate for any model not in the static `MODEL_REGISTRY` table — every Ollama model NOT hardcoded there (e.g. `qwen3.5:latest`, any newly-pulled model) silently falls through to `tier: "unknown"`.

- [ ] **Step 1: Add `providerName` to `KernelEntropyMeta`**

In `packages/reasoning/src/kernel/state/kernel-state.ts`, add one field to the interface (after `modelId`, ~line 92):

```typescript
export interface KernelEntropyMeta {
  readonly taskDescription?: string;
  readonly modelId?: string;
  readonly providerName?: string;
  readonly temperature?: number;
  // ... rest unchanged
```

- [ ] **Step 2: Write the failing unit test for the observer→sensor forwarding**

Create `packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts`. This test drives `runReactiveObserver` with a minimal kernel state carrying `meta.entropy.providerName = "ollama"` and asserts the entropy sensor's mock `score` function received `providerName: "ollama"` in its params. Follow the existing pattern in `packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-compression.test.ts` for how to construct a minimal `KernelState` and a stub `EntropySensorService` layer — read that file first to copy its state-construction helper and service-stubbing pattern exactly (this plan does not repeat that boilerplate; the existing test file is the copy source). The new test's body:

```typescript
import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { EntropySensorService } from "@reactive-agents/core";
import { runReactiveObserver } from "../../../../src/kernel/capabilities/reflect/reactive-observer.js";
// NOTE: import the same state-construction helper used in
// reactive-observer-compression.test.ts (e.g. `makeTestKernelState` or
// equivalent) rather than re-deriving one — copy that import line verbatim.

describe("reactive-observer providerName forwarding", () => {
  test("forwards meta.entropy.providerName into EntropySensorService.score params", async () => {
    let capturedProviderName: string | undefined;
    const stubSensor = Layer.succeed(EntropySensorService, {
      score: (params) => {
        capturedProviderName = params.providerName;
        return Effect.succeed({
          composite: 0.2,
          sources: { token: null, structural: 0.2, semantic: null, behavioral: 0.2, contextPressure: 0 },
          trajectory: { derivative: 0, shape: "flat", momentum: 0.2 },
          confidence: "low",
          modelTier: "local",
          iteration: 0,
          iterationWeight: 1,
          timestamp: Date.now(),
        });
      },
      scoreContext: () => Effect.succeed({ utilizationPct: 0, sections: [], atRiskSections: [], compressionHeadroom: 1 }),
      getCalibration: () => Effect.succeed({
        modelId: "test", calibrated: false, sampleCount: 0,
        highEntropyThreshold: 0.8, convergenceThreshold: 0.4, driftDetected: false,
      }),
      updateCalibration: () => Effect.succeed(undefined as never),
    });

    // Build a minimal state exactly like reactive-observer-compression.test.ts does,
    // but set meta.entropy.providerName = "ollama" and meta.entropy.modelId = "cogito:14b".
    // Run it through runReactiveObserver with stubSensor provided.
    // (Fill in using that file's exact state-construction call — same shape,
    // only the two meta.entropy fields above are new.)

    expect(capturedProviderName).toBe("ollama");
  });
});
```

Implementers: the commented instruction above ("Fill in using that file's exact state-construction call") is a literal step — open `reactive-observer-compression.test.ts`, copy its state builder and `runReactiveObserver` invocation verbatim, and only change the two `meta.entropy` fields and the assertion. Do not invent a new state-construction helper.

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts`
Expected: FAIL — `capturedProviderName` is `undefined`, not `"ollama"` (the `.score({...})` call doesn't forward it yet).

- [ ] **Step 4: Thread `providerName` through `think.ts`**

In `packages/reasoning/src/kernel/capabilities/reason/think.ts`, at the existing entropy-meta write (~line 1212):

```typescript
    // Store logprobs in entropy meta for the entropy sensor
    if (accumulatedLogprobs.length > 0) {
      const entropyMeta = state.meta.entropy ?? {};
      state = transitionState(state, { meta: { ...state.meta, entropy: { ...entropyMeta, lastLogprobs: accumulatedLogprobs, providerName: input.providerName } } });
    }
```

This branch only fires when logprobs exist. `providerName` must ALSO be set on the non-logprobs path so local models (which mostly lack logprob support) still tag it. Find the FIRST place in `think.ts` that writes `meta: { ...state.meta, entropy: { ...entropyMeta, ...` with `modelId` in it (search for `entropy: {` near where `modelId` is first set into meta — this is the entropy-meta INITIALIZATION site, upstream of the logprobs branch, not the one just edited). Add `providerName: input.providerName` to that same object literal, alongside wherever `modelId` is set there. If `modelId` is set via a spread from `input` (e.g. `modelId: input.modelId`), add `providerName: input.providerName` as a sibling line.

- [ ] **Step 5: Thread `providerName` through `reactive-observer.ts`'s `.score()` call**

In `packages/reasoning/src/kernel/capabilities/reflect/reactive-observer.ts`, in the `.score({...})` call (~line 109-119), add one line mirroring the existing `modelId` line:

```typescript
        yield* services.entropySensor.value
          .score({
            thought: latestThought.content ?? "",
            taskDescription: s.meta.entropy?.taskDescription ?? "",
            strategy: s.strategy,
            iteration: completedIteration,
            maxIterations: (s.meta.maxIterations as number) ?? 10,
            modelId: s.meta.entropy?.modelId ?? "unknown",
            providerName: s.meta.entropy?.providerName,
            temperature: s.meta.entropy?.temperature ?? 0,
            priorThought,
            logprobs: s.meta.entropy?.lastLogprobs,
            kernelState: asKernelStateLike(s),
            taskCategory: s.meta.entropy?.taskCategory,
          })
```

- [ ] **Step 6: Add `providerName` to `EntropySensorService`'s `score` params type**

In `packages/core/src/services/entropy-sensor-tag.ts`, in the `score` method's params object type (~line 78-88), add one optional field after `modelId`:

```typescript
    readonly score: (params: {
      thought: string;
      taskDescription: string;
      strategy: string;
      iteration: number;
      maxIterations: number;
      modelId: string;
      providerName?: string;
      temperature: number;
      priorThought?: string;
      logprobs?: readonly TokenLogprobLike[];
      kernelState: KernelStateLike;
      /** Task category for per-category scoring adjustments. */
      taskCategory?: string;
    }) => Effect.Effect<EntropyScoreLike, never>;
```

- [ ] **Step 7: Run the Step 2 test to verify it now passes**

Run: `bun test packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing test for the sensor-service→`lookupModel` forwarding**

Create `packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts`. This tests the actual bug: that `params.providerName` reaches `lookupModel`'s 3rd argument, so a model NOT in the static `MODEL_REGISTRY` resolves to the provider-derived tier instead of `"unknown"`. Use the existing test setup pattern from `packages/reactive-intelligence/tests/sensor/` (list that directory and copy the layer-construction pattern from whichever existing test exercises `makeEntropySensorServiceLive` or equivalent factory — read `entropy-sensor-service.ts`'s exported layer-constructor name first).

```typescript
import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
// Import whatever this package's existing sensor tests import to build a
// live EntropySensorService layer — copy the import + layer-provide pattern
// from an existing file in packages/reactive-intelligence/tests/sensor/.

describe("entropy-sensor-service providerName -> modelTier", () => {
  test("an unregistered Ollama model tags modelTier: 'local' when providerName is 'ollama'", async () => {
    // Call the live score() effect with modelId: "some-brand-new-ollama-model:9b"
    // (deliberately NOT in MODEL_REGISTRY) and providerName: "ollama", iteration: 3
    // (past the iteration<=2 short-run bypass), maxIterations: 10, and otherwise
    // minimal/empty kernelState (steps: [], toolsUsed: new Set(), etc. — mirror
    // an existing sensor test's minimal kernelState fixture).
    // Assert result.modelTier === "local".
  });

  test("no providerName still falls back to 'unknown' for an unregistered model (regression guard)", async () => {
    // Same call, omit providerName entirely.
    // Assert result.modelTier === "unknown" — proves this fix is additive,
    // not a silent default that would mask a missing providerName elsewhere.
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run: `bun test packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts`
Expected: FAIL on the first test — `result.modelTier` is `"unknown"`, not `"local"`.

- [ ] **Step 10: Wire `providerName` into `lookupModel` at the `score` call site**

In `packages/reactive-intelligence/src/sensor/entropy-sensor-service.ts`, inside the `score` implementation (~line 114):

```typescript
            const model = lookupModel(modelId, config.models, params.providerName);
```

(`modelId` here is already destructured earlier in the function from `params.modelId` — confirm the exact local variable name at that line before editing; use whatever name the surrounding code already uses, do not introduce a second binding.)

- [ ] **Step 11: Run both new test files to verify they pass**

Run: `bun test packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts`
Expected: PASS, both files, all tests including the Step 8 regression guard.

- [ ] **Step 12: Run the full reasoning + reactive-intelligence + core test suites to check for regressions**

Run: `bun test packages/reasoning packages/reactive-intelligence packages/core`
Expected: all pass, 0 fail (this touches a widely-used meta field and a public service type — a narrowing mistake in Step 6 would show up here as a type error at build, and behavior regressions would show up as new test failures).

- [ ] **Step 13: Commit**

```bash
git add packages/reasoning/src/kernel/state/kernel-state.ts \
        packages/reasoning/src/kernel/capabilities/reason/think.ts \
        packages/reasoning/src/kernel/capabilities/reflect/reactive-observer.ts \
        packages/core/src/services/entropy-sensor-tag.ts \
        packages/reactive-intelligence/src/sensor/entropy-sensor-service.ts \
        packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts \
        packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts
git commit -m "fix(entropy): thread providerName so Ollama models resolve modelTier: local"
```

---

### Task 2: Entropy-outcome correlation extractor

**Files:**
- Create: `packages/benchmarks/src/entropy-correlation.ts`
- Test: `packages/benchmarks/tests/entropy-correlation.test.ts`

**Interfaces:**
- Consumes: `TaskVariantReport` and `RunScore` from `packages/benchmarks/src/types.ts` (unchanged — read-only); `loadTrace` and `analyzeRun` from `@reactive-agents/trace` (unchanged — read-only); trace files at `${session.traceDir}/<traceId>.jsonl` (the existing convention used by `diagnoseRun` in `packages/benchmarks/src/diagnose.ts:50`).
- Produces: `EntropyOutcomeRow` type and `extractEntropyOutcomeRows(reports: readonly TaskVariantReport[], traceDir: string): Promise<EntropyOutcomeRow[]>`, plus `summarizeEntropyOutcome(rows: readonly EntropyOutcomeRow[]): EntropyOutcomeSummary` — both consumed by Task 3's runner script.

**Design:** This module is a pure, testable join — it does NOT run a bench session itself (Task 3 does that). It takes an already-produced report (or reports) plus the trace directory the session wrote to, and for every `RunScore` that has a `traceId`, loads that run's trace, runs the EXISTING `analyzeRun` from `@reactive-agents/trace` (already computes `ReasoningTrajectory` including `entropyFirst`, `entropyLast`, `entropyShape`, `entropyDegradation`, and `decisionTypes["early-stop"]` — no new trace instrumentation needed), and pairs it with that run's `trust`/`status`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/benchmarks/tests/entropy-correlation.test.ts`. This test does NOT hit disk for a real bench run — it writes a tiny synthetic trace JSONL to a temp dir and a synthetic `TaskVariantReport` pointing at it, then asserts the extractor joins them correctly.

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEntropyOutcomeRows, summarizeEntropyOutcome } from "../src/entropy-correlation.js";
import type { TaskVariantReport } from "../src/types.js";

describe("extractEntropyOutcomeRows", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("joins a RunScore to its trace's entropy trajectory", async () => {
    dir = mkdtempSync(join(tmpdir(), "entropy-corr-test-"));
    const traceId = "trace-abc123";
    const events = [
      { kind: "entropy-scored", runId: traceId, iter: 0, ts: 1, composite: 0.6, sources: { token: null, structural: 0.6, semantic: null, behavioral: 0.5, contextPressure: 0 }, sourcesPresent: 2, confidence: "low", trajectoryShape: "flat", modelTier: "local" },
      { kind: "entropy-scored", runId: traceId, iter: 1, ts: 2, composite: 0.2, sources: { token: null, structural: 0.2, semantic: null, behavioral: 0.1, contextPressure: 0 }, sourcesPresent: 2, confidence: "medium", trajectoryShape: "converging", modelTier: "local" },
      { kind: "decision-evaluated", runId: traceId, iter: 1, ts: 3, decisionType: "early-stop", fired: true },
      { kind: "run-completed", runId: traceId, iter: 1, ts: 4, status: "success" },
    ];
    writeFileSync(join(dir, `${traceId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));

    const report: TaskVariantReport = {
      taskId: "rw-1",
      modelVariantId: "cogito:14b",
      variantId: "ra-full",
      variantLabel: "Full Harness",
      runs: [{
        runIndex: 0,
        dimensions: [],
        tokensUsed: 500,
        durationMs: 1000,
        status: "pass",
        output: "done",
        traceId,
        trust: "verified-correct",
      }],
      meanScores: [],
      variance: 0,
      meanTokens: 500,
    } as TaskVariantReport;

    const rows = await extractEntropyOutcomeRows([report], dir);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("rw-1");
    expect(rows[0]!.modelVariantId).toBe("cogito:14b");
    expect(rows[0]!.trust).toBe("verified-correct");
    expect(rows[0]!.status).toBe("pass");
    expect(rows[0]!.entropyFirst).toBeCloseTo(0.6, 5);
    expect(rows[0]!.entropyLast).toBeCloseTo(0.2, 5);
    expect(rows[0]!.entropyShape).toBe("converging");
    expect(rows[0]!.earlyStopFired).toBe(true);
  });

  test("a run with no traceId is skipped, not thrown", async () => {
    dir = mkdtempSync(join(tmpdir(), "entropy-corr-test-notrace-"));
    const report: TaskVariantReport = {
      taskId: "rw-2",
      modelVariantId: "cogito:14b",
      variantId: "ra-full",
      variantLabel: "Full Harness",
      runs: [{ runIndex: 0, dimensions: [], tokensUsed: 10, durationMs: 10, status: "pass", output: "x" }],
      meanScores: [],
      variance: 0,
      meanTokens: 10,
    } as TaskVariantReport;

    const rows = await extractEntropyOutcomeRows([report], dir);
    expect(rows).toHaveLength(0);
  });

  test("summarizeEntropyOutcome buckets mean entropyLast by trust label", () => {
    const rows = [
      { taskId: "a", modelVariantId: "m", trust: "verified-correct" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.1, entropyShape: "converging" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 0, lowConfidenceIterations: 0, earlyStopFired: true },
      { taskId: "b", modelVariantId: "m", trust: "verified-correct" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.15, entropyShape: "converging" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 0, lowConfidenceIterations: 0, earlyStopFired: false },
      { taskId: "c", modelVariantId: "m", trust: "claimed-but-wrong" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.5, entropyShape: "flat" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 1, lowConfidenceIterations: 1, earlyStopFired: false },
    ];
    const summary = summarizeEntropyOutcome(rows);
    expect(summary.meanEntropyLastByTrust["verified-correct"]).toBeCloseTo(0.125, 5);
    expect(summary.meanEntropyLastByTrust["claimed-but-wrong"]).toBeCloseTo(0.5, 5);
    expect(summary.earlyStopFireCount).toBe(1);
    expect(summary.totalRows).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/benchmarks/tests/entropy-correlation.test.ts`
Expected: FAIL with "Cannot find module '../src/entropy-correlation.js'".

- [ ] **Step 3: Implement `entropy-correlation.ts`**

```typescript
// File: src/entropy-correlation.ts
// Joins bench outcome data (RunScore.trust/status) with the same run's
// entropy trajectory (from its trace) to answer: does the composite score
// actually separate good outcomes from bad ones? Read-only over both inputs
// — this module never mutates a report or a trace.
import { loadTrace, analyzeRun } from "@reactive-agents/trace";
import { join } from "node:path";
import type { TaskVariantReport, TrustVerdict } from "./types.js";

export interface EntropyOutcomeRow {
  readonly taskId: string;
  readonly modelVariantId: string;
  readonly trust: TrustVerdict | undefined;
  readonly status: "pass" | "fail" | "error";
  readonly entropyFirst: number | undefined;
  readonly entropyLast: number | undefined;
  readonly entropyShape: "converging" | "flat" | "diverging" | "unknown";
  readonly minSourcesPresent: number;
  readonly maxSourcesPresent: number;
  readonly degradedIterations: number;
  readonly lowConfidenceIterations: number;
  readonly earlyStopFired: boolean;
}

/**
 * Join every RunScore that has a traceId to its trace's ReasoningTrajectory.
 * Runs with no traceId (tracing was off, or the run errored before any trace
 * write) are silently skipped — this is a best-effort correlation extractor,
 * not a completeness check.
 */
export async function extractEntropyOutcomeRows(
  reports: readonly TaskVariantReport[],
  traceDir: string,
): Promise<EntropyOutcomeRow[]> {
  const rows: EntropyOutcomeRow[] = [];
  for (const report of reports) {
    for (const run of report.runs) {
      if (!run.traceId) continue;
      let trace;
      try {
        trace = await loadTrace(join(traceDir, `${run.traceId}.jsonl`));
      } catch {
        continue;
      }
      if (trace.events.length === 0) continue;
      const analysis = analyzeRun(trace);
      rows.push({
        taskId: report.taskId,
        modelVariantId: report.modelVariantId,
        trust: run.trust,
        status: run.status,
        entropyFirst: analysis.reasoning.entropyFirst,
        entropyLast: analysis.reasoning.entropyLast,
        entropyShape: analysis.reasoning.entropyShape,
        minSourcesPresent: analysis.reasoning.entropyDegradation.minSourcesPresent,
        maxSourcesPresent: analysis.reasoning.entropyDegradation.maxSourcesPresent,
        degradedIterations: analysis.reasoning.entropyDegradation.degradedIterations,
        lowConfidenceIterations: analysis.reasoning.entropyDegradation.lowConfidenceIterations,
        earlyStopFired: (analysis.reasoning.decisionTypes["early-stop"] ?? 0) > 0,
      });
    }
  }
  return rows;
}

export interface EntropyOutcomeSummary {
  readonly totalRows: number;
  /** Mean `entropyLast` grouped by trust label (only labels present in rows). */
  readonly meanEntropyLastByTrust: Record<string, number>;
  readonly earlyStopFireCount: number;
  /** Rows where entropyShape was "unknown" (too short a run to have a shape). */
  readonly unknownShapeCount: number;
}

export function summarizeEntropyOutcome(rows: readonly EntropyOutcomeRow[]): EntropyOutcomeSummary {
  const byTrust = new Map<string, number[]>();
  let earlyStopFireCount = 0;
  let unknownShapeCount = 0;
  for (const row of rows) {
    const label = row.trust ?? "unknown";
    if (row.entropyLast !== undefined) {
      const list = byTrust.get(label) ?? [];
      list.push(row.entropyLast);
      byTrust.set(label, list);
    }
    if (row.earlyStopFired) earlyStopFireCount++;
    if (row.entropyShape === "unknown") unknownShapeCount++;
  }
  const meanEntropyLastByTrust: Record<string, number> = {};
  for (const [label, values] of byTrust) {
    meanEntropyLastByTrust[label] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return { totalRows: rows.length, meanEntropyLastByTrust, earlyStopFireCount, unknownShapeCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/benchmarks/tests/entropy-correlation.test.ts`
Expected: PASS, all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/benchmarks/src/entropy-correlation.ts packages/benchmarks/tests/entropy-correlation.test.ts
git commit -m "feat(benchmarks): add entropy-outcome correlation extractor"
```

---

### Task 3: Run the real cross-tier bench session and produce the correlation numbers

**Files:**
- Create: `packages/benchmarks/src/run-entropy-correlation.ts` (CLI runner script)
- Create (output, not code): `wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json` (the raw extracted rows + summary, committed as evidence)

**Interfaces:**
- Consumes: `extractEntropyOutcomeRows`, `summarizeEntropyOutcome` from Task 2 (`packages/benchmarks/src/entropy-correlation.ts`); the `real-world-full` bench session preset (`packages/benchmarks/src/sessions/real-world-full.ts`, already sets `traceDir: "benchmark-traces"`).
- Produces: a JSON file at `wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json` with shape `{ rows: EntropyOutcomeRow[], summary: EntropyOutcomeSummary }` — Task 4 reads this file, does not re-run the bench.

This task is empirical, not a code-only deliverable. Do not mark it complete without the JSON file existing and containing real numbers from an actual bench run.

- [ ] **Step 1: Start the judge server (non-SUT model, live layer)**

```bash
JUDGE_LAYER=live JUDGE_PROVIDER=ollama JUDGE_MODEL=gemma4:12b \
JUDGE_MODEL_SHA=gemma4:12b JUDGE_CODE_SHA=dev PORT=8910 \
bun run packages/judge-server/src/index.ts &
```

Smoke-test before proceeding: `curl -s localhost:8910/version` must respond, AND a real `POST /judge` request must return a score (checking `/version` alone can pass even when the LLM backend is dead — verify with an actual judge call, not just the health check).

- [ ] **Step 2: Confirm calibrated models available locally**

Cross-reference: only run models that appear in BOTH `STATIC_CAPABILITIES` and `ollama list`'s output.

```bash
grep -A2 '"' packages/llm-provider/src/capability.ts | grep -E "ollama|cogito|qwen" | head -20
ollama list
```

Cross-reference: only run models that appear in BOTH `STATIC_CAPABILITIES` and `ollama list`'s output. If the previously-documented calibrated local set (`cogito:8b`, `cogito:14b`, `qwen3:4b`, `qwen3:14b`, `qwen3.5:latest`) has drifted, use whatever the grep above actually shows — do not hardcode last session's list without checking it's still accurate.

- [ ] **Step 3: Write the runner script**

```typescript
// File: src/run-entropy-correlation.ts
// One-shot script: run the real-world-full bench session (bare-llm + ra-full,
// cross-tier), then extract + write the entropy-outcome correlation report.
// Usage: bun run packages/benchmarks/src/run-entropy-correlation.ts <output.json>
import { writeFileSync } from "node:fs";
import { runSession } from "./runner.js";
import { getSession } from "./sessions/index.js";
import { extractEntropyOutcomeRows, summarizeEntropyOutcome } from "./entropy-correlation.js";

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("Usage: run-entropy-correlation.ts <output.json>");
    process.exit(1);
  }
  const session = getSession("real-world-full");
  const report = await runSession(session);
  writeFileSync(`${outputPath}.session.json`, JSON.stringify(report, null, 2));

  const rows = await extractEntropyOutcomeRows(report.taskReports, session.traceDir ?? "benchmark-traces");
  const summary = summarizeEntropyOutcome(rows);
  writeFileSync(outputPath, JSON.stringify({ rows, summary }, null, 2));
  console.log(`Wrote ${rows.length} rows. Summary:`, JSON.stringify(summary, null, 2));
}

main();
```

Before running this, check `packages/benchmarks/src/sessions/index.ts` (or wherever session presets are registered/exported) for the ACTUAL exported function name and `SessionReport` field name holding per-task reports (this plan assumes `getSession(name)` and `report.taskReports` by analogy with `TaskVariantReport[]` in `types.ts` — confirm both names against the real source before running; if the names differ, use the real ones, the intent is unchanged).

- [ ] **Step 4: Run it — FOREGROUND, with timeout, runs>=3**

```bash
JUDGE_URL=http://127.0.0.1:8910 \
timeout 590 bun run packages/benchmarks/src/run-entropy-correlation.ts \
  /tmp/claude-1000/entropy-correlation-report.json
```

If the `real-world-full` preset's default run count is below 3, override it per the preset's own CLI-override mechanism (see `packages/benchmarks/src/run.ts`'s `--runs` flag) rather than editing the preset file. Capture full stdout — the printed summary is your first look at the numbers.

- [ ] **Step 5: Sanity-check the output before trusting it**

```bash
python3 -c "
import json
d = json.load(open('/tmp/claude-1000/entropy-correlation-report.json'))
print('total rows:', d['summary']['totalRows'])
print('mean entropyLast by trust:', d['summary']['meanEntropyLastByTrust'])
print('early-stop fires:', d['summary']['earlyStopFireCount'])
print('unknown-shape rows:', d['summary']['unknownShapeCount'])
"
```

If `totalRows` is 0: tracing didn't wire up, or every run errored before a trace was written — stop and diagnose (check `benchmark-traces/` actually has `.jsonl` files) before treating this as a "no correlation" result. A 0-row report is an instrumentation failure, not a finding — do not let it be misread as one (see project memory `feedback_instrument_before_conclusion`).

- [ ] **Step 6: Copy the report into the wiki as committed evidence**

```bash
cp /tmp/claude-1000/entropy-correlation-report.json \
   wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json
```

- [ ] **Step 7: Commit**

```bash
git add packages/benchmarks/src/run-entropy-correlation.ts \
        wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json
git commit -m "feat(benchmarks): run entropy-outcome correlation against real-world-full bench session"
```

---

### Task 4: Apply the decision rule and land (or reject) a weight adjustment

**Files:**
- Read: `wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json` (Task 3's output)
- Modify (conditionally — only if the rule below says to): `packages/reactive-intelligence/src/sensor/composite.ts` (`CATEGORY_WEIGHTS`)
- Create: `wiki/Research/Debriefs/2026-09-14-entropy-weight-validation-debrief.md`

**Interfaces:**
- Consumes: `EntropyOutcomeSummary.meanEntropyLastByTrust`, `.earlyStopFireCount`, `.totalRows` from Task 3's JSON.
- Produces: a debrief document stating the verdict with the actual numbers cited, and (conditionally) a code change to `composite.ts` re-verified by re-running Task 3's script on the affected task categories only.

**Decision rule (apply exactly, do not substitute judgment for it):**

1. Compute `separation = meanEntropyLastByTrust["claimed-but-wrong"] - meanEntropyLastByTrust["verified-correct"]` (use `"dishonest"` in place of `"claimed-but-wrong"` if the former has more rows; if BOTH exist, average them). If either bucket is absent (0 rows), the rule cannot evaluate — write that up as an explicit open item in the debrief (not a "keep as-is" verdict, since there's no evidence either way) and stop; do not fabricate a separation value.
2. **If `separation >= 0.15`:** the composite meaningfully separates outcomes already. Keep `CATEGORY_WEIGHTS` unchanged. Document the number in the debrief as validation.
3. **If `0 <= separation < 0.15`:** weak signal. Do NOT touch the weights this task (touching un-evidenced knobs to chase a weak number is exactly the "hand-picked" problem this plan exists to fix). Document the number and file a follow-up need in the debrief: more bench volume (`runs` count) before concluding anything, since `n` from one session is likely too small to distinguish a real weak effect from noise.
4. **If `separation < 0`** (entropy is LOWER for wrong answers than correct ones — inverted from expectation): this is a real finding, not noise-in-the-right-direction. Write it up prominently in the debrief with the exact numbers and both bucket sizes (row counts), and do NOT attempt a same-task fix — an inverted signal needs its own investigation (which source is driving it: check `minSourcesPresent`/`maxSourcesPresent` for the two buckets — a large source-count gap between them would mean the "lower entropy" bucket is actually just measuring on fewer sources, a confound, not model confidence). Escalate this as the plan's headline finding rather than silently absorbing it into "keep as-is."
5. Separately, regardless of the `separation` outcome: report `earlyStopFireCount` verbatim. If it is `0` across `totalRows >= 10`, state plainly in the debrief that `convergenceThreshold` early-stop has now been OBSERVED to never fire in a real cross-tier run (this closes the open question from the prior audit's RC-4 — it moves from "never observed firing across all probes this session" to "never observed firing across N real bench runs, tier-aware, post-modelTier-fix").

- [ ] **Step 1: Read the report and compute `separation` per the rule above**

```bash
python3 -c "
import json
d = json.load(open('wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json'))
s = d['summary']['meanEntropyLastByTrust']
print(s)
vc = s.get('verified-correct')
cbw = s.get('claimed-but-wrong')
dis = s.get('dishonest')
print('verified-correct:', vc, 'claimed-but-wrong:', cbw, 'dishonest:', dis)
"
```

- [ ] **Step 2: Apply the matching branch of the decision rule (Steps 2-4 above) and write the debrief**

Create `wiki/Research/Debriefs/2026-09-14-entropy-weight-validation-debrief.md` with: the exact `separation` number and which rule branch fired, the `earlyStopFireCount`/`totalRows` finding, row counts per trust bucket, and — only if branch 4 (inverted) fired — the `minSourcesPresent`/`maxSourcesPresent` confound check called for by that branch. Follow the format of the existing `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md` for section structure (file:line citations, no unverified claims).

- [ ] **Step 3 (conditional — only if branch 4 fired AND the confound check ruled out a source-count artifact): propose exactly one adjustment**

If entropy is genuinely inverted and not a source-count confound, the single lowest-risk fix is widening `EXPECTED_TOOL_RANGE` or a specific `CATEGORY_WEIGHTS` entry for the task categories where the inversion concentrated (identified via the `taskId`/`modelVariantId` fields on the raw rows, not the aggregate). Name the SPECIFIC category and field changed, with the row-level evidence cited, in a follow-up commit to `packages/reactive-intelligence/src/sensor/composite.ts` — then re-run Task 3's script filtered to just that category (`--task <id>` per the bench CLI, per Global Constraints' foreground/timeout/output rules) to confirm `separation` improved. If it does not improve, revert the change and record the negative result in the debrief rather than shipping it anyway.

- [ ] **Step 4: Commit**

```bash
git add wiki/Research/Debriefs/2026-09-14-entropy-weight-validation-debrief.md
# If Step 3 fired, also: git add packages/reactive-intelligence/src/sensor/composite.ts
git commit -m "docs(entropy): land weight-validation verdict from real bench correlation data"
```
