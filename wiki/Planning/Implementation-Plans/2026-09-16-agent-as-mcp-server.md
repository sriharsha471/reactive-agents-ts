# Agent-as-MCP-Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revised 2026-09-17** after (a) the A2A repair merged (`4fa3590f`), making `agent.serveA2A()` the real precedent, and (b) security research into the MCP authorization spec. Revisions: OAuth 2.1 resource-server mode added (Tasks 4-5), DNS-rebinding/Origin protection added (Task 3), stdio added to the CLI (Task 7), `serveMCP()` option shape aligned with `serveA2A()`, stale A2A findings section removed.

**Goal:** Let any Reactive Agents agent be exposed as an MCP server — callable from Claude Desktop, Cursor, Windsurf, Cline, and any MCP host — with a security posture that is spec-compliant for remote deployment, not just safe on loopback.

**Architecture:** A new leaf package `@reactive-agents/mcp-server` wraps the SDK's `McpServer` and registers the agent as **one** tool (`run_agent`). The agent arrives as an injected executor, so the package depends on neither `runtime` nor `reasoning`. Three auth tiers:

| Tier | Transport | Auth | When |
|---|---|---|---|
| Local process | stdio | none (OS process boundary) | Host spawns `rax serve --protocol mcp --transport stdio` |
| Local network | streamable HTTP on loopback | none, or static bearer `token` | Dev, same-machine hosts |
| Remote | streamable HTTP, non-loopback | static bearer `token` **or** OAuth 2.1 resource server | Shared/multi-tenant deployment |

All HTTP goes through `secureServe` (fail-closed: non-loopback bind without auth throws). The runtime exposes `await agent.serveMCP()` returning a stop handle, mirroring `agent.serveA2A()`.

**Tech Stack:** TypeScript (strict), `@modelcontextprotocol/sdk@^1.29.0` (installed: 1.29.0, `LATEST_PROTOCOL_VERSION = "2025-11-25"`), `jose@^6` for JWT/JWKS, `bun:test`, `secureServe` from `@reactive-agents/runtime-shim`.

**Spec:** No separate RA spec. External authority: MCP specification, Authorization section (modelcontextprotocol.io/specification/…/basic/authorization) and Streamable HTTP transport section. Scoping doc: `wiki/Planning/Implementation-Plans/2026-09-16-capability-expansion-scoping.md` (Track B).

---

## Research basis

### Verified against installed code (2026-09-17)

- **SDK auth helpers are Express-only.** `requireBearerAuth` returns an Express `RequestHandler` (`sdk/dist/esm/server/auth/middleware/bearerAuth.d.ts:1,34`); `mcpAuthMetadataRouter` returns `express.Router` (`server/auth/router.d.ts:88`). RA serves web-standard `Request → Response` via `secureServe`, so these cannot be used directly. **Reusable:** the types `OAuthTokenVerifier` (`server/auth/provider.d.ts:62`), `AuthInfo` (`server/auth/types.d.ts`, includes `resource?: URL` for RFC 8707), `OAuthProtectedResourceMetadataSchema` (`shared/auth.d.ts:9`), `getOAuthProtectedResourceMetadataUrl` (`server/auth/router.d.ts:100`), and `WebStandardStreamableHTTPServerTransport.handleRequest(req, { authInfo })` (`server/webStandardStreamableHttp.d.ts:116,201`).
- **Transport has DNS-rebinding protection built in:** `allowedHosts`, `allowedOrigins`, `enableDnsRebindingProtection` (`webStandardStreamableHttp.d.ts:84-96`).
- **`jose` is not a direct dependency of any package** (only transitive via the SDK). Must be declared.
- **`secureServe`** (`packages/runtime-shim/src/secure-serve.ts`) supports only a static token: constant-time compare, 401 with bare `WWW-Authenticate: Bearer`, 1 MiB body cap, throws on non-loopback without `token`. No hook for pluggable auth — Task 4 adds one.
- **`serveA2A()` shape** (`packages/runtime/src/reactive-agent.ts:977-986`): every option optional — `{ port?, description?, hostname?, token?, name?, basePath? }`, `name` defaults to `this._name ?? this.agentId`, returns `{ port, stop() }`. Its executor maps `result.success === false` to a failure using `result.error ?? abstention reason ?? output` — `serveMCP()` must reuse that exact message logic, not reinvent it.
- **CLI env vars** are now `RA_A2A_HOST`/`RA_A2A_TOKEN` with `RA_SERVE_*` as deprecated fallback (`apps/cli/src/commands/serve.ts:143-144`).
- **MCP client** (`packages/tools/src/mcp/mcp-client.ts:384,390`) sends only static headers — RA cannot consume OAuth-protected remote MCP servers. Out of scope here; see Follow-ups.

