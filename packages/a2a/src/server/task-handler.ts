/**
 * Task handler — maps A2A message/send to internal task execution.
 * Uses a callback pattern: callers provide a TaskExecutor function.
 *
 * The task store is injected via a small `TaskStore` interface rather than a
 * raw `Ref` so the http server and the `A2AServer` service can share the same
 * backing store instead of maintaining two independent in-memory maps (see
 * `createA2AHttpServer`, which passes the `A2AServer` service itself here).
 */
import { Effect } from "effect";
import type { A2ATask, SendMessageParams } from "../types.js";
import { A2AError, type TaskNotFoundError } from "../errors.js";

export type TaskExecutor = (input: string, taskId: string) => Effect.Effect<string, A2AError>;

export interface TaskStore {
  readonly getTask: (id: string) => Effect.Effect<A2ATask, TaskNotFoundError>;
  readonly setTask: (task: A2ATask) => Effect.Effect<void>;
}

const generateId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export const createTaskHandler = (store: TaskStore, executor?: TaskExecutor) => ({
  handleMessageSend: (params: SendMessageParams): Effect.Effect<A2ATask, A2AError> =>
    Effect.gen(function* () {
      const taskId = generateId();
      const contextId = generateId();
      const timestamp = now();

      // Extract text from message parts
      const inputText = params.message.parts
        .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
        .map((p) => p.text)
        .join("\n");

      const submittedTask: A2ATask = {
        id: taskId,
        contextId,
        status: { state: "submitted", timestamp },
        history: [params.message],
        createdAt: timestamp,
        updatedAt: timestamp,
        kind: "task",
      };

      yield* store.setTask(submittedTask);

      if (!executor) {
        return submittedTask;
      }

      const workingTask: A2ATask = {
        ...submittedTask,
        status: { state: "working", timestamp: now() },
        updatedAt: now(),
      };
      yield* store.setTask(workingTask);

      // Runs the executor to completion/failure and persists the result,
      // unless the task was canceled while the executor was still running
      // (in which case the cancellation must win — never resurrect a
      // canceled task by overwriting it with a late completion/failure).
      const runToCompletion: Effect.Effect<A2ATask, A2AError> = executor(inputText, taskId).pipe(
        Effect.map(
          (output): A2ATask => ({
            ...workingTask,
            status: { state: "completed", timestamp: now() },
            artifacts: [
              {
                artifactId: generateId(),
                name: "response",
                parts: [{ kind: "text" as const, text: output }],
              },
            ],
            updatedAt: now(),
          }),
        ),
        Effect.catchAll((error) =>
          Effect.succeed({
            ...workingTask,
            status: { state: "failed" as const, message: error.message, timestamp: now() },
            updatedAt: now(),
          } satisfies A2ATask),
        ),
        Effect.flatMap((finalTask) =>
          store.getTask(finalTask.id).pipe(
            Effect.catchAll(() => Effect.succeed(finalTask)),
            Effect.flatMap((current) =>
              current.status.state === "canceled"
                ? Effect.succeed(current)
                : store.setTask(finalTask).pipe(Effect.as(finalTask)),
            ),
          ),
        ),
      );

      // Spec default is non-blocking: fork the executor and return the
      // `working` task immediately. `configuration.blocking: true` opts
      // into the old inline-await behavior.
      const blocking = params.configuration?.blocking ?? false;
      if (blocking) {
        return yield* runToCompletion;
      }

      yield* Effect.forkDaemon(runToCompletion);
      return workingTask;
    }),
});
