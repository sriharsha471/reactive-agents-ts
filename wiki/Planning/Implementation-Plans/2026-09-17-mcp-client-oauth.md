# MCP Client OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Reactive Agents agents connect to OAuth-protected remote MCP servers — for example hosted SaaS MCP servers that require a user login, and internal servers protected by an enterprise identity provider — with security that holds up against the known MCP client attack classes.

**Sequencing:** Runs **before** `2026-09-16-agent-as-mcp-server.md`. The test fixture built in Task 1 (a local OAuth authorization server plus a protected MCP server) is reusable when that plan's Task 5 builds the resource-server side.

**Architecture:** `MCPServerConfig` gains an `auth` field. `packages/tools/src/mcp/mcp-client.ts` turns it into an SDK `OAuthClientProvider` and passes it as `authProvider` to `StreamableHTTPClientTransport` / `SSEClientTransport`. The SDK already performs discovery, PKCE, resource selection, token exchange, refresh, and dynamic client registration. RA adds what the SDK leaves to the host application:

1. **Grant selection** — machine-to-machine grants (headless, default for agents) and the interactive authorization-code grant (a human logs in once).
2. **Token storage** — pluggable store; default is a permission-restricted file store keyed by server URL.
3. **Interactive flow** — loopback redirect listener, `state` validation, safe browser launch, timeout.
4. **Hardening** — every gap Task 0 finds in SDK behavior, enforced in an RA wrapper around the provider.
5. **CLI** — `rax mcp login | logout | status` so headless agents can use pre-authorized tokens.

**Tech Stack:** TypeScript (strict), `@modelcontextprotocol/sdk@^1.29.0` (installed 1.29.0, protocol `2025-11-25`), `jose` (test fixture only, unless Task 0 requires it at runtime), `bun:test`.

**Spec:** External authority — MCP specification, Authorization section (client requirements) and Security Best Practices page; RFC 6749, OAuth 2.1 draft, RFC 7636 (PKCE), RFC 8252 (native apps / loopback redirect), RFC 8414, RFC 8707, RFC 9728, RFC 7591.

---

## Research basis

### Verified against installed code (2026-09-17)

- **RA today:** `createTransport` (`packages/tools/src/mcp/mcp-client.ts:363-398`) builds HTTP transports with `{ requestInit: { headers } }` only. The Docker auto-upgrade path builds a second pair of HTTP transports at `mcp-client.ts:513-515`, also headers-only. There is no OAuth support. A static bearer token can be sent through `headers` today — that stays supported.
- **Config types exist in two places:** `MCPServerConfig` (`packages/runtime/src/runtime-types.ts:28`) and `MCPServer` (`packages/tools/src/types.ts`). Both need the new field. `.withMCP()` is at `packages/runtime/src/builder.ts:1875`.
- **SDK client auth surface** (`sdk/dist/esm/client/`):
  - `OAuthClientProvider` interface (`auth.d.ts:15`): `redirectUrl`, `clientMetadata`, `clientMetadataUrl?`, `state?()`, `clientInformation()`, `saveClientInformation?()`, `tokens()`, `saveTokens()`, `redirectToAuthorization()`, `saveCodeVerifier()`, `codeVerifier()`, `addClientAuthentication?`, `invalidateCredentials?(scope)` (`:105`), `saveDiscoveryState?` / `discoveryState?` (`:153,165`).
  - Both HTTP transports accept `authProvider` and expose `finishAuth(authorizationCode)` (`streamableHttp.d.ts:73,139`; `sse.d.ts:28,76`). Without a provider, an auth-required server throws `UnauthorizedError` (`auth.d.ts:179`).
  - `auth(provider, { serverUrl, authorizationCode?, scope?, resourceMetadataUrl? })` (`auth.d.ts:214`) runs the whole flow and is usable outside a transport — this is what `rax mcp login` calls.
  - Ready-made providers (`auth-extensions.d.ts`): `ClientCredentialsProvider` (`:62`, client_secret_basic), `PrivateKeyJwtProvider` (`:125`), `StaticPrivateKeyJwtProvider` (`:173`).
  - Helpers: `isHttpsUrl` (`:225`), `selectResourceURL` (`:226`), `discoverOAuthServerInfo` (`:332`), `registerClient` (`:444`), `refreshAuthorization` (`:396`); `withOAuth` fetch middleware (`middleware.d.ts:34`).
