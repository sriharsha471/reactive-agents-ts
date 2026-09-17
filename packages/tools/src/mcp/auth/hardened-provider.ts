/**
 * MCP client OAuth — hardening wrapper.
 *
 * Part of Task 5 of `wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md`.
 *
 * Wraps every `OAuthClientProvider` RA constructs from its OWN `MCPAuthConfig`
 * (client_credentials, private_key_jwt, authorization_code — see
 * `create-provider.ts`) to close three gaps Task 0 confirmed the installed
 * `@modelcontextprotocol/sdk@1.29.0` does not cover, plus expose a redactor
 * used at the `mcp-client.ts` error boundary. NEVER applied to a caller-
 * supplied `type: "provider"` config — that caller owns its own security
 * properties (see `create-provider.ts`'s `createAuthProvider`).
 *
 * Interception point for the first two gaps: `OAuthClientProvider.saveDiscoveryState`.
 * The SDK's `auth()` orchestrator (`client/auth.js`, `authInternal`) calls
 * `provider.saveDiscoveryState?.(state)` immediately after RFC 9728/8414
 * discovery completes and BEFORE it ever uses any endpoint from that
 * discovery (`selectResourceURL`, `startAuthorization`, `registerClient`,
 * `fetchToken` all run later in the same function) — so throwing here is a
 * true fail-closed point, not a race with an already-issued request. The
 * `state` argument's shape (`{ authorizationServerUrl: string;
 * authorizationServerMetadata?: AuthorizationServerMetadata; ... }`) is the
 * SDK's OWN `OAuthDiscoveryState` type (imported directly from
 * `client/auth.js`) — deliberately NOT this package's `./types.js`
 * `OAuthDiscoveryState`, which is a smaller, incompatible,
 * `MCPTokenStore`-facing shape (see that file's own comment on the name
 * collision). This wrapper always defines `saveDiscoveryState`, even when
 * `inner` does not (true for both M2M providers built via `withPersistence`
 * in `create-provider.ts`), because `auth()` calls it on the OUTER
 * (wrapped) provider it was actually handed — the hook fires for every
 * grant type this task wraps.
 *
 * 1. **Issuer mix-up (Task 0 gap 1):** the SDK returns whatever `issuer` an
 *    authorization server's metadata claims, with no comparison against the
 *    URL that metadata was fetched from — confirmed by
 *    `sdk-behavior-probe.test.ts`'s "does NOT validate metadata.issuer..."
 *    test. `state.authorizationServerUrl` is the URL discovery actually used
 *    (RFC 9728 `authorization_servers[0]`, or the MCP server's own origin as
 *    a fallback); `state.authorizationServerMetadata.issuer` is the value
 *    that server claims. RFC 8414 §2 requires them to match — compared via
 *    `normalizeIssuerUrl` (both sides re-serialized through WHATWG `URL`) so
 *    a trailing-slash-only difference is not treated as a mismatch. Found
 *    live 2026-09-17 against Google's real Home MCP server: Google's issuer
 *    is published as `https://accounts.google.com` (no trailing slash) while
 *    the discovered authorization-server URL was `https://accounts.google.com/`
 *    — a naive `!==` comparison refused every server exhibiting this
 *    well-known Google OAuth/OIDC quirk. A genuine scheme/host/port/path
 *    difference still fails to match after normalization and is refused.
 *
 * 2. **HTTPS downgrade (Task 0 gap 3):** the SDK's `SafeUrlSchema` only
 *    blocks `javascript:`/`data:`/`vbscript:` on discovered endpoints —
 *    confirmed by the same test file's "HTTPS enforcement" pin. Every
 *    `authorization_endpoint` / `token_endpoint` / `registration_endpoint`
 *    a discovered metadata document advertises must be `https:` unless its
 *    hostname is a loopback address (127.0.0.1 / ::1 / localhost) — same
 *    loopback-dev-exception convention as `packages/runtime-shim/src/secure-serve.ts`'s
 *    `LOOPBACK_HOSTS` (not reused directly: that module is a server-bind
 *    helper in a different package, this is a URL-hostname check on
 *    discovered client-side endpoints).
 *
 * 3. **Error sanitization (Task 0 gap 4 + this task's own scope):** the
 *    SDK's `parseErrorResponse` (`client/auth.js`) echoes a server's raw,
 *    non-RFC-6749-JSON error body verbatim into a thrown error's `.message`
 *    with zero redaction — confirmed by
 *    `sdk-behavior-probe.test.ts`'s "leaks a non-JSON... error body
 *    verbatim" test. This wrapper observes every OAuth secret this provider
 *    ever produces or consumes (access token, refresh token, client secret,
 *    code verifier, and — for authorization-code providers — the
 *    authorization code) and exposes {@link HardenedProviderExtras.redactSecrets},
 *    which `mcp-client.ts` calls on every error message crossing into
 *    `MCPConnectionError` / `ToolExecutionError`. `redactSecrets` also
 *    always strips any `Bearer <token>` pattern, independent of whether that
 *    exact token was ever observed by this provider instance — belt and
 *    suspenders against a token minted or rotated by a path this wrapper
 *    didn't see.
 */
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationCodeProviderExtra } from "./authorization-code-provider.js";