### MCP authorization requirements (from spec research)

RA's MCP server is an **OAuth resource server only**. It never hosts an authorization server, never issues tokens, never does dynamic client registration.

| Requirement | Source | Status for resource server | This plan |
|---|---|---|---|
| OAuth 2.1 bearer tokens on HTTP transport | MCP Authorization | Required when auth is used on HTTP | Task 5 |
| Stdio transport uses environment credentials, not OAuth | MCP Authorization | Spec carve-out | Task 7 (stdio has no auth layer) |
| Protected Resource Metadata at `/.well-known/oauth-protected-resource` | RFC 9728 | MUST | Task 5 |
| `WWW-Authenticate: Bearer resource_metadata="…"` on 401 | RFC 9728 §5.1 | MUST | Task 5 |
| Token audience bound to this server (reject tokens minted for others) | RFC 8707 | MUST validate | Task 5 |
| No token passthrough to upstream APIs | MCP Security Best Practices | MUST NOT | Global Constraint + Task 6 test |
| `Origin` header validation / DNS-rebinding protection | Streamable HTTP transport | MUST validate Origin | Task 3 |
| Bind localhost when running locally | Streamable HTTP transport | SHOULD | Already `secureServe` default |
| HTTPS for non-loopback authorization endpoints | OAuth 2.1 | MUST | Task 5 (validate `resource` URL scheme) |
| Authorization Server Metadata (RFC 8414), PKCE, DCR (RFC 7591) | OAuth 2.1 / MCP | Obligations on the **authorization server and client**, not the resource server | Not implemented — external IdP's job |
| Scope challenge on insufficient scope (403 `insufficient_scope`) | RFC 6750 §3.1 | SHOULD | Task 5 |

### Threat → mitigation → pinning test

| Threat | Mitigation | Test |
|---|---|---|
| Confused deputy / token replay from another resource | `aud` MUST contain the configured canonical `resource` URI | T5: token with foreign `aud` → 401 |
| Token passthrough | Executor receives input only; bearer token never reaches the agent | T6: grep-pin executor signature + tool runs with no token in args/env |
| Forged JWT | JWKS signature verify, algorithm allowlist (asymmetric only, never `none`/`HS*`), `iss` exact match | T5: `alg:none`, HS256-signed, wrong-issuer tokens → 401 |
| Expired / not-yet-valid token | `exp`/`nbf` with ≤60s clock tolerance | T5 |
| Custom verifier silently skips audience | RA re-checks `AuthInfo.resource` after any custom verifier; missing `resource` → reject (fail closed) | T5 |
| DNS rebinding against loopback server | Transport `enableDnsRebindingProtection` with `allowedHosts`/`allowedOrigins` defaulted from the bind address | T3: foreign `Host`/`Origin` → 403 |
| Unauthenticated network exposure | `secureServe` throws on non-loopback bind without token or authenticator | T3, T4 |
| Session hijacking | Stateless transport (no session IDs). If stateful mode is ever added, IDs MUST be `crypto.randomUUID()` and bound to the auth principal | Design constraint, noted in code comment |
| Token leakage via logs/errors | Never log `Authorization` header or token; error bodies never echo the token | T5: 401 body does not contain the token |
| Oversized request DoS | `secureServe` 1 MiB cap already applies before auth runs | Existing `secure-serve.test.ts` |

