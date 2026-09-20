---
title: MCP Toolkit Scaffolding — Design Spec
date: 2026-09-19
status: SHIPPED — see "Final decision" note below before reading the rest of this doc
owner: tools-warden (implementation), main thread (spec)
---

# MCP Toolkit Scaffolding

## Final decision (2026-09-19, supersedes both the original body and the Amendment below)

Two prior approaches were tried and superseded in this same session:

1. A separate `.withMcpToolkit()` builder method (original body of this doc,
   below) — worked, but required bumping `WITHER_CEILING` 85→86, flagged by
   the human as a real trade-off needing sign-off.
2. Folding toolkit requests into `.withMCP()`'s existing parameter type via a
   *structural* guard (does the object look like a config or a toolkit
   request?) — reviewed and **rejected** (see "Amendment" section below):
   every structural rule silently misrouted at least one direction on the
   same ambiguous literal shape.

**Final, shipped design**: `.withMCP()` gained overloads discriminated on JS
*type*, not object shape — a `string` (or `string[]`) means "resolve this
catalog name via a registry"; any object (single config or array) means
"connect this literal `MCPServerConfig`," exactly as before. A string can
never be mistaken for a config object, so there is no ambiguity left, unlike
approach 2's structural guess. No new top-level method exists;
`.withMcpToolkit()` was removed after being built. `WITHER_CEILING` is back
at 85.

```ts
withMCP(config: MCPServerConfig | MCPServerConfig[]): this            // unchanged
withMCP(catalogName: string, options?: {                              // new
  registry?: string
  env?: Record<string, string>
  volumes?: MCPVolumeMount[]
}): this
withMCP(catalogNames: string[]): this                                  // new, batch, no per-entry options
```

A single call mixing strings and objects in one array (e.g.
`.withMCP(["brave-search", { name: "x", command: "y" }])`) is not supported
and throws a clear synchronous error naming the limitation — callers make two
separate `.withMCP()` calls instead.

The request-resolution logic itself (registry lookup via
`defaultRegistries[request.registry ?? "docker-hub"]`, `Promise.all` over
pending requests inside `.build()`, merge into `_mcpServers`, untransformed
error propagation) is unchanged from the original `.withMcpToolkit()`
implementation described below — only the public entry point moved.

Everything below this note describes the original (now superseded) method
name and the rejected fold-in attempt; kept as history.

---

## Goal