/**
 * Loopback hostnames exempt from the HTTPS requirement (dev/test convention shared
 * across this plan). Exported so `mcp-client.ts` (the MCP-endpoint-itself HTTPS check)
 * and `apps/cli`'s `mcp.ts` (the logout-revocation HTTPS check, final-review C2) use the
 * exact same set instead of each maintaining their own copy — `packages/runtime-shim`'s
 * independent copy is a different package with its own reasons to stay separate and is
 * intentionally not consolidated here.
 */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Secrets shorter than this are not registered for redaction — avoids clobbering incidental short substrings. */
const MIN_SECRET_LENGTH = 8;

const REDACTED = "[REDACTED]";

/** Matches an `Authorization: Bearer <token>`-shaped substring anywhere in a string, case-insensitively. */
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Redacts every registered secret from `message`, longest-first (so a short
 * secret that happens to be a substring of a longer one never leaves a
 * partial fragment behind), then strips any `Bearer <token>` pattern
 * unconditionally.
 */
export function redactKnownSecrets(message: string, secrets: ReadonlySet<string>): string {
  let out = message;
  const sorted = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    out = out.split(secret).join(REDACTED);
  }
  return out.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
}

/**
 * Generic, provider-independent redaction — strips `Bearer <token>` patterns
 * only. Used as the fallback at `mcp-client.ts`'s error boundary when no
 * hardened provider is available to supply its observed secret set (e.g. a
 * connect attempt that never got far enough to construct one).
 */
export function redactBearerTokens(message: string): string {
  return message.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
}

/**
 * True when `urlString` is `https:`, or its hostname is a loopback address. Exported
 * (final-review C2) so `apps/cli`'s `mcp.ts` can apply the identical check to a
 * discovered `revocation_endpoint` / authorization-server URL before ever POSTing a
 * refresh token or client secret to it.
 */
export function isHttpsOrLoopback(urlString: string): boolean {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    // Malformed URL — not this wrapper's concern to diagnose; downstream SDK
    // URL parsing will fail on its own with a clearer error.
    return true;
  }
  if (url.protocol === "https:") return true;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/**
 * Final-review I3: `validateIssuerMatch`/`validateHttpsEndpoints` below both no-op when
 * `state.authorizationServerMetadata` is absent (RFC 8414 discovery 404s) — but the SDK
 * still falls back to constructing `/authorize`, `/token`, `/register` directly against
 * `state.authorizationServerUrl` (the RFC 9728 resource-metadata value, or the MCP
 * server's own origin) in that case. This check runs BEFORE either `!metadata` early
 * return, so a plaintext authorization-server URL is rejected even with zero discovered
 * metadata — no credential is ever sent to it.
 */
