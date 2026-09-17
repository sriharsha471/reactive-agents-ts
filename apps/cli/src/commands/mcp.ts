/**
 * `rax mcp login | logout | status` — CLI-driven OAuth for MCP client
 * connections (Task 6 of
 * `wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md`).
 *
 * Reuses, rather than re-derives, everything Tasks 1-5 already built:
 * - `createAuthProvider` (Task 3/4, `@reactive-agents/tools`) builds the
 *   exact same hardened `OAuthClientProvider` `mcp-client.ts`'s `connect()`
 *   uses for a given `MCPServer` + `MCPAuthConfig` — including the Task 4
 *   loopback-redirect listener for `authorization_code` and the Task 5
 *   issuer/HTTPS hardening + secret redaction. This command never builds
 *   its own provider from scratch.
 * - `canonicalResourceKey` / `createFileTokenStore` (Task 2) — the SAME key
 *   derivation `mcp-client.ts` uses when persisting tokens. `logout` and
 *   `status` MUST key off this function too, or a real MCP connection's
 *   stored credentials and this CLI's view of them would silently diverge
 *   (flagged explicitly in the Task 6 brief as the risk point for this
 *   file).
 * - The MCP SDK's own `auth()` orchestrator drives the actual authorization
 *   flow for `login` (discovery, DCR, PKCE, token exchange) — this file
 *   only supplies the provider and reacts to `'REDIRECT'` by waiting on the
 *   provider's loopback listener, exactly as documented on `auth()` itself
 *   (a first call ending in `'REDIRECT'`, then a second call with the
 *   collected `authorizationCode` to complete the exchange).
 *
 * Server resolution: this CLI has exactly one existing "list of configured
 * MCP servers by name" mechanism — `apps/cli/src/commands/run.ts`'s
 * `.rax/mcp.json` (an explicit `--mcp-config <path>`, else auto-detected at
 * `<cwd>/.rax/mcp.json`). That shape is duplicated here (not imported —
 * `run.ts`'s `MCPConfigFile` interface isn't exported, and the two files'
 * needs differ: `run.ts` builds live `.withMCP()` connections, this file
 * only needs a server's `name` → `endpoint` mapping) rather than invented
 * fresh. The `--url <endpoint>` fallback needs no config file at all.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auth,
  discoverOAuthServerInfo,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  canonicalResourceKey,
  createAuthProvider,
  createFileTokenStore,
  hasRedactor,
  isHttpsOrLoopback,
  openBrowser,
  validateAuthEndpointIsHttps,
  type MCPServer,
  type MCPTokenStore,
  type StoredMcpCredentials,
} from "@reactive-agents/tools";
import { fail, info, kv, section, success, warn } from "../ui.js";

// ─── Server resolution (`.rax/mcp.json`, matching `run.ts`) ───────────────

interface MCPConfigFileEntry {
  readonly name: string;
  readonly transport: string;
  readonly endpoint?: string;
}

interface MCPConfigFile {
  readonly servers: readonly MCPConfigFileEntry[];
}

function defaultMcpConfigPath(): string {
  return resolve(process.cwd(), ".rax", "mcp.json");
}

function loadMcpConfigFile(mcpConfigPath?: string): { file: string; config: MCPConfigFile } | undefined {
  const file = mcpConfigPath ?? defaultMcpConfigPath();
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf-8");
  const config = JSON.parse(raw) as MCPConfigFile;
  return { file, config };
}

function resolveEndpointFromConfig(name: string, mcpConfigPath?: string): string {
  const loaded = loadMcpConfigFile(mcpConfigPath);
  if (!loaded) {
    throw new Error(
      `rax mcp: no MCP config found for server "${name}" (looked for ${mcpConfigPath ?? defaultMcpConfigPath()}). ` +
        `Configure it there, or use --url <endpoint> for an ad-hoc login.`,
    );
  }
  const entry = loaded.config.servers.find((s) => s.name === name);
  if (!entry) {
    const known = loaded.config.servers.map((s) => s.name).join(", ") || "(none)";
    throw new Error(`rax mcp: server "${name}" not found in ${loaded.file}. Known servers: ${known}`);
  }
  if (!entry.endpoint) {
    throw new Error(
      `rax mcp: server "${name}" (transport "${entry.transport}") has no "endpoint" configured — OAuth requires an HTTP endpoint.`,
    );
  }
  return entry.endpoint;
}

export interface MCPTarget {
  readonly kind: "name" | "url";
  readonly value: string;
}

export interface ResolvedTarget {
  readonly url: string;
  /** Human-facing label — the configured server name, or the raw URL for `--url`. */
  readonly label: string;
}

