import { describe, it, expect, afterEach } from "bun:test";
import { startOAuthMcpFixture, type OAuthMcpFixture } from "./fixture.js";

let fixture: OAuthMcpFixture | undefined;

afterEach(async () => {
  if (fixture) {
    await fixture.close();
    fixture = undefined;
  }
});

const callWhoami = (resourceUrl: string, token?: string): Promise<Response> =>
  fetch(resourceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    }),
  });

const sha256Base64Url = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(digest).toString("base64url");
};

describe("OAuthMcpFixture", () => {
  it("exposes a canonical resourceUrl and issuer on loopback", async () => {
    fixture = await startOAuthMcpFixture();
    expect(fixture.resourceUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(fixture.issuer).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("401s an unauthenticated MCP call with a WWW-Authenticate resource_metadata pointer", async () => {
    fixture = await startOAuthMcpFixture();
    const res = await callWhoami(fixture.resourceUrl);
    expect(res.status).toBe(401);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain("Bearer");
    const match = /resource_metadata="([^"]+)"/.exec(header);
    expect(match).not.toBeNull();
    const metaRes = await fetch(match![1]);
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as { resource: string; authorization_servers: string[] };
    expect(meta.resource).toBe(fixture.resourceUrl);
    expect(meta.authorization_servers).toEqual([fixture.issuer]);
  });

  it("serves RFC 8414 authorization-server metadata", async () => {
    fixture = await startOAuthMcpFixture();
    const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta["issuer"]).toBe(fixture.issuer);
    expect(meta["authorization_endpoint"]).toBe(`${fixture.issuer}/authorize`);
    expect(meta["token_endpoint"]).toBe(`${fixture.issuer}/token`);
    expect(meta["registration_endpoint"]).toBe(`${fixture.issuer}/register`);
    expect(meta["code_challenge_methods_supported"]).toEqual(["S256"]);
    expect(meta["authorization_response_iss_parameter_supported"]).toBe(false);
  });

  it("a valid access token can call the whoami tool", async () => {
    fixture = await startOAuthMcpFixture();
    const token = await fixture.mintAccessToken();
    const res = await callWhoami(fixture.resourceUrl, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    expect(body.result.content[0]?.text).toBe("fixture-user");
  });

  it("401s a token minted for the wrong audience", async () => {
    fixture = await startOAuthMcpFixture();
    const token = await fixture.mintAccessToken({ aud: "http://127.0.0.1:1/mcp" });
    const res = await callWhoami(fixture.resourceUrl, token);
    expect(res.status).toBe(401);
  });

  it("403s a token missing a fixture-required scope, with insufficient_scope challenge", async () => {
    fixture = await startOAuthMcpFixture();
    fixture.configure({ requireScope: "admin" });
    const token = await fixture.mintAccessToken({ scope: "whoami" });
    const res = await callWhoami(fixture.resourceUrl, token);
    expect(res.status).toBe(403);
    const header = res.headers.get("www-authenticate") ?? "";
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="admin"');
  });

  it("full authorization_code + PKCE S256 + resource flow mints a working token", async () => {
    fixture = await startOAuthMcpFixture();
    const verifier = "test-code-verifier-0123456789abcdefghijklmno";
    const challenge = await sha256Base64Url(verifier);
    const redirectUri = "http://127.0.0.1:9/callback";

    const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "test-client");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", "state-abc");
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", fixture.resourceUrl);

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizeRes.status).toBe(302);
    const location = new URL(authorizeRes.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("state-abc");
    expect(location.searchParams.get("iss")).toBe(fixture.issuer);
    const code = location.searchParams.get("code");
    expect(code).not.toBeNull();

    const tokenRes = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: fixture.resourceUrl,
        client_id: "test-client",
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as { access_token: string; refresh_token: string };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.refresh_token).toBeTruthy();

    const callRes = await callWhoami(fixture.resourceUrl, tokenBody.access_token);
    expect(callRes.status).toBe(200);
  });

  it("PKCE mismatch at the token endpoint returns invalid_grant", async () => {
    fixture = await startOAuthMcpFixture();
    const redirectUri = "http://127.0.0.1:9/callback";
    const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "test-client");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", await sha256Base64Url("correct-verifier"));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", fixture.resourceUrl);

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const location = new URL(authorizeRes.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    const tokenRes = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: "wrong-verifier",
        resource: fixture.resourceUrl,
        client_id: "test-client",
      }),
    });
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  it("rejects a token request with a missing or mismatched resource parameter (RFC 8707)", async () => {
    fixture = await startOAuthMcpFixture();
    const verifier = "verifier-for-resource-check-0123456789";
    const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "test-client");
    authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
    authorizeUrl.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const location = new URL(authorizeRes.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    const tokenRes = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:9/callback",
        code_verifier: verifier,
        // no resource param at all
      }),
    });
    expect(tokenRes.status).toBe(400);
    const body = (await tokenRes.json()) as { error: string };
    expect(body.error).toBe("invalid_target");
  });

  it("refresh_token rotation: old refresh token is invalidated after use", async () => {
    fixture = await startOAuthMcpFixture();
    const verifier = "verifier-for-refresh-rotation-0123456789";
    const redirectUri = "http://127.0.0.1:9/callback";
    const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "test-client");
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("resource", fixture.resourceUrl);

    const authorizeRes = await fetch(authorizeUrl, { redirect: "manual" });
    const location = new URL(authorizeRes.headers.get("location")!);
    const code = location.searchParams.get("code")!;

    const firstToken = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: fixture.resourceUrl,
      }),
    }).then((r) => r.json() as Promise<{ refresh_token: string }>);

    const refreshRes1 = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: firstToken.refresh_token,
        resource: fixture.resourceUrl,
      }),
    });
    expect(refreshRes1.status).toBe(200);
    const refreshed1 = (await refreshRes1.json()) as { refresh_token: string; access_token: string };
    expect(refreshed1.refresh_token).not.toBe(firstToken.refresh_token);

    // Reusing the now-rotated-away original refresh token must fail.
    const refreshRes2 = await fetch(`${fixture.issuer}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: firstToken.refresh_token,
        resource: fixture.resourceUrl,
      }),
    });
    expect(refreshRes2.status).toBe(400);
    const body2 = (await refreshRes2.json()) as { error: string };
    expect(body2.error).toBe("invalid_grant");
  });

  it("RFC 7591 dynamic client registration returns a usable client_id/secret", async () => {
    fixture = await startOAuthMcpFixture();
    const res = await fetch(`${fixture.issuer}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/callback"] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_secret: string; redirect_uris: string[] };
    expect(body.client_id).toBeTruthy();
    expect(body.client_secret).toBeTruthy();
    expect(body.redirect_uris).toEqual(["http://127.0.0.1:9/callback"]);
  });

  it("records every request across both servers", async () => {
    fixture = await startOAuthMcpFixture();
    await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
    await callWhoami(fixture.resourceUrl);
    expect(fixture.requests.some((r) => r.path === "/.well-known/oauth-authorization-server")).toBe(true);
    expect(fixture.requests.some((r) => r.path === "/mcp")).toBe(true);
  });

  describe("misbehavior overrides", () => {
    it("issuerMismatch: metadata issuer no longer matches the AS base URL", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ issuerMismatch: true });
      const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
      const meta = (await res.json()) as { issuer: string };
      expect(meta.issuer).not.toBe(fixture.issuer);
    });

    it("onlyPlainPkce: metadata advertises only plain", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ onlyPlainPkce: true });
      const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
      const meta = (await res.json()) as { code_challenge_methods_supported: string[] };
      expect(meta.code_challenge_methods_supported).toEqual(["plain"]);
    });

    it("authorizationEndpoint: arbitrary override string is echoed verbatim", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ authorizationEndpoint: "not-a-valid-url" });
      const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
      const meta = (await res.json()) as { authorization_endpoint: string };
      expect(meta.authorization_endpoint).toBe("not-a-valid-url");
    });

    it("httpEndpointsOnNonLoopbackName: endpoints advertised under a non-loopback host", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ httpEndpointsOnNonLoopbackName: true });
      const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
      const meta = (await res.json()) as { authorization_endpoint: string; token_endpoint: string };
      expect(meta.authorization_endpoint).not.toContain("127.0.0.1");
      expect(meta.token_endpoint).not.toContain("127.0.0.1");
    });

    it("refreshReturnsInvalidGrant: refresh always fails regardless of validity", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ refreshReturnsInvalidGrant: true });
      const res = await fetch(`${fixture.issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "anything" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_grant");
    });

    it("omitStateOnRedirect: redirect has no state param even when one was sent", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ omitStateOnRedirect: true });
      const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
      authorizeUrl.searchParams.set("client_id", "c");
      authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
      authorizeUrl.searchParams.set("state", "should-be-dropped");
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.has("state")).toBe(false);
    });

    it("wrongStateOnRedirect: redirect echoes a state that doesn't match what was sent", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ wrongStateOnRedirect: true });
      const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
      authorizeUrl.searchParams.set("client_id", "c");
      authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
      authorizeUrl.searchParams.set("state", "original-state");
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("state")).not.toBe("original-state");
    });

    it("advertiseIssParameterSupported: sets the RFC 9207 metadata flag true", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ advertiseIssParameterSupported: true });
      const res = await fetch(`${fixture.issuer}/.well-known/oauth-authorization-server`);
      const meta = (await res.json()) as { authorization_response_iss_parameter_supported: boolean };
      expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    });

    it("omitIssOnRedirect: redirect has no iss param", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ omitIssOnRedirect: true });
      const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
      authorizeUrl.searchParams.set("client_id", "c");
      authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.has("iss")).toBe(false);
    });

    it("wrongIssOnRedirect: redirect carries an iss that doesn't match the real issuer", async () => {
      fixture = await startOAuthMcpFixture();
      fixture.configure({ wrongIssOnRedirect: true });
      const authorizeUrl = new URL(`${fixture.issuer}/authorize`);
      authorizeUrl.searchParams.set("client_id", "c");
      authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:9/callback");
      const res = await fetch(authorizeUrl, { redirect: "manual" });
      const location = new URL(res.headers.get("location")!);
      expect(location.searchParams.get("iss")).not.toBe(fixture.issuer);
    });
  });
});
