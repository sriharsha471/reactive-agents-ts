/**
 * MCP toolkit registry — public barrel.
 * Design spec: `wiki/Architecture/Design-Specs/2026-09-19-mcp-toolkit-scaffolding.md`.
 */
export {
  MCPVolumeMountSchema,
  MCPToolkitRequestSchema,
  MCPMissingEnvVarError,
  MCPApprovalRequiredError,
  MCPDigestMismatchError,
  MCPRegistryFetchError,
} from "./types.js";
export type {
  MCPVolumeMount,
  MCPToolkitRequest,
  MCPRegistryServerConfig,
  MCPRegistry,
} from "./types.js";

export {
  MCPApprovalStore,
  MCPApprovalStoreError,
  MCPApprovalStoreLive,
  makeFileApprovalStore,
  buildApprovalKey,
  DEFAULT_MCP_APPROVALS_PATH,
} from "./approval-store.js";
export type { MCPApprovalRecord } from "./approval-store.js";

export { approveMcpImage, isMcpImageApproved } from "./approve.js";

export {
  DockerHubHttp,
  DockerHubHttpLive,
  DockerHubMCPRegistry,
  resolveDockerHubToolkitRequest,
} from "./docker-hub.js";
export type {
  DockerHubRepositoryResponse,
  DockerHubMCPRegistryOptions,
} from "./docker-hub.js";

import type { MCPRegistry } from "./types.js";
import { DockerHubMCPRegistry } from "./docker-hub.js";

/** Registry id → implementation. `.withMcpToolkit()` (runtime, future dispatch) looks up here by default. */
export const defaultRegistries: Record<string, MCPRegistry> = {
  "docker-hub": new DockerHubMCPRegistry(),
};
