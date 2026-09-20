/**
 * MCP toolkit registry — shared types + tagged errors.
 *
 * Design spec: `wiki/Architecture/Design-Specs/2026-09-19-mcp-toolkit-scaffolding.md`.
 * Lets a caller scaffold an MCP server onto an agent from a public catalog
 * entry name (e.g. Docker Hub's `mcp/*`) instead of hand-writing a connect
 * config. `MCPRegistry` is deliberately an interface (not a hardcoded
 * Docker Hub call) so future registries (npx-based, private org catalogs)
 * plug in without an API change.
 */
import { Data, Schema } from "effect";
import type { MCPServer } from "../../types.js";

// ─── Request shape ───────────────────────────────────────────────────────────

export const MCPVolumeMountSchema = Schema.Struct({
  /** Absolute path on the host filesystem. */
  host: Schema.String,
  /** Absolute path inside the container the host path is mounted to. */
  container: Schema.String,
  /** Mount read-only (`-v host:container:ro`). Defaults to read-write. */
  readOnly: Schema.optional(Schema.Boolean),
});
export type MCPVolumeMount = typeof MCPVolumeMountSchema.Type;

export const MCPToolkitRequestSchema = Schema.Struct({
  /** Catalog entry name, e.g. `"brave-search"` (resolves to image `mcp/brave-search`). */
  name: Schema.String,
  /** Registry id to resolve against. Defaults to `"docker-hub"`. */
  registry: Schema.optional(Schema.String),
  /** Env vars the resolver validates against the catalog entry's declared requirements. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  /** Dynamic bind mounts (filesystem/git-style servers that need host access). */
  volumes: Schema.optional(Schema.Array(MCPVolumeMountSchema)),
  /**
   * Whether the digest-keyed approval gate applies to this `resolve()` call.
   * Defaults to `true` (gate on) when omitted — an unapproved image fails
   * closed with `MCPApprovalRequiredError`. Passing `false` bypasses the
   * gate entirely for this call (no `getApproval` read, and an approval is
   * never auto-recorded on success). This is an explicit, per-call trust
   * decision the CALLER is responsible for (e.g. a CI environment that vets
   * images out-of-band, or a registry already trusted without the
   * interactive `rax mcp approve` step) — never set `false` implicitly on a
   * caller's behalf.
   */
  requireApproval: Schema.optional(Schema.Boolean),
});
export type MCPToolkitRequest = typeof MCPToolkitRequestSchema.Type;

// ─── Resolved config shape ───────────────────────────────────────────────────

/**
 * Connect-ready MCP server config a registry resolves a toolkit request into.
 * Mirrors `ToolService.connectMCPServer`'s parameter type exactly
 * (`tool-service.ts:189-203`, same `Pick<MCPServer, ...>` shape as
 * `mcp-client.ts`'s internal `ConnectConfig`) so a resolved config is usable
 * by `ToolService.connectMCPServer` with no adaptation.
 */
export type MCPRegistryServerConfig = Pick<
  MCPServer,
  | "name"
  | "transport"
  | "endpoint"
  | "command"
  | "args"
  | "cwd"
  | "env"
  | "headers"
  | "auth"
  | "tokenStore"
> & {
  /**
   * Risk tier this registry recommends for tools discovered on this server
   * (design spec's "Risk-tier elevation" section). Now part of `MCPServer`
   * (`types.ts`) and consumed by `ToolService.connectMCPServer`, which uses
   * `config.defaultRiskLevel ?? "medium"` at tool-registration time.
   * `MCPServerConfig.defaultRiskLevel` in `packages/runtime/src/runtime-types.ts`
   * (the builder-facing field) is a separate, still-pending piece.
   */
  readonly defaultRiskLevel?: "low" | "medium" | "high";
};

/**
 * Pluggable resolver: turns a catalog request into a connect-ready config.
 * `resolve` returns a `Promise` (not an `Effect`) because the builder-side
 * consumer (`packages/runtime/src/builder.ts`, out of this package's
 * authority) stores `.withMcpToolkit()` requests synchronously and resolves
 * them inside its already-`async` `.build()` via `Promise.all` — matching
 * the existing `.withMCP()` pattern. Implementations do their own internal
 * work in Effect and only cross to `Promise` at this boundary.
 */
export interface MCPRegistry {
  readonly id: string;
  resolve(request: MCPToolkitRequest): Promise<MCPRegistryServerConfig>;
}

// ─── Tagged errors ───────────────────────────────────────────────────────────

export class MCPMissingEnvVarError extends Data.TaggedError("MCPMissingEnvVarError")<{
  readonly message: string;
  readonly image: string;
  readonly missing: readonly string[];
}> {}

export class MCPApprovalRequiredError extends Data.TaggedError(
  "MCPApprovalRequiredError",
)<{
  readonly message: string;
  /** Id of the registry that raised this error — pass straight to `approveMcpImage(registryId, image, digest)` (`approve.ts`), no reconstruction needed. */
  readonly registryId: string;
  readonly image: string;
  readonly digest: string;
}> {}

/**
 * Thrown when a `resolve()` call finds the image's current digest differs
 * from the one recorded at approval time (design spec's "Digest pinning"
 * point 3) — the image changed upstream since it was approved, so the
 * approval is stale and must not be silently honored.
 */
export class MCPDigestMismatchError extends Data.TaggedError(
  "MCPDigestMismatchError",
)<{
  readonly message: string;
  readonly image: string;
  readonly approvedDigest: string;
  readonly currentDigest: string;
}> {}

export class MCPRegistryFetchError extends Data.TaggedError("MCPRegistryFetchError")<{
  readonly message: string;
  readonly name: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}
