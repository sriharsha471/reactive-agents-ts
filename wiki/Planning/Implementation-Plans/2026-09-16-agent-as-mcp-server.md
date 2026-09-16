# Agent-as-MCP-Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any Reactive Agents agent be exposed as an MCP server, so Claude Desktop, Cursor, Windsurf, Cline, and other MCP hosts can call it as a tool with no glue code.

**Architecture:** A new leaf package `@reactive-agents/mcp-server` wraps the MCP SDK's `McpServer` and registers the agent as **one** tool (`run_agent`). It takes the agent as an injected executor callback, so the package depends on neither `runtime` nor `reasoning` and violates no layer rule. Two transports: stdio (what MCP hosts actually spawn) and Web-standard streamable HTTP mounted on the repo's existing `secureServe`. The runtime exposes it as an explicit `await agent.serveMCP()` returning a stop handle — deliberately **not** a `.withMCPServer()` wither (see Design Note below).

**Tech Stack:** TypeScript (strict), `@modelcontextprotocol/sdk@^1.29.0` (already a dependency of `packages/tools`), `bun:test`, `secureServe` from `@reactive-agents/runtime-shim`.

**Spec:** No separate spec — scoping doc is `wiki/Planning/Implementation-Plans/2026-09-16-capability-expansion-scoping.md` (Track B).

## Design Note: why an explicit `serveMCP()` and not a wither

`.withA2A()` is the cautionary precedent, and it is broken in exactly the way a
`.withMCPServer()` wither would be. Verified during research for this plan:

- `createA2AServerLayer(card, port)` (`packages/a2a/src/runtime.ts:7-10`) calls
  `createA2AHttpServer(port ?? 3000)` with **no executor**. Per
  `packages/a2a/src/server/task-handler.ts:46-89`, a server with no executor
  stores a `"submitted"` task and returns — the agent is never invoked.
- Nothing in the repo ever calls `.start()` on the resulting `A2AHttpServer`
  service. Grepped across `packages/runtime`, `packages/a2a`, and `apps/` —
  the only consumers are tests, and they call `handleJsonRpc` directly.

So `.withA2A()` today composes a layer that binds no port and, if it did, would
run no agent. `rax serve` appears to work only because it hand-rolls its own
~120-line server (`apps/cli/src/commands/serve.ts:139-260`) and never touches
`packages/a2a`'s.

A config-only wither can silently do nothing. An `await agent.serveMCP()` that
returns a handle cannot — it either binds and returns, or throws. The wiring
test in Task 4 pins that the agent is actually invoked, which is precisely the
assertion `.withA2A()` never had.

## Global Constraints

- Strict TypeScript. No `any`, no new `as unknown as` (repo gate ceiling is 78, currently at 79 — do not add).
- The new package must NOT import `@reactive-agents/runtime` or `@reactive-agents/reasoning`. The agent arrives as an injected executor function. This is what keeps it a leaf and makes it unit-testable without building an agent.
- Library code must never call `process.exit`. Precedent and rationale: `packages/tools/src/mcp/mcp-client.ts:115-120` ("HS-12 … library code must not unilaterally call `process.exit`") — it re-raises instead. `apps/cli` may exit; the package may not.
- New package version is `0.16.0`, matching every other package. `check-version-sync.sh` enforces this across all packages including private ones.
- Use `McpServer` + `registerTool`, NOT the low-level `Server` + `setRequestHandler`. `server/index.d.ts:71` marks `Server` `@deprecated Use McpServer instead`, and all `tool()` overloads are deprecated in favor of `registerTool`.
- Network exposure goes through `secureServe` only. Never call `Bun.serve` directly — `secureServe` is loopback-by-default and *throws* on a non-loopback bind without a token (`packages/runtime-shim/src/secure-serve.ts:64-71`). That fail-closed property is the security boundary.

---