Let users scaffold a curated bundle of MCP servers onto an agent from a public
registry (Docker Hub's `mcp/*` catalog first) instead of hand-writing
`MCPServerConfig` objects (transport, docker args, env). Prototype validated
in `scratch.ts`: `resolveDockerMCPServer(name | name[])` fetches
`hub.docker.com/v2/repositories/mcp/<name>/`, parses `full_description`
markdown for tool schema + an `## Environment Variables`/`Configuration`/
`Secrets` section, throws on missing required input, returns a real
`MCPServerConfig` (docker stdio transport).

This spec is investigation + proposal only. No implementation yet.

## Current architecture (ground truth, tools-warden read-only pass, 2026-09-19)

All citations against current working tree.

- **Config shape**: `ConnectConfig` (`packages/tools/src/mcp/mcp-client.ts:48-63`)
  — `Pick`/`Omit` of `MCPServer` (name/transport/endpoint/command/args/cwd/env/
  headers/auth/tokenStore). `MCPServerSchema` at `packages/tools/src/types.ts:493-578`,
  extended 609-622 with caller-supplied `auth`/`tokenStore`.
- **Single connection entry point**: `connectInternal(config: ConnectConfig)`
  (`mcp-client.ts:790-897`). Validates auth config first (791 → `validateAuthConfig`,
  139-161), resolves transport (792 → `resolveTransport`, 478-485), then either
  spawns stdio (`createTransport` stdio case, 529-540) or connects HTTP-like
  (`connectHttpLike`, 925-995).
- **Public consumer boundary**: `ToolService.connectMCPServer`
  (`packages/tools/src/tool-service.ts:189-203` interface, `491-585` live impl).
  This is almost certainly what `.withMCP()` calls into on the runtime side
  (not verified — out of tools-warden's read authority — but the config shape
  matches exactly). It calls `mcpClient.connect(config)` (507), then registers
  every discovered tool with **hardcoded** `riskLevel: "medium"`,
  `requiresApproval: false`, `timeoutMs: 30_000`, `source: "mcp"` (509-559) —
  no per-server or per-origin override exists today.
- **Docker lifecycle**: two-phase naming is real —
  `rax-probe-<name>-<pid>` (800) for the initial stdio probe,
  `rax-mcp-<name>-<pid>` (642) for the HTTP-upgrade respawn. Only stop
  mechanism is `docker rm -f` (`dockerRmForce`/`dockerRmForceAwait`, 261-285),
  called on disconnect, dispose, exit, and respawn. Subprocess env is never
  full `process.env` — `buildMcpSubprocessEnv` (464-474) allowlists a fixed
  non-secret base set (444-456) plus the config's own explicit `env` map.
- **No image/command allowlist exists.** `createTransport`'s stdio case
  (529-540) spawns `config.command`/`config.args` verbatim. Grep for
  allowlist/verify/sha256/digest in `mcp-client.ts` hits only the env-var
  allowlist — nothing constrains which `docker run <image>` may be spawned.
  Confirmed gap, not a guess.
- **No schema/description sanitization**: MCP-reported tool schemas are
  type-normalized (`tool-service.ts:39-54`) but not checked for
  prompt-injection-style content in descriptions.

## Where the registry/resolver seams in — finalized

**Confirmed** (2026-09-19 follow-up pass, `builder.ts` read directly): `.withMCP()`
is synchronous storage only — `applyWithMCP` pushes onto `_mcpServers:
MCPServerConfig[]` (`builder.ts:394`, call site `1901-1904`). Actual
docker/network work (`ToolService.connectMCPServer`) happens later, inside the
already-`async` `.build()`, where `_mcpServers` is read and connected
(`builder.ts:2626-2753`, config flows straight through as the same `Pick`
shape — question 1 from the original open-questions list is now closed).

This means a toolkit builder method must **not** require `await` mid-chain —
it should store unresolved *requests* synchronously, matching the existing
`.withMCP()` pattern, and let `.build()` resolve them alongside the connection
step it already awaits.

```ts
// packages/tools/src/mcp/registry/types.ts
interface MCPVolumeMount {
  host: string
  container: string
  readOnly?: boolean
}

interface MCPToolkitRequest {
  name: string                          // catalog entry, e.g. "brave-search"
  registry?: string                     // registry id, default "docker-hub"
  env?: Record<string, string>          // required + optional vars the resolver validates
  volumes?: MCPVolumeMount[]            // dynamic bind mounts, e.g. filesystem/git servers
}

interface MCPRegistry {
  readonly id: string
  resolve(request: MCPToolkitRequest): Promise<MCPServerConfig>
}

// packages/tools/src/mcp/registry/docker-hub.ts
class DockerHubMCPRegistry implements MCPRegistry {
  readonly id = "docker-hub"
  async resolve(request: MCPToolkitRequest): Promise<MCPServerConfig> { ... }
}

// packages/tools/src/mcp/registry/index.ts
const defaultRegistries: Record<string, MCPRegistry> = {
  "docker-hub": new DockerHubMCPRegistry(),
}
```

Builder surface — sync storage, deferred resolution, mirrors `.withMCP()`
exactly:

```ts
// packages/runtime/src/builder.ts
private _mcpToolkitRequests: Array<{ request: MCPToolkitRequest; registry?: MCPRegistry }> = []

withMcpToolkit(
  requests: string | MCPToolkitRequest | Array<string | MCPToolkitRequest>,
  options?: { registry?: MCPRegistry }
): this {
  applyWithMcpToolkit(this, requests, options)   // normalizes to MCPToolkitRequest[], pushes — no network call here
  return this
}
```

At `build()` (same site that reads `_mcpServers`, `builder.ts:2626`):

```ts
const resolvedToolkitConfigs = await Promise.all(
  self._mcpToolkitRequests.map(({ request, registry }) =>
    (registry ?? defaultRegistries[request.registry ?? "docker-hub"]).resolve(request)
  )
)
const mcpServers = [...self._mcpServers, ...resolvedToolkitConfigs]
```

**Docker volumes**: `MCPServerConfig` already carries a generic `command`/`args`
pair for stdio transport (no first-class `volumes` field exists or is needed —
adding one to the shared runtime type would be a cross-cutting change for a
docker-specific concern). `DockerHubMCPRegistry.resolve()` translates
`request.volumes` into `-v host:container[:ro]` flags placed into `args`
before the image name, the same way it already does for `-e VAR` flags — this
keeps `MCPServerConfig` transport-agnostic per the existing design and confines
the docker-specific mapping to the registry implementation, not the shared type.

`MCPRegistry` as an interface (not a hardcoded Docker Hub call) keeps the door
open for other registries (npx-based, a private org catalog) without an API
change later.

## Security review (must be addressed, not deferred)

The confirmed gap above (no image/command allowlist, no signature check) means
a toolkit-scaffolding feature is a **strict increase** in untrusted-code-
execution surface: it turns "type any string" into "run any `mcp/<string>`
Docker image," and the Hub API's `full_description` even publishes a cosign
verification command per image (`COSIGN_REPOSITORY=mcp/signatures cosign
verify mcp/<name> --key ...`) that nothing currently checks.

Minimum bar before shipping — **resolved**:

1. **Risk-tier elevation** (was open question 3): per-`MCPRegistry`-implementation
   concern, config-time, not a global `tool-service.ts` change. Add one optional
   field to `MCPServerConfig` (`packages/runtime/src/runtime-types.ts`):
   `defaultRiskLevel?: RiskLevel`. `ToolService.connectMCPServer`
   (`tool-service.ts:509-559`) changes its hardcode from `riskLevel: "medium"`
   to `riskLevel: config.defaultRiskLevel ?? "medium"` — a one-line,
   backward-compatible change (existing hand-written configs get identical
   behavior; only configs that set the field change). `DockerHubMCPRegistry`
   sets `defaultRiskLevel: "high"` unless the caller overrides it.
2. **Approval gate** (was open question 2): reject interactive prompting —
   breaks CI/non-interactive use, and nothing else in the builder chain blocks
   on stdin. Reuse the existing persisted-store pattern already established for
   `tokenStore` (`~/.reactive-agents/mcp-auth`, `runtime-types.ts:105-113`):
   add `~/.reactive-agents/mcp-approvals` keyed by image digest. First resolve
   of an unapproved `mcp/<name>` throws `MCPApprovalRequiredError` naming the
   image + digest + the exact approval command to run; a small
   `rax mcp approve <image>` CLI (mirrors the existing `rax mcp login` verb)
   writes the approval record after showing the image's cosign-verify command
   output. No new dependency, no interactive prompt inside `build()`.
3. **Digest pinning**: resolver stores the resolved digest (from the Hub API's
   image manifest, not the mutable tag) in the approval record; a later
   `resolve()` for the same name re-checks the current digest against the
   approved one and throws (not silently re-approves) if the image changed
   upstream.

## Phased plan

- **MVP**: `DockerHubMCPRegistry.resolve()` (promotes `scratch.ts` prototype)
  + the approval-gate (`MCPApprovalRequiredError` + `rax mcp approve`) +
  `defaultRiskLevel: "high"`. This is the actual minimum-safe MVP — resolved
  open question 4: ship gated by default, not ungated with a warning in docs.
  No catalog browsing yet; user must know the exact server name.
- **V2**: cosign signature verification wired into `rax mcp approve` (verify
  before recording approval, not just display the command) — makes the
  approval step itself trust-bearing instead of just user-attention-bearing.
- **V3**: catalog browse/search (the 245-entry `mcp/` namespace listing),
  additional registry implementations (npx-based, private org catalog).

## Open questions — remaining

All four original questions are resolved above except the one genuinely
outside this pass's authority:

1. ~~Does `.withMCP()`'s runtime-side call site match `ToolService.connectMCPServer`'s
   shape?~~ **Confirmed yes** — `builder.ts:394,1901-1904,2626-2753` (see
   "Where the registry/resolver seams in" above).
2. ~~Confirmation gate mechanism~~ **Resolved**: persisted digest-keyed approval
   store + CLI verb, no interactive prompt.
3. ~~Risk-tier elevation~~ **Resolved**: `MCPServerConfig.defaultRiskLevel`
   passed through per-registry, one-line `tool-service.ts` change.
4. ~~Should MVP ship without any protection~~ **Resolved**: no — approval gate
   is part of MVP, not deferred to V2.

Genuinely open, for the human: is `~/.reactive-agents/mcp-approvals` (new
store) acceptable, or should approvals live in the same file as
`mcp-auth`/`mcp-tokens` to avoid a third dotfile under `~/.reactive-agents/`?

## Amendment (2026-09-19, runtime-warden): fold-in into `.withMCP()` reviewed and rejected

The human asked runtime-warden to fold `.withMcpToolkit()`'s request-shaped
input into the existing `.withMCP()` method (widening its parameter type)
instead of shipping a new top-level builder method, to avoid a
`WITHER_CEILING` bump. **Reviewed and rejected — `.withMcpToolkit()` stays
separate.** `WITHER_CEILING` stays at 86.

**Concrete ambiguity found**: `MCPServerConfig` (`runtime-types.ts:32`)
requires only `name: string` — every other field (`command`, `endpoint`,
`transport`, `env`, ...) is optional. `MCPToolkitRequest`
(`packages/tools/src/mcp/registry/types.ts:26-36`) is `{ name: string;
registry?: string; env?: Record<string,string>; volumes?: MCPVolumeMount[] }`.
The literal object `{ name: "brave-search", env: { BRAVE_API_KEY: "..." } }`
— the exact shape the design spec's own usage example needs to express (a
catalog entry name plus credentials) — is **simultaneously a fully
type-valid, if incomplete, `MCPServerConfig`**. There is no structural
discriminator that resolves this correctly in both directions:

