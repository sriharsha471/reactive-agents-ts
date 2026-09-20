// Run: bun test packages/reactive-intelligence/tests/sensor/entropy-history-dedup.test.ts --timeout 15000
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { EntropySensorService, EventBusLive } from "@reactive-agents/core";
import { createReactiveIntelligenceLayer } from "../../src/runtime.js";

describe("entropy trajectory history", () => {
  const makeLayer = () => createReactiveIntelligenceLayer({ calibrationDbPath: ":memory:" }).pipe(
    Layer.provide(EventBusLive),
  );

  const state = (taskId: string) => ({
    taskId,
    strategy: "reactive",
    kernelType: "react",
    steps: [] as readonly { type: string; content: string }[],
    toolsUsed: new Set<string>(),
    iteration: 0,
    tokens: 0,
    status: "thinking" as const,
    output: null,
    error: null,
    meta: {},
  });

  test("does not append an immediately duplicated thought to trajectory history", async () => {
    const result = await Effect.gen(function* () {
      const sensor = yield* EntropySensorService;
      const first = yield* sensor.score({
        thought: "I will retrieve the requested data.",
        taskDescription: "Retrieve data",
        strategy: "reactive",
        iteration: 0,
        maxIterations: 10,
        modelId: "test-model",
        temperature: 0,
        kernelState: state("dedup-task"),
      });
      yield* sensor.score({
        thought: "I will retrieve the requested data.",
        taskDescription: "Retrieve data",
        strategy: "reactive",
        iteration: 4,
        maxIterations: 10,
        modelId: "test-model",
        temperature: 0,
        kernelState: state("dedup-task"),
      });
      return { first, trajectory: yield* sensor.getTrajectory("dedup-task") };
    }).pipe(Effect.provide(makeLayer()), Effect.runPromise);

    expect(result.trajectory.history).toHaveLength(1);
    expect(result.trajectory.history[0]).toBe(result.first.composite);
  }, 15000);

  test("allows a repeated thought after an intervening thought", async () => {
    const history = await Effect.gen(function* () {
      const sensor = yield* EntropySensorService;
      for (const [iteration, thought] of [
        [0, "First thought"],
        [1, "Second thought"],
        [2, "First thought"],
      ] as const) {
        yield* sensor.score({
          thought,
          taskDescription: "Task",
          strategy: "reactive",
          iteration,
          maxIterations: 10,
          modelId: "test-model",
          temperature: 0,
          kernelState: state("repeat-task"),
        });
      }
      return yield* sensor.getTrajectory("repeat-task");
    }).pipe(Effect.provide(makeLayer()), Effect.runPromise);

    expect(history.history).toHaveLength(3);
  }, 15000);
});