- **No existing credential store, keychain integration, or browser-launch helper** anywhere in `packages/*/src` or `apps/cli/src`. RA's per-user state lives under `~/.reactive-agents/` (e.g. `packages/diagnose/src/lib/resolve.ts:44`).
- **CLI** has no `mcp` command (`apps/cli/src/commands/`).

### Client-side threats

| Threat | Mitigation | Pinning test |
|---|---|---|
| **Command injection via `authorization_endpoint`** (CVE-2025-6514 class: a malicious server supplies an endpoint URL that is passed to a shell to open a browser) | Parse with `new URL`; allow only `https:` (or `http:` on loopback hosts); launch the browser with an argv array, never a shell string; reject URLs containing control characters | T4: endpoint `file:///…`, `javascript:…`, and `https://x/$(touch pwned)` never reach a spawn; spawn receives the URL as a single argv element |
| **Authorization server mix-up / metadata spoofing** | `issuer` in RFC 8414 metadata must equal the discovered authorization-server URL (RFC 8414 §3.3); authorization server must be listed in the resource's RFC 9728 `authorization_servers` | T5: mismatched `issuer` → connection refused |
| **Token sent to the wrong server** (token for server A replayed to server B) | Tokens keyed by canonical resource URL, never by config `name`; `resource` parameter (RFC 8707) sent on authorize and token requests; changing a config's `endpoint` never reuses the old token | T2 + T3: two configs, same `name`, different endpoints → separate tokens; `resource` present on both requests (fixture asserts) |
| **Authorization-code interception** | PKCE with `S256` only; refuse to proceed if the authorization server's metadata does not advertise `S256` in `code_challenge_methods_supported` | T4: fixture advertising only `plain` → refused |
| **CSRF on redirect** | Cryptographically random `state` per attempt; callback with a missing or mismatched `state` is rejected and the listener keeps waiting until timeout | T4 |
| **Redirect listener abuse** | Bind `127.0.0.1` only; ephemeral port; accept only `GET` on the exact callback path; single use; close after the first valid callback or timeout (default 5 min) | T4 |
| **Downgrade to plaintext** | Resource server URL, authorization endpoint, token endpoint, and registration endpoint must be `https:` unless the host is loopback | T5 |
| **Token theft at rest** | File store: directory `0700`, files `0600`, atomic write (temp file + rename); refuse to read a token file whose mode allows group/other access (same rule as OpenSSH private keys) | T2 |
| **Token leakage into the agent** | Tokens and `Authorization` headers never appear in tool results, error messages surfaced to the model, trace events, or `RAX_DEBUG` logs; SDK error messages are sanitized before wrapping in `MCPConnectionError` | T6 |
| **Credentials on stdio transport** | Spec: stdio servers get credentials from the environment, not OAuth. `auth` on a `stdio` config is a config error | T3 |
| **Silent interactive prompt in unattended runs** | The authorization-code grant never opens a browser from inside `agent.run()` unless `interactive: true` is set explicitly; otherwise it fails with an actionable `rax mcp login <name>` message | T4 |
| **Tool-description poisoning after login** | Out of scope — tracked in the agentic-security plan. Noted so reviewers don't expect it here. | — |

### Claims to verify in Task 0

The research pass (2026-09-17) reported a 2026-07-28 MCP spec revision (RFC 8707 on clients as MUST, RFC 8693 token exchange, scope step-up). The installed SDK targets `2025-11-25`. Task 0 resolves this and checks the SDK's actual client behavior for each "SDK handles it" assumption above.

---

## Global Constraints

