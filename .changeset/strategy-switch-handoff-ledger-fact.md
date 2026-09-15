---
"@reactive-agents/reasoning": patch
---

Strategy switches now mint a typed `handoff` ledger fact (rendered by the standing frame, protected by compaction) instead of string-folding the switch summary into `priorContext`. Fixes a real data-loss bug found while characterizing the switch path: `initialKernelState` was resetting the run ledger to empty on every strategy switch, silently dropping all prior tool-invocation, artifact, and requirement facts recorded before the switch. The prior ledger is now carried forward across the switch, with carried tool-result observations de-duplicated against the projection chokepoint so a carried call does not mint a second `tool-result` fact.
