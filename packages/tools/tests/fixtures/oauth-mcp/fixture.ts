/**
 * OAuth + protected-MCP test fixture.
 *
 * Spins up two real, ephemeral-port, loopback-only HTTP servers:
 *
 *  - an "authorization server" (RFC 8414 metadata, `/authorize`, `/token`,
 *    `/register`) that mints real JWTs (signed with a `jose`-generated
 *    HS256 key), verifies PKCE (S256/plain) and the RFC 8707 `resource`
 *    parameter, and rotates refresh tokens on use.
 *  - a "protected resource" that hosts one MCP tool (`whoami`) over the
 *    official SDK's `McpServer` + `WebStandardStreamableHTTPServerTransport`,
 *    gated by Bearer-token validation (audience + optional scope check),
 *    and serves RFC 9728 protected-resource metadata.
 *
 * `configure()` flips "misbehave on purpose" switches so later tasks can
 * exercise RA's own hardening against a malicious/broken authorization
 * server (metadata issuer mix-up, PKCE downgrade, dropped/forged `state`
 * or RFC 9207 `iss`, non-loopback endpoint advertisement, forced
 * `invalid_grant` on refresh, and a static scope requirement on the
 * resource).
 *
 * Test-only infrastructure — never imported from `src/`, lives under
 * `tests/`, which `packages/tools/tsconfig.json` already excludes from the
 * package's build (`"exclude": ["tests/**\/*", "dist"]`).
 */
import { SignJWT, jwtVerify, generateSecret, type JWTPayload } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface FixtureClient {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUris: readonly string[];
}

/**
 * Misbehavior switches. All default to the spec-compliant behavior (i.e.
 * every field defaults to "off" / unset); flipping one makes the fixture
 * emulate a specific malicious or broken authorization server so a later
 * task's test can prove RA's own hardening rejects it.
 */
export interface FixtureOverrides {
  /** AS metadata's `issuer` field no longer matches the AS's real base URL. */
  issuerMismatch?: boolean;
  /** AS metadata advertises only `["plain"]` for `code_challenge_methods_supported`. */
  onlyPlainPkce?: boolean;
  /** Replaces the advertised `authorization_endpoint` with this exact (possibly malformed) string. */
  authorizationEndpoint?: string;
  /** AS metadata advertises `authorization_endpoint`/`token_endpoint`/`registration_endpoint` under a plausible-looking non-loopback hostname (still `http://`), instead of the real loopback address. */
  httpEndpointsOnNonLoopbackName?: boolean;
  /** `/token` with `grant_type=refresh_token` always returns `invalid_grant`, regardless of the refresh token's validity. */
  refreshReturnsInvalidGrant?: boolean;
  /** The protected resource requires this exact scope on every call; tokens lacking it get 403 `insufficient_scope`. */
  requireScope?: string;
  /** `/authorize`'s redirect omits the `state` parameter entirely. */
  omitStateOnRedirect?: boolean;
  /** `/authorize`'s redirect echoes back a `state` value that does not match what the caller sent. */
  wrongStateOnRedirect?: boolean;
  /** Sets `authorization_response_iss_parameter_supported: true` in AS metadata (RFC 9207). */
  advertiseIssParameterSupported?: boolean;
  /** `/authorize`'s redirect omits the `iss` parameter entirely. */
  omitIssOnRedirect?: boolean;
  /** `/authorize`'s redirect includes an `iss` value that does not match this AS's real issuer. */
  wrongIssOnRedirect?: boolean;
}

export interface RecordedRequest {
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface OAuthMcpFixture {
  /** Protected MCP endpoint, e.g. `http://127.0.0.1:<port>/mcp`. */
  readonly resourceUrl: string;
  /** Authorization server base URL. */
  readonly issuer: string;
  /** Every request received by either server, in arrival order. Live view — grows as requests come in. */
  readonly requests: ReadonlyArray<RecordedRequest>;
  mintAccessToken(opts?: { aud?: string; scope?: string; expiresIn?: number }): Promise<string>;
  configure(overrides: FixtureOverrides): void;
  close(): Promise<void>;
}

export interface StartOAuthMcpFixtureOptions {
  readonly clients?: readonly FixtureClient[];
}

// ─── Internal record shapes ─────────────────────────────────────────────────

interface AuthCodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string | undefined;
  readonly codeChallengeMethod: "S256" | "plain" | undefined;
  readonly scope: string;
  readonly resource: string | undefined;
  readonly sub: string;
  consumed: boolean;
}

interface RefreshTokenRecord {
  readonly clientId: string;
  readonly scope: string;
  readonly resource: string | undefined;
  readonly sub: string;
}

