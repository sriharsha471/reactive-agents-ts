// Run: bun test packages/runtime/tests/a2a-wiring.test.ts
//
// `agent.serveA2A()` replaces the old, inert `.withA2A()` layer wiring
// (`runtime.ts`'s deleted `A2aExtraLayer`), which composed at
// runtime-construction time — before the agent existed and before there was
// any executor to hand it — so it never bound a real port and never reached
// a real `run()`. These tests prove the REPLACEMENT actually does both.
import { describe, expect, it } from "bun:test";
import { ReactiveAgents } from "../src/index.js";

describe("agent.serveA2A()", () => {
  it("RED-ON-CUT: a real A2A message/send reaches the real agent", async () => {
    const agent = await ReactiveAgents.create()
      .withName("a2a-wiring-agent")
      .withProvider("test")
      .withTestScenario([{ text: "the answer is 42" }])
      .build();

    const handle = await agent.serveA2A({ port: 0 });

    try {
      const res = (await fetch(`http://127.0.0.1:${handle.port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/send",
          params: {
            message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
            configuration: { blocking: true },
          },
          id: "1",
        }),
      }).then((r) => r.json())) as {
        result: { status: { state: string }; artifacts?: unknown };
      };

      // Cutting the executor wiring makes this red. That is the assertion
      // .withA2A() never had.
      expect(res.result.status.state).toBe("completed");
      expect(JSON.stringify(res.result.artifacts)).toContain("the answer is 42");
    } finally {
      await handle.stop();
    }
  });

  // Task 2 fix-round-1 finding: the executor only read `result.output`, never
  // `result.success`. `run()`'s documented contract (reactive-agent.ts, the
  // BARE_BUILDER_THROWS_ON comment) has abstention resolve `success: false`
  // WITHOUT throwing — so an A2A caller who triggers it got back
  // `state: "completed"`, indistinguishable from a real answer. This forces
  // the same `requiredToolUnavailable` abstention trigger used by
  // `abstention-is-not-success.test.ts` through the real A2A HTTP path and
  // asserts the task ends up `state: "failed"`, not `"completed"`.
  it("an agent that abstains reports the A2A task as failed, not completed", async () => {
    const agent = await ReactiveAgents.create()
      .withName("a2a-abstain-agent")
      .withProvider("test")
      .withModel("test")
      .withTestScenario([
        { text: "I cannot ground this without the required tool." },
        { text: "I cannot ground this without the required tool." },
      ] as never)
      .withTools({ builtins: [], adaptive: false } as never)
      .withRequiredTools({ tools: ["tool-that-does-not-exist"] })
      .withReasoning({ defaultStrategy: "reactive" })
      .withMaxIterations(2)
      .build();

    const handle = await agent.serveA2A({ port: 0 });

    try {
      const res = (await fetch(`http://127.0.0.1:${handle.port}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "message/send",
          params: {
            message: {
              role: "user",
              parts: [
                { kind: "text", text: "What is the population of the fictional city of Aetheria?" },
              ],
            },
            configuration: { blocking: true },
          },
          id: "1",
        }),
      }).then((r) => r.json())) as {
        result: { status: { state: string; message?: string } };
      };

      expect(res.result.status.state).toBe("failed");
      expect(res.result.status.message).toBeString();
    } finally {
      await handle.stop();
      await agent.dispose();
    }
  }, 20000);

  it("serves a spec-conformant agent card at /.well-known/agent.json", async () => {
    const agent = await ReactiveAgents.create()
      .withName("card-agent")
      .withProvider("test")
      .build();
    const handle = await agent.serveA2A({ port: 0, description: "Test agent" });

    try {
      const card = (await fetch(
        `http://127.0.0.1:${handle.port}/.well-known/agent.json`,
      ).then((r) => r.json())) as { protocolVersion: string; name: string; version: string };

      expect(card.protocolVersion).toBeString();
      expect(card.name).toBe("card-agent");
      // The old inline card hardcoded "0.5.0" — it must be gone.
      expect(card.version).not.toBe("0.5.0");
    } finally {
      await handle.stop();
    }
  });

  // Final-review C1: `serveA2A({token})` used to mutate `process.env`
  // (`RA_A2A_TOKEN`/`RA_A2A_HOST`) and never restore it, so a later
  // `serveA2A()` call with NO options in the same process would silently
  // inherit the previous call's hostname/token requirement. hostname stays
  // loopback here (binding non-loopback in a test is impractical/unsafe) —
  // the token-leak half of the bug is fully exercised by requiring auth on
  // the first server and asserting its ABSENCE is not inherited by the
  // second, options-less server.
  it("RED-ON-CUT: a later serveA2A() with no options does not inherit a prior call's token requirement", async () => {
    const agent1 = await ReactiveAgents.create()
      .withName("a2a-leak-agent-1")
      .withProvider("test")
      .build();

    const handle1 = await agent1.serveA2A({ port: 0, hostname: "127.0.0.1", token: "tok-1" });

    // Sanity: the first server actually enforces its own token.
    const unauthed = await fetch(`http://127.0.0.1:${handle1.port}/.well-known/agent.json`);
    expect(unauthed.status).toBe(401);

    await handle1.stop();

    const agent2 = await ReactiveAgents.create()
      .withName("a2a-leak-agent-2")
      .withProvider("test")
      .build();

    // No hostname/token passed at all — must NOT require agent1's token.
    const handle2 = await agent2.serveA2A({ port: 0 });

    try {
      const res = await fetch(`http://127.0.0.1:${handle2.port}/.well-known/agent.json`);
      expect(res.status).toBe(200);
    } finally {
      await handle2.stop();
    }
  });
});
