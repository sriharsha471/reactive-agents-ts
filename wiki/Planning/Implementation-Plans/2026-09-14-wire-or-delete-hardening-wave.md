---
title: Wire-or-Delete Hardening Wave
date: 2026-09-14
status: proposed
tags: [plan, hardening, wiring, debt, lift-gate]
source: 2026-09-14 architecture audit (session) — findings verified against source
---

# Wire-or-Delete Hardening Wave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Pair with `agent-tdd` (Effect-TS TDD, mandatory `--timeout` flags) and `effect-ts-patterns`.

**Goal:** Close the verified unwired / miswired / write-only mechanisms found in the 2026-09-14 audit so that every shipped feature either changes a run observably (and is pinned red-on-cut) or is deleted — and settle every unmeasured experimental flag with a lift verdict.

**Architecture:** Nine tasks, ordered cheapest-and-most-certain first. Tasks 1–5 are deterministic correctness fixes (no lift gate needed — a bug fix must not regress, and each ships a red-on-cut test). Tasks 6–7 change model-facing behavior and are **lift-gated** per 09 §2 (≥3pp accuracy AND ≤15% billed-token overhead, cross-tier; `ablation-warden` holds veto) — they ship opt-in and are promoted only on evidence. Task 8 builds the missing proof lane for builder withers. Task 9 closes the wave.

**Tech Stack:** TypeScript (strict, no `any`), Effect-TS 3.x, Bun 1.3.10 test runner, turbo, the deterministic `test` provider (`.withTestScenario`), `packages/benchmarks` (live cells + `replay-ablate-sweep.ts`).

**Spec:** No separate spec — this plan argues from `wiki/Architecture/Specs/09-UNIFIED-PROGRAM.md` (§2 invariants, §6 smells, §7 path) and `wiki/Architecture/DEBT-REGISTER.md` (D-2026-09-08-O, D-2026-07-30-I, orphan baseline `handoff`). Every finding below was re-verified against source on 2026-09-14; file:line citations are from that read and must be re-checked before editing (lines drift).

## Global Constraints

- Strict TypeScript: no `any`, no new `as unknown as` (the WS-5b cast ceiling ratchets down only — `scripts/check-type-escape-hatches.sh`).
- Wither ratchet: `WITHER_CEILING = 85` (`packages/runtime/tests/builder-wither-ratchet.test.ts`) — **no new `with*` methods**. New config goes on an existing wither (`.withHarness({...})`) or `HarnessConfig`.
- Lift rule (09 §2, verbatim): "Default-on requires **≥3pp accuracy lift AND ≤15% billed-token overhead**, cross-tier, per task class, where billed input tokens = `inputTokens − cacheReadInputTokens`". Otherwise opt-in, or removed. `ablation-warden` holds veto.
- Measurement ladder (09 §5.4): deterministic replay → haiku → fast local tool-caller. Promotion requires rungs 2 and 3 to agree in sign.
- Bench cells are Bernoulli: 5 tasks × n≤5 has ~13pp SE; gaps <26pp are noise. `--output` is required or nothing persists. Run live cells **foreground** with `timeout N` (N≤590), never as background tasks.
- CI has no API keys and no Ollama — every new test must pass with `.env` moved aside; live tests `skipIf` unreachable.
- Ledger single-writer: `appendEntry`/`appendEntries` only inside `packages/reasoning/src/kernel/ledger/` (`scripts/check-ledger-writes.sh`). New ledger writes = a `recordX` emitter in `kernel/ledger/emit.ts`.
- `packages/reasoning` must not import `packages/runtime` (layer rule).
- Definition of done (DEBT-REGISTER §6, binding): declaration + non-test writer + non-test reader + a mutation that goes red.
- Commits: conventional, **no `Co-Authored-By` trailers**. Re-run `git diff --cached --stat` as the literal last step before every commit.
- Work on a branch (`git switch -c wave/wire-or-delete-2026-09`); commit or stash exploratory changes before branching.

## Expected impact (honest)

| Task | Class | Expected effect | How it is proven |
|---|---|---|---|
| 1 | Security + correctness | Eliminates cross-host API-key leak for xai/groq; `.env` load order stops mattering | Red-on-cut unit test; mastra-vs-ra static-import repro goes green |
| 2 | Prompt miswire | Model is no longer told to call a tool that isn't registered. Expect fewer wasted tool-call iterations on large-result tasks; magnitude unknown | Unit test red-on-cut + before/after count of `write_result_to_file` attempts on rung-2/3 cells |
| 3 | Instrument truth | `run-completed` traces carry real cost + termination reason (today cost is hardcoded `0`) | Unit test; `rax-diagnose` shows non-zero cost on a live haiku run |
| 4 | API parity | `runStream()`/`collect()` report `success`/`terminatedBy`/`goalAchieved`/`toolCalls` identically to `run()` (today `collect()` hardcodes `success: true`) | Parity test over 3 scenarios (answer, abstain, tool loop) |
| 5 | Dead path wired | Strategy switch handoff becomes a typed, trace-visible, compaction-protected ledger fact; orphan baseline shrinks to 0 | Unit test + `check-orphans.sh` baseline removal + one replay cell for prompt drift |
| 6 | Lift verdicts | Settles 5 unmeasured flags: each promoted, kept opt-in with a verdict, or deleted. Net LOC likely **down** | Replay sweep (rung 1) + live cells rungs 2–3, verdict doc |
| 7 | Local-tier perf | Hypothesis: lower VRAM + latency on small turns, fewer silent truncations on big turns. **Risk:** Ollama reloads the model when `num_ctx` changes, which could make it slower | Opt-in; VRAM/latency/accuracy A/B on 2 local models; kill if p50 latency regresses |
| 8 | Proof lane | Every wither is classified PROVEN / UNOBSERVABLE-DETERMINISTIC / DELETE; batch 1 converts the highest-risk SILENT withers | Census gate in CI + red-on-cut tests |
| 9 | Close | Docs, register, memory in sync | Full gates green |

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `packages/llm-provider/src/llm-config.ts` | 1 | Lazy `readLLMConfigFromEnv()`; `LLMConfigFromEnv` becomes `Layer.sync` |
| `packages/llm-provider/src/runtime.ts` | 1 | Uses `readLLMConfigFromEnv()` at layer-build time |
| `packages/llm-provider/src/providers/openai.ts` | 1 | Refuses to construct a compat client with no provider key (no SDK fallback to `OPENAI_API_KEY`) |
| `packages/llm-provider/tests/llm-config-lazy-env.test.ts` (new) | 1 | Red-on-cut: late env load + no cross-host key |
| `packages/reasoning/src/assembly/result-store.ts` | 2 | Reference-action hint only when the tool is actually offered |
| `packages/reasoning/src/assembly/stages/project-results.ts` | 2 | Passes tool availability into `preview()` |
| `packages/reasoning/tests/assembly/result-ref-hint-gating.test.ts` (new) | 2 | Red-on-cut |
| `packages/core/src/services/event-bus.ts` | 3 | `AgentCompleted.totalCostUsd?` |
| `packages/runtime/src/engine/finalize/run-finalize.ts` | 3 | Publishes cost |
| `packages/trace/src/events.ts`, `packages/trace/src/normalize.ts` | 3 | `run-completed.terminatedBy?`, real `totalCostUsd` |
| `packages/trace/tests/run-completed-truth.test.ts` (new) | 3 | Red-on-cut |
| `packages/runtime/src/engine/finalize/derive-outcome.ts` | 4 | New `deriveMetadataToolCalls()` — single owner |
| `packages/runtime/src/reactive-agent.ts` | 4 | Calls the shared helper |
| `packages/runtime/src/stream-types.ts`, `engine/execute-stream.ts`, `agent-stream.ts` | 4 | StreamCompleted carries `success`/`terminatedBy`/`goalAchieved`; `collect()` reads them |
| `packages/runtime/tests/run-stream-parity.test.ts` | 4 | Extended parity cases |
| `packages/reasoning/src/kernel/ledger/emit.ts` | 5 | `recordHandoff()` emitter |
| `packages/reasoning/src/kernel/loop/runner-helpers/strategy-switch.ts` | 5 | Mints the handoff entry; stops string-folding into `priorContext` |
| `scripts/check-orphans.sh` | 5 | Remove `handoff` from `ORPHAN_BASELINE` |
| `packages/reasoning/tests/strategy-switch-handoff-ledger.test.ts` (new) | 5 | Red-on-cut |
| `wiki/Decisions/2026-09-XX-experimental-flag-verdicts.md` (new) | 6 | Verdict per flag with receipts |
| `packages/reasoning/src/harness-config.ts`, `harness-flags.ts` | 6, 7 | Flag deletions; `numCtxPolicy` field |
| `packages/reasoning/src/kernel/capabilities/reason/think.ts` | 7 | Sets `request.numCtx` under `numCtxPolicy: "demand"` |
| `packages/reasoning/src/assembly/capability.ts` | 7 | Monotone bucket helper |
| `packages/runtime/tests/wither-census.test.ts` (new) | 8 | Every wither classified; unclassified = CI red |
| `packages/runtime/tests/builder-seam-behavioral.test.ts` | 8 | Batch-1 behavioral tests |

---

## Task 0: Doc truth pass (stale "open" claims)

Five items are still listed as open in 09 / DEBT-REGISTER but are fixed in source. Stale "open" claims cause future sessions to re-fix finished work. Doc-only, no code.

**Files:**
- Modify: `wiki/Architecture/Specs/09-UNIFIED-PROGRAM.md` (§6.5, §6.6, §6.11, §7 Step 0)
- Modify: `wiki/Architecture/DEBT-REGISTER.md` (§3 `deriveRunOutcome` row)

