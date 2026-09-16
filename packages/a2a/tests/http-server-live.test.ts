// Run: bun test packages/a2a/tests/http-server-live.test.ts
import { describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { A2AHttpServer, createA2AHttpServer } from "../src/server/http-server.js";
import { createA2AServer } from "../src/server/a2a-server.js";
import type { AgentCard, JsonRpcResponse, A2ATask } from "../src/types.js";
import type { TaskExecutor } from "../src/server/task-handler.js";

/**
 * The test this package never had: bind a real port, speak real JSON-RPC,
 * assert the agent's output came back. Every bug in Task 1 is invisible
 * without it.
 */

const testAgentCard: AgentCard = {
  name: "Live Test Agent",
  description: "An agent for testing the live A2A HTTP server",
  version: "0.1.0",
  url: "http://localhost:0",
  provider: { organization: "Test Org" },
  capabilities: { streaming: false, pushNotifications: false },
};

interface TestServerOptions {
  readonly port: number;
  readonly executor: (input: string) => Effect.Effect<string, never>;
}

interface TestServerHandle {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

async function startTestServer(options: TestServerOptions): Promise<TestServerHandle> {
  const executor: TaskExecutor = (input, _taskId) => options.executor(input);
  const serverLayer = createA2AServer(testAgentCard);
  const httpLayer = createA2AHttpServer(options.port, executor).pipe(Layer.provide(serverLayer));

  const { stop, boundPort } = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* A2AHttpServer;
      const boundPort = yield* svc.start();
      return { stop: () => Effect.runPromise(svc.stop()), boundPort };
    }).pipe(Effect.provide(httpLayer)),
  );

  return { port: boundPort, stop };
}

async function rpc(
  port: number,
  method: string,
  params: unknown,
  id: string | number = "1",
): Promise<JsonRpcResponse> {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
  });
  return (await res.json()) as JsonRpcResponse;
}

describe("A2A HTTP server, live on a real port", () => {
  it("RED-ON-CUT: message/send runs the executor and tasks/get returns its output", async () => {
    // Build the server with an executor that records what it saw.
    const seen: string[] = [];
    const executor = (input: string) => {
      seen.push(input);
      return Effect.succeed(`echo: ${input}`);
    };

    const handle = await startTestServer({ port: 0, executor });

    const send = await rpc(handle.port, "message/send", {
      message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
      configuration: { blocking: true },
    });
    const sentTask = send.result as A2ATask;

    expect(seen).toEqual(["hello"]);
    // Spec shape: a Task object with `id`, not `{ taskId }`.
    expect(sentTask.id).toBeString();
    expect(sentTask.status.state).toBe("completed");
    expect(JSON.stringify(sentTask.artifacts)).toContain("echo: hello");

    const got = await rpc(handle.port, "tasks/get", { id: sentTask.id });
    const gotTask = got.result as A2ATask;
    expect(gotTask.id).toBe(sentTask.id);
    expect(gotTask.status.state).toBe("completed");

    await handle.stop();
  });

  it("echoes the JSON-RPC request id on success (spec requirement)", async () => {
    const handle = await startTestServer({ port: 0, executor: () => Effect.succeed("ok") });
    const res = await rpc(handle.port, "agent/card", {}, "req-42");
    expect(res.id).toBe("req-42");
    await handle.stop();
  });

  it("cancels an in-flight task instead of reporting TASK_NOT_FOUND", async () => {
    // A never-settling executor keeps the task in `working` so cancel is legal.
    const handle = await startTestServer({
      port: 0,
      executor: () => Effect.never,
    });
    const send = await rpc(handle.port, "message/send", {
      message: { role: "user", parts: [{ kind: "text", text: "slow" }] },
    });
    const sentTask = send.result as A2ATask;
    const cancel = await rpc(handle.port, "tasks/cancel", { id: sentTask.id });
    const canceledTask = cancel.result as A2ATask;
    expect(cancel.error).toBeUndefined();
    expect(canceledTask.status.state).toBe("canceled");
    await handle.stop();
  });

  it("returns the task immediately in non-blocking mode", async () => {
    const handle = await startTestServer({
      port: 0,
      executor: () => Effect.never,
    });
    const send = await rpc(handle.port, "message/send", {
      message: { role: "user", parts: [{ kind: "text", text: "bg" }] },
      configuration: { blocking: false },
    });
    const sentTask = send.result as A2ATask;
    // Must NOT hang waiting for the executor.
    expect(["submitted", "working"]).toContain(sentTask.status.state);
    await handle.stop();
  });
});
