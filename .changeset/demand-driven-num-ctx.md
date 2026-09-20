---
"@reactive-agents/reasoning": minor
---

Add opt-in demand-driven `num_ctx` for local Ollama models (`.withHarness({ numCtxPolicy: "demand" })`). Sizes `num_ctx` to the assembled prompt each turn instead of a fixed per-model value, monotone-growing within a run to avoid unnecessary Ollama model reloads. Default remains `"fixed"` (byte-identical to today's behavior); ships opt-in pending broader measurement.
