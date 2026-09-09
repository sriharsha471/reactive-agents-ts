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

This spec unifies delegation onto one child-spawn boundary that inherits the
existing `RunEnvelope`, makes delegation visible to the compose layer as tags,
and then adds orchestration combinators in the shape the compose layer already
uses. It deliberately does **not** introduce a new package, a new phase, or a
new noun.

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

### 2.5 Four human-in-the-loop mechanisms

| # | Mechanism | Location | Direction | Durable | Reaches children |
|---|---|---|---|---|---|
| 1 | `ConfiguredApprovalPolicy` via `.withApprovalPolicy()` | `reasoning`, envelope rail | human gates agent | yes | spawn path only |
| 2 | `requireApprovalFor` killswitch | `compose/killswitches/require-approval-for.ts` | human gates agent | no (sync callback) | no |
| 3 | `InteractionManager.approvalGate` | `@reactive-agents/interaction` | human gates agent | via EventBus | no runtime wiring at all |
| 4 | `.withUserInteraction()` | `builder.ts:1270`, kernel meta-tool | agent asks human | yes | not propagated |

#4 is the opposite direction and legitimately distinct. #1–3 are redundant.
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

## 3. Goals and non-goals

**Goals**

1. One child-spawn boundary with one inheritance rule.
2. Delegation observable and steerable from the compose layer.
3. Orchestration expressed as combinators, in the existing combinator shape.
4. One public vocabulary for delegation.

**Non-goals**

- No new package. Shipping a package nothing resolves is the exact mistake
  `identity` and `interaction` already made.
- **No 13th phase.** `Phase` is a public 12-value union, gate-checked, and "12-phase
  execution engine" appears in the site description, README, and comparison
  pages. Delegation happens *inside* `act`; tags are sufficient.
- No identity revival. `@reactive-agents/identity` is DEFER-verdict with zero
  consumers. Agent-to-agent authz earns its keep only once delegates cross
  trust boundaries for real users.
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

Sequenced last because it is the only part that can change existing runtime
behavior, and it is not required by anything before it.

## 5. Naming decisions

One noun per layer; every word already exists in the codebase.

| Concept | Word | Precedent |
|---|---|---|
| The delegated agent | **sub-agent** | `withDynamicSubAgents`, `SubAgentResult`, `SubAgentTaskArgs`, docs guide title |
| The act of delegating | **delegation** | `delegatedToolsUsed`, `subAgentDepthRefusal` |
| The tool | **spawn** | `spawn-agent`, `spawn-agents` |

Rejected: `.withDelegates()` (invents a fourth noun); `.withOrchestration()`
(the name of the removed no-op — reusing it would be actively misleading);
anything adding a third meaning to "harness" (§2.6).

## 6. Phasing

Each phase ships independently and is independently valuable.

### Phase 0 — unify the spawn boundary (bug fix, no new API)

- Extract `spawnChildAgent` + `InheritedRunContext`.
- Both paths call it; divergent lists deleted.
- Propagate `harnessPipeline`, `budgetLimits` (per §4.5 option 2), and the
  `RunEnvelope`.
- Fix `.withAgentTool()` provider default to the parent's provider.

**Acceptance:** a `.compose()` killswitch registered on the parent fires inside
a child on both paths; `.withAgentTool("x", {name:"x"})` runs on the parent's
provider; a parent budget ceiling is not exceeded by the sum of its children.

### Phase 1 — delegation tags

Add the two tags, `TagMap` entries, `ALL_TAGS` entries, emission from
`spawnChildAgent`.

**Acceptance:** a transform on `delegation.requested` can suppress a spawn and
reshape a child's task; a tap observes both tags at correct depth.

### Phase 2 — `.withSubAgents()`

Bulk constructor, existing methods untouched.

**Acceptance:** every existing sub-agent test passes unmodified; the new form
produces byte-identical `_agentTools` entries.

### Phase 3 — orchestration combinators

`route`, `fanOut`, `firstSuccess`, `quorum`, `budgetPerSubAgent`,
`capDelegationDepth`, plus registry entry alongside `killswitches`.

**Acceptance:** each combinator has a deterministic `test`-provider test;
`fanOut` + `budgetLimit` compose without either being bypassed.

### Phase 4 — approval consolidation (optional, re-decide after Phase 3)

## 7. Test plan

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

## 8. Risks

| Risk | Mitigation |
|---|---|
| Phase 0 changes child behavior for existing users (children now actually inherit constraints) | Correct by construction, but it *is* a behavior change — flag in the changeset as a fix, call it out in release notes |
| `.withAgentTool()` provider fix breaks anyone relying on the test-provider default | Nobody can be relying on canned output deliberately; treat as a bug fix |
| Budget option 2 needs a shared run-scoped counter | Scope it in Phase 0; if it proves invasive, ship option 1 + a failing test documenting the gap rather than silently accepting it |
| `check-cross-cutting.sh` rejects the new derivation site | Read the gate before writing the code |
| Combinators tempt a general workflow engine | Non-goal. Six combinators, all expressible over the two tags. Anything needing more is a user-authored combinator |

## 9. Open questions

1. Should `harnessPipeline` and `budgetLimits` become formal `RunEnvelope`
   fields rather than parallel-threaded? They are run-wide cross-cutting
   concerns by the envelope's own definition. Deferred: it widens a
   gate-guarded invariant and is not required for Phase 0.
2. Does the A2A transport inherit anything meaningful? A remote agent is a
   different process with its own harness; inheritance likely stops at the
   task payload. Phase 0 should make this boundary explicit rather than
   accidental.
