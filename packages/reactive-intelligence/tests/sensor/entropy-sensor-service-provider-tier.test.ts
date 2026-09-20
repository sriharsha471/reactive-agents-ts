// Run: bun test packages/reactive-intelligence/tests/sensor/entropy-sensor-service-provider-tier.test.ts
//
// Task 1 (entropy-weight-validation, 2026-09-14): `score()` forwards
// `params.providerName` into `lookupModel(modelId, config.models, providerName)`
// so an Ollama model that is NOT in the static MODEL_REGISTRY resolves to the
// provider-derived tier ("local") instead of silently falling through to
// "unknown". Pattern copied from entropy-sensor-service.test.ts (live
// EntropySensorServiceLive layer via createReactiveIntelligenceLayer).

import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { EntropySensorService, EventBusLive } from "@reactive-agents/core";
import { createReactiveIntelligenceLayer } from "../../src/runtime.js";

describe("entropy-sensor-service providerName -> modelTier", () => {
  const testLayer = createReactiveIntelligenceLayer({ calibrationDbPath: ":memory:" }).pipe(
    Layer.provide(EventBusLive),
  );

  const makeKernelState = (overrides: Record<string, unknown> = {}) => ({
    taskId: "provider-tier-test",
    strategy: "reactive",
    kernelType: "react",
    steps: [] as any[],
    toolsUsed: new Set<string>(),
    scratchpad: new Map<string, string>(),
    iteration: 3,
    tokens: 0,
    cost: 0,
    status: "thinking" as const,
    output: null,
    error: null,
    meta: {},
    ...overrides,
  });

  test("an unregistered Ollama model tags modelTier: 'local' when providerName is 'ollama'", async () => {
    const program = Effect.gen(function* () {
      const sensor = yield* EntropySensorService;
      return yield* sensor.score({
        thought: "Thinking about a brand new local model.",
        taskDescription: "Test unregistered ollama model tier resolution",
        strategy: "reactive",
        iteration: 3,
        maxIterations: 10,
        modelId: "some-brand-new-ollama-model:9b",
        providerName: "ollama",
        temperature: 0.3,
        kernelState: makeKernelState(),
      });
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.modelTier).toBe("local");
  });

  test("no providerName still falls back to 'unknown' for an unregistered model (regression guard)", async () => {
    const program = Effect.gen(function* () {
      const sensor = yield* EntropySensorService;
      return yield* sensor.score({
        thought: "Thinking about a brand new model with no provider hint.",
        taskDescription: "Test unregistered model with no providerName",
        strategy: "reactive",
        iteration: 3,
        maxIterations: 10,
        modelId: "some-brand-new-ollama-model:9b",
        temperature: 0.3,
        kernelState: makeKernelState(),
      });
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(result.modelTier).toBe("unknown");
  });
});