- A guard that treats "no `command`/`endpoint`/`transport`" as "this must be
  a toolkit request" would silently reroute a hand-written config where the
  caller simply forgot `command` (a typo/omission) into a **network fetch
  against the public Docker Hub catalog** by that same name — trading a
  clear, existing local validation error
  (`packages/tools/src/mcp/mcp-client.ts:478-484`,
  `resolveTransport`'s `"cannot infer transport — provide either a command or
  an endpoint"`) for a silent attempt to provision a same-named container,
  which is worse if the name happens to collide with a real catalog entry
  (e.g. `"filesystem"` is a plausible `mcp/*` catalog name) — an unrelated
  service gets scaffolded with no error at all.
- A guard requiring an extra positive signal (bare string, or `registry`, or
  `volumes` present) to call it a toolkit request is safer against that
  false-positive, but then the *documented* `{ name, env }`-only toolkit
  request (no `registry`/`volumes` needed) is misclassified the other way —
  pushed straight into `_mcpServers` unresolved, never routed through the
  registry, silently breaking the feature's own primary use case.

Every discriminator rule tested fails at least one direction on the same
literal shape — this is exactly the "real ambiguity that would misroute a
user's config silently" bar for keeping the methods separate, not merely
"more code." `.withMcpToolkit()` and its `_mcpToolkitRequests` queue /
`build()`-time resolution therefore remain as originally built
(`packages/runtime/src/builder.ts:1920-1959, 2483-2503`); `.withMCP()`'s
parameter type (`MCPServerConfig | MCPServerConfig[]`) is unchanged.