function validateAuthorizationServerUrlIsSecure(state: OAuthDiscoveryState, serverName: string): void {
  if (!isHttpsOrLoopback(state.authorizationServerUrl)) {
    throw new Error(
      `MCP server "${serverName}": authorization-server URL "${state.authorizationServerUrl}" is not HTTPS and is not a loopback address — refusing a plaintext authorization server, even with no discovered metadata document (downgrade-to-plaintext protection)`,
    );
  }
}

/**
 * Normalizes a URL string for issuer comparison. WHATWG `URL` always
 * serializes a path-less origin with a trailing `/` (`new URL("https://x.com").toString()
 * === "https://x.com/"`), but RFC 8414 issuer values in the wild are commonly
 * published WITHOUT one (e.g. Google's `https://accounts.google.com`) — a
 * naive `!==` comparison treats every such server as a mix-up attack. Both
 * sides are re-serialized through the same parser so only a real
 * scheme/host/port/path difference trips the check. Falls back to the raw
 * string on a genuinely malformed URL, which then simply fails to match
 * (fails closed).
 */
function normalizeIssuerUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

function validateIssuerMatch(state: OAuthDiscoveryState, serverName: string): void {
  const metadata = state.authorizationServerMetadata;
  if (!metadata) return;
  if (normalizeIssuerUrl(metadata.issuer) !== normalizeIssuerUrl(state.authorizationServerUrl)) {
    throw new Error(
      `MCP server "${serverName}": authorization-server metadata issuer "${metadata.issuer}" does not match the authorization-server URL "${state.authorizationServerUrl}" it was discovered from — refusing (RFC 8414 issuer mix-up protection)`,
    );
  }
}

function validateHttpsEndpoints(state: OAuthDiscoveryState, serverName: string): void {
  const metadata = state.authorizationServerMetadata;
  if (!metadata) return;
  const endpoints: ReadonlyArray<readonly [string, string | undefined]> = [
    ["authorization_endpoint", metadata.authorization_endpoint],
    ["token_endpoint", metadata.token_endpoint],
    ["registration_endpoint", metadata.registration_endpoint],
  ];
  for (const [name, url] of endpoints) {
    if (url === undefined) continue;
    if (!isHttpsOrLoopback(url)) {
      throw new Error(
        `MCP server "${serverName}": authorization-server metadata's "${name}" ("${url}") is not HTTPS and is not a loopback address — refusing a plaintext OAuth endpoint (downgrade-to-plaintext protection)`,
      );
    }
  }
}

export interface HardenedProviderExtras {
  /**
   * Redacts every OAuth secret this provider instance has observed (access
   * token, refresh token, client secret, code verifier, authorization code)
   * plus any `Bearer <token>` pattern from `message`.
   */
  redactSecrets(message: string): string;
}

/** True when `provider` additionally implements {@link HardenedProviderExtras}. */
export function hasRedactor(
  provider: OAuthClientProvider,
): provider is OAuthClientProvider & HardenedProviderExtras {
  return typeof (provider as Partial<HardenedProviderExtras>).redactSecrets === "function";
}

function hasAuthorizationCodeShape(
  provider: OAuthClientProvider,
): provider is OAuthClientProvider & AuthorizationCodeProviderExtra {
  const candidate = provider as Partial<AuthorizationCodeProviderExtra>;
  return (
    typeof candidate.waitForAuthorizationCode === "function" &&
    typeof candidate.disposeAuthorizationListener === "function"
  );
}