### Claims NOT verified — Task 0 must resolve before Task 5

The research pass reported a **2026-07-28 MCP spec revision** that (a) makes RFC 9728 and RFC 8707 MUST-level and (b) adds RFC 8693 Token Exchange and standardized scope step-up. The installed SDK's latest protocol version is `2025-11-25`, and this could not be confirmed from source. Task 0 checks the live spec. If RFC 8693 is confirmed as a *resource-server* obligation, add it as a follow-up plan — do not expand Task 5.

---

## Global Constraints

- Strict TypeScript. No `any`, no new `as unknown as` (repo gate ceiling 78, currently 79 — do not add).
- `packages/mcp-server` must NOT import `@reactive-agents/runtime` or `@reactive-agents/reasoning`. The agent arrives as an injected executor.
- Library code never calls `process.exit` (precedent: `packages/tools/src/mcp/mcp-client.ts:115-120`). `apps/cli` may.
- New package version `0.16.0` (`check-version-sync.sh` enforces).
- Use `McpServer` + `registerTool`, not the deprecated low-level `Server` / `tool()` overloads.
- All HTTP goes through `secureServe`. Never call `Bun.serve` directly.
- **Security constraints (binding, reviewers check each):**
  - The bearer token (static or OAuth) MUST NOT be passed to the executor, the agent, any tool, logs, or error bodies.
  - Every auth failure path fails closed. Missing config, unreachable JWKS, verifier throw, missing `resource` on `AuthInfo` → reject the request, never allow.
  - `token` and `oauth` are mutually exclusive — passing both throws at startup.
  - No new dependency beyond `jose`. No auth logic copied from blog posts; behavior is derived from the RFCs cited above and pinned by tests.
  - Auth tests use real signed JWTs (generate a key pair with `jose` in the test) and a real JWKS served from a local ephemeral HTTP server. No mocked verifier for the security-property tests.

---

### Task 0: Verify the current MCP authorization spec

**Files:** none (research only). Record findings in the task report and, if anything differs from the Research basis table above, amend this plan file in the same commit.

- [ ] **Step 1:** Fetch the current MCP specification Authorization page and Streamable HTTP transport page from modelcontextprotocol.io. Note the spec revision date.
- [ ] **Step 2:** For each row of the requirements table, confirm or correct the requirement level (MUST/SHOULD) with a quoted sentence from the spec.
- [ ] **Step 3:** Confirm or refute the reported 2026-07-28 revision and whether RFC 8693 Token Exchange is a resource-server obligation.
- [ ] **Step 4:** Check npm for the latest `@modelcontextprotocol/sdk` version. If a newer version supports a newer protocol revision, record it. Do **not** bump the dependency in this task — note it as a ruling for the controller.
- [ ] **Step 5:** Commit any plan amendment: `docs(plan): verify MCP authorization spec requirements`.

---

### Task 1: Scaffold the `@reactive-agents/mcp-server` package

**Files:**
- Create: `packages/mcp-server/package.json`, `tsconfig.json`, `src/index.ts`, `README.md`

- [ ] **Step 1: package.json** — use the structure of an existing leaf package. Dependencies:

```json
{
  "name": "@reactive-agents/mcp-server",
  "version": "0.16.0",
  "description": "Expose a reactive-agents agent as an MCP server — callable from Claude Desktop, Cursor, and any MCP host",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "@reactive-agents/runtime-shim": "0.16.0",
    "jose": "^6.2.2"
  }
}
```

