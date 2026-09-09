---
title: Multi-Agent Orchestration — Unified Composition Design
date: 2026-09-08
status: draft
supersedes: none
related:
  - "[[2026-07-22-cross-cutting-cascade-design]]"
  - "[[DEBT-REGISTER]]"
  - "[[09-UNIFIED-PROGRAM]]"
---

# Multi-Agent Orchestration — Unified Composition Design

## 1. Summary

Reactive Agents already has a capable delegation engine and a capable
composition layer. They cannot see each other, and the delegation engine itself
is split into two execution paths with divergent inheritance semantics.

Separately and more consequentially, a sub-agent runs a **stripped harness**: it
cannot reach memory, reactive intelligence, model routing, durability,
verification, or experience learning. Every subsystem the project pitches stops
at the delegation boundary.

Third, a sub-agent is not accountable: its OTel trace is a **disconnected root**,
so the delegation structure is invisible in any backend, and an agent addressed
across a process boundary is authenticated as a connection rather than as a
principal.

This spec unifies delegation onto one child-spawn boundary that inherits the
existing `RunEnvelope`, makes delegation visible to the compose layer as tags,
opens the rest of the framework to children on a per-concern basis, restores
trace lineage, and then adds orchestration combinators in the shape the compose
layer already uses. It closes with protocol exposure (MCP) and identity at the
process boundary. It deliberately does **not** introduce a new orchestration
package, a new phase, or a new noun.

The end state: a sub-agent is a full agent — same harness, same observability,
same guarantees — addressable over standard protocols and accountable as a
principal.

The first phase is a bug fix that ships on its own and carries no design
commitment.

## 2. Problem — code-verified findings

Every claim below was read directly from source, not inferred.

### 2.1 Two delegation paths with different inheritance (root defect)

There are two independent code paths that spawn a child agent:

| | `.withAgentTool()` / `.withRemoteAgent()` | `spawn-agent` / `spawn-agents` |
|---|---|---|
| Implementation | `builder/build-effect/local-agent-tools.ts:161` | `builder/build-effect/sub-agent-executor.ts:435` |
| Selected by | `tool-mcp-registrations.ts:104` on `_agentTools` union | `.withDynamicSubAgents()` |
| Fields passed to `createLightRuntime` | 11 | 23 |

The `.withAgentTool()` path passes only `agentId`, `agentDisplayName`,
`provider`, `model`, `maxIterations`, `systemPrompt`, `enableReasoning`,
`enableTools`, `allowedTools`, `requiredTools`, `sharedEventBus`.

It therefore **silently drops** every cross-cutting concern the other path
propagates: `taskContract`, `fabricationGuard`, `grounding`, `approvalPolicy`,
`contextProfile`, guardrails, observability, cost tracking, test scenario, and
the child dashboard registry.

This is the same defect class `RunEnvelope` was built to end — "a run-wide field
threaded by hand is silently dropped wherever a site omits it"
(`kernel/envelope/run-envelope.ts:4-7`) — reappearing at a boundary the cascade
never covered.

### 2.2 `.withAgentTool()` does not inherit the parent's provider

`local-agent-tools.ts:169`:

```ts
provider: (agentTool.agent!.provider ?? "test") as ProviderName,
```

`provider` is optional on the public signature (`builder.ts:769`), and nothing
pre-populates `_agentTools` (only `builder.ts:777` and `:812` write to it). So:

```ts
.withAgentTool("researcher", { name: "researcher" })   // runs on the TEST provider
```

The sub-agent silently runs on the deterministic `test` provider and returns
canned output. The sibling path defaults to `parentProvider ?? "test"`
(`sub-agent-executor.ts:443`). This is a live correctness bug, confirmed by
reading a single literal expression, not yet reproduced by a live run.

### 2.3 Neither path propagates `harnessPipeline` or `budgetLimits`

`sub-agent-executor.ts` contains zero references to `harness` or `pipeline`.
`createLightRuntime` already accepts `harnessPipeline` (`runtime.ts:396`) — it
is simply never passed by either delegation path.

Consequences:

- `.withBudget()` is enforced in `arbitrator.ts:1852-1859` from
  `state.meta.budgetLimits`, seeded from `KernelInput.budgetLimits`. A child
  kernel receives `undefined`, so **delegation escapes the budget ceiling**.
- All five compose killswitches (`budgetLimit`, `timeoutAfter`, `maxIterations`,
  `requireApprovalFor`, `watchdog`) and every `.compose()` transform, tap, and
  phase hook are **parent-only, silently**.

### 2.4 Delegation is invisible to the compose layer

`harness-types.ts` defines 8 tags and 12 phases. Neither set contains any
delegation concept. A spawn is an opaque tool call inside `act`, so no
combinator can observe, shape, or gate it.