/**
 * Wraps `inner` (an `OAuthClientProvider` `create-provider.ts` built from
 * RA's own `MCPAuthConfig`) with the hardening described in this file's
 * module comment. Every member not touched by a check above is delegated to
 * `inner` unchanged. If `inner` also implements
 * {@link AuthorizationCodeProviderExtra} (only `createAuthorizationCodeProvider`'s
 * return value does), those members are preserved on the returned object —
 * `mcp-client.ts`'s `hasAuthorizationCodeHandle` type guard must keep
 * recognizing a hardened authorization_code provider as one.
 */
export function hardenProvider<P extends OAuthClientProvider>(
  inner: P,
  ctx: { readonly serverName: string },
): P & HardenedProviderExtras {
  const secrets = new Set<string>();
  const remember = (value: string | undefined | null): void => {
    if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };

  const base: OAuthClientProvider = {
    get redirectUrl() {
      return inner.redirectUrl;
    },
    get clientMetadata() {
      return inner.clientMetadata;
    },
    clientMetadataUrl: inner.clientMetadataUrl,
    state: inner.state ? () => inner.state!() : undefined,

    clientInformation: async (): Promise<OAuthClientInformationMixed | undefined> => {
      const info = await inner.clientInformation();
      remember(info?.client_secret);
      return info;
    },
    saveClientInformation: inner.saveClientInformation
      ? async (info: OAuthClientInformationMixed): Promise<void> => {
          remember(info.client_secret);
          await inner.saveClientInformation!(info);
        }
      : undefined,

    tokens: async (): Promise<OAuthTokens | undefined> => {
      const t = await inner.tokens();
      remember(t?.access_token);
      remember(t?.refresh_token);
      return t;
    },
    saveTokens: async (tokens: OAuthTokens): Promise<void> => {
      remember(tokens.access_token);
      remember(tokens.refresh_token);
      await inner.saveTokens(tokens);
    },

    redirectToAuthorization: (url) => inner.redirectToAuthorization(url),
    saveCodeVerifier: async (verifier: string): Promise<void> => {
      remember(verifier);
      await inner.saveCodeVerifier(verifier);
    },
    codeVerifier: async (): Promise<string> => {
      const v = await inner.codeVerifier();
      remember(v);
      return v;
    },

    addClientAuthentication: inner.addClientAuthentication,
    prepareTokenRequest: inner.prepareTokenRequest
      ? (scope) => inner.prepareTokenRequest!(scope)
      : undefined,
    validateResourceURL: inner.validateResourceURL
      ? (serverUrl, resource) => inner.validateResourceURL!(serverUrl, resource)
      : undefined,

    invalidateCredentials: inner.invalidateCredentials
      ? (scope) => inner.invalidateCredentials!(scope)
      : undefined,

    // Always defined regardless of whether `inner` implements it — this is
    // the interception point for gaps 1 and 2 (see module comment). Runs on
    // EVERY grant type this task wraps, because `auth()` always calls
    // discovery (and therefore `saveDiscoveryState?.()`) on a provider whose
    // `discoveryState()` returns nothing cached, which is every case here.
    saveDiscoveryState: async (state: OAuthDiscoveryState): Promise<void> => {
      validateAuthorizationServerUrlIsSecure(state, ctx.serverName);
      validateIssuerMatch(state, ctx.serverName);
      validateHttpsEndpoints(state, ctx.serverName);
      await inner.saveDiscoveryState?.(state);
    },
    discoveryState: inner.discoveryState ? () => inner.discoveryState!() : undefined,
  };

  const extras: HardenedProviderExtras = {
    redactSecrets: (message: string): string => redactKnownSecrets(message, secrets),
  };

  const authCodeExtras: Partial<AuthorizationCodeProviderExtra> = hasAuthorizationCodeShape(inner)
    ? {
        waitForAuthorizationCode: async (): Promise<string> => {
          const code = await inner.waitForAuthorizationCode();
          remember(code);
          return code;
        },
        disposeAuthorizationListener: (): Promise<void> => inner.disposeAuthorizationListener(),
      }
    : {};

  return Object.assign(base, extras, authCodeExtras) as P & HardenedProviderExtras;
}
