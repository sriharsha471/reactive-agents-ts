import { describe, it, expect } from "bun:test";
import { toTraceEvent } from "../src/normalize.js";
import type { AgentEvent } from "@reactive-agents/core";

const completed = (extra: Record<string, unknown>): AgentEvent =>
  ({
    _tag: "AgentCompleted",
    taskId: "run-1",
    agentId: "a",
    success: false,
    totalIterations: 3,
    totalTokens: 1200,
    durationMs: 900,
    ...extra,
  }) as AgentEvent;

describe("run-completed carries what the publisher knows", () => {
  it("maps terminationReason to terminatedBy", () => {
    const ev = toTraceEvent(completed({ terminationReason: "abstained" }), 0);
    expect(ev?.kind).toBe("run-completed");
    expect((ev as { terminatedBy?: string }).terminatedBy).toBe("abstained");
  });

  it("maps totalCostUsd instead of hardcoding 0", () => {
    const ev = toTraceEvent(completed({ totalCostUsd: 0.0123 }), 0);
    expect((ev as { totalCostUsd: number }).totalCostUsd).toBeCloseTo(0.0123, 6);
  });

  it("absent fields stay absent / zero (older publishers)", () => {
    const ev = toTraceEvent(completed({}), 0) as { terminatedBy?: string; totalCostUsd: number };
    expect(ev.terminatedBy).toBeUndefined();
    expect(ev.totalCostUsd).toBe(0);
  });
});