export function resolveTarget(target: MCPTarget, mcpConfigPath?: string): ResolvedTarget {
  const resolved =
    target.kind === "url"
      ? { url: target.value, label: target.value }
      : { url: resolveEndpointFromConfig(target.value, mcpConfigPath), label: target.value };
  // Final-review I4: `mcp-client.ts`'s `connect()` path enforces HTTPS-unless-loopback
  // for any `auth`-bearing endpoint via `validateAuthConfig`, but this CLI drives the
  // SDK's `auth()` orchestrator directly and never goes through `connect()` — so it
  // never crossed that check. Run the identical check here, before any caller
  // (`runLogin`/`runLogout`) does anything network-facing with `resolved.url`.
  validateAuthEndpointIsHttps(resolved.label, resolved.url);
  return resolved;
}

// ─── Argument parsing ──────────────────────────────────────────────────────

function parseTargetAndFlag(
  argv: readonly string[],
  extraFlags: (arg: string, next: () => string | undefined) => boolean,
  usage: string,
): { target: MCPTarget; mcpConfigPath?: string } {
  let name: string | undefined;
  let url: string | undefined;
  let mcpConfigPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string | undefined => argv[++i];
    if (arg === "--url") {
      const v = next();
      if (v === undefined) throw new Error(`${usage}: --url requires a value`);
      url = v;
    } else if (arg === "--mcp-config") {
      const v = next();
      if (v === undefined) throw new Error(`${usage}: --mcp-config requires a value`);
      mcpConfigPath = v;
    } else if (extraFlags(arg, next)) {
      // handled by caller
    } else if (!arg.startsWith("--") && name === undefined && url === undefined) {
      name = arg;
    } else if (arg.startsWith("--")) {
      throw new Error(`${usage}: unknown flag "${arg}"`);
    } else {
      throw new Error(`${usage}: unexpected argument "${arg}"`);
    }
  }

  if (url !== undefined && name !== undefined) {
    throw new Error(`${usage}: pass either <name> or --url <endpoint>, not both`);
  }
  if (url !== undefined) {
    return { target: { kind: "url", value: url }, mcpConfigPath };
  }
  if (name !== undefined) {
    return { target: { kind: "name", value: name }, mcpConfigPath };
  }
  throw new Error(`${usage}: requires <name> or --url <endpoint>`);
}

export interface MCPLoginArgs {
  readonly target: MCPTarget;
  readonly mcpConfigPath?: string;
  readonly clientId?: string;
  readonly scope?: string;
  readonly noBrowser: boolean;
  readonly timeoutMs?: number;
}

const LOGIN_USAGE = "Usage: rax mcp login <name|--url <endpoint>> [--client-id <id>] [--scope <scope>] [--no-browser]";

export function parseLoginArgs(argv: readonly string[]): MCPLoginArgs {
  let clientId: string | undefined;
  let scope: string | undefined;
  let noBrowser = false;
  let timeoutMs: number | undefined;

  const { target, mcpConfigPath } = parseTargetAndFlag(
    argv,
    (arg, next) => {
      if (arg === "--client-id") {
        const v = next();
        if (v === undefined) throw new Error(`${LOGIN_USAGE}: --client-id requires a value`);
        clientId = v;
        return true;
      }
      if (arg === "--scope") {
        const v = next();
        if (v === undefined) throw new Error(`${LOGIN_USAGE}: --scope requires a value`);
        scope = v;
        return true;
      }
      if (arg === "--no-browser") {
        noBrowser = true;
        return true;
      }
      if (arg === "--timeout") {
        const v = next();
        if (v === undefined) throw new Error(`${LOGIN_USAGE}: --timeout requires a value (milliseconds)`);
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`${LOGIN_USAGE}: --timeout must be a positive number of milliseconds`);
        }
        timeoutMs = parsed;
        return true;
      }
      return false;
    },
    LOGIN_USAGE,
  );

  return { target, mcpConfigPath, clientId, scope, noBrowser, timeoutMs };
}

export interface MCPLogoutArgs {
  readonly target: MCPTarget;
  readonly mcpConfigPath?: string;
}

const LOGOUT_USAGE = "Usage: rax mcp logout <name|--url <endpoint>>";

export function parseLogoutArgs(argv: readonly string[]): MCPLogoutArgs {
  const { target, mcpConfigPath } = parseTargetAndFlag(argv, () => false, LOGOUT_USAGE);
  return { target, mcpConfigPath };
}

export type MCPStatusArgs = Record<string, never>;

export function parseStatusArgs(argv: readonly string[]): MCPStatusArgs {
  if (argv.length > 0) {
    throw new Error(`Usage: rax mcp status — unexpected argument "${argv[0]}"`);
  }
  return {};
}

