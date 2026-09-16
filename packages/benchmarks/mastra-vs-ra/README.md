# packages/benchmarks/mastra-vs-ra

Head-to-head benchmark: Reactive Agents vs Mastra. Not part of the release build, not published to npm, but the results are public evidence — see `results/README.md` for the numbers, and for the three real bugs (two in this bench, one in the framework itself) found and fixed before publishing them. Lives under `@reactive-agents/benchmarks` (moved from the repo-root `bench/` dir 2026-06-01 to consolidate all competition/benchmark code in one package). It is a standalone runnable (own `package.json`, own `node_modules`), not a workspace member.

## Layout

```
packages/benchmarks/mastra-vs-ra/
  package.json
  tasks.ts        # shared task corpus (21 tasks, 6 categories)
  tools.ts        # per-framework tool factories from shared ToolSpec
  verifier.ts    # deterministic output verification (contains-any / contains-all / regex / long-form)
  runner.ts       # matrix runner: tier × task × framework × run, writes results/cells-*.json + .csv
  smoke-ollama.ts # one-task smoke before full sweep
  results/        # per-run output — see results/README.md for what's canonical vs invalidated
```

## Tiers

| id | provider | model | cost per 1M in/out |
|----|----------|-------|--------------------|
| `frontier` | Anthropic | `claude-haiku-4-5` | $1 / $5 |
| `mini` | OpenAI | `gpt-4o-mini` | $0.15 / $0.60 |
| `grok` | xAI | `grok-3-mini` | $0.30 / $0.50 |
| `local` | Ollama | `qwen3.5:latest` | $0 / $0 |

Cheapest current model per provider by design — the point is reliability-per-dollar, not frontier-model showmanship.

## Run

```bash
cd packages/benchmarks/mastra-vs-ra
bun install

# Smoke test first
bun smoke-ollama.ts

# Full matrix (all tiers, all tasks, both frameworks)
bun runner.ts

# Subset selection via env
BENCH_TIER=local                  bun runner.ts
BENCH_TIER=mini,local             bun runner.ts
BENCH_TASKS=k1,t1                 bun runner.ts
BENCH_FRAMEWORKS=ra               bun runner.ts
BENCH_RUNS=5                      bun runner.ts   # repeats per cell (default 1)
```

Requires `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` in the repo-root `.env` for the paid tiers, and a running Ollama with `qwen3.5:latest` pulled for `local`.

## Output

Each run writes:

- `results/cells-<timestamp>.json` — full per-cell records
- `results/cells-<timestamp>.csv` — flat CSV for spreadsheet analysis

Plus a stdout summary table with success rate / tokens / cost / avg duration per (tier, framework).

## Fairness notes

- Both frameworks build a fresh agent per task — no warm cache advantage.
- Tools have identical names, descriptions, parameters, and behaviors across frameworks. Only the framework-native shape differs (RA's `ToolDefinition` + Effect handler vs Mastra's `{ id, inputSchema, execute }`).
- Same model ID across both. Same `maxIterations` / `maxSteps` budget.
- Deterministic verifier — no LLM-as-judge variance (yet). LLM-judge added in v2 only if substring matchers become a bottleneck.
- 180s per-cell timeout. Exceptions are recorded, not retried.
- **Mastra's `tools.ts` `execute` signature must be `(inputData, context?)`, not `({ context })`.** The older `{ context }` shape silently runs every tool call with `undefined` args on `@mastra/core` 1.36+ — no error, no crash, it just never sees real arguments. Cost us a full invalidated run (`results/INVALID-broken-mastra-tool-args/`).
- **Use the official `@ai-sdk/xai` package for the grok tier**, not `createOpenAI({ baseURL: "https://api.x.ai/v1" })`. The workaround makes every Mastra tool call fail (0/8 on tasks that pass 8/8 with the real package) — cost us a second invalidated run (`results/INVALID-broken-xai-integration/`).
- **Import `reactive-agents` dynamically, after `dotenvConfig()`, not as a static top-level import** — historical note. `llmConfigFromEnv` used to be captured at module-import time; a static import above a runtime `.env` load baked in `undefined` for every provider key. Silently masked for Anthropic/OpenAI-direct/Ollama (their SDKs re-read the matching env var independently) but not for xai/groq/litellm, where the generic `openai` SDK's fallback sent `OPENAI_API_KEY` to the wrong host instead. **Fixed in framework as of this commit** (`D-2026-09-08-O`, `wiki/Architecture/DEBT-REGISTER.md`): `LLMConfigFromEnv` now reads `process.env` lazily at layer-build time, and a keyless xai/groq client refuses to construct instead of borrowing `OPENAI_API_KEY`. The dynamic-import pattern in `runner.ts` is now harmless legacy and can be reverted to a static import at leisure.
