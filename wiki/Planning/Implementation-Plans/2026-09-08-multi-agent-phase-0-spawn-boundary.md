# Multi-Agent Phase 0 — Unified Spawn Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a sub-agent inherit the same safety, budget, and observability constraints as its parent, on both delegation paths, so no constraint is escaped by delegating.

**Architecture:** Both delegation paths (`local-agent-tools.ts` for `.withAgentTool()`, `sub-agent-executor.ts` for `spawn-agent`) currently build their own `createLightRuntime` config with divergent field lists — 11 fields vs 23. This plan introduces one shared `InheritedRunContext` record derived from the parent, has both paths spread it into `createLightRuntime`, and adds the three fields neither path passes today (`harnessPipeline`, `budgetLimits`, and a real parent provider). It also parents the child's OTel span and removes a dead Gateway approval control.

**Tech Stack:** TypeScript (strict, no `any`), Effect-TS, Bun test runner, OpenTelemetry API.

**Spec:** `wiki/Architecture/Design-Specs/2026-09-08-multi-agent-orchestration-design.md` (Phase 0; problem statement in §2.1, §2.2, §2.3, §2.5 #5, §6.1)

## Global Constraints

- **No `any`.** Use `unknown` plus narrowing. Strict TypeScript throughout (project rule, `feedback_clean_types`).
- **No `throw` in Effect code.** Use `Effect.fail` with tagged errors, or `Effect.die` for defects.
- **Undefined-spread pattern is mandatory** when forwarding optional inherited fields: `...(x !== undefined ? { x } : {})`. Writing an explicit `undefined` breaks `createLightRuntime`'s presence checks. This is the existing convention at `tool-mcp-registrations.ts:185-188`.
- **Tests use the `test` provider only.** No live-model calls: CI has no API keys and no Ollama (`feedback_ci_parity_no_keys_no_ollama`).
- **Every test needs an explicit timeout argument** (`, 30_000` as the third argument to `it`). Project convention, see `packages/runtime/tests/subagent/inheritance-dispatch.test.ts:44`.
- **Wire it AND pin it.** A test asserting a field is *present in config* is not sufficient on its own where behavior is claimed — assert observed behavior too. A consumer must read the value and behavior must change.
- **Commit messages:** no `Co-Authored-By` trailers (user preference — they surface publicly on the GitHub contributors page).
- **Run the full command with a timeout:** `bun test <path> --timeout 30000`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `packages/runtime/src/builder/build-effect/inherited-run-context.ts` | The single definition of what a child inherits from its parent, and the one function that derives it | **Create** |
| `packages/runtime/src/builder/build-effect/local-agent-tools.ts` | `.withAgentTool()` path — consumes `InheritedRunContext` instead of its own 11-field list | Modify |
| `packages/runtime/src/builder/build-effect/sub-agent-executor.ts` | `spawn-agent` path — consumes `InheritedRunContext` instead of its own 23-field list | Modify |
| `packages/runtime/src/builder/build-effect/tool-mcp-registrations.ts` | Builds the deps for both paths; gains the two new parent fields | Modify |
| `packages/runtime/src/builder.ts` | Supplies parent `harnessPipeline` + `budgetLimits` to the registrations builder | Modify |
| `packages/runtime/src/builder/build-effect/runtime-construction.ts` | Harness-pipeline compilation extracted for reuse | Modify |
| `packages/observe/src/tracer.ts` | Parents a child agent's workflow span under its parent's | Modify |
| `packages/gateway/src/types.ts` | Removes the dead `requireApprovalFor` policy field | Modify |
| `packages/runtime/tests/subagent/inheritance-parity.test.ts` | Table-driven parity gate: both paths produce the same child config | **Create** |
| `packages/runtime/tests/subagent/provider-inheritance.test.ts` | `.withAgentTool()` inherits the parent's provider | **Create** |
| `packages/runtime/tests/subagent/pipeline-propagation.test.ts` | A parent killswitch fires inside a child | **Create** |
| `packages/observe/tests/child-span-parenting.test.ts` | Child workflow span is a child, not a root | **Create** |

**Ordering rationale:** Task 1 creates the shared type with no consumers (safe). Tasks 2–3 migrate each path onto it one at a time, so a regression is attributable to one path. Task 4 adds the genuinely-new propagation. Tasks 5–6 are independent and can be done in any order relative to each other.

---

### Task 1: Define `InheritedRunContext` and its derivation

**Files:**
- Create: `packages/runtime/src/builder/build-effect/inherited-run-context.ts`
- Test: `packages/runtime/tests/subagent/inheritance-parity.test.ts`

**Interfaces:**
- Consumes: `buildLightRuntimeConfig` from `../../runtime.js` (existing, exported).
- Produces:
  - `interface InheritedRunContext` — the field bag a child inherits.
  - `const toChildRuntimeOptions: (inherited: InheritedRunContext, child: ChildIdentity) => LightRuntimeOptionsSubset` — merges inherited fields with the child's own identity, applying the undefined-spread rule.
  - `interface ChildIdentity { agentId: string; agentDisplayName: string; systemPrompt: string; maxIterations?: number; allowedTools?: readonly string[]; requiredTools?: { tools: string[]; adaptive: boolean; maxRetries: number } }`

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/tests/subagent/inheritance-parity.test.ts`:

```typescript
// Run: bun test packages/runtime/tests/subagent/inheritance-parity.test.ts --timeout 30000
//
// Parity gate for the two delegation paths (spec §2.1). Before this, the
// `.withAgentTool()` path passed 11 fields to createLightRuntime and the
// `spawn-agent` path passed 23 — so a constraint set on the parent was
// silently escaped by delegating through the shorter path. One derivation,
// one field list, asserted here so the two can never drift again.
import { describe, it, expect } from "bun:test";
import {
  toChildRuntimeOptions,
  type InheritedRunContext,
} from "../../src/builder/build-effect/inherited-run-context.js";

const childIdentity = {
  agentId: "sub-worker-1",
  agentDisplayName: "worker",
  systemPrompt: "You are a worker.",
};

describe("toChildRuntimeOptions", () => {
  it("carries every inherited field through to the child options", () => {
    const inherited: InheritedRunContext = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      enableGuardrails: true,
      enableObservability: true,
      enableCostTracking: true,
      fabricationGuard: "block",
    };

    const opts = toChildRuntimeOptions(inherited, childIdentity);

    expect(opts.provider).toBe("anthropic");
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.enableGuardrails).toBe(true);
    expect(opts.enableObservability).toBe(true);
    expect(opts.enableCostTracking).toBe(true);
    expect(opts.fabricationGuard).toBe("block");
    expect(opts.agentId).toBe("sub-worker-1");
    expect(opts.agentDisplayName).toBe("worker");
  });

  it("omits unset optional fields rather than writing undefined", () => {
    const inherited: InheritedRunContext = { provider: "test" };

    const opts = toChildRuntimeOptions(inherited, childIdentity);

    // Presence checks downstream use `!== undefined`, so a written-undefined
    // key is not equivalent to an absent one.
    expect("fabricationGuard" in opts).toBe(false);
    expect("taskContract" in opts).toBe(false);
    expect("harnessPipeline" in opts).toBe(false);
    expect("budgetLimits" in opts).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime/tests/subagent/inheritance-parity.test.ts --timeout 30000`
Expected: FAIL — `Cannot find module '../../src/builder/build-effect/inherited-run-context.js'`

- [ ] **Step 3: Write minimal implementation**

Create `packages/runtime/src/builder/build-effect/inherited-run-context.ts`:

```typescript
/**
 * InheritedRunContext — the ONE definition of what a sub-agent inherits from
 * its parent.
 *
 * Before this module the two delegation paths each built their own
 * `createLightRuntime` options: `local-agent-tools.ts` passed 11 fields and
 * `sub-agent-executor.ts` passed 23. A constraint the parent accepted was
 * therefore escapable by delegating through the shorter path (spec §2.1).
 * This is the same defect class `RunEnvelope` closed for strategies — a
 * run-wide field threaded by hand is dropped wherever a site omits it.
 *
 * Rule: a child inherits every run-wide concern from its parent. An explicit
 * per-delegate value wins over the inherited one; unset fields are OMITTED,
 * never written as `undefined`, because downstream presence checks use
 * `!== undefined`.
 */
import type { HarnessPipeline } from "@reactive-agents/core";
import type { TaskContract } from "@reactive-agents/core";
import type { FabricationGuardMode } from "@reactive-agents/reasoning";
import type { ContextProfile } from "@reactive-agents/reasoning";
import type { TestTurn } from "@reactive-agents/llm-provider";
import type { BudgetLimits } from "../../builder.js";
import type {
  ApprovalPolicyConfig,
  GroundingOptions,
  ObservabilityOptions,
  ProviderName,
} from "../types.js";
import type { ReasoningOptions } from "../../types.js";

/** Everything a child inherits. Every field except `provider` is optional. */
export interface InheritedRunContext {
  readonly provider: ProviderName;
  readonly model?: string;
  readonly reasoningOptions?: ReasoningOptions;
  readonly enableGuardrails?: boolean;
  readonly enableObservability?: boolean;
  readonly observabilityOptions?: ObservabilityOptions;
  readonly contextProfile?: Partial<ContextProfile>;
  readonly enableCostTracking?: boolean;
  readonly testScenario?: TestTurn[];
  readonly taskContract?: TaskContract;
  readonly fabricationGuard?: FabricationGuardMode;
  readonly grounding?: GroundingOptions;
  readonly approvalPolicy?: ApprovalPolicyConfig;
  /** Compose combinators + killswitches. Never propagated before (spec §2.3). */
  readonly harnessPipeline?: HarnessPipeline;
  /** Spend ceiling. Never propagated before, so delegation escaped it (spec §2.3). */
  readonly budgetLimits?: BudgetLimits;
}

/** The child's own identity and scope — never inherited. */
export interface ChildIdentity {
  readonly agentId: string;
  readonly agentDisplayName: string;
  readonly systemPrompt: string;
  readonly maxIterations?: number;
  readonly allowedTools?: readonly string[];
  readonly requiredTools?: {
    tools: string[];
    adaptive: boolean;
    maxRetries: number;
  };
}

/**
 * Merge inherited context with the child's identity into the option bag
 * `createLightRuntime` accepts. Optional fields are spread only when set.
 */
export const toChildRuntimeOptions = (
  inherited: InheritedRunContext,
  child: ChildIdentity,
): Record<string, unknown> => ({
  agentId: child.agentId,
  agentDisplayName: child.agentDisplayName,
  systemPrompt: child.systemPrompt,
  enableReasoning: true,
  enableTools: true,
  provider: inherited.provider,
  ...(child.maxIterations !== undefined ? { maxIterations: child.maxIterations } : {}),
  ...(child.allowedTools !== undefined ? { allowedTools: child.allowedTools } : {}),
  ...(child.requiredTools !== undefined ? { requiredTools: child.requiredTools } : {}),
  ...(inherited.model !== undefined ? { model: inherited.model } : {}),
  ...(inherited.reasoningOptions !== undefined ? { reasoningOptions: inherited.reasoningOptions } : {}),
  ...(inherited.enableGuardrails !== undefined ? { enableGuardrails: inherited.enableGuardrails } : {}),
  ...(inherited.enableObservability !== undefined ? { enableObservability: inherited.enableObservability } : {}),
  ...(inherited.observabilityOptions !== undefined ? { observabilityOptions: inherited.observabilityOptions } : {}),
  ...(inherited.contextProfile !== undefined ? { contextProfile: inherited.contextProfile } : {}),
  ...(inherited.enableCostTracking !== undefined ? { enableCostTracking: inherited.enableCostTracking } : {}),
  ...(inherited.testScenario !== undefined ? { testScenario: inherited.testScenario } : {}),
  ...(inherited.taskContract !== undefined ? { taskContract: inherited.taskContract } : {}),
  ...(inherited.fabricationGuard !== undefined ? { fabricationGuard: inherited.fabricationGuard } : {}),
  ...(inherited.grounding !== undefined ? { grounding: inherited.grounding } : {}),
  ...(inherited.approvalPolicy !== undefined ? { approvalPolicy: inherited.approvalPolicy } : {}),
  ...(inherited.harnessPipeline !== undefined ? { harnessPipeline: inherited.harnessPipeline } : {}),
  ...(inherited.budgetLimits !== undefined ? { budgetLimits: inherited.budgetLimits } : {}),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runtime/tests/subagent/inheritance-parity.test.ts --timeout 30000`
Expected: PASS (2 tests)

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. If `BudgetLimits` fails to import from `../../builder.js` due to a cycle, re-export it from `../types.js` and import from there instead.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/builder/build-effect/inherited-run-context.ts packages/runtime/tests/subagent/inheritance-parity.test.ts
git commit -m "feat(runtime): add InheritedRunContext, one definition of what a sub-agent inherits

The two delegation paths each built their own createLightRuntime options
(11 fields vs 23), so a constraint the parent accepted was escapable by
delegating through the shorter path. This adds the shared definition; the
paths migrate onto it next."
```

---

### Task 2: Migrate the `spawn-agent` path onto `InheritedRunContext`

**Files:**
- Modify: `packages/runtime/src/builder/build-effect/sub-agent-executor.ts:435-488` (the `createLightRuntime` call and the `SubAgentExecutorDeps` fields it reads)
- Test: `packages/runtime/tests/subagent/inheritance-parity.test.ts` (extend)

**Interfaces:**
- Consumes: `toChildRuntimeOptions`, `InheritedRunContext` from Task 1.
- Produces: `SubAgentExecutorDeps` gains `readonly inherited: InheritedRunContext` and drops the 13 individual `parent*` config fields. `parentAgentId`, `maxRecursionDepth`, `defaultMaxIter`, `getParentToolService`, `getParentContext`, `mcpServers`, and `toolsMod` remain — they are not inherited config.

- [ ] **Step 1: Write the failing test**

Append to `packages/runtime/tests/subagent/inheritance-parity.test.ts`:

```typescript
describe("spawn path parity", () => {
  it("a parent budget ceiling reaches the child config", () => {
    const inherited: InheritedRunContext = {
      provider: "test",
      budgetLimits: { tokenLimit: 5000 },
    };

    const opts = toChildRuntimeOptions(inherited, childIdentity);

    // Before this change the spawn path never passed budgetLimits, so the
    // child kernel saw `state.meta.budgetLimits === undefined` and enforced
    // no ceiling — delegation escaped the parent's budget entirely.
    expect(opts.budgetLimits).toEqual({ tokenLimit: 5000 });
  });
});
```

- [ ] **Step 2: Run test to verify it passes already**

Run: `bun test packages/runtime/tests/subagent/inheritance-parity.test.ts --timeout 30000`
Expected: PASS — Task 1 already handles this. This test documents the requirement the migration must not regress. Proceed to the migration.

- [ ] **Step 3: Replace the deps fields**

In `packages/runtime/src/builder/build-effect/sub-agent-executor.ts`, in `interface SubAgentExecutorDeps`, delete these 13 fields:

`parentProvider`, `parentModel`, `parentReasoningOptions`, `parentEnableGuardrails`, `parentEnableObservability`, `parentObservabilityOptions`, `parentContextProfile`, `parentEnableCostTracking`, `parentTestScenario`, `parentTaskContract`, `parentFabricationGuard`, `parentGrounding`, `parentApprovalPolicy`

Add in their place:

```typescript
  /**
   * Everything the child inherits from its parent. One definition, shared
   * with the `.withAgentTool()` path — see inherited-run-context.ts.
   */
  readonly inherited: InheritedRunContext;
```

Add the import at the top of the file:

```typescript
import {
  toChildRuntimeOptions,
  type InheritedRunContext,
} from "./inherited-run-context.js";
```

- [ ] **Step 4: Replace the `createLightRuntime` call**

Replace the whole `const subRuntime = createLightRuntime({ ... })` call (currently lines 435–488) with:

```typescript
      const subRuntime = createLightRuntime(
        toChildRuntimeOptions(deps.inherited, {
          agentId,
          agentDisplayName: t.name,
          systemPrompt: composedSystemPrompt,
          maxIterations: defaultMaxIter,
          ...(subAllowed !== undefined ? { allowedTools: subAllowed } : {}),
          ...(subRequiredTools !== undefined ? { requiredTools: subRequiredTools } : {}),
        }) as Parameters<typeof createLightRuntime>[0],
      );
```

Then handle the two child-specific observability overrides that must survive. Immediately before the call, compute:

```typescript
      // The child must not print its own dashboard (the parent rolls it up),
      // and its log lines carry a depth-aware prefix. Both override whatever
      // the parent's observabilityOptions said.
      const childObservabilityOptions =
        deps.inherited.enableObservability && deps.inherited.observabilityOptions
          ? { ...deps.inherited.observabilityOptions, logPrefix: childLogPrefix, emitConsole: false }
          : { logPrefix: childLogPrefix, emitConsole: false };
```

and pass `observabilityOptions: childObservabilityOptions` plus the two shared handles by spreading them onto the result:

```typescript
      const subRuntime = createLightRuntime({
        ...toChildRuntimeOptions(deps.inherited, {
          agentId,
          agentDisplayName: t.name,
          systemPrompt: composedSystemPrompt,
          maxIterations: defaultMaxIter,
          ...(subAllowed !== undefined ? { allowedTools: subAllowed } : {}),
          ...(subRequiredTools !== undefined ? { requiredTools: subRequiredTools } : {}),
        }),
        observabilityOptions: childObservabilityOptions,
        ...(sharedEventBus !== undefined ? { sharedEventBus } : {}),
        ...(sharedChildDashboardRegistry !== undefined ? { sharedChildDashboardRegistry } : {}),
      } as Parameters<typeof createLightRuntime>[0]);
```

- [ ] **Step 5: Update the destructuring block**

The function destructures `deps` near the top of `buildSubAgentTask`. Remove the 13 deleted names from that destructure and keep only: `defaultMaxIter`, `maxRecursionDepth`, `getParentToolService`, `mcpServers`, `parentAgentId`, `getParentContext`, `toolsMod`. Replace any remaining use of `parentProvider` (in the `provider` field) — it is now `deps.inherited.provider`.

- [ ] **Step 6: Update the call site**

In `packages/runtime/src/builder/build-effect/tool-mcp-registrations.ts`, replace the 13 individual fields passed to `buildSubAgentTask` (currently lines ~167–188) with a single:

```typescript
              inherited: deps.inherited,
```

and in `ToolMcpRegistrationsDeps`, replace the same 13 `parent*` fields with `readonly inherited: InheritedRunContext;` plus the import.

- [ ] **Step 7: Update the builder call site**

In `packages/runtime/src/builder.ts` at the `buildToolMcpRegistrations({ ... })` call (~line 2669), replace the 13 individual fields with:

```typescript
                    inherited: {
                        provider: parentProvider,
                        ...(parentModel !== undefined ? { model: parentModel } : {}),
                        ...(parentReasoningOptions !== undefined ? { reasoningOptions: parentReasoningOptions } : {}),
                        enableGuardrails: parentEnableGuardrails,
                        enableObservability: parentEnableObservability,
                        observabilityOptions: parentObservabilityOptions,
                        ...(parentContextProfile !== undefined ? { contextProfile: parentContextProfile } : {}),
                        enableCostTracking: parentEnableCostTracking,
                        ...(self._testScenario !== undefined ? { testScenario: self._testScenario } : {}),
                        ...(parentTaskContract !== undefined ? { taskContract: parentTaskContract } : {}),
                        ...(parentFabricationGuard !== undefined ? { fabricationGuard: parentFabricationGuard } : {}),
                        ...(parentGrounding !== undefined ? { grounding: parentGrounding } : {}),
                        ...(parentApprovalPolicy !== undefined ? { approvalPolicy: parentApprovalPolicy } : {}),
                    },
```

(`harnessPipeline` and `budgetLimits` are added in Task 4 — not yet.)

- [ ] **Step 8: Run the existing sub-agent suite**

Run: `bun test packages/runtime/tests/subagent/ packages/runtime/tests/sub-agent-light-config.test.ts --timeout 30000`
Expected: PASS, all existing tests unchanged. These are the regression gate for the migration — if any fail, the field mapping diverged.

- [ ] **Step 9: Typecheck and commit**

```bash
bun run typecheck
git add packages/runtime/src packages/runtime/tests
git commit -m "refactor(runtime): migrate spawn-agent path onto InheritedRunContext

Replaces 13 hand-threaded parent* fields with the shared record. No
behavior change intended; the existing sub-agent suite is the gate."
```

---

### Task 3: Migrate the `.withAgentTool()` path and fix the provider default

**Files:**
- Modify: `packages/runtime/src/builder/build-effect/local-agent-tools.ts:161-178`
- Test: `packages/runtime/tests/subagent/provider-inheritance.test.ts`

**Interfaces:**
- Consumes: `toChildRuntimeOptions`, `InheritedRunContext` (Task 1); `LocalAgentToolDeps` gains `readonly inherited: InheritedRunContext`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/tests/subagent/provider-inheritance.test.ts`:

```typescript
// Run: bun test packages/runtime/tests/subagent/provider-inheritance.test.ts --timeout 30000
//
// `.withAgentTool()` with no explicit provider silently ran the child on the
// deterministic `test` provider (spec §2.2): local-agent-tools.ts defaulted to
// `agentTool.agent!.provider ?? "test"` and nothing backfilled the parent's.
// An application declaring a specialist without a provider got canned output
// that looked like a real answer.
import { describe, it, expect } from "bun:test";
import {
  toChildRuntimeOptions,
  type InheritedRunContext,
} from "../../src/builder/build-effect/inherited-run-context.js";

describe(".withAgentTool provider inheritance", () => {
  it("uses the parent's provider when the agent tool declares none", () => {
    const inherited: InheritedRunContext = { provider: "anthropic" };

    const opts = toChildRuntimeOptions(inherited, {
      agentId: "sub-researcher-1",
      agentDisplayName: "researcher",
      systemPrompt: "You research.",
    });

    expect(opts.provider).toBe("anthropic");
    expect(opts.provider).not.toBe("test");
  });

  it("an explicit per-delegate provider overrides the inherited one", () => {
    const inherited: InheritedRunContext = { provider: "anthropic" };

    const opts = toChildRuntimeOptions(
      { ...inherited, provider: "ollama" },
      { agentId: "sub-x-1", agentDisplayName: "x", systemPrompt: "x" },
    );

    expect(opts.provider).toBe("ollama");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test packages/runtime/tests/subagent/provider-inheritance.test.ts --timeout 30000`
Expected: PASS — this pins the contract Task 1 established. The behavioral fix follows in Step 3.

- [ ] **Step 3: Rewrite the local path's runtime construction**

In `packages/runtime/src/builder/build-effect/local-agent-tools.ts`, add to `LocalAgentToolDeps`:

```typescript
  /** Everything the child inherits — shared with the spawn path. */
  readonly inherited: InheritedRunContext;
```

with the import:

```typescript
import {
  toChildRuntimeOptions,
  type InheritedRunContext,
} from "./inherited-run-context.js";
```

Then replace the `const subRuntime = createLightRuntime({ ... })` call (lines 161–178) with:

```typescript
        const subRuntime = createLightRuntime({
          ...toChildRuntimeOptions(
            {
              ...deps.inherited,
              // An explicit per-delegate provider/model wins over the parent's.
              ...(agentTool.agent!.provider !== undefined
                ? { provider: agentTool.agent!.provider as ProviderName }
                : {}),
              ...(agentTool.agent!.model !== undefined
                ? { model: agentTool.agent!.model }
                : {}),
            },
            {
              agentId: childAgentId,
              agentDisplayName: subName,
              systemPrompt: composedSystemPrompt,
              ...(agentTool.agent!.maxIterations !== undefined
                ? { maxIterations: agentTool.agent!.maxIterations }
                : {}),
              ...(staticAllowed !== undefined ? { allowedTools: staticAllowed } : {}),
              ...(staticRequired !== undefined ? { requiredTools: staticRequired } : {}),
            },
          ),
          ...(sharedEventBus !== undefined ? { sharedEventBus } : {}),
        } as Parameters<typeof createLightRuntime>[0]);
```

- [ ] **Step 4: Pass `inherited` at the call site**

In `packages/runtime/src/builder/build-effect/tool-mcp-registrations.ts`, in the `createLocalAgentToolRegistration(agentTool, { ... })` call (~line 121), add:

```typescript
              inherited: deps.inherited,
```

- [ ] **Step 5: Add the end-to-end behavioral assertion**

Append to `packages/runtime/tests/subagent/provider-inheritance.test.ts`:

```typescript
import { ReactiveAgents } from "../../src/index.js";

describe(".withAgentTool cross-cutting inheritance — live dispatch", () => {
  it("a parent's fabricationGuard reaches an agent-tool child", async () => {
    // Wire-it-AND-pin-it: the unit tests above assert the config mapping;
    // this asserts the composed path actually dispatches under it.
    const parent = await ReactiveAgents.create()
      .withName("agent-tool-parent")
      .withProvider("test")
      .withModel("test-model")
      .withFabricationGuard("block")
      .withAgentTool("researcher", { name: "researcher" })
      .withTools()
      .withTestScenario([
        { toolCall: { name: "researcher", args: { input: "summarize" } } },
        { text: "Done." },
      ])
      .build();

    const result = await parent.run("Delegate to the researcher.");
    await parent.dispose();

    expect(result.success).toBe(true);
  }, 30_000);
});
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/runtime/tests/subagent/ --timeout 30000`
Expected: PASS. If the live-dispatch test fails because the child now inherits the `test` scenario and consumes turns unexpectedly, set the child's scenario explicitly in the assertion rather than loosening the inheritance — the inheritance is the point.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add packages/runtime/src packages/runtime/tests
git commit -m "fix(runtime): .withAgentTool sub-agents inherit the parent's provider and cross-cutting config

The local agent-tool path defaulted an unset provider to the deterministic
test provider and dropped every cross-cutting concern, including
approvalPolicy. It now derives its child config from InheritedRunContext,
the same record the spawn path uses."
```

---

### Task 4: Propagate `harnessPipeline` and `budgetLimits`

**Files:**
- Modify: `packages/runtime/src/builder/build-effect/runtime-construction.ts:427-435` (extract the compile step)
- Modify: `packages/runtime/src/builder.ts` (pass both into `inherited`)
- Test: `packages/runtime/tests/subagent/pipeline-propagation.test.ts`

**Interfaces:**
- Consumes: `InheritedRunContext` fields `harnessPipeline`, `budgetLimits` (already declared in Task 1).
- Produces: `export const compileHarnessPipeline: (registrations: ReadonlyArray<(h: Harness) => void>) => HarnessPipeline | undefined` in `runtime-construction.ts`, reused by both the parent build and the child derivation.

- [ ] **Step 1: Write the failing test**

Create `packages/runtime/tests/subagent/pipeline-propagation.test.ts`:

```typescript
// Run: bun test packages/runtime/tests/subagent/pipeline-propagation.test.ts --timeout 30000
//
// Neither delegation path propagated harnessPipeline or budgetLimits (spec
// §2.3), so every .compose() combinator and all five killswitches were
// parent-only, silently, and .withBudget() was escaped by delegating.
import { describe, it, expect } from "bun:test";
import type { Harness } from "@reactive-agents/core";
import { ReactiveAgents } from "../../src/index.js";

describe("harness pipeline propagation into sub-agents", () => {
  it("a parent-registered phase hook also fires inside the child", async () => {
    const phasesSeen: string[] = [];

    const parent = await ReactiveAgents.create()
      .withName("pipeline-parent")
      .withProvider("test")
      .withModel("test-model")
      .withDynamicSubAgents({ maxIterations: 2 })
      .withTools()
      .compose((h: Harness) => {
        h.before("think", (ctx) => {
          phasesSeen.push(`think:${ctx.iteration}`);
          return undefined;
        });
      })
      .withTestScenario([
        { toolCall: { name: "spawn-agent", args: { task: "do the thing", name: "worker" } } },
        { text: "Done." },
      ])
      .build();

    await parent.run("Delegate.");
    await parent.dispose();

    // The parent alone produces at least one think hook. The child running
    // under the same pipeline produces more. Before the fix, the child
    // contributed exactly zero.
    expect(phasesSeen.length).toBeGreaterThan(1);
  }, 30_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime/tests/subagent/pipeline-propagation.test.ts --timeout 30000`
Expected: FAIL — the child runs with no pipeline, so only the parent's hooks fire.

If it passes at this point, the assertion is too weak to distinguish parent-only from parent+child. Strengthen it by tagging hooks with the agent id from `ctx.state` and asserting two distinct agent ids appear, then continue.

- [ ] **Step 3: Extract the pipeline compiler**

In `packages/runtime/src/builder/build-effect/runtime-construction.ts`, replace the inline IIFE at lines 427–435 with a call to a new exported function defined in the same file:

```typescript
/**
 * Compile `.withHarness()` / `.compose()` registrations into a HarnessPipeline.
 * Exported so the sub-agent boundary derives the child's pipeline from the
 * SAME registrations rather than running without one (spec §2.3).
 */
export const compileHarnessPipeline = (
  registrations: ReadonlyArray<(harness: Harness) => void>,
): HarnessPipeline | undefined => {
  if (registrations.length === 0) return undefined;
  const reg = new RegistrationHarness();
  for (const fn of registrations) fn(reg);
  return new HarnessPipeline(reg._collected);
};
```

and at the original site:

```typescript
    const harnessPipeline: HarnessPipeline | undefined = compileHarnessPipeline(
      state._harnessRegistrations,
    );
```

- [ ] **Step 4: Pass both fields into `inherited`**

In `packages/runtime/src/builder.ts`, add the import:

```typescript
import { compileHarnessPipeline } from './builder/build-effect/runtime-construction.js'
```

and extend the `inherited` object literal added in Task 2, Step 7:

```typescript
                        ...(compileHarnessPipeline(self._harnessRegistrations) !== undefined
                            ? { harnessPipeline: compileHarnessPipeline(self._harnessRegistrations) }
                            : {}),
                        ...(self._budgetLimits !== undefined ? { budgetLimits: self._budgetLimits } : {}),
```

Compute the pipeline once into a local instead of calling twice:

```typescript
            const inheritedHarnessPipeline = compileHarnessPipeline(self._harnessRegistrations)
```

placed before the `buildToolMcpRegistrations` call, then reference `inheritedHarnessPipeline` in the spread.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/runtime/tests/subagent/pipeline-propagation.test.ts --timeout 30000`
Expected: PASS

- [ ] **Step 6: Run the whole runtime suite for regressions**

Run: `bun test packages/runtime --timeout 30000`
Expected: PASS. A child now inheriting killswitches is a behavior change — if a pre-existing test fails because a child is now constrained where it previously was not, that test was encoding the bug. Update it and note the change in the commit body.

- [ ] **Step 7: Commit**

```bash
bun run typecheck
git add packages/runtime/src packages/runtime/tests
git commit -m "fix(runtime): propagate harnessPipeline and budgetLimits into sub-agents

Compose combinators and all five killswitches were parent-only, silently,
and a .withBudget() ceiling was escaped by delegating: the child kernel
saw state.meta.budgetLimits === undefined and enforced nothing.

Note: budget is inherited as the parent's ceiling, so N children may each
spend up to it. Run-scoped remaining-budget accounting is tracked
separately in the spec (section 4.5) and is not closed by this commit."
```

---

### Task 5: Parent the child's OTel span

**Files:**
- Modify: `packages/observe/src/tracer.ts:62-75`
- Test: `packages/observe/tests/child-span-parenting.test.ts`

**Interfaces:**
- Consumes: `handleTracerEvent`, `createSpanMap`, `SpanMap` — all already exported from `packages/observe/src/tracer.ts:32,41`.
- Produces: `AgentStarted` gains `readonly parentTaskId?: string`; `handleTracerEvent` behavior change.

**Verified precondition:** `parentTaskId` does **not** exist on `AgentStarted` today (`grep -rn "parentTaskId" packages/core/src/services/event-bus.ts` returns nothing). Only `parentAgentId` is stamped. Step 1 adds the field; the parenting logic that reads it comes after, so the lookup is never written against a field nobody sets.

- [ ] **Step 1: Add and stamp `parentTaskId`**

In `packages/core/src/services/event-bus.ts`, add to the `AgentStarted` event type, beside the existing `parentAgentId`:

```typescript
      /**
       * The `taskId` of the run that spawned this agent. Absent ⇒ root run.
       * Carried so a child's trace span can nest under its parent's — without
       * it, every sub-agent is a separate OTel trace root (spec §6.1).
       */
      readonly parentTaskId?: string;
```

Then stamp it in both delegation paths, alongside the existing `parentAgentId` in the child task's `metadata.context`:

- `packages/runtime/src/builder/build-effect/sub-agent-executor.ts:577-580` — use `spawningCtx.taskId`
- `packages/runtime/src/builder/build-effect/local-agent-tools.ts:187-190` — use `spawningCtx.taskId`

In both, the metadata context becomes:

```typescript
            context: {
              parentAgentId,
              parentTaskId: spawningCtx.taskId,
              runContext: childCtx,
            },
```

Verify the event publisher forwards it: `grep -rn "parentAgentId" packages/runtime/src/engine/ | head`. Wherever `parentAgentId` is copied onto the published `AgentStarted`, copy `parentTaskId` the same way. If it is not forwarded, the tracer will never see it and Task 5 silently does nothing.

- [ ] **Step 2: Write the failing test**

Create `packages/observe/tests/child-span-parenting.test.ts`:

```typescript
// Run: bun test packages/observe/tests/child-span-parenting.test.ts --timeout 30000
//
// Every agent workflow span was started with no parent context (spec §6.1), so
// a sub-agent was a separate OTel trace ROOT. A five-child fan-out produced six
// unrelated traces and the delegation structure — the thing you most need when
// debugging multi-agent — was the one thing the trace did not show.
import { describe, it, expect } from "bun:test";
import * as otelApi from "@opentelemetry/api";
import { handleTracerEvent, createSpanMap } from "../src/tracer.js";

describe("child agent span parenting", () => {
  it("starts a child agent's workflow span inside the parent's span context", () => {
    const started: Array<{ name: string; hasParent: boolean }> = [];

    const tracer = {
      startSpan: (name: string, _opts?: unknown, ctx?: otelApi.Context) => {
        started.push({
          name,
          hasParent: ctx !== undefined && otelApi.trace.getSpan(ctx) !== undefined,
        });
        return {
          setAttributes: () => {},
          setStatus: () => {},
          recordException: () => {},
          end: () => {},
        } as unknown as otelApi.Span;
      },
    } as unknown as otelApi.Tracer;

    const spans = createSpanMap();

    handleTracerEvent(tracer, spans, {
      _tag: "AgentStarted",
      taskId: "task-parent",
      agentId: "parent",
      model: "test-model",
      provider: "test",
      timestamp: Date.now(),
    } as never);

    handleTracerEvent(tracer, spans, {
      _tag: "AgentStarted",
      taskId: "task-child",
      agentId: "child",
      parentAgentId: "parent",
      parentTaskId: "task-parent",
      model: "test-model",
      provider: "test",
      timestamp: Date.now(),
    } as never);

    expect(started[0]?.hasParent).toBe(false); // root run
    expect(started[1]?.hasParent).toBe(true); // child nests under the parent
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/observe/tests/child-span-parenting.test.ts --timeout 30000`
Expected: FAIL — `expect(started[1]?.hasParent).toBe(true)` receives `false`.

If `SpanMap` is not exported from `../src/tracer.js`, export the type before proceeding.

- [ ] **Step 4: Implement parenting**

In `packages/observe/src/tracer.ts`, replace the `AgentStarted` case body's `startSpan` call with:

```typescript
          case "AgentStarted": {
            // A sub-agent's workflow span must nest under its parent's, or the
            // delegation structure is invisible in the backend (spec §6.1).
            // `parentTaskId` is stamped alongside `parentAgentId` by both
            // delegation paths; absent ⇒ this is a root run.
            const parentTaskId = (event as { parentTaskId?: string }).parentTaskId;
            const parentSpan =
              parentTaskId !== undefined ? spans.workflows.get(parentTaskId) : undefined;
            const ctx = parentSpan
              ? otelApi.trace.setSpan(otelApi.ROOT_CONTEXT, parentSpan)
              : undefined;
            const span = tracer.startSpan(
              `agent:${event.agentId}`,
              {
                kind: otelApi.SpanKind.INTERNAL,
                attributes: {
                  [OI.SPAN_KIND]: SpanKind.AGENT,
                  [OI.LLM_MODEL_NAME]: event.model,
                  [OI.LLM_PROVIDER]: event.provider,
                  "agent.id": event.agentId,
                  "task.id": event.taskId,
                },
                startTime: event.timestamp,
              },
              ctx,
            );
            spans.workflows.set(event.taskId, span);
            break;
          }
```

- [ ] **Step 5: Confirm `parentTaskId` reaches the tracer**

Run: `grep -rn "parentTaskId" packages/core/src/services/event-bus.ts packages/runtime/src/builder/build-effect/`

Expected: at least one hit showing the field on `AgentStarted`.

**If there are no hits, `parentTaskId` does not exist yet** — add it: in `packages/core/src/services/event-bus.ts` add `readonly parentTaskId?: string` to the `AgentStarted` event type, and in both delegation paths stamp it into the child task's `metadata.context` alongside the existing `parentAgentId` (`sub-agent-executor.ts:577-580`, `local-agent-tools.ts:187-190`), using the spawning run's `taskId`. Do not proceed until the field is emitted — a parenting lookup on a field nobody sets is dead code that tests can still pass by mocking.

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test packages/observe/tests/child-span-parenting.test.ts --timeout 30000`
Expected: PASS

- [ ] **Step 7: Run the observe suite and commit**

```bash
bun test packages/observe --timeout 30000
bun run typecheck
git add packages/observe packages/core packages/runtime
git commit -m "fix(observe): nest a sub-agent's workflow span under its parent's

Every agent workflow span started with no parent context, so each
sub-agent was a separate OTel trace root and a fan-out emitted one
unrelated trace per agent. The lineage data already existed on the
event; it just never reached the tracer."
```

---

### Task 6: Resolve the dead Gateway approval control

**Files:**
- Modify: `packages/gateway/src/types.ts:111`
- Modify: `packages/gateway/tests/types.test.ts:160-180`

**Interfaces:**
- Consumes: nothing.
- Produces: `PolicyConfig` no longer has a `requireApprovalFor` field.

**Decision:** remove rather than wire. Wiring it would add a sixth approval mechanism ahead of the consolidation phase that decides what the mechanism should be (spec §4.6, Phase 8). Removing it eliminates a control that silently does nothing today, which is the safety-relevant half. Gateway users who need approval gating use `.withApprovalPolicy()`, the durable rail.

- [ ] **Step 1: Confirm it is genuinely unconsumed**

Run: `grep -rn "requireApprovalFor" packages/gateway/src/`

Expected: exactly one hit, `packages/gateway/src/types.ts:111`. If there are more, **stop** — the premise is wrong; report it rather than deleting a live field.

- [ ] **Step 2: Remove the schema field**

In `packages/gateway/src/types.ts`, delete this line from `PolicyConfigSchema`:

```typescript
  requireApprovalFor: Schema.optional(Schema.Array(Schema.String)),
```

- [ ] **Step 3: Update the tests that pinned it**

In `packages/gateway/tests/types.test.ts`, remove the two assertions referencing `requireApprovalFor` (`expect(result.requireApprovalFor).toBeUndefined()` and the `["deploy", "delete"]` round-trip). These asserted the schema parsed the value, never that anything read it.

- [ ] **Step 4: Run the gateway suite**

Run: `bun test packages/gateway --timeout 30000`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
bun run typecheck
git add packages/gateway
git commit -m "fix(gateway)!: remove the dead requireApprovalFor policy field

PolicyConfig.requireApprovalFor was declared, schema-validated, and
round-trip tested, and consumed by nothing: zero approval references in
the policy engine, the gateway service, or any of the five policy files.
An application setting it on an autonomous agent reasonably believed
destructive cron-triggered actions were gated. They were not.

Removed rather than wired: wiring would add a sixth approval mechanism
ahead of the consolidation that decides what the mechanism should be.
Use .withApprovalPolicy() for gateway approval gating.

BREAKING: a config literal setting requireApprovalFor now fails schema
validation instead of being silently ignored."
```

---

### Task 7: Full-suite verification and documentation

**Files:**
- Modify: `apps/docs/src/content/docs/guides/sub-agents.md`
- Modify: `.changeset/` (new changeset file)

- [ ] **Step 1: Run every gate**

```bash
bun test --timeout 30000
bun run typecheck
bun run build
bash scripts/check-cross-cutting.sh
```

Expected: all pass. `check-cross-cutting.sh` guards the RunEnvelope invariants and this plan touched the sub-agent boundary — if it now rejects the derivation site, read the gate's own header comment before changing either the gate or the code.

- [ ] **Step 2: Document the inheritance rule**

In `apps/docs/src/content/docs/guides/sub-agents.md`, add a section after the existing intro:

```markdown
## What a sub-agent inherits

A sub-agent runs under its parent's constraints. Both delegation paths —
`.withAgentTool()` and the `spawn-agent` tool from `.withDynamicSubAgents()` —
derive the child's configuration from the same record, so the two cannot drift.

Inherited from the parent:

| Concern | Notes |
|---|---|
| Provider and model | An explicit per-delegate `provider` / `model` overrides the parent's |
| Task contract, fabrication guard, grounding | The child's answer is judged against the same rules |
| Approval policy | Coerced to `block` in the child, which has no durable store to resume from |
| Guardrails, observability, cost tracking, context profile | |
| Compose combinators and killswitches | A parent killswitch constrains its children |
| Budget limits | The parent's ceiling applies to each child |

Not inherited (opt-in per delegate, because each carries real cost): memory,
experience learning, reactive intelligence, durable runs, and sessions.
```

- [ ] **Step 3: Verify the docs examples still typecheck**

Run: `bun run docs:examples:check`
Expected: `✓ all checked doc examples typecheck.` with the skip count at or below its ceiling. Never add a `docs-skip-typecheck` marker to make this pass.

- [ ] **Step 4: Add a changeset**

Create `.changeset/multi-agent-phase-0.md`:

```markdown
---
"reactive-agents": patch
---

Sub-agents now inherit their parent's constraints on both delegation paths.

Previously the `.withAgentTool()` path passed 11 configuration fields to a
child while the `spawn-agent` path passed 23, so a constraint set on the
parent could be escaped by delegating through the shorter path. Both paths now
derive the child's configuration from one shared record.

Fixes:

- `.withAgentTool("x", { name: "x" })` with no explicit `provider` ran the
  sub-agent on the deterministic `test` provider instead of the parent's.
- The `.withAgentTool()` path dropped every cross-cutting concern, including
  `approvalPolicy`, so approval gating did not reach those sub-agents.
- Neither path propagated `harnessPipeline` or `budgetLimits`, so `.compose()`
  combinators and all five killswitches were parent-only and a `.withBudget()`
  ceiling was escaped by delegating.
- A sub-agent's OpenTelemetry workflow span was a separate trace root, so
  delegation structure was invisible in any OTLP backend.
- `PolicyConfig.requireApprovalFor` in `@reactive-agents/gateway` was removed:
  it was declared and schema-validated but consumed by nothing, so it silently
  gated nothing. Use `.withApprovalPolicy()`.
```

- [ ] **Step 5: Commit**

```bash
git add apps/docs .changeset
git commit -m "docs: document the sub-agent inheritance rule; add Phase 0 changeset"
```

---

## Self-Review

**Spec coverage (Phase 0 acceptance criteria, spec §8):**

| Spec requirement | Task |
|---|---|
| Extract `spawnChildAgent` + `InheritedRunContext` | 1, 2, 3 |
| Both paths call it; divergent lists deleted | 2, 3 |
| Propagate `harnessPipeline` | 4 |
| Propagate `budgetLimits` | 4 |
| Fix `.withAgentTool()` provider default | 3 |
| Parent the child's OTel span (§6.1) | 5 |
| Resolve `PolicyConfig.requireApprovalFor` (§2.5 #5) | 6 |
| A parent killswitch fires inside a child, both paths | 4 (spawn), 3 (agent-tool live dispatch) |
| One connected OTel trace per delegating run | 5 |

**Deviation from the spec, stated explicitly:** the spec's §4.5 recommends option 2 (inherit the parent's *live remaining* budget) over option 1 (inherit the ceiling as-is). This plan implements **option 1**, because run-scoped remaining-budget accounting needs a shared counter that does not exist yet and would expand Phase 0 well past a bug fix. The spec's own risk row anticipates this: "if it proves invasive, ship option 1 + a failing test documenting the gap rather than silently accepting it." Task 4's commit message records the gap. **Before closing Phase 0, add the documenting test** — a skipped or `.todo` test named for the N-children-exceed-parent-ceiling case — so the gap is visible in the suite rather than only in prose.

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N" references.

**Type consistency:** `InheritedRunContext` and `ChildIdentity` are defined once in Task 1 and referenced by exact name in Tasks 2, 3, and 4. `toChildRuntimeOptions` keeps one signature throughout. `compileHarnessPipeline` is defined in Task 4 Step 3 and used in Step 4.

**Known risk carried into execution:** Task 2 Step 4 and Task 3 Step 3 both use `as Parameters<typeof createLightRuntime>[0]`. That cast is a real weakening of type safety and conflicts with the project's no-`any`-spirit rule. Prefer typing `toChildRuntimeOptions`'s return as the actual options type if it can be imported without a cycle; only fall back to the cast if the import cycles. Flag it in review either way.
