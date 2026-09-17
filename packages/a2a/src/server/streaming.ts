/**
 * SSE event formatting for A2A task updates.
 *
 * Real SSE streaming (a `ReadableStream` that pushes events as they occur)
 * is not implemented — `handleMessageStream` (http-server.ts) awaits full
 * task completion and joins these formatted events into one response body.
 * `generateAgentCard` defaults `capabilities.streaming: false` accordingly
 * (agent-card.ts). A prior stub (`createSSEStream`) that built a
 * `ReadableStream` whose `send` closure was never wired to anything was
 * removed as dead code rather than kept as a marker — real streaming is a
 * separate follow-up and can reintroduce a stream builder when it lands.
 */
import type { A2ATask, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from "../types.js";

export type StreamEvent =
  | { type: "task"; data: A2ATask }
  | { type: "status-update"; data: TaskStatusUpdateEvent }
  | { type: "artifact-update"; data: TaskArtifactUpdateEvent };

export const formatSSEEvent = (event: StreamEvent): string => {
  const data = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result:
      event.type === "task"
        ? { ...event.data, kind: "task" }
        : event.type === "status-update"
          ? { ...event.data, kind: "status-update" }
          : { ...event.data, kind: "artifact-update" },
  });
  return `data: ${data}\n\n`;
};