### Task 1: Scaffold the `@reactive-agents/mcp-server` package

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts`
- Create: `packages/mcp-server/README.md`

**Interfaces:**
- Produces: the package skeleton. Task 2 fills in `src/agent-mcp-server.ts` and re-exports it from `src/index.ts`.

- [ ] **Step 1: Copy the package.json shape from an existing leaf package**

Use `packages/observe/package.json` as the structural template (scripts, repository, publishConfig, files, exports). Change name/description/dependencies:

```json
{
  "name": "@reactive-agents/mcp-server",
  "version": "0.16.0",
  "description": "Expose a reactive-agents agent as an MCP server — callable from Claude Desktop, Cursor, and any MCP host",
  "type": "module",
  "scripts": {
    "build": "tsup --config ../../tsup.config.base.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test --reporter=dots",
    "test:watch": "bun test --watch"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.28.0",
    "@reactive-agents/runtime-shim": "0.16.0"
  },
  "devDependencies": {
    "typescript": "^6.0.3",
    "bun-types": "latest"
  },
  "license": "MIT",
  "publishConfig": { "access": "public" },
  "files": ["dist", "README.md", "LICENSE"]
}
```

⚠️ **Check the `exports` block against the majority convention before copying it.** Most packages in this repo set `"bun": "./src/index.ts"` so Bun resolves workspace source directly and edits are live with no rebuild; `packages/observe` and `packages/reasoning` point `bun` at `./dist`, which is the minority. Run `grep -l '"bun": "./src' packages/*/package.json | wc -l` versus `grep -l '"bun": "./dist' packages/*/package.json | wc -l` and follow the majority. Getting this wrong means every test run needs a rebuild.

Also fill in `keywords`, `repository.directory`, `homepage`, and `bugs` to match the sibling packages — `check-version-sync.sh` and the release tooling read these.

- [ ] **Step 2: Add the tsconfig**

Copy `packages/observe/tsconfig.json` verbatim, adjusting any relative paths. Do not invent a new compiler config.

- [ ] **Step 3: Stub the entrypoint**

`packages/mcp-server/src/index.ts`:

```ts
export { createAgentMcpServer } from "./agent-mcp-server.js";
export type { AgentMcpServerOptions, AgentMcpServerHandle, AgentExecutor } from "./agent-mcp-server.js";
```

This is red until Task 2 — that is intended; the package is not built or tested standalone until then.

- [ ] **Step 4: Verify the workspace picks up the new package**

Run: `bun install` then `ls node_modules/@reactive-agents/mcp-server`
Expected: a symlink into `packages/mcp-server`. If the workspace glob in the root `package.json` does not cover `packages/*`, fix that instead of hand-linking.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server
git commit -m "chore(mcp-server): scaffold the @reactive-agents/mcp-server package"
```

---

### Task 2: The MCP server — agent as one tool, over stdio

**Files:**
- Create: `packages/mcp-server/src/agent-mcp-server.ts`
- Test: `packages/mcp-server/tests/agent-mcp-server.test.ts`

**Interfaces:**
- Consumes: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- Produces:
  - `type AgentExecutor = (input: string) => Promise<{ readonly output: string; readonly success: boolean }>`
  - `interface AgentMcpServerOptions { name: string; description: string; version?: string; executor: AgentExecutor; toolName?: string }`
  - `interface AgentMcpServerHandle { readonly server: McpServer; connect(transport: Transport): Promise<void>; close(): Promise<void> }`
  - `createAgentMcpServer(options): AgentMcpServerHandle`

Task 3 (HTTP) and Task 4 (runtime wiring) both consume `createAgentMcpServer`.

- [ ] **Step 1: Write the failing test**

The SDK ships `InMemoryTransport.createLinkedPair()` (`node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.d.ts:19`) — a real client/server pair in-process. Use it: this tests the actual MCP protocol round-trip, not a mock of it.

`packages/mcp-server/tests/agent-mcp-server.test.ts`:

```ts
// Run: bun test packages/mcp-server/tests/agent-mcp-server.test.ts
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgentMcpServer, type AgentExecutor } from "../src/agent-mcp-server.js";

const connect = async (executor: AgentExecutor, opts?: { toolName?: string }) => {
  const handle = createAgentMcpServer({
    name: "test-agent",
    description: "An agent under test",
    executor,
    ...opts,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([handle.connect(serverTransport), client.connect(clientTransport)]);
  return { client, handle };
};

describe("agent exposed as an MCP server", () => {
  it("advertises exactly one tool, named after the agent's purpose", async () => {
    const { client, handle } = await connect(async () => ({ output: "ok", success: true }));
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("run_agent");
    expect(listed.tools[0]?.description).toContain("An agent under test");
    await handle.close();
  });

  it("RED-ON-CUT: a tools/call actually invokes the executor with the caller's input", async () => {
    const seen: string[] = [];
    const { client, handle } = await connect(async (input) => {
      seen.push(input);
      return { output: `handled: ${input}`, success: true };
    });

    const result = await client.callTool({
      name: "run_agent",
      arguments: { input: "summarize the changelog" },
    });

    // This is the assertion .withA2A() never had: the agent really ran.
    expect(seen).toEqual(["summarize the changelog"]);
    expect(JSON.stringify(result.content)).toContain("handled: summarize the changelog");
    await handle.close();
  });

  it("reports a failed run as an MCP tool error, not a silent success", async () => {
    const { client, handle } = await connect(async () => ({
      output: "could not complete the task",
      success: false,
    }));
    const result = await client.callTool({ name: "run_agent", arguments: { input: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("could not complete");
    await handle.close();
  });

  it("surfaces an executor throw as a tool error instead of crashing the server", async () => {
    const { client, handle } = await connect(async () => {
      throw new Error("provider exploded");
    });
    const result = await client.callTool({ name: "run_agent", arguments: { input: "x" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("provider exploded");
    // The server must still answer after a failed call.
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    await handle.close();
  });

  it("honors a custom tool name", async () => {
    const { client, handle } = await connect(async () => ({ output: "ok", success: true }), {
      toolName: "research",
    });
    const listed = await client.listTools();
    expect(listed.tools[0]?.name).toBe("research");
    await handle.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/mcp-server/tests/agent-mcp-server.test.ts`
Expected: FAIL — `../src/agent-mcp-server.js` does not exist.

- [ ] **Step 3: Implement the server**

`registerTool`'s exact signature is at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts:150-157`; it accepts a Zod raw shape or a Standard-Schema object as `inputSchema` and auto-serves both `tools/list` and `tools/call`. Check whether `zod` is already available in the workspace (`grep -rn '"zod"' packages/*/package.json | head`). If it is, use a Zod shape; if not, prefer the SDK's schema-less form over adding a dependency — read the `registerTool` overloads and pick the one that needs no new package, and note the choice in the task report.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Runs the agent. Injected rather than imported so this package stays a leaf —
 * it must not depend on @reactive-agents/runtime.
 */
export type AgentExecutor = (
  input: string,
) => Promise<{ readonly output: string; readonly success: boolean }>;

export interface AgentMcpServerOptions {
  /** Server identity reported to the MCP host. */
  readonly name: string;
  /** Shown to the calling model as the tool's description — make it specific. */
  readonly description: string;
  readonly version?: string;
  readonly executor: AgentExecutor;
  /** Tool name the host sees. Default: "run_agent". */
  readonly toolName?: string;
}

export interface AgentMcpServerHandle {
  readonly server: McpServer;
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export function createAgentMcpServer(options: AgentMcpServerOptions): AgentMcpServerHandle {
  const toolName = options.toolName ?? "run_agent";
  const server = new McpServer({
    name: options.name,
    version: options.version ?? "0.16.0",
  });

  server.registerTool(
    toolName,
    {
      title: options.name,
      description:
        `${options.description} ` +
        `Send the task as plain language in 'input'; the agent plans and uses its own tools, ` +
        `then returns its final answer.`,
      inputSchema: /* see Step 3 note — Zod shape { input: z.string() } or the schema-less form */,
    },
    async ({ input }) => {
      try {
        const result = await options.executor(String(input));
        return {
          content: [{ type: "text" as const, text: result.output }],
          isError: !result.success,
        };
      } catch (e) {
        // A failed run must not take the server down — the host keeps the
        // connection open and may call again.
        return {
          content: [
            { type: "text" as const, text: e instanceof Error ? e.message : String(e) },
          ],
          isError: true,
        };
      }
    },
  );

  return {
    server,
    connect: (transport) => server.connect(transport),
    close: () => server.close(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/mcp-server/tests/agent-mcp-server.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd packages/mcp-server && bunx tsc --noEmit`
