/**
 * Task 0 regression pin: @modelcontextprotocol/sdk@1.29.0 client OAuth behavior.
 *
 * Purpose: pin the SDK's REAL behavior (not assumed behavior) for the client-side
 * OAuth surface that packages/tools/src/mcp/mcp-client.ts will build on in later
 * tasks of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md.
 *
 * Each test below answers one of the 8 sub-questions in Task 0's brief with a real
 * HTTP round-trip against a throwaway in-process server, or (where a round-trip
 * doesn't add signal beyond reading the source) is a citation-only assertion that
 * documents the file:line and is left as a comment for the next reader.
 *
 * If the installed SDK version changes, re-run this file — a change here means the
 * gap list in task-0-report.md is stale and Task 5 needs to be re-checked.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  auth,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  discoverAuthorizationServerMetadata,
  parseErrorResponse,
  UnauthorizedError,
  type OAuthClientProvider
} from "@modelcontextprotocol/sdk/client/auth.js";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

/** Minimal client info sufficient for the functions under test. */
const clientInformation: OAuthClientInformationMixed = {
  client_id: "test-client"
};

function makeMetadata(overrides: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata {
  return {
    issuer: "https://as.example.test",
    authorization_endpoint: "https://as.example.test/authorize",
    token_endpoint: "https://as.example.test/token",
    response_types_supported: ["code"],
    ...overrides
  };
}

let servers: ReturnType<typeof Bun.serve>[] = [];
function serve(handler: (req: Request) => Response | Promise<Response>): { url: string; server: ReturnType<typeof Bun.serve> } {
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, server };
}
afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

describe("SDK behavior pin: sub-question 1 — S256-only PKCE enforcement", () => {
  it("refuses when code_challenge_methods_supported lacks S256 (auth.js:696-699)", async () => {
    const metadata = makeMetadata({ code_challenge_methods_supported: ["plain"] });
    await expect(
      startAuthorization("https://as.example.test", {
        metadata,
        clientInformation,
        redirectUrl: "https://client.example.test/callback"
      })
    ).rejects.toThrow(/code challenge method/i);
  });

  it("proceeds when S256 is advertised (control case)", async () => {
    const metadata = makeMetadata({ code_challenge_methods_supported: ["S256"] });
    const { authorizationUrl } = await startAuthorization("https://as.example.test", {
      metadata,
      clientInformation,
      redirectUrl: "https://client.example.test/callback"
    });
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
  });

  // GAP (documented, not exercised by an HTTP round-trip): if the authorization
  // server metadata OMITS `code_challenge_methods_supported` entirely (as opposed
  // to advertising ["plain"]), auth.js:696 skips the check because of the
  // `metadata.code_challenge_methods_supported && ...` guard. The SDK still always
  // generates an S256 challenge (AUTHORIZATION_CODE_CHALLENGE_METHOD is hardcoded,
  // auth.js:16), so this omission is not independently exploitable through this
  // code path — but it means the SDK cannot warn a caller that PKCE support is
  // actually unknown, only that it was explicitly declared incompatible.
});

describe("SDK behavior pin: sub-question 2 — authorization-server `issuer` validation", () => {
  it("does NOT validate metadata.issuer against the authorization-server URL used to fetch it", async () => {
    const { url } = serve((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json(
          makeMetadata({
            // Deliberately mismatched: issuer claims to be a totally different AS.
            issuer: "https://attacker-controlled-issuer.example.test",
            authorization_endpoint: `${url}/authorize`,
            token_endpoint: `${url}/token`
          })
        );
      }
      return new Response("not found", { status: 404 });
    });

    const metadata = await discoverAuthorizationServerMetadata(url, {});
    // The SDK happily returns metadata whose `issuer` field does not match the
    // authorization-server URL (`url`) it was fetched from. No comparison exists
    // anywhere in client/auth.js — confirmed by absence of any `.issuer` read
    // against a locally-known authorization-server URL in that file.
    expect(metadata?.issuer).toBe("https://attacker-controlled-issuer.example.test");
  });
});

