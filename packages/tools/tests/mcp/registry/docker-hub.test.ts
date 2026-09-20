import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  DockerHubHttp,
  DockerHubMCPRegistry,
  type DockerHubRepositoryResponse,
} from "../../../src/mcp/registry/docker-hub.js";
import {
  buildApprovalKey,
  MCPApprovalStore,
  type MCPApprovalRecord,
} from "../../../src/mcp/registry/approval-store.js";
import {
  MCPApprovalRequiredError,
  MCPMissingEnvVarError,
} from "../../../src/mcp/registry/types.js";

// ─── Fakes ───────────────────────────────────────────────────────────────────
// No real network or disk I/O in this test file — every dependency the
// registry needs (`DockerHubHttp`, `MCPApprovalStore`) is injected as a fake
// Effect Layer.

const FULL_DESCRIPTION = `# mcp/brave-search

Search the web via the Brave Search API.

## Environment Variables

\`BRAVE_API_KEY\`|\`string\`|Your Brave Search API key
\`DEBUG\`|\`boolean\` *optional*|Enable verbose logging
`;

const fakeRepo = (fullDescription: string): DockerHubRepositoryResponse => ({
  full_description: fullDescription,
});

const fakeHttpLayer = (fullDescription: string = FULL_DESCRIPTION) =>
  Layer.succeed(
    DockerHubHttp,
    DockerHubHttp.of({
      fetchRepository: () => Effect.succeed(fakeRepo(fullDescription)),
    }),
  );

/**
 * In-memory fake approval store — pre-seed via `seed` for "already approved"
 * cases. `seed`/tracked calls are keyed however the caller (`docker-hub.ts`)
 * builds its keys — tests below use `buildApprovalKey(registryId, image)` to
 * match production key-building exactly, so a seeding mismatch would fail
 * loudly rather than silently pass on the wrong key.
 */
const fakeApprovalStoreLayer = (
  seed: Record<string, MCPApprovalRecord> = {},
  calls?: { isApproved: string[]; getApproval: string[]; recordApproval: string[] },
) => {
  const records = new Map<string, MCPApprovalRecord>(Object.entries(seed));
  return Layer.succeed(
    MCPApprovalStore,
    MCPApprovalStore.of({
      isApproved: (key, digest) =>
        Effect.sync(() => {
          calls?.isApproved.push(key);
          return records.get(key)?.digest === digest;
        }),
      getApproval: (key) =>
        Effect.sync(() => {
          calls?.getApproval.push(key);
          return records.get(key);
        }),
      recordApproval: (key, digest) =>
        Effect.sync(() => {
          calls?.recordApproval.push(key);
          records.set(key, { digest, approvedAt: new Date(0).toISOString() });
        }),
    }),
  );
};

const IMAGE = "mcp/brave-search";
const DIGEST = "mcp/brave-search"; // documented placeholder digest — see docker-hub.ts
const APPROVAL_KEY = buildApprovalKey("docker-hub", IMAGE);