Expected: clean. If `registerTool`'s generics fight the callback's parameter type, read the actual `ToolCallback` type in `mcp.d.ts` and conform — do not reach for `any` or a cast; the repo gates both.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server
git commit -m "feat(mcp-server): expose an agent as a single MCP tool over any transport"
```

---

### Task 3: Streamable-HTTP transport on `secureServe`

**Files:**
- Create: `packages/mcp-server/src/http.ts`
- Modify: `packages/mcp-server/src/index.ts` (re-export)
- Test: `packages/mcp-server/tests/http-transport.test.ts`

**Interfaces:**
- Consumes: `createAgentMcpServer` (Task 2), `secureServe` from `@reactive-agents/runtime-shim`, `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`.
- Produces: `serveAgentMcpHttp(options & { port?: number; hostname?: string; token?: string }): Promise<{ port: number; stop(): Promise<void> }>`.

- [ ] **Step 1: Read the transport's own documented usage first**

`node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.d.ts:137-146` contains a usage block showing the integration is literally `async fetch(request) { return transport.handleRequest(request); }`. Read it before writing code — the option names (`sessionIdGenerator`, `enableJsonResponse`) and the stateless-mode rule (omit `sessionIdGenerator` ⇒ stateless) come from there, not from this plan.

- [ ] **Step 2: Write the failing test**

Bind on port 0 (ephemeral) and drive it with the SDK's `StreamableHTTPClientTransport` against the real URL, so this tests a genuine HTTP round-trip:

```ts
// Run: bun test packages/mcp-server/tests/http-transport.test.ts
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveAgentMcpHttp } from "../src/http.js";

