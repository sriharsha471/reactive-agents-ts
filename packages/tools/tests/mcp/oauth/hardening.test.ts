// Run: bun test packages/tools/tests/mcp/oauth/hardening.test.ts --timeout 30000
//
// Task 5 of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md —
// closes the SDK gaps Task 0 confirmed the installed
// @modelcontextprotocol/sdk@1.29.0 does not cover (authorization-server
// issuer mix-up, HTTPS downgrade on discovered endpoints, raw-body secret
// echo in thrown errors), plus RA-owned items (HTTPS for the MCP endpoint
// itself, RAX_DEBUG never printing secrets). All against the real Task 1
// fixture (real HTTP round-trips, no mocked SDK) — item 6 of this task's
// Step 1 list (the full-runtime trace-scan) lives in
// packages/runtime/tests/mcp-oauth-trace-redaction.test.ts instead (see
// that file's header comment for why).
import { Effect } from "effect";
import { describe, it, expect, afterEach } from "bun:test";
import { makeMCPClient } from "../../../src/mcp/mcp-client.js";
import { createMemoryTokenStore } from "../../../src/mcp/auth/token-store.js";
import { startOAuthMcpFixture, type OAuthMcpFixture } from "../../fixtures/oauth-mcp/fixture.js";

let fixtures: OAuthMcpFixture[] = [];
async function fixture(
  ...args: Parameters<typeof startOAuthMcpFixture>
): Promise<OAuthMcpFixture> {
  const f = await startOAuthMcpFixture(...args);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.map((f) => f.close()));
  fixtures = [];
});

const CLIENT_ID = "hardening-client";
const CLIENT_SECRET = "hardening-correct-secret";

describe("MCP client OAuth hardening — gap 1: authorization-server issuer mix-up", () => {
  it("issuerMismatch → connect refused, no token request ever sent", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    f.configure({ issuerMismatch: true });
    const store = createMemoryTokenStore();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client
          .connect({
            name: "issuer-mismatch",
            transport: "streamable-http",
            endpoint: f.resourceUrl,
            auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
            tokenStore: store,
          })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("MCPConnectionError");
    expect(error.message).toMatch(/issuer/i);
    expect(f.requests.some((r) => r.path === "/token")).toBe(false);
  });
  // RED-ON-CUT proof (recorded in task-5-report.md): removing
  // `hardened-provider.ts`'s `validateIssuerMatch` call from
  // `saveDiscoveryState` makes this test fail — connect succeeds instead
  // (the SDK happily proceeds with the attacker-controlled-looking issuer).

  // Post-merge live-verification finding (2026-09-17, against Google Home
  // MCP): Google's real AS metadata issuer ("https://accounts.google.com")
  // has no trailing slash, but the resource's advertised authorization
  // server URL was normalized to one ("https://accounts.google.com/") —
  // the naive `!==` comparison this test's sibling above pins treated that
  // as a mix-up and refused every real-world server exhibiting this
  // pattern. `normalizeIssuerUrl` (hardened-provider.ts) fixes it; this
  // test is the fixture-based regression pin for that fix, not just a
  // manual live check.
  it("trailing-slash-only difference between issuer and authorization-server URL is not a mismatch", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    f.configure({ authorizationServerUrlTrailingSlash: true });
    const store = createMemoryTokenStore();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client.connect({
          name: "issuer-trailing-slash",
          transport: "streamable-http",
          endpoint: f.resourceUrl,
          auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
          tokenStore: store,
        });
      }),
    );

    expect(result.status).toBe("connected");
    expect(f.requests.some((r) => r.path === "/token")).toBe(true);
  });
});

