---
"@reactive-agents/tools": minor
"@reactive-agents/runtime": minor
"@reactive-agents/cli": minor
---

Reactive Agents can now connect as an OAuth 2.1 client to remote MCP servers over
`streamable-http`/`sse`. Add an `auth` config to `.withMCP()`:

```ts
.withMCP({
  name: "billing",
  transport: "streamable-http",
  endpoint: "https://mcp.example.com/mcp",
  auth: {
    type: "client_credentials",
    clientId: process.env.MCP_CLIENT_ID!,
    clientSecret: process.env.MCP_CLIENT_SECRET!,
  },
})
```

- Grants: `client_credentials` and `private_key_jwt` for unattended/production agents
  (no browser, no human); `authorization_code` for delegating to a specific user's own
  account, driven ahead of time with the new `rax mcp login|logout|status` CLI.
- Tokens persist to a permission-locked file store (`~/.reactive-agents/mcp-auth`,
  `0700`/`0600`) by default; pass your own `tokenStore` (e.g. `createMemoryTokenStore()`)
  for tests/CI or alternative storage.
- `interactive` defaults to `false` — an unattended run never unexpectedly opens a
  browser or binds a local port; only `rax mcp login` or an explicit `interactive: true`
  triggers the interactive flow.
- Hardened against known attack classes on top of the MCP SDK's own OAuth support:
  authorization-server issuer mix-up, HTTPS downgrade, and secret-echoing error
  messages are all closed, with no unauthenticated fallback on any auth failure.
- `stdio`-transport servers are unaffected — they take credentials via `env`, and
  setting `auth` on a `stdio` config is a startup error, not a silent no-op.

Not included (tracked as follow-ups): OS keychain-backed token storage, RFC 8693
token exchange for sub-agent delegation, and tool-description pinning/re-consent on
server-side mutation.

Fixes found live-testing against a real third-party OAuth-protected MCP server
(Google Home MCP, Early Access):
- The interactive login retry now also covers a 401 raised by a request AFTER the
  initial connect (e.g. a server, like Google's, that accepts an unauthenticated
  `initialize` but challenges the very next request) — previously only a 401 on the
  first connect attempt triggered the browser-login flow.
- The authorization-server issuer-match check no longer false-positives on a
  trailing-slash-only difference between the issuer an authorization server
  publishes and the URL it was discovered from (Google's real issuer omits the
  trailing slash; a naive string comparison refused every server shaped that way).
- MCP tools whose JSON Schema uses the `"integer"` type (distinct from `"number"`)
  now register correctly instead of failing with a schema-validation error.
- `rax mcp login` gained `--client-secret` and `--redirect-port`, for authorization
  servers that issue a confidential-client secret and/or validate `redirect_uri` by
  exact match rather than accepting any loopback port.