describe("DockerHubMCPRegistry", () => {
  test("resolves a known catalog entry into a stdio docker-run config with correct image/args once approved", async () => {
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({
        [APPROVAL_KEY]: { digest: DIGEST, approvedAt: new Date(0).toISOString() },
      }),
    });

    const config = await registry.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
    });

    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("docker");
    expect(config.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-e",
      "BRAVE_API_KEY",
      IMAGE,
    ]);
    expect(config.env).toEqual({ BRAVE_API_KEY: "test-key" });
  });

  test("throws a tagged error when a required env var is missing", async () => {
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({
        [APPROVAL_KEY]: { digest: DIGEST, approvedAt: new Date(0).toISOString() },
      }),
    });

    const rejection = registry.resolve({ name: "brave-search", env: {} });
    await expect(rejection).rejects.toBeInstanceOf(MCPMissingEnvVarError);
    await expect(rejection).rejects.toMatchObject({
      _tag: "MCPMissingEnvVarError",
      image: IMAGE,
      missing: ["BRAVE_API_KEY"],
    });
  });

  test("translates volume-mount input into -v host:container[:ro] args placed before the image name", async () => {
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({
        [APPROVAL_KEY]: { digest: DIGEST, approvedAt: new Date(0).toISOString() },
      }),
    });

    const config = await registry.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
      volumes: [
        { host: "/host/data", container: "/data" },
        { host: "/host/ro", container: "/ro", readOnly: true },
      ],
    });

    expect(config.args).toEqual([
      "run",
      "-i",
      "--rm",
      "-v",
      "/host/data:/data",
      "-v",
      "/host/ro:/ro:ro",
      "-e",
      "BRAVE_API_KEY",
      IMAGE,
    ]);
  });

  test("throws a tagged approval-required error naming the image + digest on first resolve of an unapproved image", async () => {
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer(), // empty — nothing approved yet
    });

    const rejection = registry.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
    });

    await expect(rejection).rejects.toBeInstanceOf(MCPApprovalRequiredError);
    await expect(rejection).rejects.toMatchObject({
      _tag: "MCPApprovalRequiredError",
      registryId: "docker-hub",
      image: IMAGE,
      digest: DIGEST,
    });
  });

  test("succeeds on a subsequent resolve once the approval store has recorded that image+digest", async () => {
    const approvalStoreLayer = fakeApprovalStoreLayer();
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer,
    });

    // First resolve fails — unapproved.
    await expect(
      registry.resolve({ name: "brave-search", env: { BRAVE_API_KEY: "test-key" } }),
    ).rejects.toBeInstanceOf(MCPApprovalRequiredError);

    // Record the approval (as `rax mcp approve` will do in a future dispatch),
    // then resolve again against the SAME store instance.
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* MCPApprovalStore;
        yield* store.recordApproval(APPROVAL_KEY, DIGEST);
      }).pipe(Effect.provide(approvalStoreLayer)),
    );

    const config = await registry.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
    });
    expect(config.command).toBe("docker");
    expect(config.args).toContain(IMAGE);
  });

  // ─── Cross-registry scoping (naming + approval-key collision) ────────────

  test("two differently-`id`'d registries resolving the same catalog name never collide on config.name or the approval-store key", async () => {
    const registryA = new DockerHubMCPRegistry({
      id: "registry-a",
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({
        [buildApprovalKey("registry-a", IMAGE)]: {
          digest: DIGEST,
          approvedAt: new Date(0).toISOString(),
        },
      }),
    });
    const registryB = new DockerHubMCPRegistry({
      id: "registry-b",
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({
        [buildApprovalKey("registry-b", IMAGE)]: {
          digest: DIGEST,
          approvedAt: new Date(0).toISOString(),
        },
      }),
    });

    const configA = await registryA.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
    });
    const configB = await registryB.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
    });

    expect(configA.name).toBe("registry-a:brave-search");
    expect(configB.name).toBe("registry-b:brave-search");
    expect(configA.name).not.toBe(configB.name);
  });

  test("an approval recorded under one registry id does NOT satisfy the gate for a different registry id resolving the same catalog name", async () => {
    // A single SHARED approval store, seeded only under `registry-a`'s key —
    // proves the key itself (not just separate store instances) is scoped.
    const sharedApprovalStoreLayer = fakeApprovalStoreLayer({
      [buildApprovalKey("registry-a", IMAGE)]: {
        digest: DIGEST,
        approvedAt: new Date(0).toISOString(),
      },
    });

    const registryA = new DockerHubMCPRegistry({
      id: "registry-a",
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: sharedApprovalStoreLayer,
    });
    const registryB = new DockerHubMCPRegistry({
      id: "registry-b",
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: sharedApprovalStoreLayer,
    });

    // registry-a is approved — succeeds.
    await expect(
      registryA.resolve({ name: "brave-search", env: { BRAVE_API_KEY: "test-key" } }),
    ).resolves.toBeTruthy();

    // registry-b is NOT approved under its own scoped key, even though the
    // underlying catalog name and image are identical — must still gate.
    await expect(
      registryB.resolve({ name: "brave-search", env: { BRAVE_API_KEY: "test-key" } }),
    ).rejects.toBeInstanceOf(MCPApprovalRequiredError);
  });

  // ─── requireApproval bypass ─────────────────────────────────────────────────

  test("resolve() with { requireApproval: false } succeeds on a never-approved image without consulting the approval store at all", async () => {
    const calls = { isApproved: [] as string[], getApproval: [] as string[], recordApproval: [] as string[] };
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer: fakeApprovalStoreLayer({}, calls), // nothing approved
    });

    const config = await registry.resolve({
      name: "brave-search",
      env: { BRAVE_API_KEY: "test-key" },
      requireApproval: false,
    });

    expect(config.command).toBe("docker");
    expect(config.args).toContain(IMAGE);
    // The approval gate must not be touched at all — not read, not written.
    expect(calls.getApproval).toEqual([]);
    expect(calls.isApproved).toEqual([]);
    expect(calls.recordApproval).toEqual([]);
  });

  test("requireApproval: false is a per-call bypass, not a silent grant — a later resolve() without it still requires approval", async () => {
    const approvalStoreLayer = fakeApprovalStoreLayer({});
    const registry = new DockerHubMCPRegistry({
      httpLayer: fakeHttpLayer(),
      approvalStoreLayer,
    });

    await expect(
      registry.resolve({
        name: "brave-search",
        env: { BRAVE_API_KEY: "test-key" },
        requireApproval: false,
      }),
    ).resolves.toBeTruthy();

    await expect(
      registry.resolve({ name: "brave-search", env: { BRAVE_API_KEY: "test-key" } }),
    ).rejects.toBeInstanceOf(MCPApprovalRequiredError);
  });
});