### 2.5 Five human-in-the-loop mechanisms

| # | Mechanism | Location | Direction | Durable | Reaches children |
|---|---|---|---|---|---|
| 1 | `ConfiguredApprovalPolicy` via `.withApprovalPolicy()` | `reasoning`, envelope rail | human gates agent | yes | spawn path only |
| 2 | `requireApprovalFor` killswitch | `compose/killswitches/require-approval-for.ts` | human gates agent | no (sync callback) | no |
| 3 | `InteractionManager.approvalGate` | `@reactive-agents/interaction` | human gates agent | via EventBus | no runtime wiring at all |
| 4 | `.withUserInteraction()` | `builder.ts:1270`, kernel meta-tool | agent asks human | yes | not propagated |
| 5 | `PolicyConfig.requireApprovalFor` | `gateway/src/types.ts:111` | human gates agent | **dead — no consumer** | n/a |

#4 is the opposite direction and legitimately distinct. #1–3 are redundant.

**#5 is a live defect, not merely redundancy.** `requireApprovalFor` is declared
in the Gateway policy schema and consumed by nothing: zero occurrences of
"approval" in `gateway/src/services/policy-engine.ts`,
`gateway/src/services/gateway-service.ts`, or any of the five files in
`gateway/src/policies/`. The only other references are `tests/types.test.ts`,
which asserts the schema round-trips the value — a textbook case of unit-testing
`f()` without pinning that `f()` is ever called.

Impact: an application configures `requireApprovalFor: ["delete-record"]` on an
autonomous gateway agent, reasonably believes destructive cron-triggered actions
are gated, and they are not. This must be either wired or removed before the
Gateway is recommended for autonomous use; a dead safety control is worse than
an absent one.

`RunEnvelopeRails` already reserves `approvalPolicy`, `approvalDecision`, and
`interactionResponse` — the canonical slots exist and are underused.

`@reactive-agents/interaction` has no importer anywhere in `packages/` or
`apps/` except the umbrella re-export and one example.

### 2.6 Naming collisions already in the public surface

- `.withHarness()` carries **two unrelated overloads** — `(fn) => void` registers
  a pipeline combinator; `(config)` sets mechanism config. The JSDoc at
  `builder.ts:578` says so in those words.
- `RunEnvelopeData.harness` is `ResolvedHarness` (mechanism config), which is
  *not* the `HarnessPipeline` (combinator registry). Two different "harness".
- `.compose(fn)` is a pure alias of `.withHarness(fn)` (`builder.ts:621`).

Any new orchestration naming must not add a third meaning to "harness".

### 2.7 What already works well (do not rebuild)

- `_agentTools` is **already a discriminated union** of local and remote
  delegates (`{name, agent}` | `{name, remoteUrl}`), dispatched at
  `tool-mcp-registrations.ts:104`. The unified registry exists internally; only
  the public surface is split.
- The spawn path's fiber semantics are correct: `Effect.forkScoped` into the
  parent's tree, `Fiber.await` returning an `Exit` so child failure never
  cascades, real cancellation on parent interrupt (`sub-agent-executor.ts:612`).
- Depth capping, MCP tool proxying, dashboard rollup, and ledger merge all work.

### 2.8 Autonomous approval has no defined semantics

Surfaced by FORGE (an application on 0.16.0) and confirmed: the approval
mechanisms are all specified against a live human in a chat turn. Nothing
defines what happens when a **cron- or heartbeat-triggered** run hits a gated
tool with no human present. Auto-deny, queue for the next human session, or hang
until timeout are all defensible; the framework picks none of them explicitly,
and `mode: "detach"` documentation assumes a human returns.

This is the load-bearing question for the whole class of applications where
"the agent acts autonomously" and "mutating actions need human approval" are
both hard requirements — which is the normal shape for an agent with a schedule.
It needs an explicit answer in the consolidation phase, and an emitted event
("approval required, no synchronous approver available") so an application can
route it to its own surface.
### 2.9 Team memory is siloed by construction

`defaultUserMemoryPath(agentId)` resolves to
`$HOME/.reactive-agents/memory/<agentId>/memory.db`
(`memory/src/types.ts:468`). Three specialist agents built as three
`ReactiveAgents` instances therefore get **three separate databases** — three
disconnected views of the same user.

An explicit shared `dbPath` is the obvious workaround, but nothing documents
whether that is supported: whether records are agent-scoped within the database
(sharing vs collision), and whether concurrent SQLite/WAL access from several
agents in one process is safe. The `relate`/`getRelated`/`search` graph added in
0.16 is precisely the mechanism that should work across a team rather than
within a single agent, which makes the gap more pointed rather than less.