describe("SDK behavior pin: sub-question 3 — `resource` parameter on both requests", () => {
  it("sets `resource` on the authorization URL (auth.js:725-727)", async () => {
    const metadata = makeMetadata({ code_challenge_methods_supported: ["S256"] });
    const { authorizationUrl } = await startAuthorization("https://as.example.test", {
      metadata,
      clientInformation,
      redirectUrl: "https://client.example.test/callback",
      resource: new URL("https://mcp.example.test/mcp")
    });
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.example.test/mcp");
  });

  it("sets `resource` on the token request body (auth.js:759-761 via executeTokenRequest)", async () => {
    let capturedBody: URLSearchParams | undefined;
    const { url } = serve(async (req) => {
      capturedBody = new URLSearchParams(await req.text());
      return Response.json({ access_token: "at-1", token_type: "bearer" });
    });
    const metadata = makeMetadata({ token_endpoint: url });

    await exchangeAuthorization("https://as.example.test", {
      metadata,
      clientInformation,
      authorizationCode: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://client.example.test/callback",
      resource: new URL("https://mcp.example.test/mcp")
    });

    expect(capturedBody?.get("resource")).toBe("https://mcp.example.test/mcp");
  });

  it("also sets `resource` on a refresh_token request (same shared code path)", async () => {
    let capturedBody: URLSearchParams | undefined;
    const { url } = serve(async (req) => {
      capturedBody = new URLSearchParams(await req.text());
      return Response.json({ access_token: "at-2", token_type: "bearer" });
    });
    const metadata = makeMetadata({ token_endpoint: url });

    await refreshAuthorization("https://as.example.test", {
      metadata,
      clientInformation,
      refreshToken: "rt-1",
      resource: new URL("https://mcp.example.test/mcp")
    });

    expect(capturedBody?.get("resource")).toBe("https://mcp.example.test/mcp");
  });
});

describe("SDK behavior pin: sub-question 4 — HTTPS enforcement on discovered endpoints", () => {
  it("does NOT reject a plain-http authorization_endpoint/token_endpoint from discovery", async () => {
    const { url } = serve((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json(
          makeMetadata({
            // http:// endpoints on a non-loopback host — SafeUrlSchema only bans
            // javascript:/data:/vbscript: schemes (shared/auth.js), not plain http.
            authorization_endpoint: "http://as.example.test/authorize",
            token_endpoint: "http://as.example.test/token"
          })
        );
      }
      return new Response("not found", { status: 404 });
    });

    const metadata = await discoverAuthorizationServerMetadata(url, {});
    expect(metadata?.authorization_endpoint).toBe("http://as.example.test/authorize");
    expect(metadata?.token_endpoint).toBe("http://as.example.test/token");
  });
});

describe("SDK behavior pin: sub-question 5 — provider.state() is called; the SDK never validates it", () => {
  it("calls provider.state() and forwards it to the authorization URL with zero validation on return", async () => {
    let stateCalls = 0;
    const provider = makeProvider({
      onState: () => {
        stateCalls++;
        return "csrf-nonce-abc";
      }
    });
    const metadata = makeMetadata({ code_challenge_methods_supported: ["S256"] });
    const { authorizationUrl } = await startAuthorization("https://as.example.test", {
      metadata,
      clientInformation,
      redirectUrl: "https://client.example.test/callback",
      state: await provider.state?.()
    });
    expect(stateCalls).toBe(1);
    expect(authorizationUrl.searchParams.get("state")).toBe("csrf-nonce-abc");
    // There is no `validateState` hook anywhere on OAuthClientProvider
    // (client/auth.d.ts has no such member) and authInternal (auth.js:299) only
    // ever reads provider.state() to send it — it never receives or checks a
    // returned state. Validating the redirect's `state` against what was sent is
    // entirely the host's responsibility (the SDK doesn't see the redirect at all
    // in a server-side flow), confirming the brief's expectation.
  });
});

