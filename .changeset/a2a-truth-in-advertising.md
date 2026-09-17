---
"@reactive-agents/a2a": minor
"@reactive-agents/runtime": patch
---

Default `generateAgentCard`'s `capabilities.streaming` to `false`. Real SSE
streaming was never implemented — `handleMessageStream` awaits full task
completion and joins the events into one response body, and the prior
`createSSEStream` stub never enqueued anything onto its `ReadableStream` — so
advertising `streaming: true` let a client rely on a capability that did not
exist. A caller with real streaming wired can still opt in via
`generateAgentCard({ capabilities: { streaming: true } })`.

Wired `A2AOptions.basePath` (previously silently dropped): `.withA2A({ basePath })`
now prefixes all three A2A routes (JSON-RPC, `/agent/card`,
`/.well-known/agent.json`) via `createA2AHttpServer`'s new third argument and
`ReactiveAgent.serveA2A({ basePath })`.

Breaking, dead-code removal: `A2AServer`'s `setMessageHandler` (always
discarded its argument; `serveA2A()` now supplies the real executor through
`createA2AHttpServer`), the unused `generateId` helper in `a2a-server.ts`,
the unused-and-drifted `JsonRpcMethod` type in `http-server.ts`, the stubbed
`createSSEStream` in `streaming.ts`, and the zero-consumer `A2AService`/
`A2AServiceLive` (`a2a-service.ts`, not even exercised by its own test file)
are all removed. None had any non-test caller in the monorepo.

Breaking, more dead-code removal (final-review pass): `createA2AServerLayer`
and `A2AServerLive` (`runtime.ts`) built `createA2AHttpServer` with NO
executor. Their only caller, `A2aExtraLayer`, was deleted in Task 2 of this
same plan, leaving both exported with zero non-test callers anywhere in the
monorepo. Removed from `runtime.ts` and from `@reactive-agents/a2a`'s and
`@reactive-agents/reactive-agents`'s public exports. `createA2AClientLayer`/
`A2AClientLive` are unaffected and remain exported.

Fixed alongside: without an executor, `message/send` used to silently accept
the task and leave it stuck in `submitted` forever with no error — now it
fails immediately with an `INTERNAL_ERROR` A2AError ("No executor configured
for this A2A server"). `createA2AHttpServer`'s `executor` parameter stays
optional (a card-only/discovery server is still a legitimate configuration),
but any real task-submitting call against one now surfaces the misconfiguration
instead of hanging silently.