describe("agent MCP server over streamable HTTP", () => {
  it("RED-ON-CUT: a real HTTP MCP client reaches the agent executor", async () => {
    const seen: string[] = [];
    const handle = await serveAgentMcpHttp({
      name: "http-agent",
      description: "An agent over HTTP",
      port: 0,
      executor: async (input) => {
        seen.push(input);
        return { output: `via http: ${input}`, success: true };
      },
    });

    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );

    const result = await client.callTool({ name: "run_agent", arguments: { input: "ping" } });
    expect(seen).toEqual(["ping"]);
    expect(JSON.stringify(result.content)).toContain("via http: ping");

    await client.close();
    await handle.stop();
  });

  it("refuses a non-loopback bind without a token (fail-closed ingress)", async () => {
    await expect(
      serveAgentMcpHttp({
        name: "x",
        description: "x",
        hostname: "0.0.0.0",
        port: 0,
        executor: async () => ({ output: "", success: true }),
      }),
    ).rejects.toThrow(/refusing to bind non-loopback/);
  });
});
```

Note the second test pins a security property inherited from `secureServe`. If it fails, the implementation is bypassing `secureServe` — that is the bug, not the test.

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/mcp-server/tests/http-transport.test.ts`
Expected: FAIL — `../src/http.js` does not exist.

- [ ] **Step 4: Implement**

```ts
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { secureServe } from "@reactive-agents/runtime-shim";
import { createAgentMcpServer, type AgentMcpServerOptions } from "./agent-mcp-server.js";

export interface ServeAgentMcpHttpOptions extends AgentMcpServerOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly token?: string;
}

export async function serveAgentMcpHttp(
  options: ServeAgentMcpHttpOptions,
): Promise<{ readonly port: number; stop(): Promise<void> }> {
  const handle = createAgentMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: every request is self-contained, so a host can reconnect
    // freely and no session table has to be reaped.
    sessionIdGenerator: undefined,
  });
  await handle.connect(transport);

  const server = await secureServe({
    port: options.port ?? 3001,
    hostname: options.hostname,
    token: options.token,
    fetch: (req) => transport.handleRequest(req),
  });

  return {
    port: server.port,
    stop: async () => {
      await handle.close();
      await server.stop();
    },
  };
}
```

⚠️ Verify the `ServerLike` shape returned by `secureServe` — read `packages/runtime-shim/src/secure-serve.ts` for the actual `port` / `stop` member names before assuming the two lines above compile. The plan's names are a best guess from the call site in `packages/a2a/src/server/http-server.ts:174`.

