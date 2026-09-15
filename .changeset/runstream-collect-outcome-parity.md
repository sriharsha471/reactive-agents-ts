---
"@reactive-agents/runtime": patch
---

`AgentStream.collect(agent.runStream(...))` now reports the same terminal outcome as `agent.run(...)`: `success`, `terminatedBy`, and `goalAchieved` are read off `StreamCompleted` (which now carries them) instead of `collect()` hardcoding `success: true` and silently dropping the other two, and `metadata.toolCalls` is derived on the stream path the same way `run()` derives it (both now share `deriveMetadataToolCalls` in `engine/finalize/derive-outcome.ts`). A failed or abstained streamed run no longer collects as a success with no tool calls.
