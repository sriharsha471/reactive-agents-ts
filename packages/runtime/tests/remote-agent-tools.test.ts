// Run: bun test packages/runtime/tests/remote-agent-tools.test.ts --timeout 20000
//
// Task 3 (A2A repair) — `createRemoteAgentToolRegistration` is the ONE client
// in the A2A repair plan with real production traffic (`.withAgentTool()` /
// `.withRemoteAgent()`), and it had no test coverage of its own. It reads the
// spec-shaped `A2ATask` (`d.result.id`, `status.state`, `artifacts[].parts[].text`)
// rather than the fictional `{ taskId, status: string, result }` dialect the
// pre-repair code assumed.
//
// This drives the handler against the REAL A2A HTTP server (`createA2AHttpServer`
// from `@reactive-agents/a2a`, fixed in Task 1) rather than a hand-rolled
// `Bun.serve` mock — the same choice `a2a-client.test.ts`'s `startRealServer`
// helper makes, and for the same reason: a hand-rolled mock encodes whatever
// shape the test author assumes, which is exactly the class of bug this repair
// plan exists to catch. Proving the round trip against the real server closes
// that gap for the client that actually carries production traffic.
import { describe, expect, test, afterEach } from "bun:test";
import { Effect, Layer } from "effect";
import {
  A2AHttpServer,
  A2AError,
  createA2AHttpServer,
  createA2AServer,
  type AgentCard,
  type TaskExecutor,
} from "@reactive-agents/a2a";
import {
  createRemoteAgentTool,
  executeRemoteAgentTool,
} from "@reactive-agents/tools";
import {
  createRemoteAgentToolRegistration,
  type RemoteAgentToolDeps,
} from "../src/builder/build-effect/remote-agent-tools.js";

const testAgentCard: AgentCard = {
  name: "Remote Agent Tools Test Agent",
  version: "0.1.0",
  url: "http://localhost:0",
  provider: { organization: "Test Org" },
  capabilities: { streaming: false },
};

/** Starts the real A2A HTTP server bound to an ephemeral loopback port. */
async function startRealServer(executor?: TaskExecutor) {
  const serverLayer = createA2AServer(testAgentCard);
  const httpLayer = createA2AHttpServer(0, executor).pipe(Layer.provide(serverLayer));

  const { stop, port } = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* A2AHttpServer;
      const boundPort = yield* svc.start();
      return { stop: () => Effect.runPromise(svc.stop()), port: boundPort };
    }).pipe(Effect.provide(httpLayer)),
  );

  return { port, stop };
}

/** Real (non-mocked) deps — same wiring the builder uses in production. */
const realDeps: RemoteAgentToolDeps = {
  createRemoteAgentTool,
  executeRemoteAgentTool,
};

let activeStop: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (activeStop) {
    await activeStop();
    activeStop = null;
  }
});

describe("createRemoteAgentToolRegistration — send→poll→result flow", () => {
  test("polls a working→completed task and extracts artifact text", async () => {
    // Server-side executor takes long enough that the first `tasks/get` poll
    // observes `working`, forcing the client's poll loop to actually loop
    // rather than resolve on the first read.
    const executor: TaskExecutor = (input) =>
      Effect.gen(function* () {
        yield* Effect.sleep("300 millis");
        return `Echo: ${input}`;
      });

    const { port, stop } = await startRealServer(executor);
    activeStop = stop;

    const registration = createRemoteAgentToolRegistration(
      { name: "remote-echo", remoteUrl: `http://localhost:${port}` },
      realDeps,
    );

    const result = (await Effect.runPromise(
      registration.handler({ message: "Hello" }),
    )) as { status: string; result: unknown };

    expect(result.status).toBe("completed");
    expect(result.result).toBe("Echo: Hello");
  });

  test("a task already completed on first poll does not loop unnecessarily", async () => {
    // Synchronous executor — by the time the client's first `tasks/get`
    // fires, the task is already terminal, so the poll loop should return
    // after exactly one `fetchTask` call.
    const executor: TaskExecutor = (input) => Effect.succeed(`Sync: ${input}`);

    const { port, stop } = await startRealServer(executor);
    activeStop = stop;

    const registration = createRemoteAgentToolRegistration(
      { name: "remote-sync", remoteUrl: `http://localhost:${port}` },
      realDeps,
    );

    const start = Date.now();
    const result = (await Effect.runPromise(
      registration.handler({ message: "world" }),
    )) as { status: string; result: unknown };
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe("completed");
    expect(result.result).toBe("Sync: world");
    // No poll interval (200ms) should have been consumed if the first read
    // was already terminal — generous bound to avoid flaking on CI jitter.
    expect(elapsedMs).toBeLessThan(200);
  });

  test("a failed task surfaces its terminal status", async () => {
    const executor: TaskExecutor = () =>
      Effect.fail(new A2AError({ code: "INTERNAL_ERROR", message: "remote agent blew up" }));

    const { port, stop } = await startRealServer(executor);
    activeStop = stop;

    const registration = createRemoteAgentToolRegistration(
      { name: "remote-fail", remoteUrl: `http://localhost:${port}` },
      realDeps,
    );

    const result = (await Effect.runPromise(
      registration.handler({ message: "boom" }),
    )) as { status: string; result: unknown };

    expect(result.status).toBe("failed");
    // Failure carries no artifacts, so extractArtifactText correctly yields undefined.
    expect(result.result).toBeUndefined();
  });
});