- [ ] **Step 5: Run both test files**

Run: `bun test packages/mcp-server`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server
git commit -m "feat(mcp-server): serve an agent over streamable HTTP via secureServe"
```

---

### Task 4: Wire it to the agent — `agent.serveMCP()`

**Files:**
- Modify: `packages/runtime/package.json` (add the workspace dependency)
- Modify: `packages/runtime/src/reactive-agent.ts` (add the method near `run()`, ~L782)
- Test: `packages/runtime/tests/mcp-server-wiring.test.ts` (create)

**Interfaces:**
- Consumes: `createAgentMcpServer` / `serveAgentMcpHttp` (Tasks 2-3), `ReactiveAgent.run()` — signature at `reactive-agent.ts:782`, returning `Promise<AgentResult & { object?: TOut }>` where `AgentResult` has `output: string` and `success: boolean` (`packages/runtime/src/builder/types.ts:1030-1040`).
- Produces: `agent.serveMCP(options?): Promise<McpServeHandle>`.

**Context the implementer needs:** `ReactiveAgent` carries no `name` or `description` field. The constructor (`reactive-agent.ts:148-166`) has `readonly agentId: string` only, and the builder's `_name` survives merely as an id prefix — `const agentId = self._stableAgentId ?? \`${self._name}-${Date.now()}\`` (`builder.ts:2581`), so deriving a tool name from `agentId` would embed a timestamp. The MCP tool's `name`/`description` therefore come from `serveMCP()`'s own options, exactly as A2A solves it via `generateAgentCard({name, description, url})` (`apps/cli/src/commands/serve.ts:127-131`).

- [ ] **Step 1: Write the failing wiring test**

This is the test `.withA2A()` never had. It must prove the agent's own `run()` is reached — not that a server object was constructed.

```ts
// Run: bun test packages/runtime/tests/mcp-server-wiring.test.ts
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReactiveAgents } from "../src/index.js";

describe("agent.serveMCP()", () => {
  it("RED-ON-CUT: an MCP host's tools/call runs the real agent", async () => {
    const agent = await ReactiveAgents.create()
      .withName("mcp-wiring-agent")
      .withProvider("test")
      .withTestScenario({ /* scenario that yields a deterministic final answer */ })
      .build();

    const handle = await agent.serveMCP({
      name: "wiring-agent",
      description: "Answers questions for the wiring test",
      port: 0,
    });

    const client = new Client({ name: "wiring-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`)),
    );
    const result = await client.callTool({ name: "run_agent", arguments: { input: "hello" } });

    // Cutting the executor wiring (passing a stub instead of agent.run) makes
    // this line red — that is the whole point of the test.
    expect(JSON.stringify(result.content)).toContain(/* the scenario's expected answer */);
    expect(result.isError).toBeFalsy();

    await client.close();
    await handle.stop();
  });
});
```

Fill the scenario in from an existing runtime test that uses `.withTestScenario()` — copy a working one rather than inventing the scenario shape. Grep `packages/runtime/tests` for `withTestScenario` and reuse the simplest.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/runtime/tests/mcp-server-wiring.test.ts`
Expected: FAIL — `agent.serveMCP is not a function`.

- [ ] **Step 3: Add the dependency**

`packages/runtime/package.json`: add `"@reactive-agents/mcp-server": "0.16.0"` to `dependencies`. Run `bun install`.

Confirm the layer direction is legal: `mcp-server` depends only on the SDK and `runtime-shim`, so `runtime → mcp-server` adds no cycle. If a layer-check gate complains, stop and report rather than adding an exception.

- [ ] **Step 4: Implement the method**

In `reactive-agent.ts`, near `run()`:

```ts
    /**
     * Serve this agent as an MCP server, callable from Claude Desktop, Cursor,
     * or any MCP host. Returns once the port is bound.
     *
     * `name` and `description` are what the calling model sees when deciding
     * whether to use this agent — be specific about what it is good for.
     */
    async serveMCP(options: {
        readonly name: string
        readonly description: string
        readonly toolName?: string
        readonly port?: number
        readonly hostname?: string
        readonly token?: string
    }): Promise<{ readonly port: number; stop(): Promise<void> }> {
        const { serveAgentMcpHttp } = await import("@reactive-agents/mcp-server")
        return serveAgentMcpHttp({
            ...options,
            executor: async (input) => {
                const result = await this.run(input)
                return { output: result.output, success: result.success }
            },
        })
    }
```