This is the memory-scope decision §5.3 defers to Phase 3c, arriving from a real
application before the phase is written. It should be settled there as a
supported, documented topology — not left as an undocumented workaround.

## 3. Goals and non-goals

**Goals**

1. One child-spawn boundary with one inheritance rule.
2. Delegation observable and steerable from the compose layer.
3. A sub-agent can reach every framework subsystem its parent can, on a
   per-concern basis with cheap defaults.
4. Orchestration expressed as combinators, in the existing combinator shape.
5. One public vocabulary for delegation.
6. A sub-agent is fully traceable and inspectable — its lineage visible in the
   trace, not only in the console.
7. An agent is addressable over standard protocols, and a caller across a
   process boundary is authenticated as a principal, not merely as a
   connection.

**Non-goals**

- No new package **for orchestration**. Shipping a package nothing resolves is
  the exact mistake `identity` and `interaction` already made. (Protocol
  exposure in Phase 6 may warrant one — that decision is made there, against the
  same consumer-at-landing test.)
- **No 13th phase.** `Phase` is a public 12-value union, gate-checked, and "12-phase
  execution engine" appears in the site description, README, and comparison
  pages. Delegation happens *inside* `act`; tags are sufficient.
- No identity for in-process delegation. A parent that spawns a child in its own
  fiber tree already has total authority over it; certificates there are
  ceremony. Identity is scoped to the process boundary — see §6.5, which amends
  this spec's original blanket deferral.
- No breaking changes to existing builder methods.

## 4. Design

### 4.1 Layer 0 — one spawn boundary (the fix)

Introduce a single internal function that both delegation paths call:

```ts
// runtime/src/builder/build-effect/spawn-child-agent.ts
export const spawnChildAgent = (
  args: ChildAgentArgs,
  inherited: InheritedRunContext,
): Effect.Effect<SubAgentResult, never, never>
```

`InheritedRunContext` is derived **once**, from the parent's resolved state, and
is the sole source of a child's cross-cutting configuration. It carries:

- the parent's `RunEnvelope` data (policy + rails + harness mechanism), with
  `approvalPolicy` coerced to `block` exactly as `createLightRuntime` does today
- `harnessPipeline`
- `budgetLimits`
- provider/model, observability, contextProfile, cost tracking, test scenario,
  shared EventBus, shared dashboard registry

`local-agent-tools.ts` and `sub-agent-executor.ts` both become thin adapters
that build `ChildAgentArgs` and delegate. Their divergent inheritance lists are
deleted, not reconciled — there is one list, in one place.

**Inheritance rule (explicit, documented, testable):** a child inherits every
run-wide concern from its parent unless the concern is declared
child-overridable, and an explicit per-delegate value wins over the inherited
one. Budget is the one concern that needs a policy decision rather than plain
inheritance — see §4.5.

### 4.2 Layer 1 — delegation tags

Add to `harness-types.ts`:

```ts
| 'delegation.requested'
| 'delegation.result'
```

with `TagMap` entries:

```ts
export type DelegationCtx = BaseCtx & {
  readonly delegateName: string;
  readonly transport: 'in-process' | 'a2a';
  readonly depth: number;
};

export type DelegationRequestPayload = {
  readonly task: string;
  readonly tools?: readonly string[];
  readonly maxIterations?: number;
};

export type DelegationResultPayload = {
  readonly success: boolean;
  readonly output: string;
  readonly tokensUsed: number;
  readonly stepsCompleted: number;
};

'delegation.requested': { payload: DelegationRequestPayload; ctx: DelegationCtx };
'delegation.result':    { payload: DelegationResultPayload;  ctx: DelegationCtx };
```

Both are emitted from `spawnChildAgent` — one boundary, so one emission site.

The existing transform semantics carry real power here for free:
`delegation.requested` returning `null` **suppresses the spawn**; returning a
modified payload **reshapes the child's task or tool scope before it launches**.
That is the whole steering mechanism, and it costs no new machinery.

No `delegation.failed` tag: a failed child is already a `delegation.result` with
`success: false`, and the spawn path deliberately never surfaces child failure
as a parent failure. A third tag would imply an error channel that does not
exist.

### 4.3 Layer 2 — `.withSubAgents()`

A bulk constructor over the union `_agentTools` already is:

```ts
.withSubAgents({
  researcher: { role: "Research specialist", tools: ["web-search"] },
  pricing:    { remote: "https://pricing.internal" },
})
```

Desugars to the existing `_agentTools` entries. `.withAgentTool()`,
`.withRemoteAgent()`, and `.withDynamicSubAgents()` are **kept permanently, no
deprecation warnings** — they are the single-item forms of the same registry,
they are documented and tested, and 85 builder methods already exist. Churn here
buys nothing.

