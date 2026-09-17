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