// ─── `login` ────────────────────────────────────────────────────────────────

interface AuthorizationCodeExtras {
  waitForAuthorizationCode(): Promise<string>;
  disposeAuthorizationListener(): Promise<void>;
}

function hasAuthorizationCodeExtras(
  provider: OAuthClientProvider,
): provider is OAuthClientProvider & AuthorizationCodeExtras {
  const candidate = provider as Partial<AuthorizationCodeExtras>;
  return (
    typeof candidate.waitForAuthorizationCode === "function" &&
    typeof candidate.disposeAuthorizationListener === "function"
  );
}

export interface MCPCliDeps {
  readonly store?: MCPTokenStore;
  /** Test/scripting hook — replaces the default "print to stderr + maybe open browser" behavior. */
  readonly onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

async function defaultOnAuthorizationUrl(url: URL, noBrowser: boolean): Promise<void> {
  // Always printed — even when a browser opens, a headless/SSH user needs
  // this to copy the link, and it is never wrong to show it.
  console.error(info(`Open this URL to authorize:\n  ${url.toString()}`));
  if (noBrowser) return;
  try {
    await openBrowser(url);
  } catch (err) {
    console.error(
      warn(`Could not open a browser automatically: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

export async function runLogin(args: MCPLoginArgs, deps: MCPCliDeps = {}): Promise<void> {
  const store = deps.store ?? createFileTokenStore();
  const { url: resourceUrl, label } = resolveTarget(args.target, args.mcpConfigPath);

  const server: MCPServer = {
    name: label,
    version: "1.0.0",
    transport: "streamable-http",
    endpoint: resourceUrl,
    tools: [],
    status: "disconnected",
    auth: {
      type: "authorization_code",
      clientId: args.clientId,
      scope: args.scope,
      interactive: true,
      timeoutMs: args.timeoutMs,
      onAuthorizationUrl:
        deps.onAuthorizationUrl ?? ((url: URL) => defaultOnAuthorizationUrl(url, args.noBrowser)),
    },
  };

  const provider = createAuthProvider(server, store);
  if (!provider || !hasAuthorizationCodeExtras(provider)) {
    throw new Error(`rax mcp login "${label}": failed to construct an authorization_code provider`);
  }

  try {
    let result = await auth(provider, { serverUrl: resourceUrl, scope: args.scope });
    if (result === "REDIRECT") {
      const code = await provider.waitForAuthorizationCode();
      result = await auth(provider, {
        serverUrl: resourceUrl,
        authorizationCode: code,
        scope: args.scope,
      });
    }
    if (result !== "AUTHORIZED") {
      throw new Error(`rax mcp login "${label}": authorization did not complete (got "${result}")`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redacted = hasRedactor(provider) ? provider.redactSecrets(message) : message;
    throw new Error(`rax mcp login "${label}" failed: ${redacted}`);
  } finally {
    await provider.disposeAuthorizationListener().catch(() => {
      /* best-effort cleanup; a login failure/success already reported above wins */
    });
  }

  console.log(success(`Logged in to "${label}" (${resourceUrl}).`));
}

// ─── `logout` ───────────────────────────────────────────────────────────────

async function tryRevoke(resourceUrl: string, stored: StoredMcpCredentials): Promise<void> {
  const refreshToken = stored.tokens?.refresh_token;
  if (!refreshToken) return;

  let serverInfo;
  try {
    serverInfo = await discoverOAuthServerInfo(resourceUrl);
  } catch (err) {
    console.error(
      warn(
        `Could not discover authorization-server metadata to revoke credentials (${err instanceof Error ? err.message : String(err)}) — deleting local credentials anyway.`,
      ),
    );
    return;
  }

  // Final-review C2: `discoverOAuthServerInfo` is called raw here (not through Task 5's
  // `hardenProvider`, which only wraps providers built for a live `connect()`), so
  // nothing else validates the (possibly attacker-controlled) authorization-server URL
  // or the specific revocation endpoint it advertises before this function would
  // otherwise POST a live refresh token + client secret to it in plaintext. Both are
  // checked BEFORE any network call; either failing skips revocation entirely and falls
  // through to the existing "still delete locally" path.
  if (!isHttpsOrLoopback(serverInfo.authorizationServerUrl)) {
    console.error(
      warn(
        `Skipping token revocation — authorization server "${serverInfo.authorizationServerUrl}" is not HTTPS and is not a loopback address — deleting local credentials anyway.`,
      ),
    );
    return;
  }

  const metadata = serverInfo.authorizationServerMetadata;
  const revocationEndpoint = metadata && "revocation_endpoint" in metadata ? metadata.revocation_endpoint : undefined;
  if (!revocationEndpoint) return;

  if (!isHttpsOrLoopback(revocationEndpoint)) {
    console.error(
      warn(
        `Skipping token revocation — revocation endpoint is not HTTPS and is not a loopback address — deleting local credentials anyway.`,
      ),
    );
    return;
  }

  const body = new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" });
  const clientId = stored.clientInformation?.client_id;
  if (clientId) body.set("client_id", clientId);
  const clientSecret = stored.clientInformation?.client_secret;
  if (clientSecret) body.set("client_secret", clientSecret);

  try {
    const res = await fetch(revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      console.error(
        warn(`Revocation endpoint returned HTTP ${res.status} — deleting local credentials anyway.`),
      );
    }
  } catch (err) {
    console.error(
      warn(
        `Failed to reach revocation endpoint (${err instanceof Error ? err.message : String(err)}) — deleting local credentials anyway.`,
      ),
    );
  }
}

export async function runLogout(args: MCPLogoutArgs, deps: MCPCliDeps = {}): Promise<void> {
  const store = deps.store ?? createFileTokenStore();
  const { url: resourceUrl, label } = resolveTarget(args.target, args.mcpConfigPath);
  const key = canonicalResourceKey(resourceUrl);
  const stored = await store.get(key);

  if (!stored) {
    console.log(info(`No stored credentials for "${label}" (${resourceUrl}).`));
    return;
  }

  // A revocation-endpoint outage must never block a local logout — this
  // always runs to completion (or gives up quietly) before `store.delete`.
  await tryRevoke(resourceUrl, stored);

  await store.delete(key);
  console.log(success(`Logged out of "${label}" (${resourceUrl}).`));
}

// ─── `status` ───────────────────────────────────────────────────────────────

function formatExpiry(stored: StoredMcpCredentials): string {
  const expiresIn = stored.tokens?.expires_in;
  if (expiresIn === undefined) return "unknown";
  const expiresAtMs = stored.savedAt + expiresIn * 1000;
  const remainingSeconds = Math.round((expiresAtMs - Date.now()) / 1000);
  return remainingSeconds > 0 ? `expires in ${remainingSeconds}s` : "expired";
}

export async function runStatus(_args: MCPStatusArgs, deps: MCPCliDeps = {}): Promise<void> {
  const store = deps.store ?? createFileTokenStore();
  const keys = await store.list();

  if (keys.length === 0) {
    console.log(info("No stored MCP OAuth credentials."));
    return;
  }

  console.log(section("MCP OAuth credentials"));
  for (const key of keys) {
    const stored = await store.get(key);
    if (!stored) continue;
    // Never print `stored.tokens.access_token` / `.refresh_token` — only
    // derived, non-secret facts. This is the one hard rule for this file.
    console.log(kv("Resource", stored.resourceUrl));
    console.log(kv("Scope", stored.tokens?.scope ?? "(none)"));
    console.log(kv("Expiry", formatExpiry(stored)));
    console.log(kv("Refresh token", stored.tokens?.refresh_token ? "yes" : "no"));
    console.log("");
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

const HELP = `
  Usage: rax mcp <subcommand> [options]

  Manage OAuth credentials for remote MCP servers.

  Subcommands:
    login <name|--url <endpoint>> [options]   Run the authorization_code login flow
    logout <name|--url <endpoint>>            Delete stored credentials (revokes if possible)
    status                                    List stored credentials (never prints tokens)

  login options:
    --client-id <id>      Statically registered client ID (default: dynamic client registration)
    --scope <scope>       OAuth scope to request
    --no-browser          Don't launch a browser — still prints the authorization URL and waits
    --timeout <ms>        Authorization callback timeout in milliseconds (default: 300000)
    --mcp-config <path>   Path to MCP server config JSON (default: .rax/mcp.json)

  logout options:
    --mcp-config <path>   Path to MCP server config JSON (default: .rax/mcp.json)

  Examples:
    rax mcp login docs-server
    rax mcp login --url https://mcp.example.com/mcp --client-id my-client --scope "read write"
    rax mcp login docs-server --no-browser
    rax mcp logout docs-server
    rax mcp status
`.trimEnd();

export async function runMcp(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case "login": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(HELP);
        return;
      }
      await runLogin(parseLoginArgs(rest));
      return;
    }
    case "logout": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(HELP);
        return;
      }
      await runLogout(parseLogoutArgs(rest));
      return;
    }
    case "status": {
      if (rest.includes("--help") || rest.includes("-h")) {
        console.log(HELP);
        return;
      }
      await runStatus(parseStatusArgs(rest));
      return;
    }
    default:
      console.error(fail(`Unknown mcp subcommand: ${sub}`));
      console.log(HELP);
      process.exit(1);
  }
}
