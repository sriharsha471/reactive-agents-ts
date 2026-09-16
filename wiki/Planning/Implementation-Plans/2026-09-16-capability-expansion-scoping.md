# Capability Expansion Scoping — 2026-09-16

Scoping doc, not an execution plan. Ranks 3 candidate capability tracks for
Reactive Agents (file-edit tool, agent-as-MCP-server, trace/DX compat) by
leverage, grounded in actual repo state (verified 2026-09-16, not assumed).
Each track ends with a recommendation and what a real implementation plan
would need next.

## Track A — `file-edit` builtin tool (patch, not full overwrite)

**Current state:** `packages/tools/src/skills/file-operations.ts` has
`file-read` (L102), `list-directory` (L195), `file-write` (L255) — write is
full-overwrite only, `requiresApproval:true`, `riskLevel:"high"`. No
edit/patch variant. Registered as a builtin via
`packages/tools/src/index.ts:110-114`.

**What's reusable:** `confinePath()` (L81) and `getFileRoot()`/
`withFileRoot()` (L20-27) are exported and already the sandbox primitive
both existing tools call — a `file-edit` tool calls the same function, zero
duplication. `HARNESS_ECHO_PATTERNS` (L369) guard is worth keeping on the
new-text side of an edit too.

**What's missing:** no diff/patch library in the repo — grepped for
diff/patch/applyPatch, only hits are `git-cli.ts`/`shell-execution.ts`
shelling out to `git diff`. Two real design choices, not one:
- **Search/replace-block format** (Aider-style: `<<<<<<< SEARCH … =======
  … >>>>>>> REPLACE`) — no new dependency, easy to implement on top of
  `fs.readFile` + string replace, forgiving of minor whitespace drift if we
  add fuzzy-match fallback.
- **Unified diff format** — matches what Claude Code / Cursor / Aider
  already emit when a model has seen those tools before (higher zero-shot
  compat across models trained on those conventions), but needs a diff-apply
  library (new dependency) and stricter context-line matching.

**Recommendation:** search/replace-block format first (no dependency, faster
to ship, good enough for the token-savings win); leave unified-diff as a
follow-up if bench data shows models keep emitting diff-format edits anyway.

**Effort:** Low (1-2 files, no cross-package impact). **Impact:** High
(every coding-agent task with >1 file edit currently pays full-file
re-emission cost). Two open items before a real plan: (1) find the exact
default-toolset registration point in `packages/runtime` (not confirmed in
this pass) so we know where `file-edit` needs wiring in; (2) locate/confirm
the file-operations test file to match its harness conventions.

## Track B — agent as MCP server (reverse of `.withMCP()`)

**Current state:** `.withMCP()` (`packages/runtime/src/builder/withers/tools.ts`
~L119) makes RA a *consumer* of external MCP servers, via
`packages/tools/src/mcp/mcp-client.ts` wrapping `@modelcontextprotocol/sdk`'s
`Client`. The SDK dependency (`packages/tools/package.json:14`, `^1.28.0`)
ships a `Server` class too — currently unused anywhere in the repo.

**Closest precedent:** A2A, not MCP. `packages/a2a/src/server/a2a-server.ts`
+ `http-server.ts` already wrap `agent.run()`
(`packages/runtime/src/reactive-agent.ts:782`) as a network-callable server.
`rax serve` (`apps/cli/src/commands/serve.ts:15`) starts an agent as **"an
A2A server"** literally — no `--protocol mcp` flag exists.

**Design fork that must be resolved before scoping tasks:** exposing an
agent via MCP means picking one of two shapes:
1. **Agent-as-one-tool** — the whole agent is a single MCP tool
   (`run_agent(prompt) -> result`), callable from Claude Desktop/Cursor/any
   MCP host. Cheap, mirrors `.withAgentTool()`'s existing local/remote-agent-
   as-tool pattern but over the MCP wire instead of in-process.
2. **Agent's tools exposed individually via MCP** — every builtin/registered
   tool the agent has becomes its own MCP tool, so an external host drives
   the agent's tools directly rather than delegating whole tasks. More work,
   unclear demand signal yet.

**Recommendation:** ship (1) first — `.withMCPServer({transport, port})` or
a `rax serve --protocol mcp` flag, both riding the existing A2A server
plumbing pattern (swap A2A's task/message protocol for MCP's `tools/list` +
`tools/call`, same HTTP/stdio transport code can likely be shared). This is
the one that makes RA agents usable as a tool inside Claude Desktop, Cursor,
Windsurf, or any MCP host with zero glue code on the consumer side — the
single highest cross-tool-compat move available.

**Effort:** Medium (new module in `packages/a2a` or a new `packages/mcp-server`,
plus a wither/CLI flag; SDK already a dependency so no new install). **Impact:**
High — this is the actual "make RA interop with the leading tools" lever,
more so than A2A (which only other A2A-aware agents speak) since MCP is the
protocol Claude Desktop/Cursor/Windsurf/Cline all already speak natively.

## Track C — trace-format & DX compat

**Correction to initial hypothesis:** I suspected `packages/observability`
(internal OTLP exporter, `otlp-exporter.ts`) and `packages/observe`
(OpenInference-semantic OTel layer) were duplicated/conflicting. Verified
otherwise: `observability` is RA's own internal telemetry (broadly imported
across kernel/runtime — 24+ internal call sites), while `observe` is a
separate, deliberately opt-in umbrella package with its own wire-up test
(`packages/observe/tests/umbrella-wire.test.ts`) proving a real re-export
path (`reactive-agents/observe` sub-path) and a real example consumer
(anti-scaffold check baked into the test itself). Two legitimate layers, not
dead duplication — no fix needed here.

**Actual gap:** none found in trace-format compat — OpenInference is the
correct choice (it's the semantic convention Arize/Phoenix and most
LLM-observability backends standardized on; Langfuse and others accept OTLP
ingestion generically). This track is in better shape than assumed.

**DX is also more mature than assumed:** `create-reactive-agent` is a real
scaffold (`npm create reactive-agent`); `apps/cli` (`rax`) ships 20 commands
(`serve`, `deploy`, `dev`, `playground`, `demo`, `discover`, `attach`, `ps`,
…) — a real CLI dev loop, not bare `npm install`. README Quick Start already
covers builder/composition/streaming/hooks.

**Recommendation:** no dedicated Track C implementation work justified right
now. The one open thread worth a narrow follow-up (not urgent): confirm
`packages/observe`'s OpenInference span mapping covers RA's newer event
types (tool-call batching, entropy/strategy-switch events from the recent
hardening wave) — a coverage gap there would mean traces render incompletely
in Phoenix/Grafana even though the plumbing is sound. Low priority, cheap
to check later.

## Ranked recommendation

1. **Track A (file-edit tool)** — ship first. Small, isolated, immediate
   accuracy/token win on every multi-edit task, no design ambiguity left.
2. **Track B (agent-as-MCP-server)** — highest strategic leverage for "RA in
   other environments with good DX" (the user's actual ask) — this is the
   move that lets RA agents drop into Claude Desktop/Cursor/Windsurf as a
   tool with no custom glue. Needs a short design decision (agent-as-one-
   tool, confirmed above) before task breakdown, then a real plan.
3. **Track C** — no action needed now beyond the one narrow OpenInference
   coverage check, whenever convenient.

## Next step

Write full `writing-plans`-style task breakdowns for Track A and Track B
(Track A can go straight to subagent-driven-development given how bounded
it is; Track B needs the transport-sharing question against
`packages/a2a`'s server code settled first — worth a quick read of
`a2a-server.ts`/`http-server.ts` before task-sizing it).
