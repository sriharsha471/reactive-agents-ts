// Run: bun test packages/reasoning/tests/kernel/capabilities/reflect/reactive-observer-provider-tier.test.ts --timeout 15000
//
// Task 1 (entropy-weight-validation, 2026-09-14): thread `providerName` from
// `state.meta.entropy.providerName` into the EntropySensorService.score()
// call so `lookupModel()`'s 3rd argument (provider-derived tier fallback)
// can ever activate for Ollama/local models not in the static registry.
//
// Pattern copied from packages/reasoning/tests/kernel/calibration-wiring.test.ts
// (StrategyServices + Option-wrapped services, NOT a Layer/Context.Tag —
// runReactiveObserver takes a plain StrategyServices bag directly).

import { Effect, Option } from "effect";
import { describe, it, expect } from "bun:test";
import { runReactiveObserver } from "../../../../src/kernel/capabilities/reflect/reactive-observer.js";
import type { KernelState, KernelRunOptions } from "../../../../src/kernel/state/kernel-state.js";
import type { StrategyServices } from "../../../../src/kernel/utils/service-utils.js";

function makeKernelState(overrides: Partial<KernelState> = {}): KernelState {
  return {
    taskId: "test-task-1",
    strategy: "reactive",
    kernelType: "react",
    messages: [],
    steps: [
      { type: "thought", content: "Analyzing the task", metadata: {} },
    ],
    toolsUsed: new Set<string>(),
    scratchpad: new Map<string, string>(),
    iteration: 3,
    tokens: 500,
    cost: 0,
    status: "thinking" as const,
    output: null,
    error: null,
    meta: {
      entropy: {
        modelId: "cogito:14b",
        providerName: "ollama",
        entropyHistory: [],
      },
    },
    controllerDecisionLog: [],
    ...overrides,
  } as KernelState;
}

function makeRunOptions(): KernelRunOptions {
  return {
    maxIterations: 10,
    strategy: "reactive",
    kernelType: "react",
    modelId: "cogito:14b",
  };
}

function noneService<T>(): Option.Option<T> {
  return Option.none();
}

function someService<T>(value: T): Option.Option<T> {
  return Option.some(value);
}

describe("reactive-observer providerName forwarding", () => {
  it("forwards meta.entropy.providerName into EntropySensorService.score params", async () => {
    let capturedProviderName: string | undefined;

    const mockEntropySensor = {
      score: (params: Record<string, unknown>) => {
        capturedProviderName = params.providerName as string | undefined;
        return Effect.succeed({
          composite: 0.2,
          sources: { token: null, structural: 0.2, semantic: null, behavioral: 0.2, contextPressure: 0 },
          trajectory: { derivative: 0, shape: "flat" as const, momentum: 0.2 },
          confidence: "low" as const,
          modelTier: "local" as const,
          iteration: 0,
          iterationWeight: 1,
          timestamp: Date.now(),
        });
      },
      scoreContext: () => Effect.succeed({
        utilizationPct: 0,
        sections: [],
        atRiskSections: [],
        compressionHeadroom: 1,
      }),
      getCalibration: (_modelId: string) => Effect.succeed({
        modelId: "test",
        calibrated: false,
        sampleCount: 0,
        highEntropyThreshold: 0.8,
        convergenceThreshold: 0.4,
      }),
      updateCalibration: (_modelId: string, _runScores: readonly number[]) => Effect.succeed({
        modelId: "test",
        calibrated: false,
        sampleCount: 1,
        highEntropyThreshold: 0.8,
        convergenceThreshold: 0.4,
      }),
      getTrajectory: (_taskId: string) => Effect.succeed({
        history: [],
        derivative: 0,
        momentum: 0,
        shape: "insufficient-data" as const,
      }),
    };

    const services: StrategyServices = {
      llm: {} as any,
      toolService: noneService(),
      promptService: noneService(),
      eventBus: noneService(),
      entropySensor: someService(mockEntropySensor),
      reactiveController: noneService(),
      dispatcher: noneService(),
    };

    const state = makeKernelState();
    const options = makeRunOptions();

    await Effect.runPromise(
      runReactiveObserver(state, services, noneService(), 0, options),
    );

    expect(capturedProviderName).toBe("ollama");
  }, 15000);
});