⚠️ Check the `exports` block against the majority convention: `grep -l '"bun": "./src' packages/*/package.json | wc -l` versus `'"bun": "./dist'`. Follow the majority (most packages point `bun` at `./src`, so edits are live with no rebuild). Fill `keywords`, `repository.directory`, `homepage`, `bugs`, `publishConfig`, `files`, `scripts` to match siblings.

- [ ] **Step 2: tsconfig** — copy a sibling leaf package's verbatim.
- [ ] **Step 3: Stub entrypoint** exporting from `./agent-mcp-server.js` (red until Task 2 — intended).
- [ ] **Step 4:** `bun install`; confirm `node_modules/@reactive-agents/mcp-server` symlinks to the package.
- [ ] **Step 5: Commit** `chore(mcp-server): scaffold the @reactive-agents/mcp-server package`

---

### Task 2: The MCP server — agent as one tool, any transport

**Files:**
- Create: `packages/mcp-server/src/agent-mcp-server.ts`
- Test: `packages/mcp-server/tests/agent-mcp-server.test.ts`

**Interfaces produced:**
- `type AgentExecutor = (input: string, context: { readonly signal?: AbortSignal }) => Promise<{ readonly output: string; readonly success: boolean }>`
- `interface AgentMcpServerOptions { name: string; description: string; version?: string; executor: AgentExecutor; toolName?: string }`
- `interface AgentMcpServerHandle { readonly server: McpServer; connect(transport: Transport): Promise<void>; close(): Promise<void> }`
- `createAgentMcpServer(options): AgentMcpServerHandle`

The executor's `context` deliberately carries **no auth information**. That is the no-passthrough boundary.

- [ ] **Step 1: Write the failing test** using `InMemoryTransport.createLinkedPair()` (real protocol round-trip, not a mock). Cases:
  1. Advertises exactly one tool, default name `run_agent`, description contains the configured description.
  2. **RED-ON-CUT:** `tools/call` invokes the executor with the caller's `input`, and the output reaches the client.
  3. `success: false` → `isError: true` with the output text.
  4. Executor throw → `isError: true` with the message; server still answers `tools/list` afterward.
  5. Custom `toolName` honored.
  6. Missing/non-string `input` → MCP input-validation error, executor NOT called.
- [ ] **Step 2:** Run, confirm FAIL.
- [ ] **Step 3: Implement.** `registerTool` signature: `sdk/dist/esm/server/mcp.d.ts:150-157`. Use a Zod shape `{ input: z.string().min(1) }` if `zod` is already a workspace dependency (`grep -rn '"zod"' packages/*/package.json`); otherwise pick the overload needing no new package and record the choice. Pass the tool callback's `extra.signal` into the executor context so host cancellation (`notifications/cancelled`) reaches the agent. Catch executor throws and return `isError: true` — a failed run must not take the server down.
- [ ] **Step 4:** Run, confirm PASS (6 tests). `bunx tsc --noEmit` clean, no casts.
- [ ] **Step 5: Commit** `feat(mcp-server): expose an agent as a single MCP tool over any transport`

---

### Task 3: Streamable HTTP on `secureServe`, with Origin/Host validation

**Files:**
- Create: `packages/mcp-server/src/http.ts`
- Modify: `packages/mcp-server/src/index.ts`
- Test: `packages/mcp-server/tests/http-transport.test.ts`

**Interfaces produced:**
- `interface ServeAgentMcpHttpOptions extends AgentMcpServerOptions { port?: number; hostname?: string; token?: string; path?: string; allowedOrigins?: readonly string[] }`
- `serveAgentMcpHttp(options): Promise<{ readonly port: number; readonly url: string; stop(): Promise<void> }>`

`path` defaults to `/mcp`. Requests to any other path get 404.

