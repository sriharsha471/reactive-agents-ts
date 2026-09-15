---
"@reactive-agents/reactive-intelligence": minor
"@reactive-agents/core": patch
"@reactive-agents/reasoning": patch
"@reactive-agents/runtime": patch
"@reactive-agents/observability": patch
---

Fix phantom entropy divergence on healthy runs (FM-C3). Gate event-driven
entropy scoring to strategies without kernel-inline coverage so kernel
thoughts are scored exactly once; fix the inverted structural source,
unify short-run/normal composite weights, use semantic novelty instead of
the constant-zero task alignment, and make the console dashboard recompute
trajectory shape from deduplicated points with confidence-gated grades
and alerts.
