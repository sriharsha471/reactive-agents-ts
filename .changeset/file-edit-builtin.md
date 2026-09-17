---
"@reactive-agents/tools": minor
"@reactive-agents/reasoning": patch
"@reactive-agents/observability": patch
---

Add a `file-edit` builtin tool that replaces an exact block of text inside an
existing file, instead of overwriting the whole file like `file-write`. Agents
editing a large file no longer need to re-emit its entire contents, which cuts
token cost and removes a class of accidental-truncation bugs.

`file-edit` refuses ambiguous edits: if `oldText` is missing from the file, or
appears more than once without `replaceAll: true`, the call fails and the file
is left untouched. It declares the same `requiresApproval: true` /
`riskLevel: "high"` posture as `file-write`, so it cannot be used to bypass an
approval gate.
