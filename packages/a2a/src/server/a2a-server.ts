import type { A2ATask, AgentCard } from "../types.js";
import { TaskNotFoundError, TaskCanceledError, InvalidTaskStateError } from "../errors.js";
import { Effect, Context, Layer, Ref } from "effect";

export class A2AServer extends Context.Tag("A2AServer")<
  A2AServer,
  {
    readonly getTask: (id: string) => Effect.Effect<A2ATask, TaskNotFoundError>;
    readonly setTask: (task: A2ATask) => Effect.Effect<void>;
    readonly cancelTask: (id: string) => Effect.Effect<A2ATask, TaskNotFoundError | TaskCanceledError | InvalidTaskStateError>;
    readonly getAgentCard: () => Effect.Effect<AgentCard>;
  }
>() {}

interface TaskStore {
  tasks: Map<string, A2ATask>;
}

const now = () => new Date().toISOString();

export const createA2AServer = (agentCard: AgentCard) =>
  Layer.effect(
    A2AServer,
    Effect.gen(function* () {
      const store = yield* Ref.make<TaskStore>({ tasks: new Map() });

      return {
        getTask: (id) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(store);
            const task = state.tasks.get(id);
            if (!task) {
              return yield* Effect.fail(new TaskNotFoundError({ taskId: id }));
            }
            return task;
          }),

        setTask: (task) =>
          Ref.update(store, (s) => ({
            tasks: new Map(s.tasks).set(task.id, task),
          })),

        cancelTask: (id) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(store);
            const task = state.tasks.get(id);
            if (!task) {
              return yield* Effect.fail(new TaskNotFoundError({ taskId: id }));
            }
            const terminalStates = ["completed", "failed", "canceled"];
            if (terminalStates.includes(task.status.state)) {
              return yield* Effect.fail(
                new InvalidTaskStateError({
                  taskId: id,
                  currentState: task.status.state,
                  attemptedTransition: "cancel",
                }),
              );
            }
            const updatedTask: A2ATask = {
              ...task,
              status: {
                state: "canceled",
                message: "Task canceled by user",
                timestamp: now(),
              },
              updatedAt: now(),
            };
            yield* Ref.update(store, (s) => ({
              tasks: new Map(s.tasks).set(id, updatedTask),
            }));
            return updatedTask;
          }),

        getAgentCard: () => Effect.succeed(agentCard),
      };
    }),
  );
