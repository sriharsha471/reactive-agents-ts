# Results — mastra-vs-ra bench

## Canonical dataset (2026-09-09, the numbers we publish)

- `canonical-frontier-mini-local.json` / `.csv` — frontier (`claude-haiku-4-5`), mini (`gpt-4o-mini`), and local (`qwen3.5:latest`) tiers. 21 tasks x 2 frameworks x 5 runs each, deterministic verifier.
- `canonical-grok.json` / `.csv` — grok tier (`grok-3-mini`, served as `grok-4.3`), same shape. Run separately after fixing the xAI integration bug (see below), so it lives in its own file rather than being re-merged into the frontier file.

Combined:

| Tier | RA | Mastra |
|---|---|---|
| frontier (haiku-4.5) | 95.2% | 99.0% |
| mini (gpt-4o-mini) | 95.2% | 95.2% |
| grok (grok-3/4.3) | 97.1% | 97.1% |
| local (qwen3.5) | 99.0% | 99.0% |

## `verification/` — targeted re-checks, not part of the headline number

`cells-2026-09-09T21-19-05-433Z.json` — a 5-run frontier-tier re-check of `f1-web-search-error` (RA only) after fixing a real framework bug found while investigating why RA lost this task (see `HS-237` in `wiki/Issues/Running Issues Log.md`). The task still doesn't pass (haiku keeps retrying past its own "stop after 2 attempts" instruction — a separate, filed issue, `HS-239`), but RA no longer ships a fabricated "I'll try again" answer as a false success; it now fails honestly with empty output. Not merged into the canonical frontier file because it only re-tests one task, not the full 21-task matrix, and because the canonical file predates the fix landing.

## `INVALID-*/` — kept deliberately, not deleted

Three earlier full or partial runs, invalidated by bugs found during investigation, each folder named for the bug:

- **`INVALID-broken-mastra-tool-args/`** — Mastra's `tools.ts` used the pre-1.0 `createTool` signature (`{ context }`) against the actually-installed API (`(inputData)`), so every Mastra tool call in the bench silently ran with `undefined` args. Made Mastra look far worse at tool use than it is.
- **`INVALID-broken-xai-integration/`** — the grok tier used an unofficial `createOpenAI` + manual `baseURL` workaround for Mastra's xAI provider instead of the real `@ai-sdk/xai` package. Made Mastra look like it couldn't do tool calls at all on Grok (0/8 on tasks that pass 8/8 with the official package).
- **`INVALID-xai-key-bug/`** — a framework-level bug (not a bench bug): `reactive-agents`'s `llmConfigFromEnv` used to be captured at module-import time, so a static `import { ReactiveAgents } from "reactive-agents"` positioned before a runtime `dotenv.config()` call got every provider key as `undefined`. For xai/groq/litellm providers this silently fell back to the OpenAI SDK's own `OPENAI_API_KEY` default, sending the wrong key to the wrong host. Filed as `D-2026-09-08-O` in `wiki/Architecture/DEBT-REGISTER.md`. **Fixed in framework as of this commit** — `LLMConfigFromEnv` now reads `process.env` lazily at layer-build time and a keyless xai/groq client refuses to construct rather than borrow `OPENAI_API_KEY`; the dynamic-import workaround in `runner.ts` is no longer load-bearing but is kept (harmless).

We're keeping these rather than deleting them. The story isn't "RA wins" — it's that we caught three real bugs (two in the bench, one in the framework) before publishing a number, and the receipts for that are worth more than the number itself.

## Reproducing

```bash
cd packages/benchmarks/mastra-vs-ra
bun install
BENCH_TIER=frontier,mini,grok,local BENCH_RUNS=5 bun runner.ts
```

Requires `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` in the repo-root `.env`, and a running Ollama with `qwen3.5:latest` pulled for the local tier.
