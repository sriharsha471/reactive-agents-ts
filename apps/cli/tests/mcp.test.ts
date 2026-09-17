// Run: bun test apps/cli/tests/mcp.test.ts --timeout 30000
//
// Task 6 of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md
// — `rax mcp login | logout | status`. Covers argument parsing for all three
// subcommands, `status`'s hard "never print a token" rule, `logout` actually
// deleting stored credentials (with and without a reachable revocation
// endpoint), and a real end-to-end `login` against the Task 1 fixture using
// `--no-browser` plus a test hook that drives the redirect with `fetch`
// (same technique as packages/tools/tests/mcp/oauth/authorization-code.test.ts).
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalResourceKey,
  createFileTokenStore,
  createMemoryTokenStore,
  type StoredMcpCredentials,
} from "@reactive-agents/tools";
import {
  parseLoginArgs,
  parseLogoutArgs,
  parseStatusArgs,
  resolveTarget,
  runLogin,
  runLogout,
  runStatus,
} from "../src/commands/mcp.js";

// Loaded from a non-literal specifier: `packages/tools/tests/**` sits outside
// this package's `rootDir`, so a statically-resolved relative import would
// fail `tsc --noEmit`'s rootDir check even though `bun test` runs it fine.
// The Task 1 fixture is test-only infra (excluded from every package's
// build), so this is reuse of a test double across package boundaries, not
// a real cross-package source dependency.
interface OAuthMcpFixture {
  readonly resourceUrl: string;
  close(): Promise<void>;
}
const fixtureModulePath = ["..", "..", "..", "packages", "tools", "tests", "fixtures", "oauth-mcp", "fixture.js"].join(
  "/",
);
const { startOAuthMcpFixture } = (await import(fixtureModulePath)) as {
  startOAuthMcpFixture: () => Promise<OAuthMcpFixture>;
};

let fixtures: OAuthMcpFixture[] = [];
async function fixture(): Promise<OAuthMcpFixture> {
  const f = await startOAuthMcpFixture();
  fixtures.push(f);
  return f;
}

let tmpDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rax-mcp-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(fixtures.map((f) => f.close()));
  fixtures = [];
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
  tmpDirs = [];
});

/** Simulates the browser: follows the fixture's real 302 chain onto the real loopback listener. */
async function driveRedirect(url: URL): Promise<void> {
  const res = await fetch(url);
  await res.text().catch(() => {});
}

function captureConsole(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  return {
    stdout,
    stderr,
    restore: () => {
      console.log = origLog;
      console.error = origError;
    },
  };
}

// ─── Argument parsing ──────────────────────────────────────────────────────

describe("mcp login argument parsing", () => {
  it("parses <name> with no flags", () => {
    const args = parseLoginArgs(["docs-server"]);
    expect(args.target).toEqual({ kind: "name", value: "docs-server" });
    expect(args.noBrowser).toBe(false);
    expect(args.clientId).toBeUndefined();
    expect(args.scope).toBeUndefined();
  });

  it("parses --url with --client-id, --scope, --no-browser", () => {
    const args = parseLoginArgs([
      "--url",
      "https://mcp.example.com/mcp",
      "--client-id",
      "my-client",
      "--scope",
      "read write",
      "--no-browser",
    ]);
    expect(args.target).toEqual({ kind: "url", value: "https://mcp.example.com/mcp" });
    expect(args.clientId).toBe("my-client");
    expect(args.scope).toBe("read write");
    expect(args.noBrowser).toBe(true);
  });

  it("parses --timeout as a positive number", () => {
    const args = parseLoginArgs(["docs-server", "--timeout", "5000"]);
    expect(args.timeoutMs).toBe(5000);
  });

  it("parses --mcp-config", () => {
    const args = parseLoginArgs(["docs-server", "--mcp-config", "/tmp/custom.json"]);
    expect(args.mcpConfigPath).toBe("/tmp/custom.json");
  });

  it("rejects both <name> and --url", () => {
    expect(() => parseLoginArgs(["docs-server", "--url", "https://x.test/mcp"])).toThrow(
      /either <name> or --url/,
    );
  });

  it("rejects neither <name> nor --url", () => {
    expect(() => parseLoginArgs(["--client-id", "x"])).toThrow(/requires <name> or --url/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseLoginArgs(["docs-server", "--bogus"])).toThrow(/unknown flag/);
  });

  it("rejects a non-numeric --timeout", () => {
    expect(() => parseLoginArgs(["docs-server", "--timeout", "not-a-number"])).toThrow(
      /positive number/,
    );
  });
});

