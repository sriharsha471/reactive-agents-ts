// Run: bun test packages/reasoning/tests/kernel/state/kernel-state-entropy-meta.test.ts
//
// Follow-up to Task 1 (entropy-weight-validation, 2026-09-14): the earlier
// fix threaded `providerName` into `meta.entropy` only via `think.ts`'s
// logprobs-write branch, which never fires for most Ollama/local models (no
// logprob support). The REAL entropy-meta seed is `initialKernelState()`,
// which builds `entropyMeta` from `KernelRunOptions` fields. This is the
// load-bearing unit test: `providerName` must survive from `KernelRunOptions`
// into the initial `state.meta.entropy`, exactly like `modelId` already does,
// so every strategy call site that threads `providerName` into its
// `KernelRunOptions` literal (direct.ts, reactive.ts, tree-of-thought.ts,
// reflexion.ts, react-kernel.ts) actually reaches the entropy sensor.

import { describe, it, expect } from "bun:test";
import { initialKernelState } from "../../../src/kernel/state/kernel-state.js";

describe("initialKernelState — entropy meta providerName seeding", () => {
  it("carries providerName from KernelRunOptions into meta.entropy, alongside modelId", () => {
    const state = initialKernelState({
      maxIterations: 10,
      strategy: "reactive",
      kernelType: "react",
      providerName: "ollama",
      modelId: "some-model",
    });

    expect(state.meta.entropy?.providerName).toBe("ollama");
    expect(state.meta.entropy?.modelId).toBe("some-model");
  });

  it("omits providerName from meta.entropy when not supplied (no forced default)", () => {
    const state = initialKernelState({
      maxIterations: 10,
      strategy: "reactive",
      kernelType: "react",
      modelId: "some-model",
    });

    expect(state.meta.entropy?.providerName).toBeUndefined();
  });
});
