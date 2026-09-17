import { createA2AClient } from "./client/index.js";
import type { ClientConfig } from "./client/a2a-client.js";

// `createA2AServerLayer`/`A2AServerLive` (built `createA2AHttpServer` with NO
// executor) were removed here — their only caller, `A2aExtraLayer`, was
// deleted in the A2A repair plan's Task 2, and without an executor a task
// handler built from them silently accepted `message/send` and left the task
// stuck in `submitted` forever with no error (see `task-handler.ts`'s
// `executor` check). `serveA2A()` (`packages/runtime`) is the real, executor-
// wired replacement. See the final-review-fix report for detail.

export const createA2AClientLayer = (config: ClientConfig) => createA2AClient(config);

export const A2AClientLive = (config: ClientConfig) => createA2AClient(config);