describe("MCP client OAuth hardening — gap 3: HTTPS downgrade on discovered endpoints", () => {
  it("httpEndpointsOnNonLoopbackName → connect refused, no token request ever sent", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    f.configure({ httpEndpointsOnNonLoopbackName: true });
    const store = createMemoryTokenStore();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client
          .connect({
            name: "http-downgrade",
            transport: "streamable-http",
            endpoint: f.resourceUrl,
            auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
            tokenStore: store,
          })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("MCPConnectionError");
    expect(error.message).toMatch(/https|plaintext/i);
    expect(f.requests.some((r) => r.path === "/token")).toBe(false);
  });
  // RED-ON-CUT proof (recorded in task-5-report.md): removing
  // `hardened-provider.ts`'s `validateHttpsEndpoints` call makes this test
  // fail — connect either hangs/DNS-fails against the bogus non-loopback
  // hostname (uncontrolled failure mode) instead of failing closed with a
  // clear config error before any request to that host is attempted.

  it("non-loopback http: MCP endpoint + auth → config error before any network call", async () => {
    const store = createMemoryTokenStore();

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client
          .connect({
            name: "http-mcp-endpoint",
            transport: "streamable-http",
            // A reserved, non-resolvable TLD (RFC 2606) — if this check ever
            // ran a network call instead of a pure string check, the test
            // would time out on DNS resolution instead of failing fast.
            endpoint: "http://example.invalid/mcp",
            auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
            tokenStore: store,
          })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("MCPConnectionError");
    expect(error.message).toMatch(/https/i);
  });

  it("final-review I3: no AS metadata document at all (404 on discovery) → plaintext non-loopback authorization-server URL still refused", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    f.configure({ authorizationServerUrlWithNoMetadata: true });
    const store = createMemoryTokenStore();

    // The fake `oauth-authz.fixture.invalid` host used by
    // `authorizationServerUrlWithNoMetadata` isn't DNS-resolvable — fine for
    // the (already-covered) "endpoints advertised under it" case, since that
    // string only ever needs to appear inside a JSON document, never be
    // fetched. This test needs RFC 8414 discovery to actually complete with
    // "no metadata found" (a clean 404), not fail on DNS resolution (an
    // uncontrolled network error), so every request aimed at that host is
    // faked to 404 here — everything else (the real fixture's resource
    // server and issuer) still goes over the real loopback network
    // unmodified.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("oauth-authz.fixture.invalid")) {
        return new Response("Not Found", { status: 404 });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      const error = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeMCPClient;
          return yield* client
            .connect({
              name: "no-as-metadata",
              transport: "streamable-http",
              endpoint: f.resourceUrl,
              auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
              tokenStore: store,
            })
            .pipe(Effect.flip);
        }),
      );

      expect(error._tag).toBe("MCPConnectionError");
      expect(error.message).toMatch(/authorization-server url|plaintext/i);
      expect(f.requests.some((r) => r.path === "/token")).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  // RED-ON-CUT proof: removing `hardened-provider.ts`'s
  // `validateAuthorizationServerUrlIsSecure` call from `saveDiscoveryState`
  // makes this test fail — with no discovered AS metadata document,
  // `validateIssuerMatch`/`validateHttpsEndpoints` both no-op (their own
  // `!metadata` early return), so nothing rejects the plaintext,
  // non-loopback `oauth-authz.fixture.invalid` authorization-server URL and
  // the connect attempt instead proceeds (or fails for an unrelated reason)
  // instead of failing closed with a clear config error.
});

describe("MCP client OAuth hardening — SDK's own PKCE enforcement (Task 0: not a gap, confirming end-to-end)", () => {
  it("onlyPlainPkce → interactive connect refused before the browser ever opens", async () => {
    const f = await fixture();
    f.configure({ onlyPlainPkce: true });
    const store = createMemoryTokenStore();
    let authorizationUrlCalls = 0;

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client
          .connect({
            name: "only-plain-pkce",
            transport: "streamable-http",
            endpoint: f.resourceUrl,
            auth: {
              type: "authorization_code",
              clientId: "only-plain-pkce-client",
              interactive: true,
              timeoutMs: 5_000,
              onAuthorizationUrl: () => {
                authorizationUrlCalls++;
                return Promise.resolve();
              },
            },
            tokenStore: store,
          })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("MCPConnectionError");
    expect(error.message).toMatch(/code challenge/i);
    expect(authorizationUrlCalls).toBe(0);
    expect(f.requests.some((r) => r.path === "/authorize")).toBe(false);
  });
});