- Strict TypeScript. No `any`, no new `as unknown as` (ceiling 78, currently 79).
- Library code never calls `process.exit`. Never opens a browser unless `interactive: true` is explicitly configured (the CLI `login` command sets it).
- Reuse SDK providers and flow functions. Do not reimplement discovery, PKCE generation, or token exchange. RA code wraps the SDK only where Task 0 finds a gap, and each wrapper cites the gap.
- **Security constraints (binding, reviewers check each):**
  - Tokens, refresh tokens, client secrets, code verifiers, and authorization codes never appear in logs, errors surfaced to the model, trace events, or tool output.
  - Every failure path fails closed — no fallback to an unauthenticated connection when auth was configured.
  - Token store keys are derived from the canonical resource URL (scheme + host + port + path, no fragment), never from `name`.
  - Existing `headers`-based static tokens keep working unchanged.
- Security tests run against the real local fixture from Task 1 over real HTTP. No mocked SDK for the security-property tests.
- No new runtime dependency without a ledger ruling. OS keychain integration is a follow-up, not this plan.

---

### Task 0: Verify the spec and the SDK's actual client behavior

**Files:** Create `packages/tools/tests/mcp/oauth/sdk-behavior-probe.test.ts` (kept as a regression pin). Amend this plan if findings differ.

- [ ] **Step 1:** Fetch the current MCP Authorization page and Security Best Practices page. Record the revision date and quote the client-side MUST/SHOULD sentences for: PKCE, `resource` parameter, protected-resource metadata discovery, authorization-server metadata discovery, HTTPS, `state`, dynamic client registration, client ID metadata documents, scope step-up.
- [ ] **Step 2:** Confirm or refute the reported 2026-07-28 revision and RFC 8693.
- [ ] **Step 3:** Read the SDK's `client/auth.js` and pin its real behavior. For each item, write a test (it can use a minimal inline HTTP server — the full fixture comes in Task 1) or cite the source line:
  1. Does it refuse when `code_challenge_methods_supported` lacks `S256`?
  2. Does it validate metadata `issuer` against the authorization-server URL?
  3. Does it send `resource` on both the authorization URL and the token request?
  4. Does it enforce HTTPS on discovered endpoints?
  5. Does it call `provider.state()` and does anything validate it on return? (Expect: the host must validate — the SDK never sees the redirect.)
  6. On `invalid_grant` during refresh, does it call `invalidateCredentials("tokens")`?
  7. On a 403 `insufficient_scope`, does it re-authorize with the requested scope, or throw?
  8. Does `UnauthorizedError` or any SDK error message include a token or code?
- [ ] **Step 4:** Produce a gap list: each "SDK does not do X" becomes a numbered requirement for Task 5. Commit: `test(tools): pin MCP SDK client OAuth behavior`.

---

### Task 1: Local OAuth + protected MCP server test fixture

**Files:**
- Create: `packages/tools/tests/fixtures/oauth-mcp/fixture.ts`
- Test: `packages/tools/tests/fixtures/oauth-mcp/fixture.test.ts`

**Interface produced:**

```ts
export interface OAuthMcpFixture {
  readonly resourceUrl: string;          // protected MCP endpoint, e.g. http://127.0.0.1:<p>/mcp
  readonly issuer: string;               // authorization server base URL
  readonly requests: ReadonlyArray<{ path: string; params: Record<string, string> }>;
  mintAccessToken(opts?: { aud?: string; scope?: string; expiresIn?: number }): Promise<string>;
  configure(overrides: FixtureOverrides): void;  // misbehavior switches for attack tests
  close(): Promise<void>;
}
export function startOAuthMcpFixture(opts?: { clients?: FixtureClient[] }): Promise<OAuthMcpFixture>;
```

