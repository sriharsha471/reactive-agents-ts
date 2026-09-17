// Run: bun test packages/tools/tests/mcp/oauth/m2m.test.ts --timeout 15000
//
// Task 3 of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md —
// machine-to-machine grants (client_credentials, private_key_jwt) wired into
// the real MCP client transports. Covers all 8 Step 1 cases from
// task-3-brief.md against the real Task 1 fixture (real HTTP round-trips, no
// mocked SDK).
import { Effect } from "effect";
import { describe, it, expect, afterEach } from "bun:test";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { makeMCPClient } from "../../../src/mcp/mcp-client.js";
import { createAuthProvider } from "../../../src/mcp/auth/create-provider.js";
import { createMemoryTokenStore } from "../../../src/mcp/auth/token-store.js";
import type { MCPServer } from "../../../src/types.js";
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

const M2M_CLIENT_ID = "m2m-client";
const M2M_CLIENT_SECRET = "m2m-correct-secret";

describe("MCP client OAuth — client_credentials (M2M)", () => {
  it("1. RED-ON-CUT: connect succeeds and whoami returns the client's subject", async () => {
    const f = await fixture({
      clients: [{ clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      const server = yield* client.connect({
        name: "oauth-m2m",
        transport: "streamable-http",
        endpoint: f.resourceUrl,
        auth: { type: "client_credentials", clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET },
        tokenStore: store,
      });
      expect(server.status).toBe("connected");

      const result = yield* client.callTool("oauth-m2m", "whoami", {});
      expect(result).toBe(M2M_CLIENT_ID);
    });

    await Effect.runPromise(program);
  });
  // RED-ON-CUT proof: removing `authProvider` from createTransport's
  // streamable-http/sse cases (packages/tools/src/mcp/mcp-client.ts) makes
  // this test fail — the fixture's /mcp endpoint 401s any request with no
  // Authorization header, and callTool then throws instead of returning
  // "m2m-client".

  it("2. wrong secret → MCPConnectionError, no unauthenticated fallback, no secret in the message", async () => {
    const f = await fixture({
      clients: [{ clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();
    const wrongSecret = "definitely-the-wrong-secret";

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      const error = yield* client
        .connect({
          name: "oauth-m2m-wrong-secret",
          transport: "streamable-http",
          endpoint: f.resourceUrl,
          auth: { type: "client_credentials", clientId: M2M_CLIENT_ID, clientSecret: wrongSecret },
          tokenStore: store,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("MCPConnectionError");
      expect(error.message).not.toContain(wrongSecret);
      expect(error.message).not.toContain(M2M_CLIENT_SECRET);
    });

    await Effect.runPromise(program);
  });

  it("3. token request's resource parameter equals the MCP endpoint's canonical URL", async () => {
    const f = await fixture({
      clients: [{ clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      yield* client.connect({
        name: "oauth-m2m-resource",
        transport: "streamable-http",
        endpoint: f.resourceUrl,
        auth: { type: "client_credentials", clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET },
        tokenStore: store,
      });
    });
    await Effect.runPromise(program);

    const tokenRequests = f.requests.filter((r) => r.path === "/token");
    expect(tokenRequests.length).toBeGreaterThan(0);
    const ccRequest = tokenRequests.find((r) => r.params["grant_type"] === "client_credentials");
    expect(ccRequest).toBeDefined();
    expect(ccRequest?.params["resource"]).toBe(f.resourceUrl);
  });

  it("4. token is persisted and reused on a second connect (no second token request)", async () => {
    const f = await fixture({
      clients: [{ clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();
    const config = {
      transport: "streamable-http" as const,
      endpoint: f.resourceUrl,
      auth: {
        type: "client_credentials" as const,
        clientId: M2M_CLIENT_ID,
        clientSecret: M2M_CLIENT_SECRET,
      },
      tokenStore: store,
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        yield* client.connect({ ...config, name: "oauth-m2m-persist-1" });
      }),
    );
    const tokenRequestsAfterFirst = f.requests.filter((r) => r.path === "/token").length;
    expect(tokenRequestsAfterFirst).toBeGreaterThan(0);

    // Fresh makeMCPClient instance — a brand-new in-memory ClientCredentialsProvider,
    // proving reuse comes from `store`, not from the first provider's own memory.
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        const server = yield* client.connect({ ...config, name: "oauth-m2m-persist-2" });
        expect(server.status).toBe("connected");
        const result = yield* client.callTool("oauth-m2m-persist-2", "whoami", {});
        expect(result).toBe(M2M_CLIENT_ID);
      }),
    );

    const tokenRequestsAfterSecond = f.requests.filter((r) => r.path === "/token").length;
    expect(tokenRequestsAfterSecond).toBe(tokenRequestsAfterFirst);
  });

  it("5. auth on a stdio config → config error at connect, before spawning anything", async () => {
    const store = createMemoryTokenStore();

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      const error = yield* client
        .connect({
          name: "oauth-m2m-stdio",
          transport: "stdio",
          command: "this-binary-does-not-exist-anywhere-xyz",
          auth: { type: "client_credentials", clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET },
          tokenStore: store,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("MCPConnectionError");
      expect(error.message).toContain("stdio");
    });

    await Effect.runPromise(program);
  });

  it("6. same server name, different endpoints → distinct store keys, no cross-server token leak", async () => {
    const fA = await fixture({
      clients: [{ clientId: "client-a", clientSecret: "secret-a", redirectUris: [] }],
    });
    const fB = await fixture({
      clients: [{ clientId: "client-b", clientSecret: "secret-b", redirectUris: [] }],
    });
    const store = createMemoryTokenStore();

    // Two independent client instances (independent activeConnections tables) so
    // reusing the server name "shared-name" against two endpoints can't collide
    // on the name — the point under test is the *store* key, which is derived
    // from the endpoint, not the name.
    const resultA = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        yield* client.connect({
          name: "shared-name",
          transport: "streamable-http",
          endpoint: fA.resourceUrl,
          auth: { type: "client_credentials", clientId: "client-a", clientSecret: "secret-a" },
          tokenStore: store,
        });
        return yield* client.callTool("shared-name", "whoami", {});
      }),
    );
    const resultB = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeMCPClient;
        yield* client.connect({
          name: "shared-name",
          transport: "streamable-http",
          endpoint: fB.resourceUrl,
          auth: { type: "client_credentials", clientId: "client-b", clientSecret: "secret-b" },
          tokenStore: store,
        });
        return yield* client.callTool("shared-name", "whoami", {});
      }),
    );

    expect(resultA).toBe("client-a");
    expect(resultB).toBe("client-b");

    const keys = await store.list();
    expect(keys.length).toBe(2);
  });

  it("7. regression pin: static headers.Authorization bearer token (no `auth`) still works", async () => {
    const f = await fixture();
    const token = await f.mintAccessToken();

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      const server = yield* client.connect({
        name: "static-bearer",
        transport: "streamable-http",
        endpoint: f.resourceUrl,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(server.status).toBe("connected");

      const result = yield* client.callTool("static-bearer", "whoami", {});
      expect(result).toBe("fixture-user");
    });

    await Effect.runPromise(program);
  });

  it("8. both `auth` and `headers.Authorization` set → config error (ambiguous credential source)", async () => {
    const f = await fixture({
      clients: [{ clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET, redirectUris: [] }],
    });
    const store = createMemoryTokenStore();
    const token = await f.mintAccessToken();

    const program = Effect.gen(function* () {
      const client = yield* makeMCPClient;
      const error = yield* client
        .connect({
          name: "oauth-m2m-ambiguous",
          transport: "streamable-http",
          endpoint: f.resourceUrl,
          auth: { type: "client_credentials", clientId: M2M_CLIENT_ID, clientSecret: M2M_CLIENT_SECRET },
          headers: { Authorization: `Bearer ${token}` },
          tokenStore: store,
        })
        .pipe(Effect.flip);

      expect(error._tag).toBe("MCPConnectionError");
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain(M2M_CLIENT_SECRET);
    });

    await Effect.runPromise(program);
  });
});

// private_key_jwt (RFC 7523 client assertion) is NOT one of Step 1's 8 required
// cases (all 8 are client_credentials-specific), and exercising it end-to-end
// against the Task 1 fixture would require teaching the fixture's /token
// endpoint to verify a signed JWT-bearer client assertion (registering a
// per-client public key, checking `sub`/`iss`/`aud`/signature) — real
// JWT-bearer server-side validation, not something Step 1 asked for and a
// meaningfully larger addition to test-only infrastructure than this task's
// scope. Instead, `createAuthProvider`'s private_key_jwt branch is verified
// directly against the REAL SDK class it wraps (`PrivateKeyJwtProvider` from
// `@modelcontextprotocol/sdk/client/auth-extensions.js`) and REAL `jose`
// signing/verification — no mocked SDK, just no fixture round-trip.
describe("MCP client OAuth — private_key_jwt (M2M) provider construction", () => {
  const baseServer: MCPServer = {
    name: "oauth-pkjwt",
    version: "unknown",
    transport: "streamable-http",
    endpoint: "https://pkjwt.example.test/mcp",
    tools: [],
    status: "disconnected",
  };

  it("signs a real, verifiable JWT client assertion via addClientAuthentication", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const store = createMemoryTokenStore();

    const server: MCPServer = {
      ...baseServer,
      auth: { type: "private_key_jwt", clientId: "pkjwt-client", privateKey: pkcs8, algorithm: "RS256" },
    };
    const provider = createAuthProvider(server, store);
    expect(provider).toBeDefined();
    expect(provider?.addClientAuthentication).toBeDefined();

    const headers = new Headers();
    const params = new URLSearchParams({ grant_type: "client_credentials" });
    await provider?.addClientAuthentication?.(headers, params, new URL("https://pkjwt.example.test/token"));

    expect(params.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    const assertion = params.get("client_assertion");
    expect(assertion).toBeTruthy();

    const { payload } = await jwtVerify(assertion ?? "", publicKey, { algorithms: ["RS256"] });
    expect(payload.iss).toBe("pkjwt-client");
    expect(payload.sub).toBe("pkjwt-client");
  });

  it("persists tokens through the store across separate provider instances", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const store = createMemoryTokenStore();
    const server: MCPServer = {
      ...baseServer,
      auth: { type: "private_key_jwt", clientId: "pkjwt-client", privateKey: pkcs8, algorithm: "RS256" },
    };

    const providerA = createAuthProvider(server, store);
    await providerA?.saveTokens({ access_token: "persisted-token", token_type: "Bearer" });

    // A brand-new provider instance (fresh in-memory SDK class), same store/endpoint.
    const providerB = createAuthProvider(server, store);
    const tokens = await providerB?.tokens();
    expect(tokens?.access_token).toBe("persisted-token");
  });
});
