import { describe, test, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { EntropySensorService, EventBusLive } from "@reactive-agents/core";
import { createReactiveIntelligenceLayer } from "../../src/runtime.js";
import { VALIDATION_DATASET } from "./validation-dataset.js";

describe("validation dataset accuracy", () => {
  // RI layer's calibration-update subscriber requires EventBus.
  // calibrationDbPath: ":memory:" — CalibrationStore defaults to a REAL disk
  // path (~/.reactive-agents/calibration.db); tests must never touch it.
  const layer = createReactiveIntelligenceLayer({ calibrationDbPath: ":memory:" }).pipe(
    Layer.provide(EventBusLive),
  );

  /**
   * High-signal examples: well-structured reasoning with tool progress.
   * All entropy sources use disorder orientation (higher = more uncertain),
   * so confident, well-structured runs land near zero. Measured post-fix
   * distribution: 0.000–0.066 across 22 examples.
   */
  test("classification accuracy >= 80% on high-signal examples", async () => {
    const highSignal = VALIDATION_DATASET.filter((e) => e.category === "high-signal");
    expect(highSignal.length).toBeGreaterThanOrEqual(15);

    let correct = 0;
    const failures: string[] = [];

    for (const example of highSignal) {
      const program = Effect.gen(function* () {
        const sensor = yield* EntropySensorService;
        return yield* sensor.score(example.input);
      });
      const score = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      if (score.composite < 0.15) {
        correct++;
      } else {
        failures.push(`  FAIL: "${example.label}" composite=${score.composite.toFixed(3)}`);
      }
    }

    const accuracy = correct / highSignal.length;
    console.log(
      `High-signal accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${highSignal.length})`,
    );
    if (failures.length > 0) console.log(failures.join("\n"));
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });

  /**
   * Low-signal examples: malformed, repetitive, stalled, or drifting.
   * Disorder-oriented sources push these up. Measured post-fix
   * distribution: 0.344–0.580 across 23 examples, cleanly above the
   * ambiguous band (max 0.279).
   */
  test("classification accuracy >= 80% on low-signal examples", async () => {
    const lowSignal = VALIDATION_DATASET.filter((e) => e.category === "low-signal");
    expect(lowSignal.length).toBeGreaterThanOrEqual(15);

    let correct = 0;
    const failures: string[] = [];

    for (const example of lowSignal) {
      const program = Effect.gen(function* () {
        const sensor = yield* EntropySensorService;
        return yield* sensor.score(example.input);
      });
      const score = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      if (score.composite > 0.30) {
        correct++;
      } else {
        failures.push(`  FAIL: "${example.label}" composite=${score.composite.toFixed(3)}`);
      }
    }

    const accuracy = correct / lowSignal.length;
    console.log(
      `Low-signal accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${lowSignal.length})`,
    );
    if (failures.length > 0) console.log(failures.join("\n"));
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });

  /**
   * Ambiguous examples: short but valid, exploratory, jargon-heavy.
   * Measured post-fix distribution: 0.218–0.279 — between high-signal
   * (max 0.066) and low-signal (min 0.344).
   */
  test("ambiguous examples fall in middle range", async () => {
    const ambiguous = VALIDATION_DATASET.filter((e) => e.category === "ambiguous");
    expect(ambiguous.length).toBeGreaterThanOrEqual(15);

    let inRange = 0;
    const failures: string[] = [];

    for (const example of ambiguous) {
      const program = Effect.gen(function* () {
        const sensor = yield* EntropySensorService;
        return yield* sensor.score(example.input);
      });
      const score = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      if (score.composite >= 0.15 && score.composite <= 0.32) {
        inRange++;
      } else {
        failures.push(`  FAIL: "${example.label}" composite=${score.composite.toFixed(3)}`);
      }
    }

    const ratio = inRange / ambiguous.length;
    console.log(
      `Ambiguous in-range: ${(ratio * 100).toFixed(1)}% (${inRange}/${ambiguous.length})`,
    );
    if (failures.length > 0) console.log(failures.join("\n"));
    expect(ratio).toBeGreaterThanOrEqual(0.7);
  });

  /**
   * Verify the dataset has enough examples per category.
   */
  test("dataset has >= 60 total examples with >= 15 per category", () => {
    expect(VALIDATION_DATASET.length).toBeGreaterThanOrEqual(60);

    const counts = { "high-signal": 0, "low-signal": 0, ambiguous: 0 };
    for (const example of VALIDATION_DATASET) {
      counts[example.category]++;
    }

    expect(counts["high-signal"]).toBeGreaterThanOrEqual(15);
    expect(counts["low-signal"]).toBeGreaterThanOrEqual(15);
    expect(counts["ambiguous"]).toBeGreaterThanOrEqual(15);

    console.log(
      `Dataset: ${VALIDATION_DATASET.length} total — ` +
        `high-signal: ${counts["high-signal"]}, ` +
        `low-signal: ${counts["low-signal"]}, ` +
        `ambiguous: ${counts["ambiguous"]}`,
    );
  });
});
