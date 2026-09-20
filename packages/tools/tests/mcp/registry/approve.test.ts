import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveMcpImage, isMcpImageApproved } from "../../../src/mcp/registry/approve.js";

// No `import { Effect } from "effect"` anywhere in this file — this is the
// whole point of `approve.ts`: a caller approves/checks an image with plain
// `Promise`s and never needs to know the store underneath is Effect-based.

describe("approveMcpImage / isMcpImageApproved (plain-Promise convenience API)", () => {
  test("approves an image and a subsequent check reports it approved at that digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-approvals-test-"));
    const path = join(dir, "mcp-approvals");
    try {
      const before = await isMcpImageApproved("docker-hub", "mcp/brave-search", "mcp/brave-search", path);
      expect(before).toBe(false);

      await approveMcpImage("docker-hub", "mcp/brave-search", "mcp/brave-search", path);

      const after = await isMcpImageApproved("docker-hub", "mcp/brave-search", "mcp/brave-search", path);
      expect(after).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scopes approval by registryId — approving under one registry does not approve another registry's identical image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-approvals-test-"));
    const path = join(dir, "mcp-approvals");
    try {
      await approveMcpImage("registry-a", "mcp/brave-search", "mcp/brave-search", path);

      expect(await isMcpImageApproved("registry-a", "mcp/brave-search", "mcp/brave-search", path)).toBe(
        true,
      );
      expect(await isMcpImageApproved("registry-b", "mcp/brave-search", "mcp/brave-search", path)).toBe(
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