describe("MCP client OAuth hardening — gap 4: error-body secret redaction", () => {
  it("tokenErrorEchoesSecret → surfaced error contains neither the client_id nor the client_secret", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    f.configure({ tokenErrorEchoesSecret: true });
    const store = createMemoryTokenStore();
    // Deliberately wrong secret — the registered client's REAL secret
    // (`CLIENT_SECRET`) must still never appear in the surfaced error even
    // though it's never submitted; the WRONG secret submitted below is what
    // the fixture's broken raw-body response echoes back.
    const wrongSecret = "definitely-wrong-secret-value";

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client
          .connect({
            name: "echo-secret",
            transport: "streamable-http",
            endpoint: f.resourceUrl,
            auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: wrongSecret },
            tokenStore: store,
          })
          .pipe(Effect.flip);
      }),
    );

    expect(error._tag).toBe("MCPConnectionError");
    // Confirm the fixture actually took the raw-body path (sanity check on
    // the test's own setup, not the thing under test).
    const tokenRequest = f.requests.find((r) => r.path === "/token");
    expect(tokenRequest).toBeDefined();
    expect(error.message).not.toContain(wrongSecret);
    expect(error.message).not.toContain(CLIENT_SECRET);
  });
  // RED-ON-CUT proof (recorded in task-5-report.md): removing
  // `hardened-provider.ts`'s secret-capturing wrappers (`clientInformation`/
  // `saveClientInformation`) — i.e. reverting `create-provider.ts` to call
  // `withPersistence(...)` directly without `hardenProvider(...)` — makes
  // this test fail: the SDK's `parseErrorResponse` echoes the raw non-JSON
  // body (which contains `client_secret=...`) verbatim into the thrown
  // error's `.message`, and nothing downstream redacts it.
});

describe("MCP client OAuth hardening — RAX_DEBUG never prints secrets", () => {
  it("interactive authorization_code flow with RAX_DEBUG=1 → no token/code/verifier/secret in console output", async () => {
    const f = await fixture();
    const store = createMemoryTokenStore();
    const captured: string[] = [];
    const originalLog = console.log;
    const originalDebug = process.env["RAX_DEBUG"];
    console.log = (...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    process.env["RAX_DEBUG"] = "1";

    async function driveRedirect(url: URL): Promise<void> {
      const res = await fetch(url);
      await res.text().catch(() => {});
    }

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeMCPClient;
          const server = yield* client.connect({
            name: "debug-scan",
            transport: "streamable-http",
            endpoint: f.resourceUrl,
            auth: {
              type: "authorization_code",
              clientId: "debug-scan-client",
              interactive: true,
              timeoutMs: 10_000,
              onAuthorizationUrl: driveRedirect,
            },
            tokenStore: store,
          });
          expect(server.status).toBe("connected");
          return yield* client.callTool("debug-scan", "whoami", {});
        }),
      );
      expect(result).toBe("fixture-user");
    } finally {
      console.log = originalLog;
      if (originalDebug === undefined) delete process.env["RAX_DEBUG"];
      else process.env["RAX_DEBUG"] = originalDebug;
    }

    const stored = await store.list();
    expect(stored.length).toBeGreaterThan(0);
    const record = await store.get(stored[0]!);
    const accessToken = record?.tokens?.access_token;
    expect(accessToken).toBeTruthy();

    const combined = captured.join("\n");
    expect(combined).not.toContain(accessToken);
    expect(combined).not.toMatch(/Bearer\s+\S+/i);
    expect(combined.toLowerCase()).not.toContain("code_verifier");
    expect(combined.toLowerCase()).not.toContain("authorization: ");
  });
});

describe("MCP client OAuth hardening — loopback exception still works (no false positive)", () => {
  it("plain http:// loopback endpoint + auth is still accepted (config-time HTTPS check exempts loopback)", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();

    const server = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        return yield* client.connect({
          name: "loopback-ok",
          transport: "streamable-http",
          endpoint: f.resourceUrl, // http://127.0.0.1:<port>/mcp
          auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
          tokenStore: store,
        });
      }),
    );
    expect(server.status).toBe("connected");
  });
});

