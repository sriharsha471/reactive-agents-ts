// Run: bun test packages/reasoning/tests/assembly/num-ctx-demand.test.ts --timeout 15000
//
// Task 7 (D-2026-07-30-I): demand-driven Ollama num_ctx, opt-in via
// HarnessConfig.numCtxPolicy = "demand". Two layers of coverage:
//   1. `nextNumCtx` — pure bucket-selection policy (Step 1).
//   2. Kernel wiring — `handleThinking` sets `request.numCtx` only when
//      `numCtxPolicy === "demand"` AND the provider is Ollama (Step 5).
//
// Step 5 deviation from the brief: the brief suggested placing the wiring
// test in `packages/runtime/tests/` via the builder's `.withProvider("ollama")`.
// Verified live: `ReactiveAgents.build()` runs an unconditional pre-flight
// `validateProviderConnection("ollama")` network call (builder.ts, calling
// `validateProviderConnection` in build-validation.ts) BEFORE `.withReplayLLM`
// can intercept anything — that would make this test require a live Ollama
// connection in CI, which the task explicitly forbids. Instead this test
// drives `executeReActKernel` directly (packages/reasoning/src/kernel/loop/
// react-kernel.ts), which accepts `providerName` and `harness` as plain
// input fields with no builder/network involvement — see the existing
// CI-safe pattern in packages/reasoning/tests/strategies/kernel/react-kernel.test.ts.
import { describe, it, expect } from "bun:test";
import { Effect, Layer } from "effect";
import { nextNumCtx } from "../../src/assembly/capability.js";
import { executeReActKernel } from "../../src/kernel/loop/react-kernel.js";
import { resolveHarnessConfig } from "../../src/harness-config.js";
import { LLMService, TestLLMService } from "@reactive-agents/llm-provider";
import type { CompletionRequest } from "@reactive-agents/llm-provider";

describe("nextNumCtx — monotone demand buckets", () => {
  it("picks the smallest bucket that fits prompt + output + headroom", () => {
    expect(nextNumCtx(3000, 2000, undefined, undefined)).toBe(8192);
    expect(nextNumCtx(7000, 2000, undefined, undefined)).toBe(16384);
  });
  it("never shrinks below the run's high-water mark (avoids Ollama reloads)", () => {
    expect(nextNumCtx(1000, 2000, 32768, undefined)).toBe(32768);
  });
  it("never exceeds the model ceiling", () => {
    expect(nextNumCtx(100_000, 2000, undefined, 32768)).toBe(32768);
  });
  it("caps at the largest bucket when nothing fits and no ceiling is known", () => {
    expect(nextNumCtx(500_000, 2000, undefined, undefined)).toBe(131072);
  });
});

/** Capturing LLMService — records every request the kernel's think phase issues. */
function capturingLayer(captured: CompletionRequest[]): Layer.Layer<LLMService> {
  const base = TestLLMService([{ text: "FINAL ANSWER: done" }]);
  return Layer.succeed(
    LLMService,
    LLMService.of({
      ...base,
      complete: (r) => {
        captured.push(r);
        return base.complete(r);
      },
      stream: (r) => {
        captured.push(r);
        return base.stream(r);
      },
    }),
  );
}

describe("demand-driven num_ctx — kernel wiring (Step 5)", () => {
  it("sets request.numCtx for a short prompt when numCtxPolicy is 'demand' and provider is ollama", async () => {
    const captured: CompletionRequest[] = [];
    const layer = capturingLayer(captured);
    await Effect.runPromise(
      executeReActKernel({
        task: "What is 2 + 2?",
        maxIterations: 1,
        providerName: "ollama",
        harness: resolveHarnessConfig({ numCtxPolicy: "demand" }),
      }).pipe(Effect.provide(layer)),
    );
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.numCtx).toBe(8192);
  });

  it("leaves request.numCtx undefined when numCtxPolicy is unset (default 'fixed')", async () => {
    const captured: CompletionRequest[] = [];
    const layer = capturingLayer(captured);
    await Effect.runPromise(
      executeReActKernel({
        task: "What is 2 + 2?",
        maxIterations: 1,
        providerName: "ollama",
      }).pipe(Effect.provide(layer)),
    );
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.numCtx).toBeUndefined();
  });

  it("leaves request.numCtx undefined for a non-ollama provider even with numCtxPolicy 'demand'", async () => {
    const captured: CompletionRequest[] = [];
    const layer = capturingLayer(captured);
    await Effect.runPromise(
      executeReActKernel({
        task: "What is 2 + 2?",
        maxIterations: 1,
        providerName: "anthropic",
        harness: resolveHarnessConfig({ numCtxPolicy: "demand" }),
      }).pipe(Effect.provide(layer)),
    );
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]?.numCtx).toBeUndefined();
  });
});
