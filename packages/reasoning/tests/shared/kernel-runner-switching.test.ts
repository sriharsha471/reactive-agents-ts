import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { TestLLMServiceLayer } from "@reactive-agents/llm-provider";
import { runKernel } from "../../src/kernel/loop/runner.js";
import {
  transitionState,
  type KernelState,
  type ThoughtKernel,
} from "../../src/kernel/state/kernel-state.js";
import { makeStep } from "../../src/kernel/capabilities/sense/step-utils.js";

// ── Kernels ───────────────────────────────────────────────────────────────────

/** Kernel that loops with identical tool calls — triggers loop detection */
function makeLoopingKernel(toolAction: string): ThoughtKernel {
  return (state: KernelState, _ctx) =>
    Effect.succeed(
      transitionState(state, {
        status: "thinking",
        iteration: state.iteration + 1,
        steps: [...state.steps, makeStep("action", toolAction)],
      }),
    );
}

/** Kernel that completes successfully on first call */
const successKernel: ThoughtKernel = (state, _ctx) =>
  Effect.succeed(
    transitionState(state, {
      status: "done",
      output: "Switched strategy succeeded",
      iteration: state.iteration + 1,
    }),
  );

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Strategy switching — disabled (default behavior)", () => {
  const testLayer = TestLLMServiceLayer();
  const toolAction = JSON.stringify({ tool: "web-search", input: '{"query":"test"}' });

  it("loop detection transitions to failed when switching disabled", async () => {
    const loopingKernel = makeLoopingKernel(toolAction);

    const result = await Effect.runPromise(
      runKernel(loopingKernel, { task: "loop test" }, {
        maxIterations: 20,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        // No strategySwitching — defaults to disabled
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Loop detected");
  });

  it("strategySwitching.enabled: false — loop detection still fails as before", async () => {
    const loopingKernel = makeLoopingKernel(toolAction);

    const result = await Effect.runPromise(
      runKernel(loopingKernel, { task: "loop test" }, {
        maxIterations: 20,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        strategySwitching: { enabled: false },
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Loop detected");
  });
});

describe("Strategy switching — maxSwitches: 0", () => {
  const testLayer = TestLLMServiceLayer();
  const toolAction = JSON.stringify({ tool: "web-search", input: '{"query":"test"}' });

  it("maxSwitches: 0 means switching immediately goes to failed", async () => {
    const loopingKernel = makeLoopingKernel(toolAction);

    const result = await Effect.runPromise(
      runKernel(loopingKernel, { task: "loop test" }, {
        maxIterations: 20,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        strategySwitching: {
          enabled: true,
          maxSwitches: 0,
          fallbackStrategy: "plan-execute-reflect",
          availableStrategies: ["plan-execute-reflect"],
        },
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Loop detected");
  });
});

describe("Strategy switching — fallbackStrategy (no LLM evaluator)", () => {
  const testLayer = TestLLMServiceLayer();
  const toolAction = JSON.stringify({ tool: "web-search", input: '{"query":"test"}' });

  it("switches to fallbackStrategy and resets state when loop detected", async () => {
    let switchHappened = false;
    // First pass: loop (iterations 0,1,2 all loop). After switch, kernel detects
    // strategy="plan-execute-reflect" on a fresh state and completes successfully.
    const switchAwareKernel: ThoughtKernel = (state, _ctx) => {
      // After strategy switch, state.strategy is updated — detect it here
      if (state.strategy === "plan-execute-reflect") {
        switchHappened = true;
        return Effect.succeed(
          transitionState(state, {
            status: "done",
            output: "Completed after strategy switch",
            iteration: state.iteration + 1,
          }),
        );
      }
      // In the original "reactive" strategy: loop with same tool action to trigger detection
      return Effect.succeed(
        transitionState(state, {
          status: "thinking",
          iteration: state.iteration + 1,
          steps: [...state.steps, makeStep("action", toolAction)],
        }),
      );
    };

    const result = await Effect.runPromise(
      runKernel(switchAwareKernel, { task: "switch test" }, {
        maxIterations: 20,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        strategySwitching: {
          enabled: true,
          maxSwitches: 1,
          fallbackStrategy: "plan-execute-reflect",
          availableStrategies: ["plan-execute-reflect"],
        },
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.status).toBe("done");
    expect(result.output).toBe("Completed after strategy switch");
    expect(switchHappened).toBe(true);
    // The strategy name on final state should reflect the switch
    expect(result.strategy).toBe("plan-execute-reflect");
  });

  it("carries the handoff onto the ledger as a typed fact after switch", async () => {
    let capturedLedger: KernelState["ledger"];
    let switchedCallIteration = 0;

    const contextCapturingKernel: ThoughtKernel = (state, ctx) => {
      if (state.strategy === "plan-execute-reflect") {
        // Fresh state after switch — capture the ledger (the handoff carrier;
        // audit 03-F5 — priorContext is left untouched by the switch now).
        capturedLedger = state.ledger;
        switchedCallIteration = state.iteration;
        return Effect.succeed(
          transitionState(state, {
            status: "done",
            output: "done",
            iteration: state.iteration + 1,
          }),
        );
      }
      // Loop to trigger switch
      return Effect.succeed(
        transitionState(state, {
          status: "thinking",
          iteration: state.iteration + 1,
          steps: [
            ...state.steps,
            makeStep("action", JSON.stringify({ tool: "web-search", input: '{"query":"test"}' })),
          ],
        }),
      );
    };

    await Effect.runPromise(
      runKernel(contextCapturingKernel, { task: "context test" }, {
        maxIterations: 20,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        strategySwitching: {
          enabled: true,
          maxSwitches: 1,
          fallbackStrategy: "plan-execute-reflect",
          availableStrategies: ["plan-execute-reflect"],
        },
      }).pipe(Effect.provide(testLayer)),
    );

    // The handoff is a typed ledger fact now, not string-folded into priorContext.
    const handoffs = (capturedLedger ?? []).filter((e) => e.kind === "handoff");
    expect(handoffs).toHaveLength(1);
    const h = handoffs[0]!;
    if (h.kind !== "handoff") throw new Error("narrow");
    expect(h.from).toBe("reactive");
    expect(h.to).toBe("plan-execute-reflect");
  });

  it("after maxSwitches exhausted, transitions to failed", async () => {
    // Kernel always loops regardless of switch
    const alwaysLoopingKernel = makeLoopingKernel(toolAction);

    const result = await Effect.runPromise(
      runKernel(alwaysLoopingKernel, { task: "exhausted" }, {
        maxIterations: 50,
        strategy: "reactive",
        kernelType: "react",
        loopDetection: { maxSameToolCalls: 3 },
        strategySwitching: {
          enabled: true,
          maxSwitches: 1,
          fallbackStrategy: "plan-execute-reflect",
          availableStrategies: ["plan-execute-reflect"],
        },
      }).pipe(Effect.provide(testLayer)),
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Loop detected");
  });
});