Behavior — real HTTP on ephemeral loopback ports, tokens are real JWTs signed with a `jose`-generated key:
- Protected MCP server exposing one tool (`whoami`, returns the token's `sub`). Validates `aud` = its own URL, returns 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, serves RFC 9728 metadata.
- Authorization server: RFC 8414 metadata; `/authorize` auto-approves and redirects with `code` + echoed `state`; `/token` supporting `authorization_code` (verifies PKCE S256 and `resource`), `refresh_token` (rotates), `client_credentials`; `/register` (RFC 7591).
- Records every request for assertions.
- `FixtureOverrides` for attack tests: `issuerMismatch`, `onlyPlainPkce`, `authorizationEndpoint` (arbitrary string), `httpEndpointsOnNonLoopbackName`, `refreshReturnsInvalidGrant`, `requireScope`, `omitStateOnRedirect`, `wrongStateOnRedirect`.

- [ ] **Step 1:** Write `fixture.test.ts` proving the fixture itself behaves (unauthenticated → 401 with metadata header; valid token → tool call works; wrong `aud` → 401; PKCE mismatch → token endpoint error).
- [ ] **Step 2:** Implement. Use the SDK's `McpServer` + `WebStandardStreamableHTTPServerTransport` for the MCP side.
- [ ] **Step 3:** Commit: `test(tools): local OAuth authorization server + protected MCP fixture`.

---

### Task 2: Auth config types and token store

**Files:**
- Modify: `packages/tools/src/types.ts` (`MCPServer`), `packages/runtime/src/runtime-types.ts` (`MCPServerConfig`)
- Create: `packages/tools/src/mcp/auth/token-store.ts`, `packages/tools/src/mcp/auth/types.ts`
- Test: `packages/tools/tests/mcp/oauth/token-store.test.ts`

**Interfaces produced:**

```ts
export type MCPAuthConfig =
  | {
      readonly type: "client_credentials";
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scope?: string;
    }
  | {
      readonly type: "private_key_jwt";
      readonly clientId: string;
      readonly privateKey: string;          // PEM or JWK JSON
      readonly algorithm: string;
      readonly scope?: string;
    }
  | {
      readonly type: "authorization_code";
      readonly clientId?: string;            // omitted ⇒ dynamic client registration
      readonly clientSecret?: string;
      readonly clientMetadataUrl?: string;   // client ID metadata document
      readonly scope?: string;
      /** Open a browser and listen for the redirect during connect. Default false: fail with a `rax mcp login` hint. */
      readonly interactive?: boolean;
      readonly redirectPort?: number;        // default ephemeral
      readonly timeoutMs?: number;           // default 300_000
      /** Called instead of launching a browser (e.g. print the URL, send to a UI). */
      readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
    }
  | { readonly type: "provider"; readonly provider: OAuthClientProvider };

export interface MCPTokenStore {
  get(key: string): Promise<StoredMcpCredentials | undefined>;
  set(key: string, value: StoredMcpCredentials): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<readonly string[]>;
}
// StoredMcpCredentials: { tokens?: OAuthTokens; clientInformation?: OAuthClientInformationMixed; discoveryState?: OAuthDiscoveryState; resourceUrl: string; savedAt: number }

export function canonicalResourceKey(serverUrl: string): string;
export function createMemoryTokenStore(): MCPTokenStore;
export function createFileTokenStore(dir?: string): MCPTokenStore;   // default ~/.reactive-agents/mcp-auth
```

`MCPServer` / `MCPServerConfig` gain `auth?: MCPAuthConfig` and `tokenStore?: MCPTokenStore`. Confirm how `MCPServerConfig` becomes `MCPServer` between runtime and tools and thread both fields through that mapping.

Secrets in config: document that `clientSecret` / `privateKey` should come from env vars. Do not add env-var interpolation syntax in this plan.

- [ ] **Step 1: Failing tests:**
  1. `canonicalResourceKey`: lowercases scheme/host, drops default port and fragment, keeps path; `https://A.com:443/mcp#x` and `https://a.com/mcp` → same key; different paths → different keys.
  2. Memory store round-trip.
  3. File store: creates dir `0700` and files `0600`; the file name is a hash of the key (no raw URL in file names); atomic write (no partial file visible if the process throws mid-write — simulate by making rename fail).
  4. File store refuses to read a file with mode `0644` (error names the path and the fix, not the contents).
  5. Two stores pointed at the same dir see each other's writes (process-restart persistence).
- [ ] **Step 2:** Implement. **Step 3:** `bun test packages/tools/tests/mcp/oauth` green, `tsc` clean.
- [ ] **Step 4:** Commit: `feat(tools): MCP auth config types and permission-restricted token store`.

---

### Task 3: Machine-to-machine grants wired into transports

**Files:**
- Create: `packages/tools/src/mcp/auth/create-provider.ts`
- Modify: `packages/tools/src/mcp/mcp-client.ts` (`createTransport` at ~L363 **and** the Docker auto-upgrade transports at ~L513)
- Test: `packages/tools/tests/mcp/oauth/m2m.test.ts`

**Interface produced:** `createAuthProvider(server: MCPServer, store: MCPTokenStore): OAuthClientProvider | undefined`.

- `client_credentials` → SDK `ClientCredentialsProvider`, wrapped so tokens persist via the store (read the SDK class — if it keeps tokens in memory only, wrap `tokens()`/`saveTokens()`).
- `private_key_jwt` → SDK `PrivateKeyJwtProvider`, same persistence wrapping.
- `provider` → passed through untouched (caller owns security).
- `authorization_code` → Task 4. In this task, throw "not yet supported" so the switch is exhaustive.

- [ ] **Step 1: Failing tests against the Task 1 fixture:**
  1. **RED-ON-CUT:** `client_credentials` config → `connect` succeeds, `whoami` returns the client's subject. Removing `authProvider` from `createTransport` makes this fail.
  2. Wrong secret → `MCPConnectionError`; no unauthenticated fallback; the error message does not contain the secret.
  3. Fixture's token request log shows the `resource` parameter equal to the MCP endpoint's canonical URL.
  4. Token is persisted in the store and reused on a second connect (fixture sees no second token request).
  5. `auth` on a `stdio` config → config error at connect, before spawning anything.
  6. Two configs with the same `name` and different endpoints → two distinct store keys, and neither token is sent to the other server.
  7. Existing `headers: { Authorization: "Bearer …" }` config without `auth` still works (regression pin).
  8. When both `auth` and an `Authorization` header are set → config error (ambiguous credential source).
- [ ] **Step 2:** Implement. The Docker auto-upgrade path must receive the same provider — add a test or record why it cannot be exercised without Docker (Docker is unavailable in the dev sandbox; the known 15 Docker-timeout failures are baseline noise).
- [ ] **Step 3:** `bun test packages/tools` — no new failures beyond the Docker baseline.
- [ ] **Step 4:** Commit: `feat(tools): OAuth client-credentials and private_key_jwt for MCP servers`.

---

### Task 4: Interactive authorization-code grant

**Files:**
- Create: `packages/tools/src/mcp/auth/authorization-code-provider.ts`, `packages/tools/src/mcp/auth/loopback-redirect.ts`, `packages/tools/src/mcp/auth/open-browser.ts`
- Modify: `create-provider.ts`, `mcp-client.ts` (connect retry after `finishAuth`)
- Test: `packages/tools/tests/mcp/oauth/authorization-code.test.ts`

**Interfaces produced:**
- `createAuthorizationCodeProvider(server, config, store): OAuthClientProvider & { waitForAuthorizationCode(): Promise<string> }`
- `startLoopbackRedirectListener({ port?, path, expectedState, timeoutMs }): Promise<{ redirectUrl: URL; code: Promise<string>; close(): Promise<void> }>`
- `openBrowser(url: URL): Promise<void>` — `xdg-open` / `open` / `cmd /c start ""` chosen by platform, spawned with an argv array.

Connect flow: transport throws `UnauthorizedError` after the SDK calls `redirectToAuthorization(url)` → if `interactive`, the provider has already started the listener and launched the browser (or called `onAuthorizationUrl`) → await the code → `transport.finishAuth(code)` → reconnect with a fresh transport. If not `interactive`, `redirectToAuthorization` throws an `MCPConnectionError` naming `rax mcp login <name>`, and no listener or browser starts.

- [ ] **Step 1: Failing tests** (fixture + `onAuthorizationUrl` hook that performs the redirect with `fetch` instead of a real browser):
  1. **RED-ON-CUT:** interactive flow completes, `whoami` works, tokens persisted; second connect performs no authorization.
  2. Non-interactive with no stored token → `MCPConnectionError` containing `rax mcp login`, no port bound (assert with a connect attempt to the would-be port or by spying `startLoopbackRedirectListener`), `openBrowser` not called.
  3. `state` missing on callback → rejected, listener keeps waiting, ends in timeout error. Wrong `state` → same.
  4. Callback on the wrong path or with `POST` → 404/405; still waiting.
  5. Listener bound to `127.0.0.1`, not `0.0.0.0` (inspect the server's address).
  6. Second callback after success → connection refused (single use; listener closed).
  7. Timeout → error, listener closed, no dangling server.
  8. Fixture advertising only `plain` PKCE → refused before the browser opens (if Task 0 found the SDK doesn't enforce this, Task 5 adds the check — mark this test as depending on Task 5 and keep it red until then, or move it).
  9. Dynamic client registration: config with no `clientId` → fixture's `/register` called once, client info persisted and reused.
  10. **`openBrowser` safety:** URLs with scheme `file:`, `javascript:`, `data:`; an `https` URL containing `$(…)`, backticks, `;`, `&&`, newline → spawn never called for disallowed schemes/control characters; for an allowed URL containing shell metacharacters, spawn is called with `shell: false` and the URL as exactly one argv element (spy on spawn).
  11. Refresh: expired access token with a valid refresh token → refreshed silently, rotated refresh token saved. Fixture `refreshReturnsInvalidGrant` → tokens cleared from the store, non-interactive run gets the `rax mcp login` error.
- [ ] **Step 2:** Implement. **Step 3:** Tests green, `tsc` clean.
- [ ] **Step 4:** Commit: `feat(tools): interactive OAuth authorization-code flow for MCP servers`.

---

### Task 5: Hardening — close the SDK gaps from Task 0

**Files:**
- Create: `packages/tools/src/mcp/auth/hardened-provider.ts` (wrapper applied to every provider RA creates, except `type: "provider"`)
- Modify: `create-provider.ts`, `mcp-client.ts` (error sanitization)
- Test: `packages/tools/tests/mcp/oauth/hardening.test.ts`

Scope is exactly the Task 0 gap list plus the items below that are RA-owned regardless of SDK behavior. Each wrapper has a one-line comment citing the gap or RFC section.

RA-owned regardless of SDK:
- HTTPS for the MCP endpoint when `auth` is set, unless loopback.
- Error sanitization: every error that crosses into `MCPConnectionError` / `ToolExecutionError` passes through a redactor that removes the current access token, refresh token, client secret, code verifier, and authorization code values, plus any `Bearer <x>` pattern.
- `RAX_DEBUG` output from `mcp-client.ts` never prints headers or provider state.

- [ ] **Step 1: Failing tests** against fixture overrides — one per gap, plus:
  1. `issuerMismatch` → refused (if a gap).
  2. `onlyPlainPkce` → refused (if a gap; un-skips Task 4 test 8).
  3. Non-loopback `http:` endpoint with `auth` → config error. Use a hostname that resolves locally (e.g. a `/etc/hosts`-free approach: pass `http://example.invalid/mcp` and assert the error happens before any network call).
  4. Fixture error bodies that echo the submitted token or secret → the surfaced error contains neither.
  5. With `RAX_DEBUG=1`, captured console output during a full authorization-code flow contains no token, code, verifier, or secret.
  6. A tool result or trace event emitted during a run using an OAuth server contains no token (run an agent with the `test` provider calling the fixture's `whoami` tool through the runtime; scan the trace).
- [ ] **Step 2:** Implement. **Step 3:** Green.
- [ ] **Step 4:** Commit: `fix(tools): harden MCP client OAuth against known attack classes`.

---

### Task 6: `rax mcp login | logout | status`

**Files:**
- Create: `apps/cli/src/commands/mcp.ts`
- Modify: CLI command registry (find where `serve.ts` is registered)

Behavior:
- Server configs come from the same place the CLI's other commands read agent config (find it; do not invent a new config file). Also accept `--url <endpoint>` with optional `--client-id`, `--scope` for ad-hoc login.
- `login <name|--url>`: runs the authorization-code flow with `interactive: true` via the SDK `auth()` function and the Task 4 provider. Prints the authorization URL to stderr as well as opening the browser (headless-SSH users copy it). With `--no-browser`, only prints it.
- `logout <name|--url>`: deletes the stored credentials for that canonical key. If the authorization server advertises a revocation endpoint (RFC 7009), revoke the refresh token first; a revocation failure is reported but still deletes locally.
- `status`: lists stored credentials — server URL, scopes, expiry, whether a refresh token exists. **Never prints token values.**

- [ ] **Step 1:** Tests for argument parsing, `status` output redaction (seed a store, assert no token substring in stdout/stderr), and `logout` deleting the file. `login` end-to-end against the Task 1 fixture using `--no-browser` plus a test hook that follows the printed URL.
- [ ] **Step 2:** Implement. Help text documents all three subcommands.
- [ ] **Step 3:** Commit: `feat(cli): rax mcp login, logout, and status`.

---

### Task 7: Runtime surface, docs, changeset, live verification

**Files:**
- Modify: `packages/runtime/src/builder.ts` (`.withMCP()` JSDoc — `auth` example), exports in `packages/tools/src/index.ts` (`MCPAuthConfig`, `MCPTokenStore`, `createFileTokenStore`, `createMemoryTokenStore`)
- Create: `.changeset/mcp-client-oauth.md` (`@reactive-agents/tools` minor, `@reactive-agents/runtime` minor, `@reactive-agents/cli` minor)
- Modify: `apps/docs/src/content/docs/guides/tools.md` (MCP section), `reference/builder-api.md`, `reference/configuration.md`, `cookbook/agent-tool-calling-mcp.md`
- Test: `packages/runtime/tests/mcp-oauth-wiring.test.ts`

- [ ] **Step 1: Wiring test (RED-ON-CUT):** `ReactiveAgents.create().withProvider("test").withMCP({ name, endpoint: fixture.resourceUrl, auth: { type: "client_credentials", … }, tokenStore: createMemoryTokenStore() })` with a test scenario that calls the fixture's tool; assert the tool result reached the run. Cut the `auth` passthrough between `MCPServerConfig` and `MCPServer` → red.
- [ ] **Step 2: Docs** must cover: choosing a grant (agents in production → `client_credentials` / `private_key_jwt`; user-delegated access → `authorization_code` + `rax mcp login` once); where tokens are stored and the permission rule; secrets from env vars; `interactive` and why it defaults off; stdio servers use env vars, not OAuth; what RA does not do yet (OS keychain, token exchange, tool-description pinning).
- [ ] **Step 3: Gates:** `bun run docs:examples:check`, `bun run docs:sync:check`, `bun test packages/tools packages/runtime apps/cli` (Docker baseline failures only).
- [ ] **Step 4: Live verification.** Against the local fixture via a scratch script using a real agent. Then attempt one real OAuth-protected remote MCP server if one is reachable without new accounts or paid access; if not, say so plainly in the report — do not claim compatibility with any named hosted server that was not exercised.
- [ ] **Step 5:** Commit: `docs(mcp): document OAuth for MCP servers`.

---

## Final review focus (whole-branch reviewer, most capable model)

1. Walk every row of the client threat table; confirm a test pins it and goes red when the mitigation is removed.
2. Grep the branch for any path where token, refresh token, secret, verifier, or code reaches logs, traces, tool output, or model-visible errors.
3. Confirm every auth failure fails closed with no unauthenticated fallback.
4. Confirm `openBrowser` can never reach a shell and rejects non-http(s) schemes.
5. Confirm no browser opens and no port binds during `agent.run()` unless `interactive: true`.
6. Confirm existing header-based MCP configs and the stdio/Docker paths are unchanged.

---

## Follow-ups (separate plans)

- **OS keychain token store** (macOS Keychain, libsecret, Windows Credential Manager) as an optional `MCPTokenStore`.
- **Scope step-up** on 403 `insufficient_scope`, if Task 0 shows the SDK doesn't handle it and the spec requires it.
- **RFC 8693 token exchange** for delegating a user's token to sub-agents with attenuated scope — belongs with capability attenuation in the agentic-security plan.
- **Tool-description pinning / re-consent on mutation** — agentic-security plan.
- **Cortex UI login flow** using `onAuthorizationUrl`.