- [ ] **Step 1: Read** `webStandardStreamableHttp.d.ts:40-146` for the option names and the stateless-mode rule (omit `sessionIdGenerator` ⇒ stateless). Do not rely on this plan for option names.
- [ ] **Step 2: Write the failing test.** Bind on port 0, drive with the SDK's `StreamableHTTPClientTransport` against the real URL. Cases:
  1. **RED-ON-CUT:** real HTTP client reaches the executor.
  2. Non-loopback bind without `token` rejects with `/refusing to bind non-loopback/` (inherited `secureServe` property — if red, the implementation bypasses `secureServe`).
  3. With `token`: request without `Authorization` → 401; with correct bearer → success.
  4. **DNS rebinding:** a raw `fetch` with `Host: evil.example` → 403 (or the transport's rejection status — read the source and pin the actual one). A raw `fetch` with `Origin: https://evil.example` → rejected. A request with no `Origin` (non-browser client) → allowed.
  5. Request to `/other` → 404.
- [ ] **Step 3:** Run, confirm FAIL.
- [ ] **Step 4: Implement.** Stateless transport. Enable `enableDnsRebindingProtection`. Default `allowedHosts` to `["127.0.0.1:<port>", "localhost:<port>", "[::1]:<port>"]` for a loopback bind — note the port is only known after bind with `port: 0`, so construct the transport after `secureServe` resolves or read how the transport matches hosts and handle it. For a non-loopback bind, require the caller to supply `allowedOrigins`/`allowedHosts` explicitly or derive them from `hostname:port`; record the ruling. Comment on the stateless choice: if stateful mode is added later, session IDs MUST be `crypto.randomUUID()` and bound to the authenticated principal.
- [ ] **Step 5:** `bun test packages/mcp-server` PASS.
- [ ] **Step 6: Commit** `feat(mcp-server): serve an agent over streamable HTTP with Origin/Host validation`

---

### Task 4: `secureServe` pluggable authenticator

**Files:**
- Modify: `packages/runtime-shim/src/secure-serve.ts`
- Test: `packages/runtime-shim/tests/secure-serve.test.ts` (extend)

**Why here and not in `mcp-server`:** the fail-closed "no non-loopback bind without auth" rule lives in `secureServe`. OAuth mode must satisfy that rule through the same boundary, not by passing a dummy token or adding a bypass flag.

**Interface produced (additive — existing callers unchanged):**

```ts
export type AuthenticateResult<TAuth> =
  | { readonly ok: true; readonly auth: TAuth }
  | { readonly ok: false; readonly response: Response };

export interface SecureServeOptions<TAuth = undefined> extends Omit<ServeOptions, "fetch"> {
  readonly token?: string;
  readonly authenticate?: (req: Request) => Promise<AuthenticateResult<TAuth>>;
  readonly maxBodyBytes?: number;
  readonly fetch: (req: Request, auth: TAuth | undefined) => Response | Promise<Response>;
}
```

Adjust names/generics to what compiles cleanly against the existing `ServeOptions` in `packages/runtime-shim/src/types.ts` and the 5 existing callers (`a2a`, `health`, `judge-server`, `cli serve`, tests). Existing callers pass a one-argument `fetch` — confirm that still type-checks without edits.

- [ ] **Step 1: Write failing tests:**
  1. `token` and `authenticate` both set → rejects at startup.
  2. Non-loopback bind with `authenticate` and no `token` → allowed to bind.
  3. `authenticate` returning `{ ok: false, response }` → that response is returned; `fetch` never called.
  4. `authenticate` throwing → 401, `fetch` never called (fail closed), and the thrown message is not in the body.
  5. `authenticate` success → `fetch` receives the `auth` value.
  6. Body-size cap still runs **before** `authenticate` (oversized request → 413, `authenticate` never called — prevents spending JWKS/crypto work on junk).
- [ ] **Step 2:** Run, confirm FAIL. **Step 3:** Implement. **Step 4:** `bun test packages/runtime-shim` plus the existing A2A/health/judge-server suites green.
- [ ] **Step 5: Commit** `feat(runtime-shim): pluggable fail-closed authenticator for secureServe`

---

### Task 5: OAuth 2.1 resource-server mode

**Blocked by Task 0.** If Task 0 changed any requirement level, follow the amended table.

**Files:**
- Create: `packages/mcp-server/src/oauth.ts`
- Modify: `packages/mcp-server/src/http.ts`, `src/index.ts`
- Test: `packages/mcp-server/tests/oauth.test.ts`

**Interfaces produced:**

```ts
export interface McpOAuthOptions {
  /** Canonical URI of this MCP server, e.g. "https://agents.example.com/mcp". Tokens MUST be minted for it (RFC 8707). */
  readonly resource: string;
  /** Authorization server issuer(s) listed in protected-resource metadata. JWT `iss` must match one exactly. */
  readonly authorizationServers: readonly string[];
  /** JWKS endpoint. Required for the built-in JWT verifier. */
  readonly jwksUri?: string;
  /** Scopes every call requires. Advertised as `scopes_supported`. */
  readonly requiredScopes?: readonly string[];
  /** Accepted JWS algorithms. Default ["RS256", "ES256", "EdDSA"]. Symmetric and "none" are rejected even if listed. */
  readonly algorithms?: readonly string[];
  /** Escape hatch for opaque tokens (e.g. RFC 7662 introspection). RA still enforces `resource` and scopes on its result. */
  readonly verifier?: OAuthTokenVerifier;
}
```

`ServeAgentMcpHttpOptions` gains `oauth?: McpOAuthOptions`, mutually exclusive with `token`.

- [ ] **Step 1: Write the failing tests.** Generate an asymmetric key pair with `jose` in the test; serve its JWKS from a real ephemeral local HTTP server. Mint tokens with `jose.SignJWT`. Cases:
  1. **Metadata:** `GET /.well-known/oauth-protected-resource` (and the path-suffixed form for `/mcp` per RFC 9728 §3.1 — confirm which the spec requires) returns JSON that parses with `OAuthProtectedResourceMetadataSchema`, with `resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported: ["header"]`. Served without auth.
  2. No token → 401 with `WWW-Authenticate: Bearer resource_metadata="<metadata url>"`.
  3. Valid token (correct `iss`, `aud` = resource, scopes, unexpired) → tool call succeeds, executor runs.
  4. **Confused deputy:** `aud` = a different resource → 401, executor not called.
  5. Wrong `iss` → 401. Expired → 401. `nbf` in the future → 401.
  6. **Algorithm attacks:** `alg: "none"` unsigned token → 401. HS256 token signed with the public key bytes as secret → 401. Token signed by a different key not in JWKS → 401.
  7. Missing required scope → 403 with `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`.
  8. JWKS server down → 401 (fail closed), not 500 and not allow.
  9. Custom `verifier` returning `AuthInfo` without `resource` → 401. With a mismatched `resource` → 401.
  10. **No leakage:** no 401/403 body or header contains the token string.
  11. `token` + `oauth` both set → startup throws.
  12. `resource` with `http://` scheme and a non-loopback hostname → startup throws (OAuth 2.1 requires HTTPS; loopback `http` allowed for dev).
  13. **RED-ON-CUT:** removing the `aud` check makes test 4 go green-for-the-attacker — verify by mutation, restore, record both runs in the report.
- [ ] **Step 2:** Run, confirm FAIL.
- [ ] **Step 3: Implement** as an `authenticate` function passed to `secureServe` (Task 4):
  - Extract bearer from the `Authorization` header only (never query string).
  - Built-in path: `jose.createRemoteJWKSet(new URL(jwksUri))` + `jose.jwtVerify(token, jwks, { issuer, audience: resource, algorithms, clockTolerance: 60 })`. Build `AuthInfo` from claims (`client_id`/`azp`, space-delimited `scope`, `exp`, `resource`).
  - Custom verifier path: call it, then enforce `AuthInfo.resource` equals `resource` (ignoring hash fragment) — reject when missing.
  - Enforce `requiredScopes` on both paths.
  - Pass `AuthInfo` into `transport.handleRequest(req, { authInfo })`. It must not flow into the executor.
  - Serve the metadata route before authentication.
  - Filter `algorithms` to asymmetric algorithms at startup; throw if the result is empty.
- [ ] **Step 4:** `bun test packages/mcp-server` PASS. `tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(mcp-server): OAuth 2.1 resource-server mode (RFC 9728, RFC 8707)`

---

### Task 6: `agent.serveMCP()` — mirror `serveA2A()`

**Files:**
- Modify: `packages/runtime/package.json` (add `@reactive-agents/mcp-server: 0.16.0`)
- Modify: `packages/runtime/src/reactive-agent.ts` (method next to `serveA2A()`, ~L977)
- Test: `packages/runtime/tests/mcp-server-wiring.test.ts`

**Interface produced:**

```ts
async serveMCP(options?: {
  readonly port?: number
  readonly description?: string
  readonly hostname?: string
  readonly token?: string
  readonly oauth?: McpOAuthOptions
  readonly name?: string
  readonly toolName?: string
  readonly path?: string
}): Promise<{ readonly port: number; readonly url: string; stop(): Promise<void> }>
```

Defaults match `serveA2A()`: `name = options.name ?? this._name ?? this.agentId`. `description` defaults to a generic "Runs the <name> agent on a task" string. Default port 3001 (A2A uses 3000 — avoid collision when both run).

- [ ] **Step 1: Extract the shared failure-message logic.** `serveA2A()`'s executor computes the decline message (`result.error ?? abstention reason ?? output ?? 'Agent declined…'`) inline. Extract it to a private helper and use it from both methods. Two copies would drift.
- [ ] **Step 2: Write the failing wiring test** (copy a working `.withTestScenario()` from `packages/runtime/tests`):
  1. **RED-ON-CUT:** an HTTP MCP client's `tools/call` runs the real agent and returns the scenario's answer.
  2. A declining run (`success: false`) → `isError: true` with the same message `serveA2A()` would produce.
  3. **No passthrough:** with `token` set, the agent run receives only the input — assert the token string appears nowhere in the run's captured messages/trace.
  4. `name` defaults to the `.withName()` value in `tools/list` title.
- [ ] **Step 3:** Run, confirm FAIL (`agent.serveMCP is not a function`).
- [ ] **Step 4: Implement.** Pass the executor's `signal` into `run()` if `run()` accepts an abort signal; if not, do not add one — record the limitation (host cancellation doesn't stop the run) in the report and the docs. Match `serveA2A()`'s import style (static vs dynamic).
- [ ] **Step 5:** Prove red-on-cut: replace the executor body with a stub, confirm test 1 fails, restore byte-identical, confirm pass. Record both.
- [ ] **Step 6: Commit** `feat(runtime): add agent.serveMCP() to expose an agent to MCP hosts`

