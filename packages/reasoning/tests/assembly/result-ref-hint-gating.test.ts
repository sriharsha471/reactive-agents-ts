// Run: bun test packages/reasoning/tests/assembly/result-ref-hint-gating.test.ts --timeout 15000
//
// The overflow preview must only teach `write_result_to_file` when that tool is
// actually offered to the model. Default harness does not register it
// (RA_OVERHAUL off), so advertising it sends the model to a nonexistent tool.
import { describe, it, expect } from "bun:test";
import { projectResultsStage } from "../../src/assembly/stages/project-results.js";
import { EventLog } from "../../src/assembly/event-log.js";
import { ResultStore, offersWriteByRef } from "../../src/assembly/result-store.js";
import { resolveCapability } from "../../src/assembly/capability.js";
import { emptyTrace } from "../../src/assembly/trace.js";

function overflowCtx(schemas: readonly unknown[]) {
  const prev = process.env.RA_TOOL_RESULT_BUDGET_CHARS;
  process.env.RA_TOOL_RESULT_BUDGET_CHARS = "400";
  const cap = resolveCapability({ window: 1000, outputBudget: 100, dialect: "native-fc", tier: "local" });
  if (prev === undefined) delete process.env.RA_TOOL_RESULT_BUDGET_CHARS;
  else process.env.RA_TOOL_RESULT_BUDGET_CHARS = prev;
  const store = new ResultStore();
  const big = Array.from({ length: 50 }, (_, i) => ({ sha: `s${i}`, commit: { message: `message ${i} ${"x".repeat(50)}` } }));
  const ref = store.put("github/list_commits", big);
  const log = new EventLog()
    .append({ kind: "tool_called", tool: "github/list_commits", callId: "c1", args: {} })
    .append({ kind: "tool_result", callId: "c1", ref, shape: "Array" });
  const input = { log, capability: cap, store, persona: { system: "" }, tools: { schemas } };
  return projectResultsStage({ ...input, systemPrompt: "", messages: [], toolSchemas: schemas, trace: emptyTrace(cap) });
}

describe("result-ref action hint is gated on tool availability", () => {
  it("does NOT mention write_result_to_file when the tool is not offered", () => {
    const ctx = overflowCtx([{ name: "github/list_commits" }]);
    const tr = ctx.messages.find((m) => m.role === "tool_result")!;
    expect(tr.content).toContain("result_ref=");
    expect(tr.content).not.toContain("write_result_to_file");
  });

  it("DOES mention write_result_to_file when the tool is offered", () => {
    const ctx = overflowCtx([{ name: "github/list_commits" }, { name: "write_result_to_file" }]);
    const tr = ctx.messages.find((m) => m.role === "tool_result")!;
    expect(tr.content).toContain("write_result_to_file");
  });

  it("offersWriteByRef recognizes flat and function-wrapped schema shapes", () => {
    expect(offersWriteByRef([{ name: "write_result_to_file" }])).toBe(true);
    expect(offersWriteByRef([{ type: "function", function: { name: "write_result_to_file" } }])).toBe(true);
    expect(offersWriteByRef([{ name: "file-write" }])).toBe(false);
    expect(offersWriteByRef([])).toBe(false);
  });
});