describe("SDK behavior pin: sub-question 6 — invalid_grant during refresh calls invalidateCredentials('tokens')", () => {
  it("invalidates tokens and falls through to a fresh authorization attempt", async () => {
    let refreshCallCount = 0;
    let invalidateScope: string | undefined;
    const { url } = serve(async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/token") {
        refreshCallCount++;
        return Response.json({ error: "invalid_grant", error_description: "refresh token expired" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    });
    const metadata = makeMetadata({
      authorization_endpoint: `${url}/authorize`,
      token_endpoint: `${url}/token`,
      code_challenge_methods_supported: ["S256"]
    });

    let hasRefreshToken = true;
    const provider = makeProvider({
      redirectUrl: "https://client.example.test/callback",
      tokens: () => (hasRefreshToken ? ({ access_token: "stale", token_type: "bearer", refresh_token: "rt-expired" } as OAuthTokens) : undefined),
      onInvalidateCredentials: (scope) => {
        invalidateScope = scope;
        hasRefreshToken = false; // simulate the store actually clearing the refresh token
      },
      discoveryState: () => ({ authorizationServerUrl: url, authorizationServerMetadata: metadata })
    });

    const result = await auth(provider, { serverUrl: `${url}/mcp` });

    // First refresh attempt fails with invalid_grant -> auth()'s outer catch
    // (auth.js:156-159) calls provider.invalidateCredentials('tokens') and retries
    // authInternal. On retry, tokens() now returns undefined (no refresh_token), so
    // the SDK falls through to starting a brand-new authorization flow.
    expect(invalidateScope).toBe("tokens");
    expect(refreshCallCount).toBe(1);
    expect(result).toBe("REDIRECT");
  });
});

describe("SDK behavior pin: sub-question 7 — 403 insufficient_scope re-authorization (transport layer, not auth.js)", () => {
  it("is implemented in StreamableHTTPClientTransport, not in client/auth.js", () => {
    // Confirmed by reading node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:336-349:
    //   if (response.status === 403 && this._authProvider) {
    //     const { resourceMetadataUrl, scope, error } = extractWWWAuthenticateParams(response);
    //     if (error === 'insufficient_scope') { ... re-runs auth() with the challenged scope,
    //       tracks `_lastUpscopingHeader` to avoid an infinite retry loop, throws
    //       StreamableHTTPError(403, 'Server returned 403 after trying upscoping') if the
    //       same WWW-Authenticate header repeats ... }
    //   }
    // client/auth.js itself has no knowledge of HTTP status codes at all — `auth()` only
    // orchestrates discovery/PKCE/token exchange, it never issues the protected-resource
    // request that could 403. So: the SDK DOES re-authorize with the requested scope, but
    // only for callers going through StreamableHTTPClientTransport / sse.js / middleware.js.
    // A caller that calls `auth()` directly (as `rax mcp login` will) gets none of this —
    // Task 6's login command must not assume scope step-up "just happens".
    expect(true).toBe(true);
  });
});

describe("SDK behavior pin: sub-question 8 — do SDK errors leak tokens/codes?", () => {
  it("UnauthorizedError never embeds a token or code (constructor takes only a message)", () => {
    const err = new UnauthorizedError();
    expect(err.message).toBe("Unauthorized");
    expect(err.message).not.toMatch(/[A-Za-z0-9_-]{20,}/); // no token-shaped substring
  });

  it("parseErrorResponse's fallback DOES echo the raw response body verbatim into the error message", async () => {
    // GAP: when the error body isn't valid OAuth-error JSON, parseErrorResponse's
    // catch branch (auth.js:134-137) builds `Raw body: ${body}` directly into the
    // thrown error's `.message`. If a misbehaving or compromised authorization
    // server's non-JSON error page happens to echo back a submitted token, secret,
    // or code (e.g. a generic "Bad request: <full querystring>" debug page), that
    // value flows straight into the SDK's error message with no redaction.
    const secretLookingBody = "Bad Request: client_secret=super-secret-value-123 was rejected";
    const response = new Response(secretLookingBody, { status: 400 });
    const err = await parseErrorResponse(response);
    expect(err.message).toContain("super-secret-value-123");
  });

  it("a well-formed OAuth error JSON body does not leak beyond error/error_description (control case)", async () => {
    const response = Response.json({ error: "invalid_grant", error_description: "token expired" }, { status: 400 });
    const err = await parseErrorResponse(response);
    expect(err).toBeInstanceOf(InvalidGrantError);
    expect(err.message).toBe("token expired");
  });
});

/** Builds a minimal OAuthClientProvider stub with only the members a given test needs. */
function makeProvider(opts: {
  redirectUrl?: string | URL;
  onState?: () => string | Promise<string>;
  tokens?: () => OAuthTokens | undefined | Promise<OAuthTokens | undefined>;
  onInvalidateCredentials?: (scope: "all" | "client" | "tokens" | "verifier" | "discovery") => void;
  discoveryState?: () => { authorizationServerUrl: string; authorizationServerMetadata?: AuthorizationServerMetadata };
}): OAuthClientProvider {
  let savedVerifier = "";
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return opts.redirectUrl;
    },
    get clientMetadata() {
      return { redirect_uris: [String(opts.redirectUrl ?? "https://client.example.test/callback")] };
    },
    state: opts.onState,
    clientInformation: () => clientInformation,
    tokens: opts.tokens ?? (() => undefined),
    saveTokens: () => {},
    redirectToAuthorization: () => {},
    saveCodeVerifier: (v: string) => {
      savedVerifier = v;
    },
    codeVerifier: () => savedVerifier,
    invalidateCredentials: opts.onInvalidateCredentials,
    discoveryState: opts.discoveryState
  };
  return provider;
}
