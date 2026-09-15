import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { applyStrategySwitch } from "../src/kernel/loop/runner-helpers/strategy-switch.js";
import {
  initialKernelState,
  transitionState,
  type KernelContext,
  type KernelHooks,
  type KernelInput,
  type KernelRunOptions,
} from "../src/kernel/state/kernel-state.js";
import { appendEntry } from "../src/kernel/ledger/run-ledger.js";
import { renderStandingFrame } from "../src/assembly/standing-frame.js";

const hooks = { onStrategySwitched: () => Effect.void } as unknown as KernelHooks;
const options = { strategy: "reactive" } as unknown as KernelRunOptions;
const input = { task: "t", requiredTools: [] } as unknown as KernelInput;
const context = { input } as unknown as KernelContext;

const priorWithLedger = () => {
  const s = initialKernelState(options);
  const ledger = appendEntry(s.ledger, {
    kind: "harness-signal",
    iteration: 1,
    signal: "prior-fact",
  });
  return transitionState(transitionState(s, { ledger }), { iteration: 3 });
};

const doSwitch = () =>
  Effect.runPromise(
    applyStrategySwitch({
      state: priorWithLedger(),
      currentInput: input,
      context,
      options,
      hooks,
      triedStrategies: ["reactive"],
      switchCount: 0,
      fromStrategy: "reactive",
      toStrategy: "plan-execute-reflect",
      failureReason: "loop detected",
    }),
  );

describe("strategy switch — ledger", () => {
  test("prior ledger facts survive the switch", async () => {
    const r = await doSwitch();
    expect((r.state.ledger ?? []).some((e) => e.kind === "harness-signal" && e.signal === "prior-fact")).toBe(true);
  });

  test("the switch mints exactly one handoff entry", async () => {
    const r = await doSwitch();
    const handoffs = (r.state.ledger ?? []).filter((e) => e.kind === "handoff");
    expect(handoffs).toHaveLength(1);
    const h = handoffs[0]!;
    if (h.kind !== "handoff") throw new Error("narrow");
    expect(h.from).toBe("reactive");
    expect(h.to).toBe("plan-execute-reflect");
    expect(h.summary).toContain("loop detected");
  });

  test("handoff is no longer string-folded into priorContext", async () => {
    const r = await doSwitch();
    expect(r.currentInput.priorContext ?? "").not.toContain("Strategy Switch Handoff");
  });

  test("the standing frame renders the handoff from the ledger", async () => {
    const r = await doSwitch();
    const frame = renderStandingFrame({ ledger: r.state.ledger } as Parameters<typeof renderStandingFrame>[0]);
    expect(frame.sections.map((s) => s.name)).toContain("handoff");
  });

  // Step 4 guard: carrying `priorState.ledger` forward means any carried
  // observation `steps` growth must not re-project a SECOND `tool-result`
  // entry for a call id the carried ledger already recorded.
  test("no tool-result is duplicated for the same call id after the carry", async () => {
    const r = await doSwitch();
    const toolResults = (r.state.ledger ?? []).filter((e) => e.kind === "tool-result");
    const callIds = toolResults.map((e) => (e.kind === "tool-result" ? e.toolCallId : undefined)).filter(
      (id): id is string => id !== undefined,
    );
    expect(new Set(callIds).size).toBe(callIds.length);
  });
});