### 4.4 Layer 3 — orchestration combinators

New entry point `reactive-agents/compose/orchestration`, same
`(harness: Harness) => void` shape as killswitches, applied via the existing
`.compose()`:

| Combinator | Behavior |
|---|---|
| `route(match)` | Pick a delegate by task shape at `delegation.requested` |
| `fanOut(names, { merge })` | Same task to N delegates, merge results |
| `firstSuccess(names)` | Race; first successful result wins |
| `quorum(names, n)` | Require n agreeing results |
| `budgetPerSubAgent({ tokens })` | Per-child ceiling; composes with `budgetLimit` |
| `capDelegationDepth(n)` | Surface the existing depth cap as a combinator |

`fanOut`, `firstSuccess`, and `quorum` need a spawn primitive the harness does
not have — they are implemented as `delegation.requested` transforms that expand
one request into many through `spawnChildAgent`, not as new kernel machinery.

### 4.5 Budget inheritance — the one real policy question

Plain inheritance of `budgetLimits` gives every child the parent's **full**
ceiling, so N children can spend N× the parent's budget while each individually
"respects" it. Three options:

1. **Inherit the ceiling as-is** — simple, but the escape stays, just renamed.
2. **Inherit the parent's live remaining budget** — correct, requires the child
   to read a shared run-scoped counter.
3. **Inherit as-is, plus opt-in `budgetPerSubAgent`** — closes nothing by default.

**Recommendation: option 2.** The run, not the agent, is the unit a budget
should bound, and `RunContext` already threads run-scoped identity to every
descendant. Option 1 ships a fix that does not fix. This is the one place the
spec chooses correctness over the smallest diff.

### 4.6 Approval consolidation (deferred, sequenced last)

Once `delegation.*` exists and `spawnChildAgent` inherits the envelope rails,
consolidation is mostly deletion:

- `ConfiguredApprovalPolicy` stays the durable engine (already an envelope rail).
- `requireApprovalFor` becomes a thin adapter that writes the same rail instead
  of running its own synchronous gate.
- `@reactive-agents/interaction` becomes the human-facing transport for
  `interactionResponse`, or is honestly marked experimental-and-unwired.

Sequenced late because it is the only part that can change existing runtime
behavior, and it is not required by anything before it. Phase 7 (identity) may
subsume part of it: once a caller is a principal, "who may approve" becomes an
authorization question rather than a fourth approval mechanism.

## 5. Leveraging the framework a sub-agent currently cannot reach

### 5.1 Sub-agents run a stripped harness

`buildLightRuntimeConfig` (`runtime.ts:330-420`) accepts the full agent surface.
Neither delegation path passes any of:

| Not inherited | Consequence for a sub-agent |
|---|---|
| `enableMemory` | No memory bootstrap, no semantic recall, no episodic record. A child starts blank every time and its work is never remembered. |
| `enableExperienceLearning` | The ExperienceStore is documented as **cross-agent** learning. Sub-agents neither contribute to nor read from it — the one place "cross-agent" should mean something. |
| `enableReactiveIntelligence` + options | No entropy sensing inside a child: no early stop, no context compression, no strategy switch, no bandit learning. A looping child burns its full iteration budget. |
| `modelRouting` | Every child runs the parent's model. No cheap-model routing for simple delegates. |
| `durableRuns` | No durable store. This is why `approvalPolicy` must be coerced to `block` in children (`sub-agent-executor.ts:477-483`) — detach would strand the child. A crash mid-delegation loses all child work. |
| `adaptiveHarness`, `horizonProfile`, `calibration` | No adaptive mechanism control or per-model threshold calibration. |
| `strategySwitching`, `retryPolicy`, `minIterations` | A child cannot switch strategy or retry under policy. |
| `verificationStep`, `outputValidator`, `customTermination` | A child's answer is never verified or schema-validated before it returns to the parent. |
| `thinking` / `thinkingOptions` | Extended thinking never reaches a child. |
| `session` | A child has no session continuity across delegations. |

Guardrails, observability, cost tracking, and `contextProfile` *are* inherited by
the spawn path (and none of them by the `.withAgentTool()` path — §2.1).

The framing that matters: **sub-agents are second-class citizens of the
framework.** Every subsystem the project pitches — memory, reactive
intelligence, local-to-frontier portability, durability, verification — stops at
the delegation boundary. Fixing composition (§4) without fixing this ships a
better way to orchestrate agents that still cannot use the framework.

### 5.2 What "full advantage" unlocks

Ranked by leverage, each grounded in a system that already exists:

