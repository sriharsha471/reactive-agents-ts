/**
 * Example T9: MCP Server with OAuth 2.1
 *
 * Demonstrates connecting to an OAuth-protected remote MCP server using the
 * client_credentials grant — the machine-to-machine mode meant for unattended
 * agents. RA turns `auth` into a real OAuth 2.1 client: it discovers the
 * server's authorization metadata, requests a token bound to that exact
 * server (RFC 8707), persists it to a permission-restricted file store, and
 * refuses a plaintext connection unless the endpoint is loopback.
 *
 * For a human-delegated server (an agent acting on YOUR account), use
 * `auth: { type: "authorization_code" }` instead and run `rax mcp login
 * <name>` once beforehand — see the Tools guide's OAuth section for that flow:
 * https://reactive-agents.dev/guides/tools/#oauth-21-auth
 *
 * Prerequisites (for the LIVE path):
 *   MCP_OAUTH_ENDPOINT=https://your-server.example/mcp
 *   MCP_OAUTH_CLIENT_ID=...
 *   MCP_OAUTH_CLIENT_SECRET=...
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... MCP_OAUTH_ENDPOINT=... MCP_OAUTH_CLIENT_ID=... \
 *     MCP_OAUTH_CLIENT_SECRET=... bun run apps/examples/src/tools/T9-mcp-oauth.ts
 *
 * Test mode (no OAuth server reached, uses mock response):
 *   bun run apps/examples/src/tools/T9-mcp-oauth.ts
 */

import { ReactiveAgents } from "reactive-agents";

export interface ExampleResult {
  passed: boolean;
  output: string;
  steps: number;
  tokens: number;
  durationMs: number;
}

export async function run(opts?: { provider?: string; model?: string }): Promise<ExampleResult> {
  const start = Date.now();
  type PN = "anthropic" | "openai" | "ollama" | "gemini" | "litellm" | "test";
  const provider = (opts?.provider ?? (process.env.ANTHROPIC_API_KEY ? "anthropic" : "test")) as PN;
  const endpoint = process.env.MCP_OAUTH_ENDPOINT;
  const clientId = process.env.MCP_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
  // useReal requires a non-test provider AND a full set of OAuth credentials.
  // If any are missing, fall back to test mode entirely so withTestScenario works.
  const useReal = provider !== "test" && Boolean(endpoint && clientId && clientSecret);
  const effectiveProvider = (useReal ? provider : "test") as PN;

  console.log("\n=== MCP OAuth Example ===");
  console.log(`Mode: ${useReal ? `LIVE (MCP + OAuth client_credentials + ${provider})` : "TEST (mock)"}\n`);

  let b = ReactiveAgents.create()
    .withName("mcp-oauth-agent")
    .withProvider(effectiveProvider);
  if (useReal && opts?.model) b = b.withModel(opts.model);
  b = b
    .withTools()
    .withMCP(useReal ? [{
      name: "oauth-server",
      transport: "streamable-http",
      endpoint: endpoint!,
      auth: {
        type: "client_credentials",
        clientId: clientId!,
        clientSecret: clientSecret!,
      },
      // Omit tokenStore to use the default: a permission-restricted file
      // store at ~/.reactive-agents/mcp-auth, keyed by the server's URL —
      // the same store `rax mcp login|logout|status` reads and writes.
    }] : [])
    .withMaxIterations(5);
  if (effectiveProvider === "test") {
    b = b.withTestScenario([{ text: "FINAL ANSWER: Connected to the OAuth-protected MCP server and completed the requested task using its tools." }]);
  }
  const agent = await b.build();

  const result = await agent.run(
    "Use the connected MCP server's tools to complete a simple task, then summarize what happened."
  );

  console.log(`Output: ${result.output.slice(0, 200)}`);
  console.log(`Steps: ${result.metadata.stepsCount}`);

  const passed = result.success && result.output.length > 10;
  return {
    passed,
    output: result.output.slice(0, 300),
    steps: result.metadata.stepsCount,
    tokens: result.metadata.tokensUsed,
    durationMs: Date.now() - start,
  };
}

if (import.meta.main) {
  const r = await run();
  console.log(r.passed ? "✅ PASS" : "❌ FAIL", r.output.slice(0, 200));
  process.exit(r.passed ? 0 : 1);
}