describe("mcp logout argument parsing", () => {
  it("parses <name>", () => {
    const args = parseLogoutArgs(["docs-server"]);
    expect(args.target).toEqual({ kind: "name", value: "docs-server" });
  });

  it("parses --url", () => {
    const args = parseLogoutArgs(["--url", "https://mcp.example.com/mcp"]);
    expect(args.target).toEqual({ kind: "url", value: "https://mcp.example.com/mcp" });
  });

  it("rejects missing target", () => {
    expect(() => parseLogoutArgs([])).toThrow(/requires <name> or --url/);
  });

  it("rejects login-only flags", () => {
    expect(() => parseLogoutArgs(["docs-server", "--client-id", "x"])).toThrow(/unknown flag/);
  });
});

describe("mcp status argument parsing", () => {
  it("accepts no arguments", () => {
    expect(parseStatusArgs([])).toEqual({});
  });

  it("rejects any positional argument", () => {
    expect(() => parseStatusArgs(["extra"])).toThrow(/unexpected argument/);
  });
});

describe("resolveTarget", () => {
  it("--url resolves to itself with no config lookup", () => {
    const resolved = resolveTarget({ kind: "url", value: "https://mcp.example.com/mcp" });
    expect(resolved).toEqual({ url: "https://mcp.example.com/mcp", label: "https://mcp.example.com/mcp" });
  });

  it("<name> with no config file throws a helpful error", () => {
    expect(() =>
      resolveTarget({ kind: "name", value: "docs-server" }, "/nonexistent/mcp.json"),
    ).toThrow(/no MCP config found/);
  });

  it("<name> not present in an existing config file throws with known names", () => {
    // Reuse a tempdir purely as a scratch location for a config file.
    const path = "/tmp/rax-mcp-test-config-not-found.json";
    Bun.write(path, JSON.stringify({ servers: [{ name: "other", transport: "streamable-http", endpoint: "https://x.test/mcp" }] }));
    try {
      expect(() => resolveTarget({ kind: "name", value: "docs-server" }, path)).toThrow(/not found in/);
    } finally {
      Bun.file(path).exists().then((exists) => {
        if (exists) void rm(path).catch(() => {});
      });
    }
  });
});

// ─── status — never prints token values ────────────────────────────────────

describe("mcp status", () => {
  it("lists resource/scope/expiry/refresh-token presence and never prints token values", async () => {
    const dir = await tempDir();
    const store = createFileTokenStore(dir);
    const resourceUrl = "https://mcp.example.com/mcp";
    const secretAccessToken = "SECRET-ACCESS-TOKEN-VALUE-abc123xyz";
    const secretRefreshToken = "SECRET-REFRESH-TOKEN-VALUE-def456uvw";
    const key = canonicalResourceKey(resourceUrl);
    const record: StoredMcpCredentials = {
      tokens: {
        access_token: secretAccessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: secretRefreshToken,
        scope: "read write",
      },
      resourceUrl,
      savedAt: Date.now(),
    };
    await store.set(key, record);

    const capture = captureConsole();
    try {
      await runStatus({}, { store });
    } finally {
      capture.restore();
    }

    const allOutput = [...capture.stdout, ...capture.stderr].join("\n");
    expect(allOutput).toContain(resourceUrl);
    expect(allOutput).toContain("read write");
    expect(allOutput).toContain("expires in");
    expect(allOutput).toContain("yes"); // refresh token present
    expect(allOutput).not.toContain(secretAccessToken);
    expect(allOutput).not.toContain(secretRefreshToken);
  });

  it("reports expired credentials as expired, not as a countdown", async () => {
    const dir = await tempDir();
    const store = createFileTokenStore(dir);
    const resourceUrl = "https://expired.example.com/mcp";
    await store.set(canonicalResourceKey(resourceUrl), {
      tokens: { access_token: "tok-value-long-enough", token_type: "Bearer", expires_in: 1 },
      resourceUrl,
      savedAt: Date.now() - 60_000,
    });

    const capture = captureConsole();
    try {
      await runStatus({}, { store });
    } finally {
      capture.restore();
    }
    expect(capture.stdout.join("\n")).toContain("expired");
  });

  it("prints a friendly message when the store is empty", async () => {
    const dir = await tempDir();
    const store = createFileTokenStore(dir);
    const capture = captureConsole();
    try {
      await runStatus({}, { store });
    } finally {
      capture.restore();
    }
    expect(capture.stdout.join("\n")).toContain("No stored MCP OAuth credentials");
  });
});

// ─── logout — deletes credentials; revocation is best-effort ───────────────