1. **Per-delegate model routing.** A `summarize` delegate on a local 4B model
   while the parent runs frontier. Local-to-frontier portability is the
   project's central claim, and multi-agent is where it pays the most — a
   fan-out of five cheap children against one expensive parent is the canonical
   cost win. `modelRouting` already exists; it just never reaches a child.

2. **Reactive Intelligence inside children.** The entropy controller's whole
   purpose is stopping a wasteful loop early. A sub-agent is exactly where an
   unattended loop is least visible and most expensive. `route()` in §4.4 also
   becomes learnable rather than hand-written: the Thompson-sampling bandit
   already learns per `(model, taskCategory)`, and "which delegate wins this
   task category" is the same shape.

3. **Memory as the delegation channel.** Parent-to-child context is currently a
   prompt string (`composeSubAgentDirectivePrompt`) — re-serialized every
   spawn. With a shared memory layer a child recalls instead of being
   re-prompted, cutting tokens on exactly the hot path, and its findings persist
   for later delegations instead of dying with the fiber.

4. **ExperienceStore across delegates.** The store already models
   `(taskType, toolPattern) → success rate`. "For research tasks, delegate to
   `researcher` — 88% over 12 runs" is the same record with the delegate as the
   pattern. This is cross-agent learning finally meaning cross-*agent*.

5. **Durable delegation.** Persisting children unlocks resume-mid-delegation and
   removes the forced `block` coercion, so durable HITL works inside a child
   rather than being downgraded by necessity.

6. **Verification and debrief rollup.** A child's answer should be verifiable
   before the parent consumes it, and child debriefs should synthesize into the
   parent's. Both subsystems exist and neither crosses the boundary.

7. **Multi-agent replay.** `packages/replay` has no parent/child concept, so a
   multi-agent run cannot be deterministically replayed — the debugging story
   is weakest exactly where runs are hardest to reason about.

### 5.3 Design implication — inheritance must be per-concern, not all-or-nothing

§4.1 states children inherit run-wide concerns. §5.1 shows why that rule needs a
second axis: some of these are *expensive* (memory opens a database, durable
runs write rows, RI adds per-step scoring). Forcing them on every child of every
fan-out is a performance and cost regression, not a fix.

`InheritedRunContext` therefore classifies each concern:

- **Always inherited** — safety and judgment: envelope policy + rails,
  `harnessPipeline`, `budgetLimits`, guardrails, `contextProfile`. A child must
  never escape a constraint its parent accepted. This is Phase 0.
- **Inherited by default, per-delegate override** — provider/model,
  observability, cost tracking, `thinking`, `retryPolicy`.
- **Opt-in, off by default** — memory, experience learning, reactive
  intelligence, durable runs, session. Enabled per delegate, or for all children
  via one switch:

  ```ts
  .withSubAgents(
    { researcher: { role: "..." }, summarizer: { model: "llama3.2:3b" } },
    { inherit: { memory: true, reactiveIntelligence: true } },
  )
  ```

The default stays cheap. The capability becomes reachable, which today it is
not at any price.

## 6. Sub-agents as first-class principals

A sub-agent that cannot be traced, inspected, or securely addressed is a
half-baked agent regardless of how well it composes. §4 makes delegation
composable and §5 makes it capable; this section makes it **accountable**.

### 6.1 Traceability — the lineage exists and never reaches OTel

The data is already there:

- `packages/trace` models delegation as a first-class concept: `depth` and
  `rootRunId` on correlation (`trace/src/events.ts:62-63`,
  `trace/src/normalize.ts:41-74`).
- The spawn path stamps `parentAgentId` and the child's `RunContext` onto the
  child's task metadata (`sub-agent-executor.ts:574-580`), and children publish
  on the parent's shared EventBus.

But it stops at the OTel boundary. `observe/src/tracer.ts:63` starts every
agent workflow span with **no parent context**:

```ts
case "AgentStarted": {
  const span = tracer.startSpan(`agent:${event.agentId}`, { … });  // no ctx arg
  spans.workflows.set(event.taskId, span);
```

Child LLM and tool spans correctly nest under their *own* agent's workflow span
(the `ctx` third argument at `tracer.ts:103`, `:155`), but the child's workflow
span itself is keyed by a fresh `taskId` and started from nothing. **Every
sub-agent is therefore a separate OTel trace root**, disconnected from the
parent run that spawned it.

In practice: a five-child fan-out produces six unrelated traces in any OTLP
backend, and the delegation structure — the single most important thing to see
when debugging a multi-agent run — is the one thing the trace does not show.

**Fix:** `AgentStarted` carries `parentAgentId`; look up the parent's workflow
span and start the child's within its context. The lineage data needs no new
plumbing — only to be used. This is small and high-value; it belongs in Phase 0
alongside the other propagation fixes.

