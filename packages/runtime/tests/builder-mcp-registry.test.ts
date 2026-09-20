import { describe, it, expect, afterEach } from "bun:test";
import {
  MCPApprovalRequiredError,
  defaultRegistries,
  type MCPRegistry,
  type MCPRegistryServerConfig,
} from "@reactive-agents/tools";
import { ReactiveAgents, ReactiveAgentBuilder } from "../src/index.js";

/**
 * `.build()` connects every `_mcpServers` entry eagerly, inside the same
 * layer construction that resolves toolkit requests (`tool-init-layer.ts`).
 * A fake resolved config's `command` isn't a real MCP server, so the
 * downstream connect step fails in this sandbox after toolkit
 * resolve+merge already ran and mutated `_mcpServers` — exactly what these
 * tests assert on. Swallow that unrelated downstream failure; it is not
 * part of `.withMCP()`'s registry-resolved-form contract under test here
 * (mirrors why the existing object-form `.withMCP()` builder tests never
 * call `.build()` at all).
 */
const buildIgnoringDownstreamConnectFailure = async (
  builder: ReactiveAgentBuilder
): Promise<void> => {
  try {
    await builder.build();
  } catch {
    // expected — see comment above
  }
};

/**
 * `.withMCP(catalogName)`'s string branch resolves via the id-keyed
 * `defaultRegistries` lookup (default `"docker-hub"`), not an injectable
 * `MCPRegistry` instance parameter — the public `options.registry` is a
 * `string` id per the finalized design. To swap in a fake resolver for these
 * tests, register it under a throwaway id in the shared `defaultRegistries`
 * map and pass that id as `options.registry`, cleaning up afterward so tests
 * don't leak state into each other.
 */
const FAKE_REGISTRY_ID = "__test-fake__";

const fakeRegistry = (
  resolveImpl: (request: { name: string }) => Promise<MCPRegistryServerConfig>
): MCPRegistry & { calls: unknown[] } => {
  const calls: unknown[] = [];
  const registry: MCPRegistry & { calls: unknown[] } = {
    id: FAKE_REGISTRY_ID,
    calls,
    resolve: (request) => {
      calls.push(request);
      return resolveImpl(request as { name: string });
    },
  };
  defaultRegistries[FAKE_REGISTRY_ID] = registry;
  return registry;
};

afterEach(() => {
  delete defaultRegistries[FAKE_REGISTRY_ID];
});

describe("ReactiveAgentBuilder — .withMCP() registry-resolved (string) form", () => {
  it("stores toolkit requests synchronously without resolving (returns `this`, not a Promise)", () => {
    const builder = ReactiveAgents.create()
      .withName("toolkit-agent")
      .withProvider("test")
      .withMCP("brave-search");

    expect(builder).toBeInstanceOf(ReactiveAgentBuilder);
    const requests = (builder as any)._mcpToolkitRequests;
    expect(requests).toHaveLength(1);
    expect((builder as any)._mcpServers).toHaveLength(0);
  });

  it("resolves a single toolkit request at .build() time and merges it into the mcp server list", async () => {
    const registry = fakeRegistry(async (request) => ({
      name: request.name,
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", `mcp/${request.name}`],
    }));

    const builder = ReactiveAgents.create()
      .withName("toolkit-agent")
      .withProvider("test")
      .withMCP("brave-search", { registry: registry.id });

    await buildIgnoringDownstreamConnectFailure(builder);

    expect(registry.calls).toEqual([{ name: "brave-search", registry: registry.id }]);
    const mcpServers = (builder as any)._mcpServers;
    expect(mcpServers.map((s: { name: string }) => s.name)).toEqual(["brave-search"]);
    // Pending requests are drained after resolution.
    expect(
      (builder as any)._mcpToolkitRequests
    ).toHaveLength(0);
  });

  it("resolves multiple toolkit requests in parallel via a batch string[] call", async () => {
    const order: string[] = [];
    const registry = fakeRegistry(async (request) => {
      order.push(`start:${request.name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${request.name}`);
      return { name: request.name, transport: "stdio", command: "docker" };
    });
    // Batch string[] has no per-entry options, so register the fake under
    // "docker-hub" itself for this one test to exercise the default id.
    defaultRegistries["docker-hub-backup"] = defaultRegistries["docker-hub"];
    defaultRegistries["docker-hub"] = registry;

    try {
      const builder = ReactiveAgents.create()
        .withName("toolkit-agent")
        .withProvider("test")
        .withMCP(["a", "b"]);

      await buildIgnoringDownstreamConnectFailure(builder);

      const mcpServers = (builder as any)._mcpServers;
      expect(mcpServers.map((s: { name: string }) => s.name).sort()).toEqual(["a", "b"]);
      // Both resolves started before either finished — ran in parallel, not serially.
      expect(order[0]).toMatch(/^start:/);
      expect(order[1]).toMatch(/^start:/);
    } finally {
      defaultRegistries["docker-hub"] = defaultRegistries["docker-hub-backup"];
      delete defaultRegistries["docker-hub-backup"];
    }
  });

  it("mixing .withMCP(config) and .withMCP(catalogName) in one chain connects both", async () => {
    const registry = fakeRegistry(async (request) => ({
      name: request.name,
      transport: "stdio",
      command: "docker",
    }));

    const builder = ReactiveAgents.create()
      .withName("toolkit-agent")
      .withProvider("test")
      .withMCP({ name: "hand-written", transport: "stdio", command: "echo" })
      .withMCP("brave-search", { registry: registry.id });

    await buildIgnoringDownstreamConnectFailure(builder);

    const mcpServers = (builder as any)._mcpServers;
    expect(mcpServers.map((s: { name: string }) => s.name).sort()).toEqual(["brave-search", "hand-written"]);
  });

  it("a registry rejection propagates out of .build() untransformed", async () => {
    const rejection = new MCPApprovalRequiredError({
      message: "approval required for mcp/brave-search",
      registryId: "docker-hub",
      image: "mcp/brave-search",
      digest: "sha256:deadbeef",
    });
    const registry = fakeRegistry(() => Promise.reject(rejection));

    const builder = ReactiveAgents.create()
      .withName("toolkit-agent")
      .withProvider("test")
      .withMCP("brave-search", { registry: registry.id });

    await expect(builder.build()).rejects.toBe(rejection);
  });

  it("a mixed string+object array in one .withMCP() call throws a clear synchronous error", () => {
    const builder = ReactiveAgents.create()
      .withName("toolkit-agent")
      .withProvider("test");

    expect(() =>
      (builder as any).withMCP([
        "brave-search",
        { name: "hand-written", transport: "stdio", command: "echo" },
      ])
    ).toThrow(/mix catalog names.*MCPServerConfig objects/i);
  });
});
