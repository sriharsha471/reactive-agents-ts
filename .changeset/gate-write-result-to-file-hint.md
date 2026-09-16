---
"@reactive-agents/reasoning": patch
---

The `write_result_to_file` hint appended to overflowing tool-result previews is now gated on that tool actually being offered to the model (`offersWriteByRef(schemas)`). Previously the hint was unconditional, so the default harness (where `write_result_to_file` is not registered unless `RA_OVERHAUL=1`) instructed models to call a tool that does not exist. Live bench measurement (rw-4, claude-haiku-4-5, n=3): the hint appeared on 13/13 overflow events before this fix and 0/13 after.
