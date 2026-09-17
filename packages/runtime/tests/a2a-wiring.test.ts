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
});