interface RegisteredClient {
  readonly clientId: string;
  readonly clientSecret: string | undefined;
  readonly redirectUris: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURE_SUBJECT = "fixture-user";

const base64UrlEncode = (bytes: ArrayBuffer): string =>
  Buffer.from(bytes).toString("base64url");

const sha256Base64Url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64UrlEncode(digest);
};

/** Coerces an arbitrary parsed body/query object into a flat string map for `requests` recording. */
const toStringParams = (obj: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
};

const readStringParam = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const jsonError = (status: number, error: string, description?: string): Response =>
  Response.json(
    description ? { error, error_description: description } : { error },
    { status },
  );

/** Parses a request's body as either JSON or `application/x-www-form-urlencoded` into a flat string map. */
const parseBodyParams = async (req: Request): Promise<Record<string, string>> => {
  const contentType = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length === 0) return {};
  if (contentType.includes("application/json")) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      return toStringParams(parsed as Record<string, unknown>);
    }
    return {};
  }
  return toStringParams(Object.fromEntries(new URLSearchParams(text)));
};

// ─── Fixture implementation ────────────────────────────────────────────────

export async function startOAuthMcpFixture(
  opts?: StartOAuthMcpFixtureOptions,
): Promise<OAuthMcpFixture> {
  const signingKey = await generateSecret("HS256");

  const requests: RecordedRequest[] = [];
  const record = (path: string, params: Record<string, string>): void => {
    requests.push({ path, params });
  };

  let overrides: FixtureOverrides = {};

  const authCodes = new Map<string, AuthCodeRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const clients = new Map<string, RegisteredClient>();
  for (const c of opts?.clients ?? []) {
    clients.set(c.clientId, {
      clientId: c.clientId,
      clientSecret: c.clientSecret,
      redirectUris: [...c.redirectUris],
    });
  }

  // `issuerBaseUrl` is filled in once the auth server is bound (below); the
  // resource server's fetch handler only reads it once an actual request
  // arrives, which can't happen before `startOAuthMcpFixture` returns.
  let issuerBaseUrl = "";

  // ── Resource server (protected MCP) ────────────────────────────────────

  const resourceServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handleResourceRequest(req),
  });
  const resourceUrl = `http://127.0.0.1:${resourceServer.port}/mcp`;
  const resourceMetadataUrl = `http://127.0.0.1:${resourceServer.port}/.well-known/oauth-protected-resource`;

  async function signAccessToken(params: {
    sub: string;
    aud: string;
    scope: string;
    clientId: string;
    expiresIn: number;
  }): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: JWTPayload = {
      sub: params.sub,
      aud: params.aud,
      scope: params.scope,
      client_id: params.clientId,
      iat: now,
      exp: now + params.expiresIn,
    };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuerBaseUrl)
      .sign(signingKey);
  }

  function makeWhoamiServer(): McpServer {
    const mcp = new McpServer({ name: "oauth-mcp-fixture", version: "1.0.0" });
    mcp.registerTool(
      "whoami",
      { title: "Who Am I", description: "Returns the calling access token's subject." },
      (extra) => {
        const authInfo = extra.authInfo;
        const sub = authInfo?.extra?.["sub"];
        return {
          content: [{ type: "text", text: typeof sub === "string" ? sub : "" }],
        };
      },
    );
    return mcp;
  }

  async function handleResourceRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
      record(url.pathname, toStringParams(Object.fromEntries(url.searchParams)));
      return Response.json({
        resource: resourceUrl,
        authorization_servers: [issuerBaseUrl],
        bearer_methods_supported: ["header"],
      });
    }

    if (url.pathname === "/mcp") {
      record(url.pathname, toStringParams(Object.fromEntries(url.searchParams)));

      const authHeader = req.headers.get("authorization") ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(authHeader);
      const unauthorized = (): Response =>
        new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"` },
        });

      if (!match) return unauthorized();
      const token = match[1] ?? "";

      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, signingKey, { algorithms: ["HS256"] });
        payload = verified.payload;
      } catch {
        return unauthorized();
      }

      const aud = payload.aud;
      const audMatches =
        aud === resourceUrl || (Array.isArray(aud) && aud.includes(resourceUrl));
      if (!audMatches) return unauthorized();

      const scopeString = readStringParam(payload["scope"]) ?? "";
      const scopes = scopeString.length > 0 ? scopeString.split(" ") : [];

      const requiredScope = overrides.requireScope;
      if (requiredScope !== undefined && !scopes.includes(requiredScope)) {
        return new Response(null, {
          status: 403,
          headers: {
            "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      const authInfo: AuthInfo = {
        token,
        clientId: readStringParam(payload["client_id"]) ?? "unknown",
        scopes,
        expiresAt: payload.exp,
        resource: new URL(resourceUrl),
        extra: { sub: payload.sub ?? "" },
      };

      // JSON responses (not SSE) — every consumer of this fixture, including
      // its own fixture.test.ts, talks plain request/response JSON-RPC; the
      // real MCP client SDK (Tasks 3-6) handles either mode transparently.
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const server = makeWhoamiServer();
      await server.connect(transport);
      return transport.handleRequest(req, { authInfo });
    }

    return new Response("Not Found", { status: 404 });
  }

  // ── Authorization server ────────────────────────────────────────────────

  const authServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handleAuthRequest(req),
  });
  issuerBaseUrl = `http://127.0.0.1:${authServer.port}`;

  function metadataEndpoints(): {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  } {
    if (overrides.httpEndpointsOnNonLoopbackName) {
      const fakeHost = `http://oauth-authz.fixture.invalid:${authServer.port}`;
      return {
        authorization_endpoint: overrides.authorizationEndpoint ?? `${fakeHost}/authorize`,
        token_endpoint: `${fakeHost}/token`,
        registration_endpoint: `${fakeHost}/register`,
      };
    }
    return {
      authorization_endpoint: overrides.authorizationEndpoint ?? `${issuerBaseUrl}/authorize`,
      token_endpoint: `${issuerBaseUrl}/token`,
      registration_endpoint: `${issuerBaseUrl}/register`,
    };
  }

  function authServerMetadata(): Record<string, unknown> {
    const endpoints = metadataEndpoints();
    return {
      issuer: overrides.issuerMismatch ? `${issuerBaseUrl}-mismatched-issuer` : issuerBaseUrl,
      authorization_endpoint: endpoints.authorization_endpoint,
      token_endpoint: endpoints.token_endpoint,
      registration_endpoint: endpoints.registration_endpoint,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
      code_challenge_methods_supported: overrides.onlyPlainPkce ? ["plain"] : ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      scopes_supported: ["whoami"],
      authorization_response_iss_parameter_supported:
        overrides.advertiseIssParameterSupported === true,
    };
  }

  function validateResourceParam(resource: string | undefined): Response | undefined {
    if (resource === undefined) {
      return jsonError(400, "invalid_target", "missing resource parameter");
    }
    if (resource !== resourceUrl) {
      return jsonError(400, "invalid_target", "resource does not match this fixture's protected resource");
    }
    return undefined;
  }

  async function handleAuthorize(url: URL): Promise<Response> {
    const params = toStringParams(Object.fromEntries(url.searchParams));
    record("/authorize", params);

    const clientId = url.searchParams.get("client_id") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge") ?? undefined;
    const codeChallengeMethodRaw = url.searchParams.get("code_challenge_method");
    const codeChallengeMethod: "S256" | "plain" | undefined =
      codeChallengeMethodRaw === "plain" ? "plain" : codeChallengeMethodRaw === "S256" ? "S256" : undefined;
    const scope = url.searchParams.get("scope") ?? "";
    const resource = url.searchParams.get("resource") ?? undefined;

    if (!redirectUri) {
      return jsonError(400, "invalid_request", "missing redirect_uri");
    }

    const code = crypto.randomUUID();
    authCodes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      resource,
      sub: FIXTURE_SUBJECT,
      consumed: false,
    });

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);

    if (!overrides.omitStateOnRedirect) {
      redirectUrl.searchParams.set(
        "state",
        overrides.wrongStateOnRedirect ? "wrong-state-value" : state ?? "",
      );
    }
    if (!overrides.omitIssOnRedirect) {
      redirectUrl.searchParams.set(
        "iss",
        overrides.wrongIssOnRedirect ? `${issuerBaseUrl}-wrong-issuer` : issuerBaseUrl,
      );
    }

    return new Response(null, { status: 302, headers: { Location: redirectUrl.toString() } });
  }

  async function handleAuthorizationCodeGrant(body: Record<string, string>): Promise<Response> {
    const code = body["code"];
    const codeVerifier = body["code_verifier"];
    const resource = body["resource"];
    const redirectUri = body["redirect_uri"];

    if (!code) return jsonError(400, "invalid_request", "missing code");
    const codeRecord = authCodes.get(code);
    if (!codeRecord || codeRecord.consumed) return jsonError(400, "invalid_grant", "unknown or already-used code");
    if (redirectUri !== undefined && redirectUri !== codeRecord.redirectUri) {
      return jsonError(400, "invalid_grant", "redirect_uri mismatch");
    }

    if (codeRecord.codeChallenge) {
      if (!codeVerifier) return jsonError(400, "invalid_grant", "missing code_verifier");
      const method = codeRecord.codeChallengeMethod ?? "S256";
      const computed = method === "plain" ? codeVerifier : await sha256Base64Url(codeVerifier);
      if (computed !== codeRecord.codeChallenge) {
        return jsonError(400, "invalid_grant", "PKCE verification failed");
      }
    }

    const resourceError = validateResourceParam(resource);
    if (resourceError) return resourceError;

    codeRecord.consumed = true;

    const accessToken = await signAccessToken({
      sub: codeRecord.sub,
      aud: resource ?? resourceUrl,
      scope: codeRecord.scope,
      clientId: codeRecord.clientId,
      expiresIn: 3600,
    });
    const refreshToken = crypto.randomUUID();
    refreshTokens.set(refreshToken, {
      clientId: codeRecord.clientId,
      scope: codeRecord.scope,
      resource,
      sub: codeRecord.sub,
    });

    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
      scope: codeRecord.scope,
    });
  }

  async function handleRefreshTokenGrant(body: Record<string, string>): Promise<Response> {
    if (overrides.refreshReturnsInvalidGrant) {
      return jsonError(400, "invalid_grant", "refresh forced to fail by fixture override");
    }

    const refreshToken = body["refresh_token"];
    const resource = body["resource"];
    if (!refreshToken) return jsonError(400, "invalid_request", "missing refresh_token");

    const refreshRecord = refreshTokens.get(refreshToken);
    if (!refreshRecord) return jsonError(400, "invalid_grant", "unknown refresh_token");

    const resourceError = validateResourceParam(resource ?? refreshRecord.resource);
    if (resourceError) return resourceError;

    // Rotation: the old refresh token is invalidated as soon as a new one is issued.
    refreshTokens.delete(refreshToken);
    const newRefreshToken = crypto.randomUUID();
    refreshTokens.set(newRefreshToken, refreshRecord);

    const accessToken = await signAccessToken({
      sub: refreshRecord.sub,
      aud: resource ?? refreshRecord.resource ?? resourceUrl,
      scope: refreshRecord.scope,
      clientId: refreshRecord.clientId,
      expiresIn: 3600,
    });

    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: newRefreshToken,
      scope: refreshRecord.scope,
    });
  }

  async function handleClientCredentialsGrant(body: Record<string, string>): Promise<Response> {
    const clientId = body["client_id"] ?? "";
    const scope = body["scope"] ?? "";
    const resource = body["resource"];

    const resourceError = validateResourceParam(resource);
    if (resourceError) return resourceError;

    const accessToken = await signAccessToken({
      sub: clientId,
      aud: resource ?? resourceUrl,
      scope,
      clientId,
      expiresIn: 3600,
    });

    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    });
  }

  async function handleToken(req: Request): Promise<Response> {
    const body = await parseBodyParams(req);
    record("/token", body);

    switch (body["grant_type"]) {
      case "authorization_code":
        return handleAuthorizationCodeGrant(body);
      case "refresh_token":
        return handleRefreshTokenGrant(body);
      case "client_credentials":
        return handleClientCredentialsGrant(body);
      default:
        return jsonError(400, "unsupported_grant_type", body["grant_type"] ?? "missing grant_type");
    }
  }

  async function handleRegister(req: Request): Promise<Response> {
    const body = await parseBodyParams(req);
    record("/register", body);

    const redirectUrisRaw = body["redirect_uris"];
    let redirectUris: string[] = [];
    if (redirectUrisRaw) {
      try {
        const parsed: unknown = JSON.parse(redirectUrisRaw);
        if (Array.isArray(parsed)) {
          redirectUris = parsed.filter((v): v is string => typeof v === "string");
        }
      } catch {
        redirectUris = [];
      }
    }

    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomUUID();
    clients.set(clientId, { clientId, clientSecret, redirectUris });

    return Response.json(
      {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "client_secret_post",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      },
      { status: 201 },
    );
  }

  async function handleAuthRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      record(url.pathname, toStringParams(Object.fromEntries(url.searchParams)));
      return Response.json(authServerMetadata());
    }
    if (url.pathname === "/authorize" && req.method === "GET") {
      return handleAuthorize(url);
    }
    if (url.pathname === "/token" && req.method === "POST") {
      return handleToken(req);
    }
    if (url.pathname === "/register" && req.method === "POST") {
      return handleRegister(req);
    }
    return new Response("Not Found", { status: 404 });
  }

  return {
    resourceUrl,
    issuer: issuerBaseUrl,
    requests,
    mintAccessToken: (mintOpts) =>
      signAccessToken({
        sub: FIXTURE_SUBJECT,
        aud: mintOpts?.aud ?? resourceUrl,
        scope: mintOpts?.scope ?? "",
        clientId: "fixture-direct-mint",
        expiresIn: mintOpts?.expiresIn ?? 3600,
      }),
    configure: (next) => {
      overrides = { ...overrides, ...next };
    },
    close: async () => {
      resourceServer.stop(true);
      authServer.stop(true);
    },
  };
}
