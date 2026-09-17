# @reactive-agents/a2a

> A2A (Agent2Agent) protocol for TypeScript — Agent Cards and a JSON-RPC 2.0 server/client.

[![npm](https://img.shields.io/npm/v/@reactive-agents/a2a?color=CB3837&logo=npm)](https://www.npmjs.com/package/@reactive-agents/a2a)
[![docs](https://img.shields.io/badge/docs-reactiveagents.dev-7C3AED)](https://docs.reactiveagents.dev)

An Effect-TS implementation of the [Agent2Agent (A2A) protocol](https://a2a-protocol.org) for agent-to-agent interoperability. Generate A2A-compliant Agent Cards, expose your agent as a JSON-RPC 2.0 server, and discover or call remote agents as a client. Lets independent agents advertise capabilities and delegate work to one another over HTTP. Agent Cards advertise `streaming: false` — incremental SSE delivery isn't implemented yet; `message/stream` awaits full task completion and returns it as a single event.

## Install
```bash
bun add @reactive-agents/a2a
# or: npm install @reactive-agents/a2a
```

## Usage

### Generate an Agent Card and call a remote agent
```ts
import { Effect } from "effect";
import { generateAgentCard, A2AClient, createA2AClient } from "@reactive-agents/a2a";

// Describe your agent for discovery (served at /.well-known/agent.json)
const card = generateAgentCard({
  name: "research-agent",
  description: "Searches the web and summarizes findings",
  url: "https://agents.example.com/research",
});

// Talk to a remote A2A agent over JSON-RPC 2.0
const clientLayer = createA2AClient({ baseUrl: "https://agents.example.com/research" });

const program = Effect.gen(function* () {
  const client = yield* A2AClient;
  const task = yield* client.sendMessage({
    message: { role: "user", parts: [{ kind: "text", text: "Summarize A2A" }] },
  });
  return yield* client.getTask({ id: task.id });
});

await Effect.runPromise(Effect.provide(program, clientLayer));
```

### Serve your agent over HTTP

The easiest way to serve an agent is `agent.serveA2A()` from `@reactive-agents/runtime` — see [the docs](https://docs.reactiveagents.dev/features/a2a-protocol). To use this package's server directly:

```ts
import { createA2AServer, createA2AHttpServer } from "@reactive-agents/a2a";
import { Effect, Layer } from "effect";

const serverLayer = createA2AServer(card);                    // task store + lifecycle
const httpLayer = createA2AHttpServer(3000, executor);         // JSON-RPC server, bound via secureServe

await Effect.runPromise(
  Effect.gen(function* () {
    const http = yield* A2AHttpServer;
    yield* http.start();
  }).pipe(Effect.provide(Layer.provide(httpLayer, serverLayer))),
);
```

`executor: TaskExecutor` is `(input: string, taskId: string) => Effect.Effect<string, A2AError>` — it runs the agent for a submitted task. Without one, the server still serves the Agent Card, but `message/send` fails with `INTERNAL_ERROR` rather than accepting work it can't run.

## API

- `generateAgentCard(config)` / `toolsToSkills(tools)` — build an A2A Agent Card; map tool definitions to `AgentSkill[]`.
- `A2AServer` / `createA2AServer(card)` — task store service (`getTask`, `cancelTask`, `setTask`, `getAgentCard`).
- `A2AHttpServer` / `createA2AHttpServer(port, executor?, basePath?, options?)` — JSON-RPC 2.0 HTTP server (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `agent/card`). `message/send` is non-blocking by default (returns immediately with a `working` task); pass `configuration: { blocking: true }` to await completion. `message/stream` always awaits completion and returns the result as SSE events — it is not incremental.
- `createTaskHandler(store, executor?)` / `TaskExecutor` — wire task execution and persistence.
- `formatSSEEvent` / `StreamEvent` — Server-Sent Events helpers.
- `A2AClient` / `createA2AClient(config)` — remote client (`sendMessage`, `getTask`, `cancelTask`, `getAgentCard`), returning real `A2ATask` objects.
- `discoverAgent(url)` / `discoverMultipleAgents(urls)` — fetch Agent Cards for discovery.
- `matchCapabilities` / `findBestAgent` — capability-based agent selection.
- `createA2AClientLayer` / `A2AClientLive` — client runtime layer.
- Protocol types: `AgentCard`, `AgentSkill`, `A2AMessage`, `A2ATask`, `TaskState`, `Part`, `Artifact`, plus error types (`A2AError`, `TransportError`, `DiscoveryError`, `TaskNotFoundError`).

## Part of Reactive Agents

This package is part of [Reactive Agents](https://github.com/tylerjrbuell/reactive-agents-ts) — the TypeScript AI agent framework built on Effect-TS. See the [full documentation](https://docs.reactiveagents.dev).