---

### Task 7: `rax serve --protocol mcp` (HTTP and stdio)

**Files:**
- Modify: `apps/cli/src/commands/serve.ts`

- [ ] **Step 1: Flags.** `--protocol a2a|mcp` (default `a2a`) and `--transport http|stdio` (default `http`; `stdio` only valid with `mcp`). Reject invalid values with a message naming the valid options.
- [ ] **Step 2: HTTP path.** Call `agent.serveMCP({ port, hostname, token })` with env vars `RA_MCP_HOST` / `RA_MCP_TOKEN` (no deprecated fallbacks — these are new). OAuth from the CLI is out of scope for this task: document that OAuth requires the programmatic API. Print the bound URL and the host config block:

```
MCP server listening on http://127.0.0.1:<port>/mcp

Add to your MCP host config:
  { "mcpServers": { "<name>": { "url": "http://127.0.0.1:<port>/mcp" } } }
```

- [ ] **Step 3: stdio path.** Build the agent, `createAgentMcpServer(...)`, connect a `StdioServerTransport`. **stdout is the protocol channel:** every banner, log line, and warning goes to stderr. Verify the agent's own console output (status renderer, logging) does not write to stdout in this mode — if it does, disable it for stdio and record how. Print the stdio host config block to stderr:

```
{ "mcpServers": { "<name>": { "command": "rax", "args": ["serve", "--protocol", "mcp", "--transport", "stdio"] } } }
```

