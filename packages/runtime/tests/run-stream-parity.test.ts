// Run: bun test packages/runtime/tests/run-stream-parity.test.ts
//
// FM-4 part 1 regression harness — run() and runStream() now both call the
// single shared `deriveTaskOutcome` (engine/finalize/derive-outcome.ts) so
// they cannot silently disagree about the terminal outcome of the same
// scenario. `receipt.terminatedBy` IS on both paths (computeTrustReceipt
// spreads it onto TrustReceipt), and `receipt.verdict` is itself a function
// of the shared `goalAchieved` computation (three of its branches key on it
// — see receipt.ts), so comparing `receipt.terminatedBy` / `receipt.verdict`
// pins the same shared computation this task unified.
//
// The suite below (task 4, wire-or-delete hardening wave) additionally pins
// full outcome parity between `run()` and `AgentStream.collect(runStream())`:
// `success`, `terminatedBy`, `goalAchieved`, and `metadata.toolCalls` must
// match exactly — see task-4-brief.md.
import { describe, it, expect } from "bun:test";
import { Effect } from "effect";
import { ReactiveAgents } from "../src/index.js";
import { AgentStream } from "../src/index.js";

describe("run/stream terminal-outcome parity", () => {
  it("run() and runStream() agree on receipt.terminatedBy and receipt.verdict for the same scenario", async () => {
    const scenario = [{ text: "FINAL ANSWER: 4" }];

    const runAgent = await ReactiveAgents.create().withProvider("test").withTestScenario(scenario).build();
    const streamAgent = await ReactiveAgents.create().withProvider("test").withTestScenario(scenario).build();
    try {
      const runResult = await runAgent.run("What is 2 + 2?");

      let streamReceipt: { terminatedBy?: string; verdict?: string } | undefined;
      for await (const event of streamAgent.runStream("What is 2 + 2?")) {
        if (event._tag === "StreamCompleted") {
          streamReceipt = event.receipt;
        }
      }

      expect(streamReceipt?.terminatedBy).toBe(runResult.terminatedBy);
      expect(streamReceipt?.verdict).toBe(runResult.receipt?.verdict);
    } finally {
      await runAgent.dispose();
      await streamAgent.dispose();
    }
  }, 20000);
});

async function runBoth(build: () => ReturnType<typeof ReactiveAgents.create>, prompt: string) {
  const a = await build().build();
  const b = await build().build();
  try {
    const run = await a.run(prompt);
    const collected = await AgentStream.collect(b.runStream(prompt));
    return { run, collected };
  } finally {
    await a.dispose();
    await b.dispose();
  }
}

const loopTool = {
  tools: [
    {
      definition: {
        name: "parity_tool",
        description: "returns a fixed value",
        parameters: [],
        riskLevel: "low" as const,
        timeoutMs: 5000,
        requiresApproval: false,
        category: "custom" as const,
        source: "function" as const,
      },
      handler: () => Effect.succeed("42"),
    },
  ],
};

describe("run() vs collect(runStream()) — full outcome parity", () => {
  it("plain answer", async () => {
    const { run, collected } = await runBoth(
      () => ReactiveAgents.create().withProvider("test").withTestScenario([{ text: "FINAL ANSWER: 4" }]),
      "What is 2 + 2?",
    );
    expect(collected.success).toBe(run.success);
    expect(collected.terminatedBy).toBe(run.terminatedBy);
    expect(collected.goalAchieved).toBe(run.goalAchieved);
  }, 30000);

  it("tool loop: metadata.toolCalls matches", async () => {
    const { run, collected } = await runBoth(
      () =>
        ReactiveAgents.create()
          .withProvider("test")
          .withTools(loopTool)
          .withTestScenario([
            { toolCalls: [{ name: "parity_tool", args: {} }] },
            { text: "FINAL ANSWER: 42" },
          ]),
      "Use parity_tool then answer.",
    );
    expect(run.metadata.toolCalls?.map((t) => t.name)).toEqual(["parity_tool"]);
    expect(collected.metadata.toolCalls?.map((t) => t.name)).toEqual(run.metadata.toolCalls?.map((t) => t.name));
  }, 30000);

  it("failed/abstained run is not collected as success", async () => {
    // Pinned abstention scenario (abstention-is-not-success.test.ts): a
    // required tool that is never registered can never be satisfied, so the
    // run must decline rather than throw (unlike max_iterations/llm_error,
    // which the bare builder rethrows as an ExecutionError — see
    // BARE_BUILDER_THROWS_ON in reactive-agent.ts).
    const { run, collected } = await runBoth(
      () =>
        ReactiveAgents.create()
          .withProvider("test")
          .withTestScenario([
            { text: "I cannot ground this without the required tool." },
            { text: "I cannot ground this without the required tool." },
          ])
          .withTools({ builtins: [], adaptive: false })
          .withRequiredTools({ tools: ["tool-that-does-not-exist"] })
          .withReasoning({ defaultStrategy: "reactive" })
          .withMaxIterations(2),
      "What is the population of the fictional city of Aetheria?",
    );
    expect(run.success).toBe(false);
    expect(collected.success).toBe(run.success);
    expect(collected.terminatedBy).toBe(run.terminatedBy);
  }, 30000);
});