### 6.2 Inspectability — what works, what is missing

Working: child dashboard rollup into one parent print
(`ChildDashboardRegistry`), run-scoped ledger merge with `sub-agent:<name>`
provenance (`mergePassLedger`), depth- and name-aware log prefixes, and the
live status renderer's collapsed sub-agent line.

Missing: deterministic replay of a multi-agent run (§5.2 item 7), and child
debrief synthesis into the parent's debrief (§5.2 item 6).

### 6.3 Secure communication — transport is covered, identity is not

**What exists.** A2A ingress is secure-by-default: `secureServe` binds loopback
unless `RA_A2A_HOST` is set and **refuses a non-loopback bind without
`RA_A2A_TOKEN`** (`a2a/src/server/http-server.ts:172-178`). Outbound, the
client supports bearer and API-key auth. `withReceiptSigning({ privateKeyJwk })`
already provides cryptographic run attestation.

**What does not exist.** A shared bearer token authenticates a *connection*, not
an *agent*. There is no per-caller principal, so an RA-hosted A2A server cannot:

- distinguish which agent is calling
- authorize per skill rather than per server
- audit actions against a principal
- represent a delegation chain (parent authorized child to act on its behalf)

That list is precisely `packages/identity`, which already implements
`CertificateAuth`, `PermissionManager`, `AuditLogger`, `IdentityService`, and a
`Delegation` type — and is dormant with zero consumers.

### 6.4 Protocol reach

| Protocol | Consume | Expose |
|---|---|---|
| A2A | ✅ client, discovery, capability matching | ✅ JSON-RPC server + SSE |
| MCP | ✅ `tools/src/mcp/mcp-client.ts` | ❌ **nothing** |

`packages/tools/src/mcp/` contains exactly one file, the client. There is no
`@modelcontextprotocol/sdk/server` import anywhere in the repo. An RA agent
cannot be consumed as an MCP server, which is the standard way an agent is
plugged into Claude Desktop, Cursor, and the rest of the ecosystem.

This is the largest single adoption gap in the framework, and it is
architecturally adjacent: exposing an agent over a protocol is the same
capability-publication problem A2A already solves, with a different wire format.

### 6.5 Revised position on identity (reversing §3)

§3 lists identity revival as a non-goal, on the reasoning that agent-to-agent
authz is "designing for a user that doesn't exist." **That reasoning does not
survive the requirement that sub-agents communicate securely as first-class
principals.** Under that requirement, identity is not speculative — it is the
named gap in §6.3.

The reversal is scoped, not total. Identity enters as **Phase 7**, last, and
only after delegation is unified, capable, observable, and traceable. Two
conditions gate it, so it does not repeat the mistake of shipping a package
nothing resolves:

1. It must have a consumer at the moment it lands — the A2A server's per-caller
   authorization path, not a layer merged and left dormant.
2. Local in-process delegation must not be forced to pay for it. A parent
   spawning a child in its own fiber tree already has total authority over that
   child; certificates there are ceremony. Identity applies at the **process
   boundary** (A2A, MCP), where the caller is genuinely untrusted.

§3's non-goal is amended accordingly: *identity is deferred until the protocol
boundary needs it, and is scoped to that boundary.*

## 7. Naming decisions

One noun per layer; every word already exists in the codebase.

| Concept | Word | Precedent |
|---|---|---|
| The delegated agent | **sub-agent** | `withDynamicSubAgents`, `SubAgentResult`, `SubAgentTaskArgs`, docs guide title |
| The act of delegating | **delegation** | `delegatedToolsUsed`, `subAgentDepthRefusal` |
| The tool | **spawn** | `spawn-agent`, `spawn-agents` |

Rejected: `.withDelegates()` (invents a fourth noun); `.withOrchestration()`
(the name of the removed no-op — reusing it would be actively misleading);
anything adding a third meaning to "harness" (§2.6).

## 8. Phasing

Each phase ships independently and is independently valuable.

### Phase 0 — unify the spawn boundary (bug fix, no new API)

- Extract `spawnChildAgent` + `InheritedRunContext`.
- Both paths call it; divergent lists deleted.
- Propagate `harnessPipeline`, `budgetLimits` (per §4.5 option 2), and the
  `RunEnvelope`.
- Fix `.withAgentTool()` provider default to the parent's provider.
- Parent the child's OTel workflow span under the parent's (§6.1) — the lineage
  data already exists on `AgentStarted`.