Use a dynamic `import()` only if the repo's other optional integrations do (`runtime.ts:1481` loads A2A that way). If static imports are the norm for hard dependencies, use a static import — match the surrounding file, and say which you chose and why in the task report.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/runtime/tests/mcp-server-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove the test is red-on-cut**

Temporarily replace the `executor` body with `async () => ({ output: "stub", success: true })`. Re-run: the test MUST fail. Restore, confirm the file is byte-identical to before the mutation, re-run: PASS. Record both results in the task report — a wiring test that is not verified red-on-cut is the exact failure mode this whole task exists to avoid.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime packages/mcp-server
git commit -m "feat(runtime): add agent.serveMCP() to expose an agent to MCP hosts"
```

---

### Task 5: `rax serve --protocol mcp`

**Files:**
- Modify: `apps/cli/src/commands/serve.ts`

**Context:** flags are parsed by a hand-rolled `for` loop + `switch (arg)` at `serve.ts:45-87`, so a new case is a three-line addition. The agent is built at `serve.ts:96-107` and today unconditionally calls `.withA2A({ port })` before `startServer(builder.build(), name, port)`.

- [ ] **Step 1: Add the flag**

Add a `--protocol` case to the switch, accepting `a2a` (default) or `mcp`. Reject any other value with a clear message naming both valid options — do not silently fall back.

- [ ] **Step 2: Branch the serve path**

When `protocol === "mcp"`, skip `.withA2A()` entirely and call `agent.serveMCP({ name, description, port, hostname: process.env.RA_SERVE_HOST, token: process.env.RA_SERVE_TOKEN })` instead of `startServer(...)`. Print the bound URL and the exact JSON block a user pastes into an MCP host's config, because that is the step where this feature actually gets adopted:

```
MCP server listening on http://127.0.0.1:<port>/mcp

Add to your MCP host config:
  { "mcpServers": { "<name>": { "url": "http://127.0.0.1:<port>/mcp" } } }
```

Keep the CLI's existing process-lifetime handling (it may `process.exit`; the library may not).

- [ ] **Step 3: Update the command's `--help` text**

Find the usage/help string in `serve.ts` and document `--protocol a2a|mcp` alongside the existing flags.

- [ ] **Step 4: Manual verification**

Run: `bun run apps/cli/src/index.ts serve --protocol mcp --port 0` (adjust to the CLI's real entrypoint)
Expected: it prints a bound URL and stays up. Then confirm with a real client — the simplest check is the `StreamableHTTPClientTransport` snippet from Task 3's test pointed at the printed port.

State plainly in the task report whether an actual MCP host (Claude Desktop/Cursor) was tested or only a programmatic client. Do not claim host compatibility that was not exercised.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/serve.ts
git commit -m "feat(cli): rax serve --protocol mcp"
```

---

### Task 6: Changeset, docs, and the package README

**Files:**
- Create: `.changeset/agent-as-mcp-server.md`
- Modify: `packages/mcp-server/README.md`
- Modify: the docs page covering serving/deploying an agent (find it: `grep -rln "withA2A\|rax serve" apps/docs/src/content/docs/`)

- [ ] **Step 1: Write the changeset**

```markdown
---
"@reactive-agents/mcp-server": minor
"@reactive-agents/runtime": minor
---

Any agent can now be served as an MCP server and called from Claude Desktop,
Cursor, Windsurf, or any other MCP host:

```ts
const handle = await agent.serveMCP({
  name: "research-agent",
  description: "Researches a topic and returns a sourced summary",
  port: 3001,
});
```

or from the CLI with `rax serve --protocol mcp`. The agent is exposed as a
single `run_agent` tool: the host sends a task in plain language, the agent
plans and uses its own tools, and returns its final answer.

The server binds loopback-only by default and refuses to bind a public
interface without an auth token.
```

- [ ] **Step 2: Write the package README**

Cover: what it does, the copy-pasteable MCP host config block, stdio vs HTTP, and the security default (loopback unless a token is set). Match the tone and structure of `packages/observe/README.md`.

