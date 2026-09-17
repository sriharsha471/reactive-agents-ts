// Run: bun test packages/tools/tests/mcp/oauth/token-store-atomic-write.test.ts --timeout 15000
//
// Task 2 Step 1 item 3 (atomic-write sub-case): simulate a mid-write failure
// (rename throwing, e.g. disk full) and confirm no partial credential file
// is ever visible at the final path.
//
// Isolated into its own file because it needs `node:fs/promises`'s `rename`
// mocked BEFORE `../../../src/mcp/auth/token-store.js` is imported (Bun's
// `mock.module` only affects imports that happen after it is called, and the
// mock is process-global — see packages/llm-provider/tests/num-ctx-wiring.test.ts
// for the same pattern). Restored in `afterAll` so later test files in the
// same `bun test` run get the real `node:fs/promises` back.
import { describe, it, expect, mock, afterAll } from "bun:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFsPromises = { ...(await import("node:fs/promises")) };

let renameShouldFail = false;
const renameMock = mock(
  async (...args: Parameters<typeof realFsPromises.rename>) => {
    if (renameShouldFail) {
      throw new Error("simulated rename failure (disk full)");
    }
    return realFsPromises.rename(...args);
  },
);

mock.module("node:fs/promises", () => ({
  ...realFsPromises,
  rename: renameMock,
}));

afterAll(() => {
  mock.module("node:fs/promises", () => realFsPromises);
});

const { createFileTokenStore, canonicalResourceKey } = await import(
  "../../../src/mcp/auth/token-store.js"
);
type StoredMcpCredentials =
  import("../../../src/mcp/auth/types.js").StoredMcpCredentials;

describe("createFileTokenStore — atomic write", () => {
  it("leaves no partial file at the final path when rename fails mid-write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-auth-atomic-test-"));
    try {
      const store = createFileTokenStore(dir);
      const key = canonicalResourceKey("https://example.com/mcp");
      const creds: StoredMcpCredentials = {
        tokens: { access_token: "at-1", token_type: "bearer" },
        resourceUrl: "https://example.com/mcp",
        savedAt: Date.now(),
      };

      renameShouldFail = true;
      await expect(store.set(key, creds)).rejects.toThrow(
        /simulated rename failure/,
      );

      // No final credential file should exist — set() must have thrown
      // before rename ever landed the temp file at its destination.
      const entriesAfterFailure = (await readdir(dir)).filter(
        (name) => !name.includes(".tmp-"),
      );
      expect(entriesAfterFailure).toEqual([]);
      expect(await store.get(key)).toBeUndefined();

      // No leaked temp file either — the store cleans it up on failure.
      expect(await readdir(dir)).toEqual([]);

      // A subsequent successful write still works once rename succeeds again.
      renameShouldFail = false;
      await store.set(key, creds);
      expect(await store.get(key)).toEqual(creds);
    } finally {
      renameShouldFail = false;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