- Resolve `PolicyConfig.requireApprovalFor` (§2.5 #5): wire it to the durable
  approval rail, or delete it. It ships today as a safety control that does
  nothing, so it does not wait for the consolidation phase.

**Acceptance:** a `.compose()` killswitch registered on the parent fires inside
a child on both paths; `.withAgentTool("x", {name:"x"})` runs on the parent's
provider; a parent budget ceiling is not exceeded by the sum of its children; a
delegating run emits **one** connected OTel trace, not one per agent.

### Phase 1 — delegation tags

Add the two tags, `TagMap` entries, `ALL_TAGS` entries, emission from
`spawnChildAgent`.

**Acceptance:** a transform on `delegation.requested` can suppress a spawn and
reshape a child's task; a tap observes both tags at correct depth.

### Phase 2 — `.withSubAgents()` + the `inherit` surface

Bulk constructor, existing methods untouched. Carries the per-concern
`inherit` option from §5.3 — the switch every later phase needs.

**Acceptance:** every existing sub-agent test passes unmodified; the new form
produces byte-identical `_agentTools` entries; `inherit` toggles are honored
per delegate.

### Phase 3 — reach the framework from a child (§5)

Ordered within the phase by leverage, each independently shippable:

- **3a — per-delegate model routing.** `modelRouting` + per-delegate `model`.
  The cost win, and the one that makes local-to-frontier portability real in
  multi-agent. Ship first.
- **3b — reactive intelligence in children.** `enableReactiveIntelligence` +
  options, opt-in. Stops unattended child loops.
- **3c — memory + experience learning in children.** Shared memory layer as the
  delegation channel; ExperienceStore records keyed by delegate.
- **3d — verification + debrief rollup.** Child answers verified before the
  parent consumes them; child debriefs synthesized into the parent's.

**Acceptance per sub-phase:** the concern demonstrably takes effect inside a
child (asserted on child config *and* on observed behavior — see
`feedback_wire_it_and_pin_it`: a consumer must read it and behavior must
change); default-off concerns stay off unless opted in.

### Phase 4 — orchestration combinators

`route`, `fanOut`, `firstSuccess`, `quorum`, `budgetPerSubAgent`,
`capDelegationDepth`, plus registry entry alongside `killswitches`.

Sequenced after Phase 3 because `route()` is substantially more valuable once
the bandit can learn delegate selection (§5.2 item 2), and `fanOut` is only
economical once children can run cheaper models (3a).

**Acceptance:** each combinator has a deterministic `test`-provider test;
`fanOut` + `budgetLimit` compose without either being bypassed.

### Phase 5 — durable delegation + full inspectability

Persist children; remove the forced `block` coercion so durable HITL works
inside a child. Unlocks resume-mid-delegation. Lands the two §6.2 gaps
alongside it, since both depend on children being persisted:

- child debrief synthesis into the parent's debrief
- multi-agent replay (parent/child lineage in `packages/replay`)

**Acceptance:** a run killed mid-delegation resumes and completes the child; a
multi-agent run replays deterministically with delegation structure intact.

### Phase 6 — protocol exposure (MCP server)

Expose an RA agent as an MCP server, mirroring what A2A already does for its
own wire format (§6.4). The capability-publication problem is already solved by
`generateAgentCard` / `toolsToSkills`; this is a second serialization of it.

Largest single adoption gap in the framework — an RA agent becomes usable from
Claude Desktop, Cursor, and any MCP client.

**Acceptance:** an RA agent is reachable from a real MCP client; its skills
enumerate; a tool call round-trips.

### Phase 7 — identity at the process boundary

Wire `packages/identity` into the A2A (and Phase 6 MCP) server's authorization
path: per-caller principal, per-skill authorization, per-principal audit, and
delegation chains (§6.3, §6.5).

Two gates, both hard:

1. It lands **with** its consumer — the server authorization path — never as a
   dormant layer. If the consumer slips, this phase slips with it.
2. In-process delegation does not pay for it.

**Acceptance:** two RA agents on separate processes authenticate as distinct
principals; an unauthorized skill call is refused and audited; a delegation
chain is representable and verifiable.

### Phase 8 — approval consolidation (optional, re-decide after Phase 4)

## 9. The deliverable that is not code

Field feedback from FORGE (a local-first application on 0.16.0, redesigning a
single coach agent into a small specialist team) states the ask plainly: the
biggest unlock is not more primitives, it is **one end-to-end documented example
wiring `createAgentTool` + `.withGateway` + shared memory + approval-gating for
one concrete application shape**, because each piece is documented in isolation
and the application is left discovering whether they compose.

That is a correct read of the gap, and it applies to this spec directly: §4–§6
add composition, capability, and accountability, and none of it is reachable if
the composed shape is never shown once. Every phase from 2 onward therefore
carries a documentation obligation, and Phase 3 in particular must land the
worked example for the common shape:

> single process, small team of specialists under one orchestrator, autonomous
> schedule, mutating actions gated by human approval, one shared user memory

Deliberately not a swarm and not cross-process — that shape is the common one
and it is currently the least documented.

Two constraints this example must satisfy, both from §2:

- it must state what happens when the schedule fires an approval-gated tool with
  no human present (§2.8), rather than demonstrating only the live-human path
- it must show the supported team-memory topology (§2.9), not an undocumented
  shared-`dbPath` workaround

## 10. Test plan

Existing coverage: `packages/runtime/tests/subagent/` (8 files) covers the spawn
path's cancellation, depth, observability, ledger merge, and dashboard rollup.
`inheritance-dispatch.test.ts` asserts only that a child *runs* under a parent
policy — it does not assert propagation. Nothing covers `.withAgentTool()`
inheritance at all.

New tests required:

1. `subagent/inheritance-parity.test.ts` — table-driven: for each cross-cutting
   concern, assert both delegation paths produce the same child config. This is
   the regression gate for §2.1 and must fail before Phase 0 lands.
2. `subagent/provider-inheritance.test.ts` — `.withAgentTool()` with no provider
   uses the parent's (§2.2).
3. `subagent/pipeline-propagation.test.ts` — a parent killswitch fires in a
   child (§2.3).
4. `subagent/budget-containment.test.ts` — N children cannot exceed the parent
   ceiling (§4.5).
5. Tag tests per Phase 1; combinator tests per Phase 3.

All use the deterministic `test` provider — no live-model dependency, CI-safe
with no keys (see `feedback_ci_parity_no_keys_no_ollama`).

Gate impact: `check-cross-cutting.sh` may need a check extension, since the
sub-agent boundary becomes a sanctioned envelope-derivation site. Confirm before
Phase 0 lands rather than discovering it in CI.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Phase 0 changes child behavior for existing users (children now actually inherit constraints) | Correct by construction, but it *is* a behavior change — flag in the changeset as a fix, call it out in release notes |
| `.withAgentTool()` provider fix breaks anyone relying on the test-provider default | Nobody can be relying on canned output deliberately; treat as a bug fix |
| Budget option 2 needs a shared run-scoped counter | Scope it in Phase 0; if it proves invasive, ship option 1 + a failing test documenting the gap rather than silently accepting it |
| `check-cross-cutting.sh` rejects the new derivation site | Read the gate before writing the code |
| Combinators tempt a general workflow engine | Non-goal. Six combinators, all expressible over the two tags. Anything needing more is a user-authored combinator |
| Phase 3 concerns are individually cheap to enable and collectively expensive (a memory-and-RI-enabled fan-out of five is a very different cost profile) | Default-off per §5.3; the ablation rule applies — measure lift per concern before any of them becomes default-on |
| Shared memory across children leaks one delegate's context into another | Decide the memory scope explicitly in 3c (per-run shared vs per-delegate namespaced); do not inherit the parent's store by accident |
| Phase 7 repeats the identity mistake — a layer merged with nothing resolving it | The consumer-at-landing gate is hard, not advisory. If the A2A/MCP authorization path is not ready, Phase 7 does not land |
| Phase 6 (MCP server) drifts into a general protocol-gateway project | Scope is one wire format over the existing capability-publication model. Reuse `generateAgentCard`/`toolsToSkills`; do not build a protocol abstraction layer for a second protocol |
| Exposing an agent over MCP widens the attack surface before Phase 7 exists | Mirror A2A's secure-by-default ingress (loopback bind, token required for non-loopback) from day one — never ship an unauthenticated non-loopback listener |

## 12. Open questions

1. Should `harnessPipeline` and `budgetLimits` become formal `RunEnvelope`
   fields rather than parallel-threaded? They are run-wide cross-cutting
   concerns by the envelope's own definition. Deferred: it widens a
   gate-guarded invariant and is not required for Phase 0.
2. Does the A2A transport inherit anything meaningful? A remote agent is a
   different process with its own harness; inheritance likely stops at the
   task payload. Phase 0 should make this boundary explicit rather than
   accidental.
3. Should `packages/replay` gain a parent/child concept (§5.2 item 7)? A
   multi-agent run is currently not deterministically replayable, which is the
   weakest debugging story exactly where runs are hardest to reason about. Not
   scoped here — it is its own design question, and it should be raised again
   once Phase 4 makes multi-agent runs common enough to need it.
4. Do any Phase 3 concerns clear the project's lift rule (≥3pp lift, ≤15% token
   overhead) well enough to become default-on for children? Assume no until
   measured; the ablation warden owns that verdict, not this spec.
