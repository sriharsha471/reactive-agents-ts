/**
 * Plain-`Promise` convenience API over `MCPApprovalStore` — the public,
 * caller-facing entry point for approving/checking an MCP toolkit image.
 *
 * Design spec: `wiki/Architecture/Design-Specs/2026-09-19-mcp-toolkit-scaffolding.md`.
 * `MCPApprovalStore` itself is an Effect `Context.Tag` service (internal
 * implementation stays Effect-TS-patterned per `AGENTS.md`), but nothing
 * outside `packages/tools` should ever need to `import { Effect } from
 * "effect"` just to approve an image — this file is the one place that
 * crosses from Effect to `Promise`, mirroring `DockerHubMCPRegistry.resolve()`'s
 * own `Effect.runPromiseExit` boundary. A future `rax mcp approve <image>`
 * CLI verb and any other Promise-based caller (e.g. `scratch.ts`) call these
 * functions directly.
 */
import { Effect } from "effect";
import { buildApprovalKey, makeFileApprovalStore } from "./approval-store.js";

/**
 * Records an approval for `image` (as resolved by registry `registryId`) at
 * `digest`. Persists to the file-backed store at `path` (defaults to
 * `~/.reactive-agents/mcp-approvals`, see `DEFAULT_MCP_APPROVALS_PATH`).
 *
 * This is an explicit, caller-initiated trust decision — it is the write
 * path a human (or a CI step that has independently vetted the image) calls
 * after reviewing the image, mirroring the `MCPApprovalRequiredError`
 * message's `rax mcp approve <image>` guidance.
 */
export const approveMcpImage = (
  registryId: string,
  image: string,
  digest: string,
  path?: string,
): Promise<void> =>
  Effect.runPromise(
    makeFileApprovalStore(path).recordApproval(buildApprovalKey(registryId, image), digest),
  );

/**
 * Checks whether `image` (as resolved by registry `registryId`) is currently
 * approved at `digest`. Reads the same file-backed store `approveMcpImage`
 * writes to.
 */
export const isMcpImageApproved = (
  registryId: string,
  image: string,
  digest: string,
  path?: string,
): Promise<boolean> =>
  Effect.runPromise(
    makeFileApprovalStore(path).isApproved(buildApprovalKey(registryId, image), digest),
  );