- [ ] **Step 4: Help text** documents both flags and both env vars.
- [ ] **Step 5: Manual verification.** HTTP: start with `--port 0`, connect a programmatic `StreamableHTTPClientTransport`, call the tool. stdio: spawn the command with the SDK's `StdioClientTransport`, call the tool, and confirm nothing non-JSON-RPC appeared on stdout. State plainly whether a real host (Claude Desktop/Cursor) was tested or only programmatic clients.
- [ ] **Step 6: Commit** `feat(cli): rax serve --protocol mcp over HTTP and stdio`

---

### Task 8: Changeset, docs, security guide

**Files:**
- Create: `.changeset/agent-as-mcp-server.md` (`@reactive-agents/mcp-server` minor, `@reactive-agents/runtime` minor, `@reactive-agents/runtime-shim` minor, `@reactive-agents/cli` minor)
- Modify: `packages/mcp-server/README.md`
- Modify: the serving/deploying docs page (`grep -rln "serveA2A\|rax serve" apps/docs/src/content/docs/`)

- [ ] **Step 1: Changeset** — describe `agent.serveMCP()`, the three auth tiers, `rax serve --protocol mcp`, and the `secureServe` authenticator hook.
- [ ] **Step 2: README + docs** must include:
  - Host config blocks for stdio and HTTP.
  - The three-tier auth table.
  - An OAuth example against a generic IdP (issuer + JWKS + resource), and an explicit statement that the IdP must mint tokens with `aud` = the `resource` URI (RFC 8707) — the most common deployment failure.
  - What RA does **not** do: host an authorization server, DCR, token exchange; TLS termination (deploy behind a TLS proxy; `resource` must be `https`).
  - Known limitations (e.g., cancellation, if Task 6 found `run()` has no signal).