- [ ] **Step 1: Re-verify each claim is still fixed (do not trust this plan's read)**

```bash
cd /home/tylerbuell/Documents/AIProjects/reactive-agents-ts
grep -n "RESOLVED 2026-08-18" packages/reasoning/src/kernel/capabilities/decide/terminal-gate.ts   # §6.5
grep -n "sole confinement authority" packages/tools/src/healing/path-resolver.ts                 # §6.6
grep -n "classifyTier(model)" packages/runtime/src/engine/phases/cost-track.ts                   # §6.11 cost-track
grep -n 'terminatedBy === "llm_error") return "failure"' packages/runtime/src/engine/util.ts     # deriveRunOutcome
grep -rn '"discover-tools"' packages/*/src --include=*.ts | grep -v benchmarks | grep -v "\.test\."  # Step 0
```

Expected: first four print one hit each. The last prints only `kernel-constants.ts` (a reserved-name set, not a registration) — confirm by opening that line. If any check fails, leave that doc item open and note why.

- [ ] **Step 2: Amend 09 in place**

In §6.5 heading append: `**RESOLVED 2026-08-18** — callers derive coveredTools from ledger-backed deriveRequirementEvidence (terminal-gate.ts header, divergence (b)); verified 2026-09-14.`
In §6.6 heading append: `**RESOLVED** — path-resolver.ts no longer remaps out-of-root paths; file-operations.ts throw is the sole authority; verified 2026-09-14.`
In §6.11 replace the sentence "The `cost-track.ts` and `calibration.ts` stubs are unaffected by this closure and remain open." with: "`cost-track.ts` is RESOLVED (classifies tier via `classifyTier(model)`, reads `metadata.inputTokens`; verified 2026-09-14). `calibration.ts` returns an empty adapter overlay **by design** (see its JSDoc — every intent is delivered through a live non-adapter channel); not a stub."
In §7 Step 0, strike "Delete `discover-tools` (§5.2)" and "Fix `cost-track` tier/input tokens (6.11)" with `~~…~~ done (verified 2026-09-14)`.

- [ ] **Step 3: Amend DEBT-REGISTER**

In the `deriveRunOutcome: llm_error with an empty errorsFromLoop classifies as "success"` row, change status `**OPEN — pre-existing, deliberately preserved**` to `**RESOLVED** — engine/util.ts now returns "failure" for llm_error (verified 2026-09-14)`.

- [ ] **Step 4: Commit**

```bash
git add wiki/Architecture/Specs/09-UNIFIED-PROGRAM.md wiki/Architecture/DEBT-REGISTER.md
git diff --cached --stat
git commit -m "docs(wiki): close five stale open claims in 09 and DEBT-REGISTER"
```

---

## Task 1: Provider config reads env lazily; compat providers never borrow another provider's key

**Why (D-2026-09-08-O, confirmed live):** `llmConfigFromEnv` (`llm-config.ts:387`) is a module-level object evaluated at import time. An app that loads `.env` after `import "reactive-agents"` gets every key `undefined`. For xai/groq, `openai.ts:300` then passes `apiKey: undefined` to `new OpenAI(...)`, whose SDK falls back to `process.env.OPENAI_API_KEY` — **an OpenAI key is sent to `api.x.ai`**. Two independent fixes, both needed: (a) read env at layer-build time; (b) a compat provider with no key of its own fails loudly instead of letting the SDK borrow one.

**Files:**
- Modify: `packages/llm-provider/src/llm-config.ts:355-454`
- Modify: `packages/llm-provider/src/runtime.ts:2,101-103`
- Modify: `packages/llm-provider/src/providers/openai.ts:293-311` (and the three `makeOpenAICompatProvider({...})` calls near `:803-825`)
- Modify: `packages/llm-provider/src/index.ts:148`
- Test: `packages/llm-provider/tests/llm-config-lazy-env.test.ts` (new)

**Interfaces:**
- Produces: `export function readLLMConfigFromEnv(): typeof LLMConfig.Service` (llm-provider public export). `LLMConfigFromEnv` keeps its name and type (`Layer.Layer<LLMConfig>`). `llmConfigFromEnv` stays exported but `@deprecated` (snapshot semantics documented) — removal is a separate minor-version decision.

- [ ] **Step 1: Write the failing test**

Create `packages/llm-provider/tests/llm-config-lazy-env.test.ts`:

```ts
// Run: bun test packages/llm-provider/tests/llm-config-lazy-env.test.ts --timeout 15000
//
// D-2026-09-08-O regression. Two invariants:
//   1. A key placed in process.env AFTER the package is imported is still the
//      key the provider uses (env is read at layer build, not module import).
//   2. A compat provider (xai/groq) with no key of its own must NOT construct an
//      SDK client — the `openai` SDK's own fallback is OPENAI_API_KEY, which
//      would ship an OpenAI key to a third-party host.
import { describe, it, expect, mock, beforeAll, afterEach } from "bun:test";
import { Effect } from "effect";

let capturedCtor: { apiKey?: string; baseURL?: string } | null = null;

mock.module("openai", () => ({
  default: class MockOpenAI {
    constructor(opts: { apiKey?: string; baseURL?: string }) {
      capturedCtor = opts;
    }
    chat = {
      completions: {
        create: mock(async () => ({
          choices: [{ message: { content: "ok", role: "assistant" }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          model: "grok-3-mini",
        })),
      },
    };
    embeddings = { create: mock(async () => ({ data: [] })) };
  },
}));

const savedEnv = { XAI_API_KEY: process.env.XAI_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

let mod: typeof import("../src/index.js");

beforeAll(async () => {
  // Simulate "imported before dotenv ran": no xai key at import time.
  delete process.env.XAI_API_KEY;
  mod = await import("../src/index.js");
});

afterEach(() => {
  capturedCtor = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const completeVia = (layer: ReturnType<typeof mod.createLLMProviderLayer>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* mod.LLMService;
      return yield* llm.complete({ model: "grok-3-mini", messages: [{ role: "user", content: "hi" }], maxTokens: 16 });
    }).pipe(Effect.provide(layer), Effect.either),
  );

describe("provider config reads env lazily (D-2026-09-08-O)", () => {
  it("uses an XAI_API_KEY set after import", async () => {
    process.env.XAI_API_KEY = "xai-set-after-import";
    const result = await completeVia(mod.createLLMProviderLayer("xai", undefined, "grok-3-mini"));
    expect(result._tag).toBe("Right");
    expect(capturedCtor?.apiKey).toBe("xai-set-after-import");
  });

  it("never constructs an xai client with another provider's key", async () => {
    delete process.env.XAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai-must-not-leak";
    const result = await completeVia(mod.createLLMProviderLayer("xai", undefined, "grok-3-mini"));
    expect(result._tag).toBe("Left");
    // The SDK must not even be constructed — construction is where the fallback happens.
    expect(capturedCtor).toBeNull();
    if (result._tag === "Left") expect(String((result.left as { message?: string }).message)).toContain("XAI_API_KEY");
  });

  it("LLMConfigFromEnv layer reflects env at build time", async () => {
    process.env.XAI_API_KEY = "xai-layer-build";
    const cfg = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* mod.LLMConfig;
      }).pipe(Effect.provide(mod.LLMConfigFromEnv)),
    );
    expect(cfg.xaiApiKey).toBe("xai-layer-build");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/llm-provider/tests/llm-config-lazy-env.test.ts --timeout 15000`
Expected: all 3 FAIL — test 1 `apiKey` is `undefined`; test 2 `capturedCtor` is non-null with `apiKey: undefined`; test 3 `xaiApiKey` is `undefined`.

- [ ] **Step 3: Make env reading lazy in `llm-config.ts`**

Replace the `export const llmConfigFromEnv = LLMConfig.of({ ... });` block with a function whose body is the **identical** object literal (move it verbatim — do not change any field or default), then re-derive the two existing exports:

```ts
/**
 * Build LLMConfig from `process.env` NOW. Called at layer-build time so a
 * `.env` loaded after `import "reactive-agents"` is still honored
 * (D-2026-09-08-O). Field list and defaults documented above.
 */
export function readLLMConfigFromEnv(): typeof LLMConfig.Service {
  return LLMConfig.of({
    // ...the exact object literal previously assigned to llmConfigFromEnv...
  });
}

/**
 * @deprecated Import-time SNAPSHOT of `process.env` — keys loaded after the
 * package is imported are missing. Use `readLLMConfigFromEnv()` (or the
 * `LLMConfigFromEnv` layer, which reads lazily). Kept for API compatibility.
 */
export const llmConfigFromEnv = readLLMConfigFromEnv();

/** Reads `process.env` when the layer is BUILT, not when the module loads. */
export const LLMConfigFromEnv = Layer.sync(LLMConfig, readLLMConfigFromEnv);
```

Update the file's `@example` JSDoc (`const config = llmConfigFromEnv;`) to `const config = readLLMConfigFromEnv();`.

- [ ] **Step 4: Use the lazy reader in `runtime.ts`**

```ts
import { LLMConfig, LLMConfigFromEnv, readLLMConfigFromEnv } from "./llm-config.js";
// ...
  const configLayer = Object.keys(configOverrides).length > 0
    ? Layer.sync(LLMConfig, () => LLMConfig.of({ ...readLLMConfigFromEnv(), ...configOverrides }))
    : LLMConfigFromEnv;
```

Export the new function in `index.ts:148`:

```ts
export { LLMConfig, LLMConfigFromEnv, llmConfigFromEnv, readLLMConfigFromEnv } from "./llm-config.js";
```

- [ ] **Step 5: Refuse keyless compat clients in `openai.ts`**

Add an `apiKeyEnvVar` option to `makeOpenAICompatProvider`'s options type (next to `resolveApiKey`), set it on the three provider calls (`"OPENAI_API_KEY"` for openai, `"GROQ_API_KEY"` for groq, `"XAI_API_KEY"` for xai), and guard inside `getClient`:

```ts
    const getClient = (): Promise<OpenAIClient> => {
      if (!_clientPromise) {
        const baseURL = config.providerConfig?.baseUrl ?? resolveBaseUrl?.(config);
        const apiKey = config.providerConfig?.apiKey ?? resolveApiKey(config);
        const headers = config.providerConfig?.headers;
        // D-2026-09-08-O: the `openai` SDK falls back to OPENAI_API_KEY when
        // apiKey is undefined. For any provider other than openai itself that
        // would send an OpenAI key to a third-party host — refuse instead.
        if (apiKey === undefined && providerName !== "openai") {
          return Promise.reject(
            new Error(
              `${providerName}: no API key. Set ${apiKeyEnvVar} (loaded before build()) ` +
                `or pass .withProvider("${providerName}", { apiKey }).`,
            ),
          );
        }
        _clientPromise = (
          import("openai") as unknown as Promise<OpenAIModule>
        ).then(({ default: OpenAI }) => new OpenAI({
          apiKey,
          ...(baseURL ? { baseURL } : {}),
          ...(headers ? { defaultHeaders: headers } : {}),
        }));
      }
      return _clientPromise;
    };
```

Check how the existing `complete`/`stream` call sites turn a rejected `getClient()` into an `LLMError` (they wrap it in `Effect.tryPromise` with `toEffectError`). If a site calls `getClient()` outside a `tryPromise`, wrap it — the test's `Left` assertion depends on it.

- [ ] **Step 6: Check litellm for the same class**

Run: `grep -n "apiKey" packages/llm-provider/src/providers/litellm.ts | head`
litellm uses `fetch` with `Authorization: Bearer ${apiKey}` only when `apiKey` is set (`litellm.ts:211,366`) — no SDK fallback, so no cross-host leak. Confirm its key resolution (`litellm.ts:242-245`) reads `config`, which is now lazy. No code change expected; if the read shows an import-time snapshot, apply the Step 3 pattern.

- [ ] **Step 7: Run the tests to verify they pass, plus the neighbors**

Run: `bun test packages/llm-provider/tests/llm-config-lazy-env.test.ts packages/llm-provider/tests/groq-xai-provider.test.ts packages/llm-provider/tests/openai-provider.test.ts --timeout 15000`
Expected: all PASS.

- [ ] **Step 8: Mutation check (red-on-cut)**

Temporarily revert Step 5's guard only → test 2 must go RED. Temporarily change `LLMConfigFromEnv` back to `Layer.succeed(LLMConfig, llmConfigFromEnv)` → test 3 must go RED. Restore both.

- [ ] **Step 9: End-to-end repro**

The bench that exposed the bug worked around it with a dynamic import. Revert that workaround **in a scratch copy** and prove the static import now works:

```bash
cp packages/benchmarks/mastra-vs-ra/runner.ts /tmp/claude-1000/runner-static.ts
# Edit the copy: replace `const { ReactiveAgents } = await import("reactive-agents")` with a
# top-level `import { ReactiveAgents } from "reactive-agents"`.
```

If `XAI_API_KEY` is in `.env`, run one xai cell with the copy (foreground, `timeout 300`). Expected: a real billed response, not `400 "Incorrect API key provided"`. If no xai key exists, record "E2E skipped — no key" in the debrief (unit tests remain the proof).

- [ ] **Step 10: Docs + register**

- `packages/llm-provider/README.md:116`: mention `readLLMConfigFromEnv()` and that the layer reads lazily.
- `packages/judge-server/tests/live-layer.test.ts:4-8`: the comment's premise (env read at import) is no longer true — update the comment; keep the `??=` dummy key (harmless).
- `packages/runtime/src/build-validation.ts:34-46`: update the JSDoc (the split-brain it describes is now closed at the source).
- `packages/benchmarks/mastra-vs-ra/README.md:69` + `results/README.md:27`: "fixed in framework as of <commit>"; keep the dynamic import (harmless) or restore the static one.
- DEBT-REGISTER D-2026-09-08-O: `⚠️ OPEN` → `✅ RESOLVED (<sha>)` with test file path.
- Add a changeset: `bunx changeset` → `@reactive-agents/llm-provider` patch: "Read provider API keys from the environment at build time; refuse to send a missing groq/xai key's OpenAI fallback to a third-party host."

- [ ] **Step 11: Commit**

```bash
git add packages/llm-provider packages/runtime/src/build-validation.ts packages/judge-server/tests/live-layer.test.ts packages/benchmarks/mastra-vs-ra wiki/Architecture/DEBT-REGISTER.md .changeset
git diff --cached --stat
git commit -m "fix(llm-provider): read env at layer build and refuse keyless compat clients"
```

---

## Task 2: Stop advertising `write_result_to_file` when it is not registered

**Why (verified 2026-09-14):** `ResultStore.summarize()` and `.preview()` (`result-store.ts:59-60, 104`) tell the model, on every overflowing tool result, to "act on it by reference (e.g. `write_result_to_file(result_ref=…, path)`)". That tool is registered **only** when `RA_OVERHAUL=1` (`runtime-construction.ts:378` → `tool-capabilities.ts:146`), which is default-OFF. So the default harness instructs models to call a tool that does not exist. This is a model-facing miswire on the exact path (large results) where local models are weakest.

**Files:**
- Modify: `packages/reasoning/src/assembly/result-store.ts:48-110`
- Modify: `packages/reasoning/src/assembly/stages/project-results.ts:169`
- Modify: `packages/reasoning/src/assembly/evidence-entry.ts:88-97`
- Test: `packages/reasoning/tests/assembly/result-ref-hint-gating.test.ts` (new)

**Interfaces:**
- Produces: `ResultStore.preview(ref: string, budgetChars: number, opts?: { readonly writeByRef?: boolean }): string` and `ResultStore.summarize(ref: string, opts?: { readonly writeByRef?: boolean }): string`. `writeByRef` defaults to `false`. New pure helper `export function offersWriteByRef(schemas: readonly unknown[]): boolean` in `result-store.ts`.

- [ ] **Step 1: Find every caller so none is missed**

Run: `grep -rn "\.preview(\|\.summarize(\|evidenceFromStored(" packages/reasoning/src --include=*.ts | grep -v "\.test\."`
Expected (2026-09-14): `project-results.ts:169`, `evidence-entry.ts:95`, and `evidenceFromStored` callers. Record the list in the task report.

- [ ] **Step 2: Write the failing test**

```ts
// Run: bun test packages/reasoning/tests/assembly/result-ref-hint-gating.test.ts --timeout 15000
//
// The overflow preview must only teach `write_result_to_file` when that tool is
// actually offered to the model. Default harness does not register it
// (RA_OVERHAUL off), so advertising it sends the model to a nonexistent tool.
import { describe, it, expect } from "bun:test";
import { projectResultsStage } from "../../src/assembly/stages/project-results.js";
import { EventLog } from "../../src/assembly/event-log.js";
import { ResultStore, offersWriteByRef } from "../../src/assembly/result-store.js";
import { resolveCapability } from "../../src/assembly/capability.js";
import { emptyTrace } from "../../src/assembly/trace.js";

function overflowCtx(schemas: readonly unknown[]) {
  const prev = process.env.RA_TOOL_RESULT_BUDGET_CHARS;
  process.env.RA_TOOL_RESULT_BUDGET_CHARS = "400";
  const cap = resolveCapability({ window: 1000, outputBudget: 100, dialect: "native-fc", tier: "local" });
  if (prev === undefined) delete process.env.RA_TOOL_RESULT_BUDGET_CHARS;
  else process.env.RA_TOOL_RESULT_BUDGET_CHARS = prev;
  const store = new ResultStore();
  const big = Array.from({ length: 50 }, (_, i) => ({ sha: `s${i}`, commit: { message: `message ${i} ${"x".repeat(50)}` } }));
  const ref = store.put("github/list_commits", big);
  const log = new EventLog()
    .append({ kind: "tool_called", tool: "github/list_commits", callId: "c1", args: {} })
    .append({ kind: "tool_result", callId: "c1", ref, shape: "Array" });
  const input = { log, capability: cap, store, persona: { system: "" }, tools: { schemas } };
  return projectResultsStage({ ...input, systemPrompt: "", messages: [], toolSchemas: schemas, trace: emptyTrace(cap) });
}

describe("result-ref action hint is gated on tool availability", () => {
  it("does NOT mention write_result_to_file when the tool is not offered", () => {
    const ctx = overflowCtx([{ name: "github/list_commits" }]);
    const tr = ctx.messages.find((m) => m.role === "tool_result")!;
    expect(tr.content).toContain("result_ref=");
    expect(tr.content).not.toContain("write_result_to_file");
  });

  it("DOES mention write_result_to_file when the tool is offered", () => {
    const ctx = overflowCtx([{ name: "github/list_commits" }, { name: "write_result_to_file" }]);
    const tr = ctx.messages.find((m) => m.role === "tool_result")!;
    expect(tr.content).toContain("write_result_to_file");
  });

  it("offersWriteByRef recognizes flat and function-wrapped schema shapes", () => {
    expect(offersWriteByRef([{ name: "write_result_to_file" }])).toBe(true);
    expect(offersWriteByRef([{ type: "function", function: { name: "write_result_to_file" } }])).toBe(true);
    expect(offersWriteByRef([{ name: "file-write" }])).toBe(false);
    expect(offersWriteByRef([])).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/reasoning/tests/assembly/result-ref-hint-gating.test.ts --timeout 15000`
Expected: test 1 FAILS (content contains `write_result_to_file`); test 3 fails to import `offersWriteByRef`.

- [ ] **Step 4: Implement the gate in `result-store.ts`**

Add near the top-level helpers:

```ts
const WRITE_BY_REF_TOOL = "write_result_to_file";

/** True when the model's offered tool schemas include the by-reference writer. */
export function offersWriteByRef(schemas: readonly unknown[]): boolean {
  return schemas.some((s) => {
    if (typeof s !== "object" || s === null) return false;
    const flat = (s as { name?: unknown }).name;
    const fn = (s as { function?: { name?: unknown } }).function?.name;
    return flat === WRITE_BY_REF_TOOL || fn === WRITE_BY_REF_TOOL;
  });
}
```

Change `summarize` and `preview` signatures and gate the clause:

```ts
  summarize(ref: string, opts?: { readonly writeByRef?: boolean }): string {
    const s = this.map.get(ref);
    if (!s) return `[unknown result_ref="${ref}"]`;
    const readHint = s.recallable ? ` Re-read the full data with ${renderRecallHint(ref, "full")}.` : "";
    const actHint = opts?.writeByRef
      ? ` act on it by reference (e.g. ${WRITE_BY_REF_TOOL}(result_ref="${ref}", path)).`
      : "";
    return (
      `${s.tool} result stored as result_ref="${ref}" (${describeShape(s.value)}). ` +
      `Full data held system-side;${actHint} Do not retype it.${readHint}`
    );
  }
```

In `preview(ref, budgetChars, opts?)`, build the footer the same way:

```ts
    const actHint = opts?.writeByRef
      ? `act on the complete data by reference (e.g. ${WRITE_BY_REF_TOOL}(result_ref="${ref}", path)). `
      : "";
    const footer =
      `\n\n[content truncated — ${fullText.length} chars total; full data held ` +
      `system-side as result_ref="${ref}". Summarize from the sections shown above; ` +
      actHint +
      `Do not retype it.${readHint}]`;
```

Also fix the stale comment at `result-store.ts:94` ("recoverable via `write_result_to_file(result_ref)` / recall") → "recoverable via recall, or `write_result_to_file` when offered".

- [ ] **Step 5: Thread availability through the callers**

`project-results.ts:169`:

```ts
        content = c.store.preview(e.ref, budget, { writeByRef: offersWriteByRef(c.tools.schemas) });
```

(Import `offersWriteByRef` from `../result-store.js`. Compute it once above the loop, not per result.)

`evidence-entry.ts` — add an optional param and pass it through:

```ts
export function evidenceFromStored(
  store: ResultStore,
  ref: string,
  previewBudget: number,
  opts?: { readonly writeByRef?: boolean },
): EvidenceEntry {
  return {
    full: store.materialize(ref, "bullets"),
    preview: store.preview(ref, previewBudget, opts),
    ...(isRecallableRef(ref) ? { storedKey: ref } : {}),
  };
}
```

For each `evidenceFromStored` caller found in Step 1: if that site has the tool schemas in scope, pass `{ writeByRef: offersWriteByRef(schemas) }`; otherwise omit (defaults to no hint — the safe direction).

- [ ] **Step 6: Run tests; expect some golden/snapshot drift**

Run: `bun test packages/reasoning/tests/assembly --timeout 15000`
Expected: the new test passes. Any existing test that asserted the old string (`golden-trace.test.ts`, `pipeline.test.ts`, `project-results.test.ts`) passes `{ name: "write_result_to_file" }` in its schemas **or** asserted the hint — inspect each failure: if the fixture offers the tool, it should still pass; if it doesn't, update the expectation (the old expectation encoded the bug). Do NOT blanket-update snapshots.

Then: `bun test packages/reasoning --timeout 30000` and `bun run packages/benchmarks/src/replay-lane-cli.ts` (golden replay lane). Record any golden divergence in the task report — a prompt-text change is expected to diverge on overflow shapes only.

- [ ] **Step 7: Mutation check**

Hardcode `writeByRef: true` in `project-results.ts` → test 1 must go RED. Restore.

- [ ] **Step 8: Measure the behavior change (rung 2, before/after)**

This is a bug fix (not lift-gated), but record its effect so Task 6's `RA_OVERHAUL` verdict has a baseline. Pick 2–3 tasks with large tool results from `packages/benchmarks/src/task-registry.ts` (grep for tasks using `web-search`/`http-get`/file listings; e.g. the `rw-*` research tasks). For each of `before` (checkout `HEAD~1` in a worktree) and `after`:

```bash
timeout 580 bun run packages/benchmarks/src/run.ts --session real-world-full \
  --provider anthropic --model claude-haiku-4-5-20251001 \
  --task <rw-a>,<rw-b> --variant ra-full --runs 3 \
  --output wiki/Research/Harness-Reports/2026-09-XX-result-ref-hint-<before|after>.json
```

From each run's traces count attempted calls to the unregistered tool:

```bash
grep -h '"tool-call-start"' .reactive-agents/traces/<runIds>.jsonl | grep -c write_result_to_file
```

Expected after: 0. Report before/after counts, iterations, billed tokens, accuracy. Accuracy differences at n=3 are noise; the count is the signal.

- [ ] **Step 9: Commit**

```bash
git add packages/reasoning wiki/Research/Harness-Reports/2026-09-XX-result-ref-hint-*.json
git diff --cached --stat
git commit -m "fix(reasoning): only advertise write_result_to_file when the tool is offered"
```

---

## Task 3: `run-completed` trace carries real cost and termination reason

**Why (verified):** `AgentCompleted` already carries `terminationReason` (`event-bus.ts` + `run-finalize.ts:81`), but the trace bridge drops it (`normalize.ts:64-90` never maps it), and `normalize.ts:87` hardcodes `totalCostUsd: 0` even though `result.metadata.cost` is available at finalize (`run-finalize.ts:114`). Every trace-based cost figure (`rax-diagnose`, `traceStats`, replay diffs) silently reads zero, and a consumer reading the completion event cannot tell an abstention from a success (DEBT-REGISTER "RunCompletedEvent carries no terminatedBy" row).

**Files:**
- Modify: `packages/core/src/services/event-bus.ts` (AgentCompleted member, ~line 421-460)
- Modify: `packages/runtime/src/engine/finalize/run-finalize.ts:65-86`
- Modify: `packages/trace/src/events.ts:97-108`
- Modify: `packages/trace/src/normalize.ts:64-90`
- Test: `packages/trace/tests/run-completed-truth.test.ts` (new)

**Interfaces:**
- Produces: `AgentCompleted.totalCostUsd?: number`; `RunCompletedEvent.terminatedBy?: string` (raw reason, same semantics as `AgentCompleted.terminationReason`).

- [ ] **Step 1: Write the failing test**

```ts
// Run: bun test packages/trace/tests/run-completed-truth.test.ts --timeout 15000
import { describe, it, expect } from "bun:test";
import { toTraceEvent } from "../src/normalize.js";
import type { AgentEvent } from "@reactive-agents/core";

const completed = (extra: Record<string, unknown>): AgentEvent =>
  ({
    _tag: "AgentCompleted",
    taskId: "run-1",
    agentId: "a",
    success: false,
    totalIterations: 3,
    totalTokens: 1200,
    durationMs: 900,
    ...extra,
  }) as AgentEvent;

describe("run-completed carries what the publisher knows", () => {
  it("maps terminationReason to terminatedBy", () => {
    const ev = toTraceEvent(completed({ terminationReason: "abstained" }), 0);
    expect(ev?.kind).toBe("run-completed");
    expect((ev as { terminatedBy?: string }).terminatedBy).toBe("abstained");
  });

  it("maps totalCostUsd instead of hardcoding 0", () => {
    const ev = toTraceEvent(completed({ totalCostUsd: 0.0123 }), 0);
    expect((ev as { totalCostUsd: number }).totalCostUsd).toBeCloseTo(0.0123, 6);
  });

  it("absent fields stay absent / zero (older publishers)", () => {
    const ev = toTraceEvent(completed({}), 0) as { terminatedBy?: string; totalCostUsd: number };
    expect(ev.terminatedBy).toBeUndefined();
    expect(ev.totalCostUsd).toBe(0);
  });
});
```

If `AgentEvent` is not the exported name, use the type `toTraceEvent`'s first parameter is declared with (`normalize.ts:37`).

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/trace/tests/run-completed-truth.test.ts --timeout 15000`
Expected: tests 1 and 2 FAIL (`undefined`, `0`). Test 3 passes.

- [ ] **Step 3: Implement**

`event-bus.ts` (AgentCompleted member, after `terminationReason`):

```ts
      /** Run cost in USD (result.metadata.cost) — optional so older publishers stay valid. */
      readonly totalCostUsd?: number;
```

`run-finalize.ts` (inside the `eb.publish({ _tag: "AgentCompleted", ... })` literal):

```ts
        ...(typeof result.metadata?.cost === "number" ? { totalCostUsd: result.metadata.cost } : {}),
```

`events.ts` (`RunCompletedEvent`):

```ts
  /** Raw termination reason (AgentCompleted.terminationReason) — e.g. "abstained", "max-iterations:5". */
  readonly terminatedBy?: string
```

`normalize.ts` (`case "AgentCompleted"`):

```ts
        ...(raw.terminationReason !== undefined ? { terminatedBy: raw.terminationReason } : {}),
        totalTokens: raw.totalTokens,
        totalCostUsd: raw.totalCostUsd ?? 0,
```

- [ ] **Step 4: Run tests + dependents**

Run: `bun test packages/trace packages/diagnose --timeout 30000 && bun test packages/runtime/tests --timeout 30000 -t "trace|finalize|completed"`
Expected: PASS.

- [ ] **Step 5: Mutation check**

Delete the `totalCostUsd` spread in `run-finalize.ts` → an end-to-end check must catch it. Add to `packages/runtime/tests/` a small test (in an existing trace-recording test file if one exists — `grep -rln "run-completed" packages/runtime/tests`) that runs a `.withTestScenario` agent with `.withTracing()` and a pricing registry that yields non-zero cost, and asserts the recorded `run-completed.totalCostUsd > 0`. If the test provider always reports cost 0 (DEBT-REGISTER B3 notes `withCostTracking reports cost 0`), assert `terminatedBy` end-to-end instead and document that cost is proven at unit level only.

- [ ] **Step 6: Live verification (rung 2)**

```bash
timeout 300 bun run .agents/skills/harness-improvement-loop/scripts/harness-probe.ts
```

(or any single haiku run with tracing on). Then `jq 'select(.kind=="run-completed")' .reactive-agents/traces/<runId>.jsonl` → expect `totalCostUsd > 0` for a billed provider and `terminatedBy` present.

- [ ] **Step 7: Commit + register**

Mark the DEBT-REGISTER "RunCompletedEvent carries no terminatedBy/abstention" row RESOLVED. Changeset: `@reactive-agents/trace`, `@reactive-agents/core`, `@reactive-agents/runtime` patch.

```bash
git add packages/core packages/runtime packages/trace wiki/Architecture/DEBT-REGISTER.md .changeset
git diff --cached --stat
git commit -m "fix(trace): carry real cost and termination reason onto run-completed"
```

---

## Task 4: `runStream()` / `collect()` report the same outcome as `run()`

**Why (verified):** `AgentStream.collect()` builds its result with a hardcoded `success: true` (`agent-stream.ts:219, 258`) and never sets `terminatedBy` or `goalAchieved` — `StreamCompleted` doesn't carry them (`stream-types.ts:23-60`; the parity test's own header admits the gap). `run()` additionally derives `metadata.toolCalls` from reasoning steps (`reactive-agent.ts:1554-1569`), which the stream path never does. So an abstained or failed streamed run collects as a success with no tool calls. This is 09 Step 2 ("one terminal outcome") residue.

**Files:**
- Modify: `packages/runtime/src/engine/finalize/derive-outcome.ts` (add `deriveMetadataToolCalls`)
- Modify: `packages/runtime/src/reactive-agent.ts:1542-1573`
- Modify: `packages/runtime/src/stream-types.ts:23-60`
- Modify: `packages/runtime/src/engine/execute-stream.ts:557-567`
- Modify: `packages/runtime/src/agent-stream.ts:209-270`
- Test: `packages/runtime/tests/run-stream-parity.test.ts`

**Interfaces:**
- Produces: `export function deriveMetadataToolCalls(steps: ReadonlyArray<{ readonly type: string; readonly metadata?: Record<string, unknown> }> | undefined): Array<{ name: string; arguments?: unknown; id?: string }>` in `derive-outcome.ts`. `StreamCompleted` gains `success?: boolean`, `terminatedBy?: TerminatedBy`, `goalAchieved?: boolean | null` (all optional, backward-compatible).

- [ ] **Step 1: Write the failing parity tests**

Append to `packages/runtime/tests/run-stream-parity.test.ts`:

```ts
import { Effect } from "effect";
import { AgentStream } from "../src/index.js"; // exported at runtime/src/index.ts:118

async function runBoth(build: () => ReturnType<typeof ReactiveAgents.create>, prompt: string) {
  const a = await build().build();
  const b = await build().build();
  try {
    const run = await a.run(prompt);
    const collected = await AgentStream.collect(b.runStream(prompt));
    return { run, collected };
  } finally {
    await a.dispose();
    await b.dispose();
  }
}

const loopTool = {
  tools: [
    {
      definition: {
        name: "parity_tool",
        description: "returns a fixed value",
        parameters: [],
        riskLevel: "low" as const,
        timeoutMs: 5000,
        requiresApproval: false,
        category: "custom" as const,
        source: "function" as const,
      },
      handler: () => Effect.succeed("42"),
    },
  ],
};

describe("run() vs collect(runStream()) — full outcome parity", () => {
  it("plain answer", async () => {
    const { run, collected } = await runBoth(
      () => ReactiveAgents.create().withProvider("test").withTestScenario([{ text: "FINAL ANSWER: 4" }]),
      "What is 2 + 2?",
    );
    expect(collected.success).toBe(run.success);
    expect(collected.terminatedBy).toBe(run.terminatedBy);
    expect(collected.goalAchieved).toBe(run.goalAchieved);
  }, 30000);

  it("tool loop: metadata.toolCalls matches", async () => {
    const { run, collected } = await runBoth(
      () =>
        ReactiveAgents.create()
          .withProvider("test")
          .withTools(loopTool)
          .withTestScenario([
            { toolCalls: [{ name: "parity_tool", args: {} }] },
            { text: "FINAL ANSWER: 42" },
          ]),
      "Use parity_tool then answer.",
    );
    expect(run.metadata.toolCalls?.map((t) => t.name)).toEqual(["parity_tool"]);
    expect(collected.metadata.toolCalls?.map((t) => t.name)).toEqual(run.metadata.toolCalls?.map((t) => t.name));
  }, 30000);

  it("failed/abstained run is not collected as success", async () => {
    // Use the abstention scenario already pinned elsewhere:
    //   grep -rln "abstained" packages/runtime/tests | head
    // and copy its builder chain here verbatim. The assertion is the point:
    const { run, collected } = await runBoth(
      () => ReactiveAgents.create().withProvider("test").withMaxIterations(1)
        .withTools(loopTool)
        .withTestScenario([{ toolCalls: [{ name: "parity_tool", args: {} }] }]),
      "loop",
    );
    expect(run.success).toBe(false);
    expect(collected.success).toBe(run.success);
    expect(collected.terminatedBy).toBe(run.terminatedBy);
  }, 30000);
});
```

Before running, confirm `AgentStream.collect` is a static/object method (`agent-stream.ts:209`; if it is an instance method, construct per its JSDoc) and merge the `Effect` import with any existing one; confirm the third scenario actually produces `run.success === false` with the current code (if max_iterations yields `success: true`, swap in the pinned abstention scenario from `abstained-outcome-classification.test.ts` — the test must exercise a non-success outcome).

- [ ] **Step 2: Run to verify failures**

Run: `bun test packages/runtime/tests/run-stream-parity.test.ts --timeout 30000`
Expected: `terminatedBy`/`goalAchieved` assertions FAIL (collected `undefined`); tool-loop `toolCalls` FAILS (collected `undefined`); failure case FAILS (`collected.success === true`).

- [ ] **Step 3: Extract the single tool-call projection**

In `derive-outcome.ts`, add (moved verbatim from `reactive-agent.ts:1554-1569`):

```ts
/** `AgentResultMetadata.toolCalls` — single owner for run() and runStream(). */
export function deriveMetadataToolCalls(
  steps: ReadonlyArray<{ readonly type: string; readonly metadata?: Record<string, unknown> }> | undefined,
): Array<{ name: string; arguments?: unknown; id?: string }> {
  return (steps ?? [])
    .filter((s) => s.type === "action")
    .map((s) => {
      const tc = s.metadata?.toolCall as { name?: string; arguments?: unknown; id?: string } | undefined;
      return tc?.name
        ? {
            name: tc.name,
            ...(tc.arguments !== undefined ? { arguments: tc.arguments } : {}),
            ...(tc.id !== undefined ? { id: tc.id } : {}),
          }
        : null;
    })
    .filter((x): x is { name: string; arguments?: unknown; id?: string } => x !== null);
}
```

In `reactive-agent.ts`, replace the inline `derivedToolCalls` computation with `const derivedToolCalls = deriveMetadataToolCalls(reasoningSteps)` (import from `./engine/finalize/derive-outcome.js`).

- [ ] **Step 4: Carry the outcome on StreamCompleted**

`stream-types.ts`, in the `StreamCompleted` member:

```ts
      /** Same as AgentResult.success. Optional for backward compatibility. */
      readonly success?: boolean;
      /** Same as AgentResult.terminatedBy. */
      readonly terminatedBy?: TerminatedBy;
      /** Same as AgentResult.goalAchieved. */
      readonly goalAchieved?: boolean | null;
```

`execute-stream.ts`, in `completedEvent`:
- `metadata`: spread the derived tool calls onto the existing metadata:

```ts
            metadata: (() => {
              const base = ((taskResult as { metadata?: AgentResultMetadata }).metadata) ?? {
                duration: Date.now() - startMs, cost: 0, tokensUsed: 0, stepsCount: 0,
              };
              const toolCalls = deriveMetadataToolCalls(
                (base as { reasoningSteps?: ReadonlyArray<{ type: string; metadata?: Record<string, unknown> }> }).reasoningSteps,
              );
              return toolCalls.length > 0 ? { ...base, toolCalls } : base;
            })(),
            success: Boolean((taskResult as { success?: unknown }).success),
            ...((taskResult as { terminatedBy?: TerminatedBy }).terminatedBy !== undefined
              ? { terminatedBy: (taskResult as { terminatedBy?: TerminatedBy }).terminatedBy }
              : {}),
```

- `goalAchieved`: the stream site already calls `deriveTaskOutcome(...)` for the receipt (`execute-stream.ts:632`). Hoist that call so both the receipt and `goalAchieved` read one result (`const outcome = isPausedRun ? undefined : deriveTaskOutcome(...)`; `receipt = outcome?.receipt`; `goalAchieved: outcome?.goalAchieved ?? null`). The receipt is spread onto the event after signing — add `goalAchieved` in that same spread.

Check how `run()` sets `AgentResult.goalAchieved` and `success` (`grep -n "goalAchieved\|success:" packages/runtime/src/reactive-agent.ts | sed -n 1,20p`) and mirror its exact source (e.g. if `run()` uses `r.success`, use `taskResult.success`).

- [ ] **Step 5: Read them in `collect()`**

`agent-stream.ts`, both branches:

```ts
          result = {
            output: event.output,
            success: event.success ?? true,
            taskId: event.taskId ?? "",
            agentId: event.agentId ?? "",
            metadata: event.metadata,
            ...(event.terminatedBy !== undefined ? { terminatedBy: event.terminatedBy } : {}),
            ...(event.goalAchieved !== undefined ? { goalAchieved: event.goalAchieved } : {}),
            ...(event.receipt !== undefined ? { receipt: event.receipt } : {}),
          };
```

(`?? true` only preserves behavior for events from older producers; every current producer sets it.)

- [ ] **Step 6: Run tests**

Run: `bun test packages/runtime/tests/run-stream-parity.test.ts packages/runtime/tests/run-stream.test.ts packages/runtime/tests/execute-stream.test.ts packages/runtime/tests/ledger-stream-parity.test.ts --timeout 30000`
Expected: PASS. Then UI consumers: `bun test packages/ui-core packages/react packages/svelte packages/vue --timeout 30000` (they consume `StreamCompleted`).

- [ ] **Step 7: Mutation checks**

(a) Revert `collect()` to `success: true` → failure case RED. (b) Drop the `toolCalls` spread in `execute-stream.ts` → tool-loop case RED. Restore both.

- [ ] **Step 8: Update the parity test header + commit**

Delete the header paragraph saying `StreamCompletedEvent` "does not currently expose top-level `terminatedBy`/`goalAchieved`". Changeset: `@reactive-agents/runtime` patch.

```bash
git add packages/runtime .changeset
git diff --cached --stat
git commit -m "fix(runtime): runStream collect reports the same outcome and tool calls as run"
```

---

## Task 5: Strategy-switch handoff becomes a ledger fact (wire the dead renderer)

**Why (verified):** `HandoffEntry` is declared (`run-ledger.ts:153-158`), rendered by the standing frame (`standing-frame.ts:124, 180-190`), protected by compaction (`compaction.ts:60`), and relayed by adaptive (`adaptive.ts:481`) — but **nothing writes one** (the sole `ORPHAN_BASELINE` entry in `check-orphans.sh`). Instead `applyStrategySwitch` (`strategy-switch.ts:132-143, 235-242`) string-concatenates the handoff into `priorContext`. Two carriers for one concept; the typed one is dead. Wiring it makes the handoff trace-visible (`ledger-entry` events), addressable (`ledger://handoff/<seq>`), and compaction-protected.

**Second question this task must answer first:** `applyStrategySwitch` builds the new state with `initialKernelState(currentOptions)`, whose `ledger` is `[]` (`kernel-state.ts:1205`). Carried observation steps are re-added, but the **prior ledger** (tool invocations, artifacts, requirement facts) may be dropped on switch — which would make `assess()` re-list satisfied requirements as outstanding after every switch. Step 1 pins which is true.

**Files:**
- Modify: `packages/reasoning/src/kernel/ledger/emit.ts` (add `recordHandoff`)
- Modify: `packages/reasoning/src/kernel/loop/runner-helpers/strategy-switch.ts:104-259`
- Modify: `scripts/check-orphans.sh:43-45`
- Test: `packages/reasoning/tests/strategy-switch-handoff-ledger.test.ts` (new)

**Interfaces:**
- Consumes: `appendEntry(ledger, entry)` (`run-ledger.ts:220`), `HandoffEntry` (`run-ledger.ts:153`).
- Produces: `export function recordHandoff(ledger: RunLedger | undefined, handoff: { readonly from: string; readonly to: string; readonly summary: string }, iteration: number): RunLedger` in `emit.ts`.

- [ ] **Step 1: Pin current ledger behavior across a switch (characterization test)**

```ts
// Run: bun test packages/reasoning/tests/strategy-switch-handoff-ledger.test.ts --timeout 15000
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { applyStrategySwitch } from "../src/kernel/loop/runner-helpers/strategy-switch.js";
import {
  initialKernelState,
  transitionState,
  type KernelContext,
  type KernelHooks,
  type KernelInput,
  type KernelRunOptions,
} from "../src/kernel/state/kernel-state.js";
import { appendEntry } from "../src/kernel/ledger/run-ledger.js";
import { renderStandingFrame } from "../src/assembly/standing-frame.js";

const hooks = { onStrategySwitched: () => Effect.void } as unknown as KernelHooks;
const options = { strategy: "reactive" } as unknown as KernelRunOptions;
const input = { task: "t", requiredTools: [] } as unknown as KernelInput;
const context = { input } as unknown as KernelContext;

const priorWithLedger = () => {
  const s = initialKernelState(options);
  const ledger = appendEntry(s.ledger, {
    kind: "harness-signal",
    iteration: 1,
    signal: "prior-fact",
  });
  return transitionState(transitionState(s, { ledger }), { iteration: 3 });
};

const doSwitch = () =>
  Effect.runPromise(
    applyStrategySwitch({
      state: priorWithLedger(),
      currentInput: input,
      context,
      options,
      hooks,
      triedStrategies: ["reactive"],
      switchCount: 0,
      fromStrategy: "reactive",
      toStrategy: "plan-execute-reflect",
      failureReason: "loop detected",
    }),
  );

describe("strategy switch — ledger", () => {
  test("prior ledger facts survive the switch", async () => {
    const r = await doSwitch();
    expect((r.state.ledger ?? []).some((e) => e.kind === "harness-signal" && e.signal === "prior-fact")).toBe(true);
  });

  test("the switch mints exactly one handoff entry", async () => {
    const r = await doSwitch();
    const handoffs = (r.state.ledger ?? []).filter((e) => e.kind === "handoff");
    expect(handoffs).toHaveLength(1);
    const h = handoffs[0]!;
    if (h.kind !== "handoff") throw new Error("narrow");
    expect(h.from).toBe("reactive");
    expect(h.to).toBe("plan-execute-reflect");
    expect(h.summary).toContain("loop detected");
  });

  test("handoff is no longer string-folded into priorContext", async () => {
    const r = await doSwitch();
    expect(r.currentInput.priorContext ?? "").not.toContain("Strategy Switch Handoff");
  });

  test("the standing frame renders the handoff from the ledger", async () => {
    const r = await doSwitch();
    const frame = renderStandingFrame({ ledger: r.state.ledger } as Parameters<typeof renderStandingFrame>[0]);
    expect(frame.sections.map((s) => s.name)).toContain("handoff");
  });
});
```

Adjust `transitionState` usage if `ledger` must be patched with `iteration` in one call, and check `renderStandingFrame`'s input/return field names (`standing-frame.ts:153-200`) before running.

- [ ] **Step 2: Run and record which tests fail**

Run: `bun test packages/reasoning/tests/strategy-switch-handoff-ledger.test.ts --timeout 15000`
Expected: tests 2, 3, 4 FAIL. **Test 1 is the characterization:** if it FAILS, the prior ledger is dropped on switch — a real defect fixed in Step 4. If it PASSES, some other mechanism carries it (note which in the task report) and Step 4's carry line is unnecessary.

- [ ] **Step 3: Add the emitter**

In `emit.ts`:

```ts
/**
 * Record a strategy switch's carried context as a typed ledger fact. The
 * standing frame renders it (standing-frame.ts) and compaction protects it
 * (compaction.ts) — replaces string-folding the handoff into priorContext.
 */
export function recordHandoff(
  ledger: RunLedger | undefined,
  handoff: { readonly from: string; readonly to: string; readonly summary: string },
  iteration: number,
): RunLedger {
  return appendEntry(ledger, {
    kind: "handoff",
    iteration,
    from: handoff.from,
    to: handoff.to,
    summary: handoff.summary,
  });
}
```

- [ ] **Step 4: Use it in `applyStrategySwitch`**

After `state = transitionState(state, { iteration: priorState.iteration });`:

```ts
    // Carry the run's ledger across the switch (only if Step 1 test 1 failed),
    // then record the handoff as a typed fact instead of priorContext text.
    state = transitionState(state, {
      ledger: recordHandoff(
        priorState.ledger,
        { from: fromStrategy, to: toStrategy, summary: handoffSummary },
        priorState.iteration,
      ),
    });
```

(If Step 1 test 1 passed, use `state.ledger` instead of `priorState.ledger` as the base.)

Replace the `existingPrior` block so `priorContext` is left untouched:

```ts
    const failedSet = new Set(handoff.permanentlyFailedTools);
    const currentInput: KernelInput = {
      ...priorInput,
      requiredTools: failedSet.size > 0
        ? (priorInput.requiredTools ?? []).filter((t) => !failedSet.has(t))
        : priorInput.requiredTools,
    };
```

Verify the ledger-growth chokepoint doesn't double-project carried observation steps into duplicate `tool-result` entries: after the change, count entries by kind in test 1's result and assert no `tool-result` appears twice for the same call id. If duplicates appear, filter carried steps already represented in `priorState.ledger`, and add that assertion to the test.

- [ ] **Step 5: Shrink the orphan baseline**

`scripts/check-orphans.sh:43-45` → `ORPHAN_BASELINE=()`. Update the comment block above it. Run: `bash scripts/check-orphans.sh` → expected exit 0 (it fails if a baselined kind gains a writer, which this proves).

- [ ] **Step 6: Run suites**

```bash
bun test packages/reasoning/tests/strategy-switch-handoff-ledger.test.ts packages/reasoning/tests/strategy-switch-carryover.test.ts packages/reasoning/tests/strategies/strategy-switching-e2e.test.ts --timeout 30000
bun test packages/reasoning --timeout 60000
bash scripts/check-ledger-writes.sh && bash scripts/check-orphans.sh && bash scripts/check-projection.sh
```

Expected: PASS. Existing tests asserting `priorContext` contains `Strategy Switch Handoff` encode the old carrier — update them to read the ledger.

- [ ] **Step 7: Mutation check**

Comment out the `recordHandoff` call → tests 2 and 4 RED, and `check-orphans.sh` RED. Restore.

- [ ] **Step 8: Prompt-drift check (this changes model-visible text)**

The handoff text moves from "Prior context (from earlier work on this task):\n…Strategy Switch Handoff…" to "Prior strategy handoff (reactive → plan-execute-reflect):\n…". Treat as a behavior change:
1. Rung 1: `bun run packages/benchmarks/src/replay-lane-cli.ts` — record divergences (expected only on switch-carrying goldens).
2. Rung 2/3: one small cell on a task known to trigger a switch (the run `01M2GM1SZ0FVXDD3TNN0F9FZ5A` from the entropy audit switched; find its task in `wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md`) — haiku + one local tier, n=3 each, before vs after. Acceptance: no accuracy regression beyond noise and billed tokens within ±15%. If it regresses, keep the ledger entry (observability win) but restore identical wording by making the standing-frame handoff section use the old text — do not keep two carriers.

- [ ] **Step 9: Commit**

Update DEBT-REGISTER (orphan-baseline gate row: `handoff` baseline removed) and the `HandoffEntry` JSDoc ("Typed NOW; RENDERED by the Projector in Wave D" → "Minted by applyStrategySwitch via recordHandoff").

```bash
git add packages/reasoning scripts/check-orphans.sh wiki/Architecture/DEBT-REGISTER.md wiki/Research/Harness-Reports
git diff --cached --stat
git commit -m "feat(reasoning): mint strategy-switch handoff as a ledger fact"
```

---

## Task 6: Settle the unmeasured experimental flags (lift verdicts)

**Why:** Five mechanisms ship behind default-OFF flags with no lift verdict. Each is maintained code, a config surface, and a source of confusion. 09 §2: default-on only on evidence; otherwise opt-in with a verdict, or removed.

| Flag | Mechanism | Known state (2026-09-14) |
|---|---|---|
| `RA_OVERHAUL` | registers `write_result_to_file` | "INERT on current golden corpus" (rung-1 sweep 2026-07-28). Task 2 removed its accidental prompt dependency. |
| `RA_TOOL_INDEX` | tool index disclosure | default OFF "pending ablation-warden cross-tier measurement" |
| `RA_THOUGHT_CONTINUITY` | replays model's own thoughts | **Void on local tier by construction** (Ollama discards `thinking`; confirmed byte-identical prompts 2026-07-27). Only frontier tiers can measure it. |
| `RA_TOOL_OBSERVE_SYMMETRY` | multi-tool observation shape | "gated so it can be benched live before any default-on decision" |
| `RA_RATIONALE_AUDIT` | rationale block for audit | "decode-tax-only (audit, not quality)" — not a quality mechanism; lift rule doesn't apply the same way |

**Files:**
- Create: `wiki/Decisions/2026-09-XX-experimental-flag-verdicts.md`
- Modify (per verdict): `packages/reasoning/src/harness-flags.ts`, `harness-config.ts`, `index.ts`, `packages/runtime/src/builder/build-effect/runtime-construction.ts`, `packages/benchmarks/src/replay-ablate-sweep.ts`, plus mechanism files
- Test: existing `packages/runtime/tests/mechanism-liveness.test.ts`, `scripts/check-harness-config.sh`, `scripts/check-ablatable.sh`

- [ ] **Step 1: Dispatch `ablation-warden` with a MissionBrief (use `mission-brief` skill)**

End-state: one verdict per flag (PROMOTE / KEEP-OPT-IN / DELETE) with receipts. Authority: read + run benches only; no framework edits. Success criteria: every verdict cites rung-1 result plus rung 2 and rung 3 (except `RA_THOUGHT_CONTINUITY`: rung 2 + a second frontier model, since local is void by construction; and `RA_RATIONALE_AUDIT`: token/latency cost only).

- [ ] **Step 2: Rung 1 — zero-token replay sweep**

```bash
timeout 580 bun run packages/benchmarks/src/replay-ablate-sweep.ts | tee /tmp/claude-1000/flag-sweep-2026-09.txt
```

Before trusting any INERT: confirm each flag's toggle literal in the sweep's `BEHAVIOURAL` table matches the source comparison (`harness-flags.ts`: `RA_OVERHAUL === "1"`, `RA_TOOL_INDEX` default false, etc.) — the sweep header documents three past false-INERT faults. INERT on replay is **not** a delete authorization for prompt-affecting mechanisms (sweep header).

- [ ] **Step 3: Rungs 2 and 3 — live A/B cells per flag**

For each flag F (and each tier: `anthropic claude-haiku-4-5-20251001` for rung 2; `ollama` with a fast tool-caller that exists locally — check `ollama list`, e.g. `gemma4:12b` or `granite4:latest` — for rung 3):

```bash
# OFF arm
timeout 580 bun run packages/benchmarks/src/run.ts --session real-world-full \
  --provider <p> --model <m> --task <task-set> --variant ra-full --runs 5 \
  --output wiki/Research/Harness-Reports/2026-09-XX-flag-<F>-off-<m>.json
# ON arm
<F>=<on-literal> timeout 580 bun run packages/benchmarks/src/run.ts --session real-world-full \
  --provider <p> --model <m> --task <task-set> --variant ra-full --runs 5 \
  --output wiki/Research/Harness-Reports/2026-09-XX-flag-<F>-on-<m>.json
```

Task set per flag: pick tasks where the mechanism can act (tool-index: wide tool surface — see `wide-surface-ablation.ts`; overhaul: large-result file-write tasks; observe-symmetry: parallel tool calls). If a cell would exceed 590s, split tasks across invocations. Before reading tokens, print the tool surface (`vis`) per arm — the tool-surface confound voided 4 prior findings.

- [ ] **Step 4: Apply the lift rule and write the decision doc**

For each flag record: accuracy ON vs OFF per tier (with n and ±SE), billed-token delta, verdict. Rules:
- ≥3pp on both tiers, same sign, AND ≤15% billed tokens → PROMOTE (flip default in `harness-flags.ts`, keep env override, add red-on-cut liveness test).
- Otherwise, if the mechanism serves a non-accuracy purpose (rationale audit = auditability) → KEEP-OPT-IN, with the verdict linked from the flag's JSDoc.
- Otherwise → DELETE.
- Gap within noise (<26pp at this n) and no token win → DELETE is the default for pure-harness mechanisms (simplicity principle), unless the warden records a reason to extend measurement.

- [ ] **Step 5: Execute DELETE verdicts (one commit per flag)**

For a deleted flag, remove in this order, running `bun test packages/reasoning packages/runtime --timeout 60000` after each:
1. Its reader in `harness-flags.ts` + export in `reasoning/src/index.ts`.
2. Its field in `HarnessConfig` / `ResolvedHarness` (`harness-config.ts`).
3. The mechanism code (for `RA_OVERHAUL`: `writeResultToFile` in `kernel-meta-tools.ts:68-71`, the registration at `tool-capabilities.ts:146-150`, `runtime-construction.ts:375-378`, `kernel-constants.ts:26` name, the tool in `packages/tools/src/skills/write-result-to-file.ts` + `tools/src/index.ts:124` + `artifact-contract.ts:52`, its test, and Task 2's `offersWriteByRef` gate + hint text — at that point the hint is never shown, so delete it rather than keep dead branches).
4. Its row in `replay-ablate-sweep.ts` and any bench arm.
5. Docs: `grep -rn "<FLAG>" apps/docs wiki/Architecture README.md AGENTS.md`.

Sole-caller grep before every deletion: `grep -rn "<symbol>" packages apps scripts --include=*.ts --include=*.svelte | grep -v node_modules`. Public exports removed = changeset (minor bump if a public symbol goes).

- [ ] **Step 6: Gates + commit**

```bash
bash scripts/check-harness-config.sh && bash scripts/check-ablatable.sh
bunx turbo run build typecheck
git add -A wiki/Decisions wiki/Research/Harness-Reports packages scripts .changeset
git diff --cached --stat
git commit -m "chore(reasoning): apply lift verdicts to experimental harness flags"
```

---

## Task 7: Demand-driven `num_ctx` for Ollama (opt-in, measured)

**Why (D-2026-07-30-I, verified):** `ResolvedCapability.predictNumCtx()` + `BUCKETS = [8192…131072]` (`capability.ts:48, 70, 87-90`) have zero callers. The wire `num_ctx` is fixed per model (`local.ts:91-102`: `request.numCtx ?? config.explicitNumCtx ?? capability.recommendedNumCtx ?? config.defaultNumCtx`). Small prompts over-allocate KV cache; large tool results can't grow the window.

**Main risk:** Ollama reloads the model when `num_ctx` changes between requests, which can cost seconds per reload. So the policy must be **monotone non-decreasing within a run** (grow only), and it ships **opt-in** until measured.

**Files:**
- Modify: `packages/reasoning/src/harness-config.ts` (add `numCtxPolicy`)
- Modify: `packages/reasoning/src/assembly/capability.ts:87-90` (add `nextNumCtx`)
- Modify: `packages/reasoning/src/kernel/state/kernel-state.ts` (meta field `numCtxHighWater?: number`)
- Modify: `packages/reasoning/src/kernel/capabilities/reason/think.ts:1018-1032`
- Test: `packages/reasoning/tests/assembly/num-ctx-demand.test.ts` (new), extend `packages/llm-provider/tests/num-ctx-wiring.test.ts`

**Interfaces:**
- Produces: `HarnessConfig.numCtxPolicy?: "fixed" | "demand"` (default `"fixed"`); `export function nextNumCtx(assembledPromptTokens: number, outputBudget: number, highWater: number | undefined, ceiling: number | undefined): number` in `capability.ts`.
- Consumes: `request.numCtx` precedence in `local.ts:97` (request wins — so setting it from the kernel is sufficient; no provider change).

- [ ] **Step 1: Write the failing unit test for the pure policy**

```ts
// Run: bun test packages/reasoning/tests/assembly/num-ctx-demand.test.ts --timeout 15000
import { describe, it, expect } from "bun:test";
import { nextNumCtx } from "../../src/assembly/capability.js";

describe("nextNumCtx — monotone demand buckets", () => {
  it("picks the smallest bucket that fits prompt + output + headroom", () => {
    expect(nextNumCtx(3000, 2000, undefined, undefined)).toBe(8192);
    expect(nextNumCtx(7000, 2000, undefined, undefined)).toBe(16384);
  });
  it("never shrinks below the run's high-water mark (avoids Ollama reloads)", () => {
    expect(nextNumCtx(1000, 2000, 32768, undefined)).toBe(32768);
  });
  it("never exceeds the model ceiling", () => {
    expect(nextNumCtx(100_000, 2000, undefined, 32768)).toBe(32768);
  });
  it("caps at the largest bucket when nothing fits and no ceiling is known", () => {
    expect(nextNumCtx(500_000, 2000, undefined, undefined)).toBe(131072);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/reasoning/tests/assembly/num-ctx-demand.test.ts --timeout 15000`
Expected: FAIL — `nextNumCtx` is not exported.

- [ ] **Step 3: Implement the pure policy**

In `capability.ts`, add below `BUCKETS` and make `predictNumCtx` delegate to it:

```ts
/**
 * Demand-driven Ollama num_ctx. Monotone within a run: Ollama reloads the model
 * when num_ctx changes, so the window only ever GROWS (highWater), and never
 * past the model's ceiling. Opt-in via HarnessConfig.numCtxPolicy = "demand".
 */
export function nextNumCtx(
  assembledPromptTokens: number,
  outputBudget: number,
  highWater: number | undefined,
  ceiling: number | undefined,
): number {
  const need = assembledPromptTokens + outputBudget + 1024; // headroom
  const bucket = BUCKETS.find((b) => b >= need) ?? BUCKETS[BUCKETS.length - 1];
  const grown = Math.max(bucket, highWater ?? 0);
  return ceiling !== undefined ? Math.min(grown, ceiling) : grown;
}
```

```ts
    predictNumCtx(assembledPromptTokens: number): number {
      return nextNumCtx(assembledPromptTokens, input.outputBudget, undefined, undefined);
    },
```

Run Step 1's test → PASS.

- [ ] **Step 4: Add the config field**

`harness-config.ts`: add `readonly numCtxPolicy?: "fixed" | "demand"` to `HarnessConfig`, `readonly numCtxPolicy: "fixed" | "demand"` to `ResolvedHarness`, and in `resolveHarnessConfig`: `numCtxPolicy: config.numCtxPolicy ?? "fixed",`. No env flag (config-only surface; avoids another `RA_*`). Update `scripts/check-harness-config.sh` if it enumerates fields.

- [ ] **Step 5: Wire it in `think.ts` (write the failing kernel test first)**

Test (add to `packages/reasoning/tests/assembly/num-ctx-demand.test.ts`): run a kernel think turn with a capturing `LLMService` (pattern: `packages/runtime/tests/builder-seam-behavioral.test.ts` harness A with `.withReplayLLM(capturingLayer)` and `.withHarness({ numCtxPolicy: "demand" })`), assert the captured request has `numCtx === 8192` for a short prompt; with `numCtxPolicy` unset assert `numCtx === undefined`. Place it in `packages/runtime/tests/num-ctx-demand-wiring.test.ts` since it uses the builder. Confirm `.withHarness` accepts `numCtxPolicy` (`grep -n "withHarness" -A20 packages/runtime/src/builder.ts`). Run → RED.

Implementation in `think.ts`, before `gatewayStream(...)`:

```ts
    // D-2026-07-30-I: demand-driven num_ctx (opt-in). Only the local provider
    // reads request.numCtx (local.ts resolveOllamaNumCtx — request wins).
    // Output budget 2000 matches from-kernel-state.ts's resolveCapability call.
    const demandNumCtx =
      harness?.numCtxPolicy === "demand" && profile.tier === "local"
        ? nextNumCtx(
            yield* estimateTokenCount([
              { role: "system", content: systemPromptWithDriver },
              ...messagesForRequest,
            ]),
            2000,
            state.meta.numCtxHighWater,
            profile.maxTokens,
          )
        : undefined;
```

and in the request object: `...(demandNumCtx !== undefined ? { numCtx: demandNumCtx } : {}),`. After the call, persist the high-water mark: `state = transitionState(state, { meta: { ...state.meta, numCtxHighWater: demandNumCtx } })` when defined.

Verified 2026-09-14: `harness` is the optional `ResolvedHarness` parameter of the think function (`think.ts:307-308`); `estimateTokenCount(messages): Effect<number>` is exported from `@reactive-agents/llm-provider` (`token-counter.ts:26`, `index.ts:168`) — reuse it, do not write a new estimator; `profile.maxTokens` is the context window (`context-profile.ts:45`, already wired from `capability.recommendedNumCtx` per its S1.4 note). Before writing: confirm `messagesForRequest` is `LLMMessage[]`-compatible (map it if not), that the enclosing function is an `Effect.gen` (so `yield*` works), and gate on provider rather than tier if tier `local` can be non-Ollama (`grep -n "tier" packages/reasoning/src/context/context-profile.ts | head`). `.withHarness(config: HarnessConfig)` is an existing overload (`builder.ts:596`), so no new wither is needed.

Run the kernel test → GREEN. Mutation: remove the spread → RED.

- [ ] **Step 6: Measure (rung 3 — the only rung where this matters)**

Two local models (one small: e.g. `granite4:latest`; one mid: `gemma4:12b`), task set mixing short-answer and large-tool-result tasks, n=5, arms `fixed` vs `demand`. Collect per run: accuracy, wall-clock, p50/p95 per-turn latency (from `llm-exchange` trace events), peak VRAM (`nvidia-smi --query-gpu=memory.used --format=csv -l 1 > vram-<arm>.csv` in a second terminal, or `ollama ps` sampled), and count of distinct `num_ctx` values per run (reload proxy).

Acceptance to promote to default-on for local tier: no accuracy regression beyond noise, p50 turn latency not worse, and peak VRAM or wall-clock measurably better on at least one model with no regression on the other. Otherwise keep opt-in and record the numbers; if it's slower on both → delete `predictNumCtx`/`BUCKETS`/`nextNumCtx` and the field (register discharge option 2).

- [ ] **Step 7: Commit**

Report → `wiki/Research/Harness-Reports/2026-09-XX-num-ctx-demand.md`. DEBT-REGISTER D-2026-07-30-I → WIRED (opt-in) + verdict link. Docs: add `numCtxPolicy` to the `.withHarness` docs page (`grep -rln "withHarness" apps/docs/src/content/docs | head -3`).

```bash
git add packages/reasoning packages/runtime wiki apps/docs scripts .changeset
git diff --cached --stat
git commit -m "feat(reasoning): opt-in demand-driven num_ctx for local models"
```

---

## Task 8: Builder wither proof lane — census gate + batch 1

**Why:** 85 withers, 7 behavioral seam tests. The class has already failed in production: `.withBehavioralContracts()` enforced nothing for ~10 days after Move 1 with every test green (D-2026-08-23-B). DEBT-REGISTER calls the seam lane "the highest-leverage test work in the repo".

**Files:**
- Create: `packages/runtime/tests/wither-census.test.ts`
- Modify: `packages/runtime/tests/builder-seam-behavioral.test.ts`

**Interfaces:**
- Produces: `WITHER_PROOF` map (exported from the census test file only) `Record<string, { status: "PROVEN"; test: string } | { status: "UNOBSERVABLE-DETERMINISTIC"; reason: string } | { status: "INFRA"; reason: string }>`.

- [ ] **Step 1: Write the census gate (fails until every wither is classified)**

```ts
// Run: bun test packages/runtime/tests/wither-census.test.ts --timeout 15000
//
// Every public with*/without* method must be classified. PROVEN = a named
// red-on-cut behavioral test exists. UNOBSERVABLE-DETERMINISTIC = its effect
// needs a live provider (reason required). INFRA = wiring-only (layers, test
// hooks) whose behavior is pinned elsewhere (reason required). A new wither
// with no row fails CI.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReactiveAgents } from "../src/index.js";

type Proof =
  | { readonly status: "PROVEN"; readonly test: string }
  | { readonly status: "UNOBSERVABLE-DETERMINISTIC"; readonly reason: string }
  | { readonly status: "INFRA"; readonly reason: string };

export const WITHER_PROOF: Readonly<Record<string, Proof>> = {
  withPersona: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withTaskContext: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withTools: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withReasoning: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withMaxIterations: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withOutputValidator: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withOutputSchema: { status: "PROVEN", test: "builder-seam-behavioral.test.ts" },
  withBehavioralContracts: { status: "PROVEN", test: "behavioral-contract-enforcement.test.ts" },
  withTestScenario: { status: "INFRA", reason: "test provider driver; exercised by every deterministic test" },
  withReplayLLM: { status: "INFRA", reason: "test LLM injection; exercised by seam harness A" },
  withLayers: { status: "INFRA", reason: "late-bound layer merge; see builder-seam-behavioral header" },
  // Step 2 fills the remaining 74 rows. Do not guess PROVEN — each PROVEN row
  // must name a test file that fails when the wither's wiring line is cut.
};

function witherNames(): string[] {
  const proto = Object.getPrototypeOf(ReactiveAgents.create());
  return Object.getOwnPropertyNames(proto).filter((n) => /^with(out)?[A-Z]/.test(n));
}

describe("wither proof census", () => {
  it("every wither is classified", () => {
    const missing = witherNames().filter((n) => !(n in WITHER_PROOF));
    expect(missing).toEqual([]);
  });

  it("no stale rows for removed withers", () => {
    const live = new Set(witherNames());
    expect(Object.keys(WITHER_PROOF).filter((n) => !live.has(n))).toEqual([]);
  });

  it("every PROVEN row names an existing test file that mentions the wither", () => {
    for (const [name, proof] of Object.entries(WITHER_PROOF)) {
      if (proof.status !== "PROVEN") continue;
      const src = readFileSync(join(import.meta.dir, proof.test), "utf8");
      expect(src.includes(`${name}(`)).toBe(true);
    }
  });
});
```

Run → test 1 FAILS listing ~74 unclassified withers. That list is the work queue.

- [ ] **Step 2: Classify every remaining wither (research, no guessing)**

For each unclassified wither: `grep -rln "\.<wither>(" packages/runtime/tests packages/*/tests | head` and open candidates. A row is PROVEN only if a test builds an agent with vs without the wither and asserts an observable difference. Otherwise classify UNOBSERVABLE-DETERMINISTIC (effect needs live model/long run — cite why) or INFRA, or leave **SILENT** by not adding a row yet and adding it to batch 1. Commit the census with every row classified; SILENT withers get a temporary row `{ status: "UNOBSERVABLE-DETERMINISTIC", reason: "SILENT — batch <n> (plan 2026-09-14 Task 8)" }` so the backlog is explicit and grep-able.

- [ ] **Step 3: Batch 1 — the six highest-risk SILENT withers**

Priority = safety/cost enforcement first (the D-2026-08-23-B class): `withBudget`, `withKillSwitch`, `withTimeout`, `withGuardrails`, `withRequiredTools`, `withApprovalPolicy`. For each, write one red-on-cut test in `builder-seam-behavioral.test.ts` with the same shape as the existing ones:

```ts
  // N. withRequiredTools — wiring: <cite the runtime-construction.ts line that reads _requiredTools>.
  //    Scenario answers without calling the required tool. With the wither the
  //    harness must not accept that answer as success; without it, it does.
  //    Cut the wiring → both runs succeed → RED.
  it("withRequiredTools() blocks an answer that skipped the required tool", async () => {
    const build = () =>
      ReactiveAgents.create()
        .withName("seam")
        .withProvider("test")
        .withTools(loopTool)
        .withReasoning({ defaultStrategy: "reactive", maxIterations: 3 })
        .withTestScenario([{ text: "FINAL ANSWER: guessed" }]);
    const required = await build().withRequiredTools({ tools: ["seam_marker_tool"] }).build();
    const free = await build().build();
    try {
      const rr = await required.run("q");
      const rf = await free.run("q");
      expect(rf.success).toBe(true);
      expect(rr.success === false || rr.goalAchieved === false || rr.terminatedBy === "abstained").toBe(true);
    } finally {
      await required.dispose();
      await free.dispose();
    }
  });
```

Before writing each test, read the wither's signature and its runtime reader (`grep -n "_requiredTools\|_budget\|_killSwitch\|_timeout\|_guardrails\|_approvalPolicy" packages/runtime/src/builder/build-effect/runtime-construction.ts packages/runtime/src/runtime.ts`) so the asserted behavior is what the code is supposed to do. For each: run → GREEN; cut the named wiring line → RED; restore. **If a test cannot be made to go RED on cut, you have found a SILENT wither whose behavior never changes: stop and file it as a finding** (that is the purpose of this lane) — do not weaken the assertion.

Flip each proven row in `WITHER_PROOF` to `{ status: "PROVEN", test: "builder-seam-behavioral.test.ts" }`.

- [ ] **Step 4: Run + commit**

```bash
bun test packages/runtime/tests/wither-census.test.ts packages/runtime/tests/builder-seam-behavioral.test.ts --timeout 60000
git add packages/runtime/tests wiki/Architecture/DEBT-REGISTER.md
git diff --cached --stat
git commit -m "test(runtime): wither proof census gate and batch-1 behavioral seam tests"
```

Record in DEBT-REGISTER B3: counts PROVEN / UNOBSERVABLE / INFRA / SILENT-remaining, and the next batch list. Subsequent batches are follow-on work (6 withers per batch), not part of this wave.

---

## Task 9: Wave close — full gates, debrief, memory

- [ ] **Step 1: Full gates with `.env` moved aside (CI parity)**

```bash
mv .env /tmp/claude-1000/.env.aside
bunx turbo run build typecheck
bun test --timeout 60000 2>&1 | tail -15
for s in scripts/check-*.sh; do bash "$s" || echo "FAIL $s"; done
bun run docs:examples:check
bunx turbo run test --filter=@reactive-agents/benchmarks -- tests/t0-deterministic.test.ts
mv /tmp/claude-1000/.env.aside .env
```

Expected: build 37/37, typecheck clean, 0 test failures (compare total vs the 9,250 baseline — new tests should raise it, nothing should drop), every `check-*.sh` exits 0.

- [ ] **Step 2: Release dry run**

Run: `bun run release:dry 0.16.1` (or the next version) → clean. Do not tag.

- [ ] **Step 3: Debrief**

Dispatch `debrief-scribe` (MissionBrief + the per-task reports + bench JSON paths) → `wiki/Research/Debriefs/2026-09-XX-wire-or-delete-hardening-wave-debrief.md`. Must include: each task's red-on-cut evidence, every measured number with n, every verdict, and anything that did NOT go as planned.

- [ ] **Step 4: Sync knowledge**

- `wiki/Hot.md`: replace the latest-session block with this wave; update "What's Next" (τ-bench bridge, wither batches 2+, any KEEP-OPT-IN re-measurements).
- `wiki/Architecture/Specs/09-UNIFIED-PROGRAM.md` §4 verified-state: add rows for items that changed (orphan baseline 0, flag count, wither proof counts).
- Claude memory (`MEMORY.md` + topic file) and `.agents/MEMORY.md`: one entry for the wave with commit range.

- [ ] **Step 5: Commit**

```bash
git add wiki .agents/MEMORY.md
git diff --cached --stat
git commit -m "docs(wiki): wire-or-delete hardening wave debrief and state sync"
```

---

## Execution order and dependencies

```
Task 0 ─┐
Task 1 ─┼─ independent, any order (all deterministic)
Task 3 ─┤
Task 4 ─┘
Task 2 ──► Task 6 (RA_OVERHAUL verdict depends on Task 2's gate + before/after counts)
Task 5 ─── independent (has its own prompt-drift cell)
Task 7 ─── independent (local-tier measurement)
Task 8 ─── independent
Task 9 ─── last
```

Parallel-safe groupings for subagent execution: {0, 1, 3} touch disjoint packages; 4 and 3 both touch `run-finalize`-adjacent runtime files — run sequentially. 5 and 7 both touch `packages/reasoning` kernel files — run sequentially. Use one worktree per parallel task; `git status` both trees before merging (absolute-path edits in a worktree hit the main checkout).

## Out of scope (recorded, not forgotten)

- τ-bench environment bridge (tabled 2026-09-14 by owner).
- Wither batches 2+ (queue produced by Task 8 Step 2).
- `RecallService` per-iteration seam — 09 §6.7 ruling: measured 0.0pp, parked; noop layer only.
- `packages/interaction` wire-or-demote — needs an owner product decision.
- #39 per-entity requirement coverage; memory default-on measurement (W6) — separate lift-gated items.
