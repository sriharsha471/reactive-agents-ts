---
"@reactive-agents/a2a": minor
"@reactive-agents/runtime": minor
---

A2A serving now actually works. Previously `.withA2A()` composed a server layer
at runtime-construction time — before the agent existed — so it bound no port
and reached no executor; an agent configured for A2A silently served nothing.

Serving is now an explicit call that binds before it returns:

```ts
const handle = await agent.serveA2A({ port: 3000 });
// ... other agents can now reach it at /.well-known/agent.json
await handle.stop();
```

`.withA2A({ port, basePath })` still configures the defaults `serveA2A()` falls
back to when the caller omits them. `rax serve` now uses this same server
implementation instead of its own hand-rolled copy.

Protocol fixes:
- `message/send` returns a spec-shaped `A2ATask` (`id`, `status`, `artifacts`,
  …) instead of a bespoke `{ taskId }`.
- JSON-RPC responses echo the request `id` instead of a hardcoded value.
- `configuration.blocking` is honored: a non-blocking send returns immediately
  in `submitted`/`working` state and the caller polls `tasks/get`.
- `tasks/cancel` now finds the task it's asked to cancel — it previously read
  from a different task store than `message/send` wrote to and always
  reported `TASK_NOT_FOUND`.

Client fixes: both `@reactive-agents/a2a`'s `A2AClient` and the runtime's
`.withRemoteAgent()` / `.withAgentTool()` now read the real `A2ATask` shape
(`task.status.state`, `task.artifacts`) instead of the old bespoke response
shape they previously (and incorrectly) assumed.
