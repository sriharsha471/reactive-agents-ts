/**
 * MCP toolkit approval store — digest-keyed, persisted, no interactive prompt.
 *
 * Design spec: `wiki/Architecture/Design-Specs/2026-09-19-mcp-toolkit-scaffolding.md`
 * ("Security review" §2). A `DockerHubMCPRegistry.resolve()` call for an
 * image that has never been approved fails closed with
 * `MCPApprovalRequiredError` rather than prompting on stdin (breaks CI /
 * non-interactive use). Approving is a separate, explicit step — this module
 * only exposes the read/write primitives; a future `rax mcp approve <image>`
 * CLI verb (out of this dispatch's scope) calls `recordApproval` after
 * showing the image's cosign-verify command output.
 *
 * Persisted as one JSON file at `~/.reactive-agents/mcp-approvals`, mirroring
 * the existing `~/.reactive-agents/mcp-auth` file-store convention
 * (`mcp/auth/token-store.ts`) — same atomic-write-via-rename pattern, same
 * `0700`/`0600` mode discipline.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Context, Data, Effect, Layer } from "effect";

/** Default file-store path — matches the `~/.reactive-agents/<...>` convention. */
export const DEFAULT_MCP_APPROVALS_PATH = join(homedir(), ".reactive-agents", "mcp-approvals");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export class MCPApprovalStoreError extends Data.TaggedError("MCPApprovalStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MCPApprovalRecord {
  /** Image digest recorded at approval time (see docker-hub.ts's `resolveDigest` for the current MVP limitation). */
  readonly digest: string;
  /** ISO-8601 timestamp of when the approval was recorded. */
  readonly approvedAt: string;
}

/**
 * Builds the registry-scoped key every store method is keyed on. **Not**
 * just the bare image string — two different `MCPRegistry` implementations
 * (or two differently-`id`'d instances of the same one) can resolve the same
 * catalog `name` into the same underlying image, and without this scoping
 * an approval recorded for one registry would silently satisfy the gate for
 * the other. Callers (`docker-hub.ts`, `approve.ts`) must always build keys
 * through this function rather than concatenating ad hoc.
 */
export const buildApprovalKey = (registryId: string, image: string): string =>
  `${registryId}/${image}`;

/**
 * Digest-keyed local approval store. `isApproved`/`getApproval` are read
 * paths a registry consults before resolving an image into a connect config;
 * `recordApproval` is the write path a future CLI verb calls. `key` must be
 * a registry-scoped key built via `buildApprovalKey` — the store itself is
 * registry-agnostic and does no scoping of its own.
 */
export class MCPApprovalStore extends Context.Tag("MCPApprovalStore")<
  MCPApprovalStore,
  {
    readonly isApproved: (
      key: string,
      digest: string,
    ) => Effect.Effect<boolean, MCPApprovalStoreError>;
    readonly getApproval: (
      key: string,
    ) => Effect.Effect<MCPApprovalRecord | undefined, MCPApprovalStoreError>;
    readonly recordApproval: (
      key: string,
      digest: string,
    ) => Effect.Effect<void, MCPApprovalStoreError>;
  }
>() {}

/** Keyed by registry-scoped key (see `buildApprovalKey`), not the bare image string. */
type ApprovalsFile = Record<string, MCPApprovalRecord>;

const isEnoent = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT";

/**
 * Builds an `MCPApprovalStore` implementation backed by a single JSON file
 * at `path`. Every fs access is wrapped in `Effect.tryPromise` — no raw
 * `await`/`fs` calls at call sites.
 */
export const makeFileApprovalStore = (
  path: string = DEFAULT_MCP_APPROVALS_PATH,
): Context.Tag.Service<typeof MCPApprovalStore> => {
  const readAll = Effect.tryPromise({
    try: async (): Promise<ApprovalsFile> => {
      try {
        const raw = await readFile(path, "utf8");
        return JSON.parse(raw) as ApprovalsFile;
      } catch (err) {
        if (isEnoent(err)) return {};
        throw err;
      }
    },
    catch: (cause) =>
      new MCPApprovalStoreError({
        message: `Failed to read MCP approval store at "${path}"`,
        cause,
      }),
  });

  const writeAll = (data: ApprovalsFile): Effect.Effect<void, MCPApprovalStoreError> =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
        const tmpPath = `${path}.tmp-${randomBytes(6).toString("hex")}`;
        await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: FILE_MODE });
        await rename(tmpPath, path);
      },
      catch: (cause) =>
        new MCPApprovalStoreError({
          message: `Failed to write MCP approval store at "${path}"`,
          cause,
        }),
    });

  return MCPApprovalStore.of({
    getApproval: (key) => readAll.pipe(Effect.map((all) => all[key])),

    isApproved: (key, digest) =>
      readAll.pipe(Effect.map((all) => all[key]?.digest === digest)),

    recordApproval: (key, digest) =>
      readAll.pipe(
        Effect.flatMap((all) =>
          writeAll({
            ...all,
            [key]: { digest, approvedAt: new Date().toISOString() },
          }),
        ),
      ),
  });
};

/** Live `MCPApprovalStore` layer, persisted at `path` (default `~/.reactive-agents/mcp-approvals`). */
export const MCPApprovalStoreLive = (
  path: string = DEFAULT_MCP_APPROVALS_PATH,
): Layer.Layer<MCPApprovalStore> => Layer.succeed(MCPApprovalStore, makeFileApprovalStore(path));