- [ ] **Step 3: Gates:** `bun run docs:examples:check`, `bun run docs:sync:check`, `bun run release:dry 0.16.1` (new package must appear in the publish set).
- [ ] **Step 4: Commit** `docs(mcp-server): document serving an agent over MCP, including OAuth`

---

## Final review focus (for the whole-branch reviewer)

Run on the most capable model. In addition to the standard review, the reviewer must:
1. Walk every row of the Threat table and confirm a test pins it and the test goes red when the mitigation is removed.
2. Grep the branch for any path where the `Authorization` header or token value reaches the executor, logs, error bodies, or trace events.
3. Confirm every auth error path fails closed (exceptions, network failures, missing fields).
4. Confirm `secureServe`'s existing callers behave identically (A2A, health, judge-server, CLI suites green).
5. Live-verify: `agent.serveMCP()` with the `test` provider over HTTP with a static token, and with OAuth against a locally-served JWKS.

---

## Follow-ups (separate plans, not this branch)

- **MCP client OAuth** — now its own plan, `2026-09-17-mcp-client-oauth.md`, executed **before** this one. Its Task 1 fixture (local authorization server + JWKS + protected MCP server) should be reused by this plan's Task 5 tests instead of building a second one.
- **Tool-descriptor trust on the client** — pin MCP tool descriptions at registration and require re-consent when a remote server mutates them mid-session (tool poisoning / rug-pull). Belongs to the agentic-security track.
- **RFC 8693 Token Exchange** — only if Task 0 confirms it as a resource-server obligation.
- **Agentic security layer** — capability-scoped tool grants per sub-agent, tool-output sanitization, intent/goal-alignment checks on tool calls. Ranked #2 in the 2026-09-17 capability gap research; next plan after this one.
