---
"@reactive-agents/trace": patch
"@reactive-agents/core": patch
"@reactive-agents/runtime": patch
---

`run-completed` trace events now carry the real run cost (`totalCostUsd`) and raw termination reason (`terminatedBy`) instead of hardcoding cost to 0 and dropping the reason entirely. `AgentCompleted` gains an optional `totalCostUsd` field forwarded from `result.metadata.cost` at finalize; `RunCompletedEvent` gains an optional `terminatedBy` field mapped from `AgentCompleted.terminationReason`.
