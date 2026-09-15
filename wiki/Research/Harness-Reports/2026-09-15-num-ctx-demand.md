# 2026-09-15 — Demand-driven `num_ctx` for Ollama (Task 7, D-2026-07-30-I)

## What shipped

`ResolvedCapability.predictNumCtx()` + `BUCKETS = [8192, 16384, 32768, 65536,
131072]` (`packages/reasoning/src/assembly/capability.ts`) had zero callers
(D-2026-07-30-I). This wires them into an **opt-in** demand-driven `num_ctx`
policy for local Ollama models:

- `HarnessConfig.numCtxPolicy?: "fixed" | "demand"` — default `"fixed"`
  (today's behavior, byte-identical). No env flag; config-only surface.
- `nextNumCtx(assembledPromptTokens, outputBudget, highWater, ceiling)` in
  `capability.ts` — pure bucket-selection policy, monotone: never shrinks
  below `highWater`, never exceeds `ceiling`.
- Wired in `think.ts`, gated on `numCtxPolicy === "demand" && providerName ===
  "ollama"`. Sets `request.numCtx` (which already wins over
  `capability.recommendedNumCtx`/`config.defaultNumCtx` in
  `local.ts:resolveOllamaNumCtx` — no provider change needed) and persists
  the chosen value to `state.meta.numCtxHighWater` so the next turn in the
  same run only grows.

## Source-verification findings (brief's 4 unconfirmed assumptions)

1. **Harness parameter access in `think.ts`.** Confirmed: `handleThinking`
   reads `const h = input.harness ?? resolveHarnessConfig();` — `input.harness`
   is `ResolvedHarness | undefined` on `KernelInput`. Used `h.numCtxPolicy`,
   not a separately-named `harness?` parameter (that name belongs to the
   unrelated `buildThinkProviderRequest` helper at the top of the file).

2. **`estimateTokenCount` signature.** Confirmed exactly as the brief stated:
   `estimateTokenCount(messages: readonly LLMMessage[]): Effect.Effect<number,
   never>`, exported from `@reactive-agents/llm-provider`
   (`token-counter.ts:26`, `index.ts:168`). `handleThinking` is an
   `Effect.gen` function, so `yield* estimateTokenCount([...])` works exactly
   as sketched.

3. **`profile.maxTokens` as ceiling, `tier === "local"` as Ollama proxy.**
   `profile.maxTokens` is confirmed correct as the ceiling (the resolved
   context-window token budget, `context-profile.ts:45`). **`tier ===
   "local"` is NOT a reliable Ollama proxy** — this was the one real
   deviation from the brief. `packages/llm-provider/src/capability.ts`'s
   `fallbackCapability()` assigns `tier: "local"` to ANY unrecognized
   provider (not just Ollama) as its conservative fallback, and the `"test"`
   stub provider's static entry also carries `tier: "local"`. The existing,
   already-used pattern for "is this Ollama" is `providerName === "ollama"`
   (see `packages/reasoning/src/kernel/loop/runner.ts:226`, which gates a
   different Ollama-only default the same way). Implementation gates on
   `input.providerName === "ollama"` instead of `profile.tier === "local"`.

4. **`.withHarness(config: HarnessConfig)` overload.** Confirmed existing at
   `packages/runtime/src/builder.ts:596` — no new wither needed. Verified via
   `bunx tsc --noEmit` in `packages/runtime` that `.withHarness({
   numCtxPolicy: "demand" })` type-checks against the existing overload with
   zero changes to `builder.ts`.

## Test-placement deviation (CI-safety)

The brief suggested placing the Step 5 kernel-wiring test in
`packages/runtime/tests/` via `.withProvider("ollama")` +
`.withReplayLLM(capturingLayer)`. Verified live that this is **not CI-safe**:
`ReactiveAgentBuilder.build()` runs an unconditional pre-flight
`validateProviderConnection("ollama")` (`build-validation.ts:326-348`) that
does a real `fetch` to the Ollama endpoint **before** `.withReplayLLM` can
intercept anything — this would require a live Ollama connection in CI,
which the task explicitly forbids ("CI has no Ollama").

Instead, the wiring test drives `executeReActKernel()`
(`packages/reasoning/src/kernel/loop/react-kernel.ts`) directly, which
accepts `providerName` and `harness` as plain `KernelInput` fields with zero
builder/network involvement — the same CI-safe pattern already used by
`packages/reasoning/tests/strategies/kernel/react-kernel.test.ts`. Also
skipped extending `packages/llm-provider/tests/num-ctx-wiring.test.ts` as the
brief suggested: that file already has a test named exactly
`"request.numCtx still wins over explicitNumCtx (per-call beats
per-agent)"` (line 212) proving the one precedence fact this feature depends
on — adding a duplicate would be redundant test surface for zero new
coverage.

## Test results

`packages/reasoning/tests/assembly/num-ctx-demand.test.ts` (new, 7 tests):

- Step 1/2: pure `nextNumCtx` tests — RED (`nextNumCtx` not exported) before
  Step 3, GREEN after.
- Step 5: kernel-wiring tests — RED (`numCtxPolicy` unimplemented) before
  wiring `think.ts`, GREEN after: `numCtx === 8192` for a short prompt with
  `numCtxPolicy: "demand"` + `providerName: "ollama"`; `numCtx === undefined`
  with the policy unset; `numCtx === undefined` for a non-Ollama provider
  even with `numCtxPolicy: "demand"` (the tier-vs-provider gating fix,
  proven).

Mutation check: removed `...(demandNumCtx !== undefined ? { numCtx:
demandNumCtx } : {})` from the request object → the "sets numCtx" test failed
(RED) as expected; restored → GREEN again.

Full-suite regression: `bun test packages/reasoning` — **2844 pass, 4 todo, 0
fail** (no change in pass count from baseline). `packages/llm-provider/tests/
num-ctx-wiring.test.ts` — 8 pass, 0 fail (unmodified, unaffected).
`bunx tsc --noEmit` clean in `packages/reasoning` and `packages/runtime`.
`bunx turbo run build` clean for `reasoning`, `runtime`, `llm-provider`.

## Step 6: measurement

**Models** (substituted per task instructions — `granite4:latest` unavailable
in this environment despite the brief's suggestion):
`gemma4:12b` (small, 11.9B params, fully GPU-resident) and
`gemma4:26b-a4b-it-q4_K_M` (mid, 25.8B params, CPU/GPU split ~34%/66%).
Both report native `context length: 262144`; the framework's Ollama probe
caps `recommendedNumCtx` at `min(contextLength, 32768)` — so the `"fixed"`
arm always loads both models at `num_ctx=32768`.

**Tasks**: `short` (trivial `typeof null` question, no tools) and
`large-ctx` (a synthetic ~30KB/~800-line config dump with a planted secret
token, embedded directly in the prompt — no tool calls, to keep the harness
simple and avoid the per-result curation budget interacting with the
measurement). n=3 per (model, arm, task) = 24 runs total.

**Method**: a scratch script (`ReactiveAgents.create().withProvider("ollama")
.withModel(m).withHarness({numCtxPolicy: arm}).withMaxIterations(2)`),
timing wall-clock via `performance.now()` per `agent.run()`, checking output
correctness by regex, and sampling `ollama ps` immediately after each run for
the `CONTEXT` and `SIZE`/`PROCESSOR` columns (reload + footprint proxy).
`nvidia-smi -L` failed (`Driver/library version mismatch`) — no GPU-memory
proxy was available on this hardware, so VRAM comparison relies entirely on
`ollama ps`'s `SIZE` column plus the `CPU/GPU` split percentage it reports
for partially-offloaded models.

**IMPORTANT CAVEAT on the numbers below**: each of the 6 trials per arm is a
*separate* `agent.build()` → `run()` → `dispose()` against one long-lived
Ollama server process. Running all `short` trials before all `large-ctx`
trials (per arm) means the `demand` arm's num_ctx sequence is
8192→8192→8192→32768→32768→32768 — i.e. exactly ONE growth transition,
identical in kind to what a single continuous multi-turn agent run would do
as its context grows. But because Ollama retains the loaded model+num_ctx
*across separate agent runs* on the same server, the observed reload costs
below are technically a **cross-run policy reset**, not strictly isolated to
one continuous session — the qualitative shape (one reload per bucket
transition) matches the real single-run design intent, but readers should
not over-generalize "aggregate wall-clock across mixed task sizes" to mean
"demand is 3x slower on every real single-run agent task" — most real runs
stay at one size class and never pay this tax at all.

### Results — gemma4:12b (fully GPU-resident)

| arm | task | trial | wallMs | correct | ollama ps CONTEXT | SIZE |
| --- | --- | --- | --- | --- | --- | --- |
| fixed | short | 1 | 6025 | ✓ | 32768 | 8.4 GB |
| fixed | short | 2 | 2902 | ✓ | 32768 | 8.4 GB |
| fixed | short | 3 | 3155 | ✓ | 32768 | 8.4 GB |
| fixed | large-ctx | 1 | 6782 | ✓ | 32768 | 8.4 GB |
| fixed | large-ctx | 2 | 3055 | ✓ | 32768 | 8.4 GB |
| fixed | large-ctx | 3 | 2084 | ✓ | 32768 | 8.4 GB |
| demand | short | 1 | 5711 | ✓ | **8192** | 8.4 GB |
| demand | short | 2 | 3459 | ✓ | 8192 | 8.4 GB |
| demand | short | 3 | 2938 | ✓ | 8192 | 8.4 GB |
| demand | large-ctx | 1 | 11396 | ✓ | **32768** (reload: 8192→32768) | 8.4 GB |
| demand | large-ctx | 2 | 1795 | ✓ | 32768 | 8.4 GB |
| demand | large-ctx | 3 | 2177 | ✓ | 32768 | 8.4 GB |

- Accuracy: 6/6 both arms.
- Steady-state (excluding the one reload call per task-group): fixed mean
  ≈2799ms, demand mean ≈2592ms — comparable, demand fractionally faster,
  well within n=3 noise.
- Aggregate (all 6 calls): fixed 24003ms, demand 27476ms — demand ~14%
  slower, entirely attributable to the single 11396ms reload-transition call.
- VRAM proxy (`SIZE`): unchanged (8.4 GB) at both 8192 and 32768 — no
  measurable footprint win at this model size on this hardware.

### Results — gemma4:26b-a4b-it-q4_K_M (CPU/GPU split)

| arm | task | trial | wallMs | correct | ollama ps CONTEXT | SIZE / split |
| --- | --- | --- | --- | --- | --- | --- |
| fixed | short | 1 | 52123 (cold load, model swap from 12b) | ✓ | 32768 | 18 GB, 34/66 |
| fixed | short | 2 | 5742 | ✓ | 32768 | 18 GB, 34/66 |
| fixed | short | 3 | 4652 | ✓ | 32768 | 18 GB, 34/66 |
| fixed | large-ctx | 1 | 11934 | ✓ | 32768 | 18 GB, 34/66 |
| fixed | large-ctx | 2 | 3497 | ✓ | 32768 | 18 GB, 34/66 |
| fixed | large-ctx | 3 | 3626 | ✓ | 32768 | 18 GB, 34/66 |
| demand | short | 1 | **49358** (reload: 32768→8192) | ✓ | **8192** | 18 GB, 31/69 |
| demand | short | 2 | 5099 | ✓ | 8192 | 18 GB, 31/69 |
| demand | short | 3 | 4873 | ✓ | 8192 | 18 GB, 31/69 |
| demand | large-ctx | 1 | **33211** (reload: 8192→32768) | ✓ | 32768 | 18 GB, 34/66 |
| demand | large-ctx | 2 | 3454 | ✓ | 32768 | 18 GB, 34/66 |
| demand | large-ctx | 3 | 3899 | ✓ | 32768 | 18 GB, 34/66 |

- Accuracy: 6/6 both arms.
- Steady-state: fixed short mean ≈5197ms, large-ctx mean ≈3562ms (excluding
  the cold-load and the first large-ctx call, which is elevated — likely
  Ollama prompt-prefix caching warming up on the repeated ~30KB prompt, not a
  num_ctx effect, since fixed's num_ctx never changes); demand short mean
  ≈4986ms, large-ctx mean ≈3676ms — **steady-state numbers are essentially
  identical between arms** once loaded.
- Reload cost when `num_ctx` DOES change: **33–49 seconds** on this
  CPU/GPU-split model — an order of magnitude worse than the 12B model's
  ~3–4.6s reload cost. This is the brief's "Main risk" (Ollama reloads on any
  `num_ctx` change) manifesting concretely, and it's worse for larger,
  partially-offloaded models than for small fully-GPU-resident ones.
- VRAM proxy: `SIZE` unchanged (18 GB) at 8192 vs 32768; the CPU/GPU split
  shifted slightly (69% GPU at num_ctx=8192 vs 66% GPU at 32768) — a small
  directional signal that a smaller context window frees a little headroom
  for more of the model to sit on GPU, but not large enough to call a
  measured win given `nvidia-smi` was unavailable to confirm actual VRAM
  bytes.

## Decision: KEEP OPT-IN (not promoted, not deleted)

Per the brief's acceptance rule:

> Promote to default-on only if: no accuracy regression, p50 latency not
> worse, and peak VRAM or wall-clock measurably better on at least one model
> with no regression on the other. Otherwise keep opt-in and record the
> numbers; delete only if it's measurably WORSE on both models with no
> compensating benefit.

- **No accuracy regression**: 24/24 correct across both arms, both models.
- **No measurably-better VRAM or wall-clock on any model**: steady-state
  latency is a wash on both models (well within n=3 noise); the `ollama ps`
  VRAM proxy showed no material win on either model given the hardware's
  `nvidia-smi` limitation. → **promotion bar not met.**
- **Not "measurably worse on both with no compensating benefit" either**:
  the aggregate-wall-clock regression is dominated by the reload tax, which
  is a real, confirmed cost (the brief's stated main risk) but is triggered
  only by a bucket-boundary GROWTH event — something a real single-run agent
  session pays at most once per size-class jump, not on every turn. The
  measurement's task-size-alternation harness structure inflated this cost
  relative to a typical run. Given that confound, "slower on both" is not a
  clean enough signal to delete a correctly-implemented, correctly-gated,
  zero-regression, opt-in mechanism.

**Verdict: ships opt-in (`numCtxPolicy: "demand"`), documented in
`apps/docs/src/content/docs/features/harness-control.md`, DEBT-REGISTER
D-2026-07-30-I marked WIRED/opt-in. Not promoted to default-on for local
tier** (explicitly out of scope for this pass per the task brief) **and not
deleted** — `predictNumCtx`/`BUCKETS`/`nextNumCtx` now have real callers and
passing tests, and the measured regression doesn't clear the bar for
removal. A follow-up measurement inside one genuinely continuous multi-turn
agent session (rather than N separate `agent.run()` calls against a shared
Ollama process) would be needed before either promoting or reconsidering
deletion — flagged as a gap, not resolved here.

## Files changed

- `packages/reasoning/src/assembly/capability.ts` — `nextNumCtx()` exported,
  `predictNumCtx` delegates to it.
- `packages/reasoning/src/harness-config.ts` — `numCtxPolicy` field on
  `HarnessConfig`/`ResolvedHarness`, resolved in `resolveHarnessConfig`.
- `packages/reasoning/src/kernel/state/kernel-state.ts` — `KernelMeta.
  numCtxHighWater?: number`.
- `packages/reasoning/src/kernel/capabilities/reason/think.ts` — wiring:
  computes `demandNumCtx`, sets `request.numCtx`, persists the high-water
  mark.
- `packages/reasoning/tests/assembly/num-ctx-demand.test.ts` (new) — pure
  policy tests + CI-safe kernel-wiring tests.
- `apps/docs/src/content/docs/features/harness-control.md` — `numCtxPolicy`
  documented as the 12th harness-control field.
- `wiki/Architecture/DEBT-REGISTER.md` — D-2026-07-30-I marked WIRED/opt-in
  with a verdict link to this report.
