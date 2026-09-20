// Run: bun test packages/runtime/tests/mcp-oauth-wiring.test.ts --timeout 30000
//
// Task 7 of wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md —
// pins that `.withMCP({ auth, tokenStore })` (runtime's `MCPServerConfig`)
// genuinely reaches the real MCP connection (`packages/tools`'
// `MCPServer`/`connectMCPServer`), not just that the two types happen to be
// structurally compatible. Tasks 3-6 already proved the OAuth mechanics
// themselves work against the fixture from inside `packages/tools`'s own
// test suite (`packages/tools/tests/mcp/oauth/*.test.ts`) and
// `mcp-oauth-trace-redaction.test.ts` in this same directory proves a full
// agent run with OAuth doesn't leak secrets. This test's only job is the
// runtime-layer PASSTHROUGH: does `auth`/`tokenStore` set via `.withMCP()`
// actually arrive at the connection, end to end, through a real agent run
// against the real Task 1 fixture (no mocks).
//
// RED-ON-CUT: per task-2-report.md, `MCPServerConfig` becomes `MCPServer` at
// exactly one site — `packages/runtime/src/builder/build-effect/tool-init-layer.ts`,
// inside `buildToolInitLayer`'s init effect:
//
//   yield* ts.connectMCPServer({
//     ...mcp,
//     transport: inferMcpTransport(mcp),
//   });
//
// `auth`/`tokenStore` ride along only because `...mcp` is a wholesale
// object spread. Temporarily replacing that spread with an explicit
// field list omitting `auth`/`tokenStore` (or otherwise dropping those two
// keys before the call) must turn this test red — the fixture's protected
// `/mcp` endpoint 401s any unauthenticated connection attempt, so with no
// credentials forwarded the MCP connection itself fails and the run either
// throws or never gets a tool result back.
import { describe, it, expect, afterEach } from "bun:test";
import { ReactiveAgents } from "../src/builder.js";
import { createMemoryTokenStore } from "@reactive-agents/tools";

/**
 * Same cross-package test-fixture-import pattern as
 * `mcp-oauth-trace-redaction.test.ts` in this directory — see that file's
 * header comment for the full rationale (dynamic import of a non-literal
 * path sidesteps TypeScript's `rootDir` check on a file that's deliberately
 * excluded from `packages/tools`' build).
 */
interface TestOAuthMcpFixture {
  readonly resourceUrl: string;
  readonly requests: ReadonlyArray<{ readonly path: string; readonly params: Readonly<Record<string, string>> }>;
  configure(overrides: Record<string, unknown>): void;
  close(): Promise<void>;
}
interface TestOAuthMcpFixtureModule {
  startOAuthMcpFixture(opts?: {
    readonly clients?: readonly {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly redirectUris: readonly string[];
    }[];
  }): Promise<TestOAuthMcpFixture>;
}
const fixtureModulePath: string = "../../tools/tests/fixtures/oauth-mcp/fixture.js";
const { startOAuthMcpFixture } = (await import(fixtureModulePath)) as TestOAuthMcpFixtureModule;

let fixtures: TestOAuthMcpFixture[] = [];
async function fixture(
  ...args: Parameters<TestOAuthMcpFixtureModule["startOAuthMcpFixture"]>
): Promise<TestOAuthMcpFixture> {
  const f = await startOAuthMcpFixture(...args);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.map((f) => f.close()));
  fixtures = [];
});

const CLIENT_ID = "runtime-wiring-client";
const CLIENT_SECRET = "runtime-wiring-correct-secret";

describe("MCP client OAuth — runtime `.withMCP({ auth, tokenStore })` passthrough", () => {
  it("a real agent run reaches the OAuth-protected fixture's tool and gets its result back", async () => {
    const f = await fixture({
      clients: [{ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: [] }],
    });

    const agent = await ReactiveAgents.create()
      .withName("mcp-oauth-wiring")
      .withProvider("test")
      .withMCP({
        name: "oauth-fixture",
        transport: "streamable-http",
        endpoint: f.resourceUrl,
        auth: { type: "client_credentials", clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        tokenStore: createMemoryTokenStore(),
      })
      .withTestScenario([
        { toolCall: { name: "oauth-fixture/whoami", args: {} } },
        { text: "Done." },
      ])
      .build();

    try {
      const result = await agent.run("Who am I?");
      expect(result.success).toBe(true);

      // Prove the fixture's tool actually ran and returned the real,
      // authenticated result (the access token's subject == the client id),
      // not just that the run didn't throw — read it back from the
      // observation step's content in the reasoning trace.
      const observationText = (result.metadata.reasoningSteps ?? [])
        .filter((s) => s.type === "observation")
        .map((s) => s.content)
        .join("\n");
      expect(observationText).toContain(CLIENT_ID);

      // Sanity check on the connection itself: the fixture's /token endpoint
      // was actually hit (proves auth/tokenStore reached the real transport,
      // not that the tool call happened to short-circuit some other way).
      const tokenRequest = f.requests.find((r) => r.path === "/token");
      expect(tokenRequest).toBeDefined();
    } finally {
      await agent.dispose();
    }
  });
});
