/**
 * Remote A2A agent tool registration helper.
 *
 * Builds a `(toolDef, handler)` registration pair for a remote agent
 * accessible via the A2A JSON-RPC protocol (`message/send`,
 * `tasks/get`). The handler wraps `executeRemoteAgentTool` from
 * `@reactive-agents/tools` with a `RemoteAgentClient` instance that
 * speaks JSON-RPC over `fetch`.
 *
 * Lifted from builder.ts pre-W25 (6,232-LOC checkpoint).
 */

import { Effect } from "effect";
import { assertPublicUrl } from "@reactive-agents/runtime-shim";
import { agentEgressGuard, type A2ATask, type AgentEgressConfig } from "@reactive-agents/a2a";
import type {
  RemoteAgentClient,
  TaskResult,
  ToolDefinition,
} from "@reactive-agents/tools";

/**
 * A2A tasks reach a terminal state asynchronously (Task 1's non-blocking
 * default forks the executor and returns a `working` task immediately).
 * These are the states after which the task will never again change.
 */
const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "canceled",
  "rejected",
  "input_required",
  "unknown",
]);

/**
 * Extracts the agent's textual output from a spec-shaped `A2ATask`.
 *
 * Per `A2ATaskSchema`, output lives in `artifacts[].parts[].text` — never a
 * flat `task.result` field. `artifacts` (and each artifact's `parts`) can be
 * absent or empty, e.g. while the task is still `working`, so this returns
 * `undefined` rather than throwing in that case.
 */
const extractArtifactText = (task: Pick<A2ATask, "artifacts">): string | undefined => {
  const texts = (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts ?? [])
    .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
    .map((part) => part.text);
  return texts.length > 0 ? texts.join("\n") : undefined;
};

/**
 * Egress guard for A2A peer URLs (F15). These are operator-configured, and
 * local peers (loopback / RFC-1918) are a legitimate multi-agent pattern, so
 * private targets are allowed by default; cloud-metadata / link-local is always
 * blocked. Set RA_AGENT_STRICT_EGRESS=1, or pass `deps.egress.strictEgress`,
 * to also refuse private targets.
 *
 * Guard itself lives in `@reactive-agents/a2a` (`client/discovery.ts`) — this
 * is the SAME flag `discoverAgent` reads, and `packages/runtime` already
 * depends on `packages/a2a`, so sharing it closes the two-site direct-read
 * gap (Task 15 ablatability audit) without a new package edge.
 */

export interface RemoteAgentToolRegistration {
  readonly def: ToolDefinition;
  readonly handler: (
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, Error>;
}

export interface RemoteAgentToolDeps {
  readonly createRemoteAgentTool: (
    name: string,
    agentCardUrl: string,
    baseUrl: string,
  ) => ToolDefinition;
  readonly executeRemoteAgentTool: (
    tool: ToolDefinition,
    input: Record<string, unknown>,
    client: RemoteAgentClient,
    agentCardUrl: string,
  ) => Promise<TaskResult>;
  readonly egress?: AgentEgressConfig;
}

export const createRemoteAgentToolRegistration = (
  agentTool: { readonly name: string; readonly remoteUrl: string },
  deps: RemoteAgentToolDeps,
): RemoteAgentToolRegistration => {
  const { createRemoteAgentTool, executeRemoteAgentTool } = deps;
  const guard = agentEgressGuard(deps.egress);

  // Remote A2A agent tool
  const toolDef = createRemoteAgentTool(
    agentTool.name,
    `${agentTool.remoteUrl}/.well-known/agent.json`,
    agentTool.remoteUrl,
  );
  const remoteUrl = agentTool.remoteUrl;
  const remoteClient: RemoteAgentClient = {
    sendMessage: (params: {
      message: { role: string; content: string };
      agentCardUrl: string;
    }) =>
      Effect.tryPromise({
        try: async () => {
          await assertPublicUrl(remoteUrl, guard);
          return fetch(remoteUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "message/send",
              params: {
                message: {
                  role: params.message.role,
                  parts: [
                    {
                      kind: "text",
                      text: params.message.content,
                    },
                  ],
                },
              },
              id: crypto.randomUUID(),
            }),
          })
            .then((r) => r.json())
            .then((d: Record<string, unknown>) => {
              const task = d.result as A2ATask | undefined;
              if (!task?.id) {
                throw new Error(
                  `A2A message/send response missing task id: ${JSON.stringify(d)}`,
                );
              }
              return { taskId: task.id };
            });
        },
        catch: (e) => new Error(String(e)),
      }),
    getTask: (params: { id: string }) =>
      Effect.tryPromise({
        try: async () => {
          await assertPublicUrl(remoteUrl, guard);

          const fetchTask = async (): Promise<A2ATask> => {
            const response = await fetch(remoteUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tasks/get",
                params: { id: params.id },
                id: crypto.randomUUID(),
              }),
            });
            const data = (await response.json()) as Record<string, unknown>;
            const task = data.result as A2ATask | undefined;
            if (!task?.status) {
              throw new Error(`A2A tasks/get response missing task status: ${JSON.stringify(data)}`);
            }
            return task;
          };

          // Poll until the task reaches a terminal state — Task 1's
          // non-blocking `message/send` default means the task may still
          // be `submitted`/`working` on the first read.
          const maxAttempts = 30;
          const pollIntervalMs = 200;
          let lastTask: A2ATask = await fetchTask();
          for (
            let attempt = 1;
            attempt < maxAttempts && !TERMINAL_TASK_STATES.has(lastTask.status.state);
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            lastTask = await fetchTask();
          }

          return { status: lastTask.status.state, result: extractArtifactText(lastTask) };
        },
        catch: (e) => new Error(String(e)),
      }),
  };
  const handler = (args: Record<string, unknown>) =>
    Effect.tryPromise({
      try: () =>
        executeRemoteAgentTool(
          toolDef,
          args,
          remoteClient,
          `${remoteUrl}/.well-known/agent.json`,
        ),
      catch: (e) => new Error(String(e)),
    });
  return { def: toolDef, handler };
};