describe("mcp logout", () => {
  it("deletes stored credentials even when the revocation endpoint is unreachable", async () => {
    const dir = await tempDir();
    const store = createFileTokenStore(dir);
    // Port 1 refuses connections immediately (no DNS/timeout delay) — this
    // simulates the "revocation endpoint outage" case the brief requires
    // must never block a local logout.
    const resourceUrl = "http://127.0.0.1:1/mcp";
    const key = canonicalResourceKey(resourceUrl);
    await store.set(key, {
      tokens: { access_token: "tok", token_type: "Bearer", refresh_token: "refresh-tok" },
      resourceUrl,
      savedAt: Date.now(),
    });

    expect(await store.get(key)).toBeDefined();

    const capture = captureConsole();
    try {
      await runLogout({ target: { kind: "url", value: resourceUrl } }, { store });
    } finally {
      capture.restore();
    }

    expect(await store.get(key)).toBeUndefined();
    expect(capture.stdout.join("\n")).toContain("Logged out");
  });

  it("is a no-op (not an error) when nothing is stored for the target", async () => {
    const dir = await tempDir();
    const store = createFileTokenStore(dir);
    const capture = captureConsole();
    try {
      await runLogout({ target: { kind: "url", value: "https://never-logged-in.example.com/mcp" } }, { store });
    } finally {
      capture.restore();
    }
    expect(capture.stdout.join("\n")).toContain("No stored credentials");
  });

  it("POSTs a real RFC 7009 revocation request when the authorization server advertises one, then deletes locally regardless of the response", async () => {
    const revocationRequests: Array<{ token: string | null; tokenTypeHint: string | null }> = [];
    let revocationStatus = 200;

    const resourceServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req: Request): Response => {
        const url = new URL(req.url);
        if (url.pathname === "/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: `http://127.0.0.1:${resourceServer.port}/mcp`,
            authorization_servers: [`http://127.0.0.1:${authServer.port}`],
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    const authServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: `http://127.0.0.1:${authServer.port}`,
            authorization_endpoint: `http://127.0.0.1:${authServer.port}/authorize`,
            token_endpoint: `http://127.0.0.1:${authServer.port}/token`,
            revocation_endpoint: `http://127.0.0.1:${authServer.port}/revoke`,
            response_types_supported: ["code"],
          });
        }
        if (url.pathname === "/revoke" && req.method === "POST") {
          const body = await req.text();
          const params = new URLSearchParams(body);
          revocationRequests.push({
            token: params.get("token"),
            tokenTypeHint: params.get("token_type_hint"),
          });
          return new Response(null, { status: revocationStatus });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const dir = await tempDir();
      const store = createFileTokenStore(dir);
      const resourceUrl = `http://127.0.0.1:${resourceServer.port}/mcp`;
      const key = canonicalResourceKey(resourceUrl);
      await store.set(key, {
        tokens: {
          access_token: "access-tok",
          token_type: "Bearer",
          refresh_token: "refresh-tok-to-revoke",
        },
        resourceUrl,
        savedAt: Date.now(),
      });

      // Case 1: revocation endpoint succeeds.
      await runLogout({ target: { kind: "url", value: resourceUrl } }, { store });
      expect(revocationRequests).toHaveLength(1);
      expect(revocationRequests[0]).toEqual({ token: "refresh-tok-to-revoke", tokenTypeHint: "refresh_token" });
      expect(await store.get(key)).toBeUndefined();

      // Case 2: revocation endpoint returns an error — deletion still proceeds.
      revocationStatus = 500;
      await store.set(key, {
        tokens: { access_token: "access-tok-2", token_type: "Bearer", refresh_token: "refresh-tok-2" },
        resourceUrl,
        savedAt: Date.now(),
      });
      const capture = captureConsole();
      try {
        await runLogout({ target: { kind: "url", value: resourceUrl } }, { store });
      } finally {
        capture.restore();
      }
      expect(revocationRequests).toHaveLength(2);
      expect(await store.get(key)).toBeUndefined();
      expect([...capture.stdout, ...capture.stderr].join("\n")).toContain("Logged out");
    } finally {
      resourceServer.stop(true);
      authServer.stop(true);
    }
  });
});

// ─── login — end-to-end against the Task 1 fixture ─────────────────────────

describe("mcp login", () => {
  it("completes the authorization_code flow against the fixture with --no-browser + a fetch-driven redirect hook, and persists tokens", async () => {
    const f = await fixture();
    const store = createMemoryTokenStore();

    const capture = captureConsole();
    try {
      await runLogin(
        {
          target: { kind: "url", value: f.resourceUrl },
          clientId: "cli-login-client",
          noBrowser: true,
          timeoutMs: 10_000,
        },
        { store, onAuthorizationUrl: driveRedirect },
      );
    } finally {
      capture.restore();
    }

    expect(capture.stdout.join("\n")).toContain("Logged in");
    const stored = await store.get(canonicalResourceKey(f.resourceUrl));
    expect(stored?.tokens?.access_token).toBeTruthy();
    expect(stored?.tokens?.refresh_token).toBeTruthy();
  });

  it("surfaces a redacted error message when authorization never completes (timeout)", async () => {
    const f = await fixture();
    const store = createMemoryTokenStore();

    await expect(
      runLogin(
        {
          target: { kind: "url", value: f.resourceUrl },
          clientId: "cli-login-timeout-client",
          noBrowser: true,
          timeoutMs: 300,
          // No onAuthorizationUrl hook — the callback never arrives, so the
          // loopback listener's own timeout fires.
        },
        { store },
      ),
    ).rejects.toThrow(/timed out/i);
  });
});