- [ ] **Step 3: Add a docs page section**

Document `agent.serveMCP()` and `rax serve --protocol mcp` on the serving/deploying page. Include the host-config JSON — the feature is worthless to a user who cannot wire it up.

- [ ] **Step 4: Run the docs and release gates**

Run: `bun run docs:examples:check`, then `bun run release:dry 0.16.1`
Expected: both clean. `release:dry` must show the new package in the publish set — if it is missing, the package.json is misconfigured (`files`, `publishConfig`, or the workspace glob).

- [ ] **Step 5: Commit**

```bash
git add .changeset packages/mcp-server/README.md apps/docs
git commit -m "docs(mcp-server): document serving an agent over MCP"
```

---

## Verified findings in `packages/a2a` — fix separately, NOT in this plan

All eight were found while researching this plan and independently confirmed.
They are deliberately excluded: bundling a dead-code investigation into a
feature branch buries both. B1/B2 are the significant ones and together are a
textbook "mechanism whose behavior never changes the run" — the exact class the
2026-09 wire-or-delete wave was hunting.

- **B1 — `.withA2A()` binds nothing.** `createA2AHttpServer`'s `Layer.effect` returns a service exposing `start()`, and nothing in `packages/runtime`, `packages/a2a`, or `apps/` ever calls it. `enableA2A: true` materializes a service nobody starts.
- **B2 — and it would run no agent if it did.** `runtime.ts:8` calls `createA2AHttpServer(port ?? 3000)` with no `executor`; per `task-handler.ts:46-89` a server without one stores a `"submitted"` task and returns. B1+B2 mean the 267-line A2A HTTP server is production-dead — only tests consume it.
- **B3 — `rax serve` duplicates ~120 lines of it** (`serve.ts:139-260` vs `http-server.ts:168-256`): two JSON-RPC switches, two task maps, two `secureServe` calls, and divergent env vars (`RA_SERVE_HOST`/`RA_SERVE_TOKEN` vs `RA_A2A_HOST`/`RA_A2A_TOKEN`). The CLI also calls `.withA2A({ port })` *and* binds its own server on the same port — harmless only because of B1. **Fixing B1 without B3 introduces an `EADDRINUSE` on `rax serve`.** Fix them together.
- **B4 — `A2AServer.setMessageHandler` is a stubbed public API.** `a2a-server.ts:31`: `setMessageHandler: () => Effect.sync(() => {})` discards its argument while the `Context.Tag` interface advertises it as the way to supply a handler.
- **B5 — dead code:** `a2a-server.ts:21` `generateId` is unused.
- **B6 — `JsonRpcMethod` unused and drifted:** declared at `http-server.ts:32-38` including `"tasks/sendSubscribe"` and `"message/stream"`; nothing references the type, and `routeRequest` has no case for either.
- **B7 — `any` in `serve.ts` against the strict-types rule:** L111 `Promise<InstanceType<typeof Object>>` (i.e. `Promise<Object>`), L115 `let agent: any`, plus `body: any`, `(p: any)`, `(result: any)`, `(err: any)` through L143-201.
- **B8 — stale agent-card constants:** `runtime.ts:1483-1487` hardcodes `version: "0.5.0"` (repo is 0.16.0) and `url: http://localhost:${port}`, ignoring `RA_A2A_HOST`.

**Decision taken: A2A is kept and repaired, not deleted.** The repair has its
own plan — `wiki/Planning/Implementation-Plans/2026-09-16-a2a-repair.md` — which
supersedes this section. Deeper investigation there found more than B1-B8: the
package's own client and server cannot interoperate (`{taskId}` vs the spec's
`A2ATask.id`), two disjoint task stores make `tasks/cancel` always report
TASK_NOT_FOUND, JSON-RPC responses never echo the request id, and
`configuration.blocking` is declared but unread.

Sequencing note: that plan's Task 2 adds `agent.serveA2A()` with the same
explicit-call shape as this plan's `agent.serveMCP()`, for the same reason.
Whichever lands second should check the first's implementation and match it —
two serve methods with divergent option shapes or return handles would be a
worse outcome than either one alone.
