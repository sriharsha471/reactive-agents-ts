/**
 * AgentCard generator — pure functions to produce A2A-compliant Agent Cards.
 */
import type { AgentCard, AgentSkill, AgentCapabilities } from "./types.js";

export interface AgentCardGeneratorConfig {
  name: string;
  description?: string;
  version?: string;
  url: string;
  organization?: string;
  organizationUrl?: string;
  capabilities?: Partial<AgentCapabilities>;
  skills?: AgentSkill[];
}

export const generateAgentCard = (config: AgentCardGeneratorConfig): AgentCard => {
  return {
    name: config.name,
    description: config.description,
    version: config.version ?? "0.1.0",
    protocolVersion: "0.3.0",
    url: config.url,
    provider: {
      organization: config.organization ?? "Reactive Agents",
      url: config.organizationUrl,
    },
    capabilities: {
      // Real SSE streaming isn't implemented yet — `handleMessageStream`
      // (server/http-server.ts) just awaits full completion and joins the
      // events into one body, and `createSSEStream` (server/streaming.ts)
      // never enqueues anything. Advertising `streaming: true` by default
      // would let a client rely on a capability we don't have. A caller who
      // has actually wired real streaming can still opt in explicitly via
      // `config.capabilities.streaming`.
      streaming: config.capabilities?.streaming ?? false,
      pushNotifications: config.capabilities?.pushNotifications ?? false,
      ...config.capabilities,
    },
    skills: config.skills ?? [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
  };
};

/** Generate skills array from ToolDefinition-like objects. */
export const toolsToSkills = (
  tools: ReadonlyArray<{ name: string; description: string; parameters?: ReadonlyArray<{ name: string }> }>,
): AgentSkill[] =>
  tools.map((t) => ({
    id: t.name,
    name: t.name,
    description: t.description,
    tags: [],
  }));
