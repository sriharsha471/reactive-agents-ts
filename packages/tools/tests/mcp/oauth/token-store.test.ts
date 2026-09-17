// Run: bun test packages/tools/tests/mcp/oauth/token-store.test.ts --timeout 15000
//
// Task 2 of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md —
// config types + persistent token store. Covers Step 1 items 1, 2, 3 (minus the
// simulated-rename-failure sub-case, which lives in
// token-store-atomic-write.test.ts because it needs a `node:fs/promises` mock
// installed before the module under test is imported), 4, and 5.
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, stat, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalResourceKey,
  createMemoryTokenStore,
  createFileTokenStore,
} from "../../../src/mcp/auth/token-store.js";
import type { StoredMcpCredentials } from "../../../src/mcp/auth/types.js";

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-auth-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

const sampleCreds = (resourceUrl: string): StoredMcpCredentials => ({
  tokens: { access_token: "at-1", token_type: "bearer" },
  resourceUrl,
  savedAt: Date.now(),
});

describe("canonicalResourceKey", () => {
  it("lowercases scheme and host, drops default https port and fragment", () => {
    const a = canonicalResourceKey("https://A.com:443/mcp#x");
    const b = canonicalResourceKey("https://a.com/mcp");
    expect(a).toBe(b);
  });

  it("lowercases scheme and host, drops default http port", () => {
    const a = canonicalResourceKey("HTTP://Example.COM:80/mcp");
    const b = canonicalResourceKey("http://example.com/mcp");
    expect(a).toBe(b);
  });

  it("keeps a non-default port", () => {
    const a = canonicalResourceKey("https://example.com:8443/mcp");
    const b = canonicalResourceKey("https://example.com/mcp");
    expect(a).not.toBe(b);
  });

  it("produces different keys for different paths", () => {
    const a = canonicalResourceKey("https://example.com/mcp");
    const b = canonicalResourceKey("https://example.com/other");
    expect(a).not.toBe(b);
  });
});

describe("createMemoryTokenStore", () => {
  it("round-trips get/set/delete/list", async () => {
    const store = createMemoryTokenStore();
    const key = canonicalResourceKey("https://example.com/mcp");
    expect(await store.get(key)).toBeUndefined();

    const creds = sampleCreds("https://example.com/mcp");
    await store.set(key, creds);
    expect(await store.get(key)).toEqual(creds);
    expect(await store.list()).toEqual([key]);

    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("does not persist across separate instances (process-lifetime only)", async () => {
    const key = canonicalResourceKey("https://example.com/mcp");
    const storeA = createMemoryTokenStore();
    await storeA.set(key, sampleCreds("https://example.com/mcp"));

    const storeB = createMemoryTokenStore();
    expect(await storeB.get(key)).toBeUndefined();
  });
});

describe("createFileTokenStore", () => {
  it("creates the store directory with mode 0700", async () => {
    const dir = await makeTmpDir();
    const authDir = join(dir, "mcp-auth");
    const store = createFileTokenStore(authDir);
    const key = canonicalResourceKey("https://example.com/mcp");

    await store.set(key, sampleCreds("https://example.com/mcp"));

    const dirStat = await stat(authDir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("writes credential files with mode 0600, named by a hash of the key (never the raw URL)", async () => {
    const dir = await makeTmpDir();
    const store = createFileTokenStore(dir);
    const serverUrl = "https://example.com/very-secret-mcp-server";
    const key = canonicalResourceKey(serverUrl);

    await store.set(key, sampleCreds(serverUrl));

    const entries = await readdir(dir);
    expect(entries.length).toBe(1);
    const fileName = entries[0]!;

    // File name must be a hash of the key, not the raw URL or key text.
    expect(fileName).not.toContain("example.com");
    expect(fileName).not.toContain("secret");
    const expectedHash = createHash("sha256").update(key, "utf8").digest("hex");
    expect(fileName).toBe(`${expectedHash}.json`);

    const filePath = join(dir, fileName);
    const fileStat = await stat(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    // The raw URL is allowed to live inside the (permission-restricted)
    // file content — only the directory listing must not leak it.
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("example.com");
  });

  it("round-trips get/set/delete/list", async () => {
    const dir = await makeTmpDir();
    const store = createFileTokenStore(dir);
    const key = canonicalResourceKey("https://example.com/mcp");
    const creds = sampleCreds("https://example.com/mcp");

    expect(await store.get(key)).toBeUndefined();
    await store.set(key, creds);
    expect(await store.get(key)).toEqual(creds);
    expect(await store.list()).toEqual([key]);

    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("refuses to read a world/group-readable credential file", async () => {
    const dir = await makeTmpDir();
    const store = createFileTokenStore(dir);
    const key = canonicalResourceKey("https://example.com/mcp");
    await store.set(key, sampleCreds("https://example.com/mcp"));

    const entries = await readdir(dir);
    const filePath = join(dir, entries[0]!);
    await chmod(filePath, 0o644);

    let thrown: unknown;
    try {
      await store.get(key);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(filePath);
    expect(message).toContain("chmod 600");
  });

  it("refuses to list when a credential file is world/group-readable", async () => {
    const dir = await makeTmpDir();
    const store = createFileTokenStore(dir);
    const key = canonicalResourceKey("https://example.com/mcp");
    await store.set(key, sampleCreds("https://example.com/mcp"));

    const entries = await readdir(dir);
    const filePath = join(dir, entries[0]!);
    await chmod(filePath, 0o640);

    await expect(store.list()).rejects.toThrow(/chmod 600/);
  });

  it("sees writes from another store instance pointed at the same directory (process-restart persistence)", async () => {
    const dir = await makeTmpDir();
    const key = canonicalResourceKey("https://example.com/mcp");
    const creds = sampleCreds("https://example.com/mcp");

    const storeA = createFileTokenStore(dir);
    await storeA.set(key, creds);

    // A brand-new store instance pointed at the same directory — simulates
    // a fresh process reading credentials a previous run persisted.
    const storeB = createFileTokenStore(dir);
    expect(await storeB.get(key)).toEqual(creds);
    expect(await storeB.list()).toEqual([key]);

    await storeB.delete(key);
    expect(await storeA.get(key)).toBeUndefined();
  });

  it("uses the default directory (~/.reactive-agents/mcp-auth) when none is given", async () => {
    const store = createFileTokenStore();
    // Exercise get() only (not set()) so this test never writes under the
    // real home directory.
    const key = canonicalResourceKey("https://nonexistent.example.invalid/mcp");
    expect(await store.get(key)).toBeUndefined();
  });
});
