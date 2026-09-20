/**
 * Docker Hub MCP registry — resolves an `mcp/*` catalog entry name into a
 * connect-ready `MCPRegistryServerConfig`.
 *
 * Design spec: `wiki/Architecture/Design-Specs/2026-09-19-mcp-toolkit-scaffolding.md`.
 * Promotes the throwaway `scratch.ts` prototype (`resolveDockerMCPServer`) to
 * a production, Effect-TS-patterned implementation: fetch
 * `hub.docker.com/v2/repositories/mcp/<name>/`, parse `full_description`
 * markdown for an `## Environment Variables`/`Configuration`/`Secrets`
 * section, validate required env vars are present, gate on the digest-keyed
 * approval store, and build a `docker run` stdio config.
 */
import { Cause, Context, Effect, Exit, Layer, Option, Schema } from "effect";
import {
  MCPApprovalRequiredError,
  MCPDigestMismatchError,
  MCPMissingEnvVarError,
  MCPRegistryFetchError,
  type MCPRegistry,
  type MCPRegistryServerConfig,
  type MCPToolkitRequest,
} from "./types.js";
import {
  buildApprovalKey,
  MCPApprovalStore,
  MCPApprovalStoreError,
  MCPApprovalStoreLive,
} from "./approval-store.js";

// ─── Docker Hub repository response ─────────────────────────────────────────

const DockerHubRepositoryResponseSchema = Schema.Struct({
  full_description: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type DockerHubRepositoryResponse = typeof DockerHubRepositoryResponseSchema.Type;

const DockerMCPEnvVarSchema = Schema.Struct({
  name: Schema.String,
  required: Schema.Boolean,
  description: Schema.String,
});
type DockerMCPEnvVar = typeof DockerMCPEnvVarSchema.Type;

// ─── full_description markdown parsing ──────────────────────────────────────

const TABLE_ROW_RE = /^`([A-Za-z0-9_.-]+)`\|`?([A-Za-z]+)?`?\s*(\*optional\*)?\|(.+)$/;

const parseTableRows = (block: string): DockerMCPEnvVar[] =>
  block
    .split("\n")
    .map((line) => TABLE_ROW_RE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      name: match[1] ?? "",
      required: match[3] === undefined,
      description: (match[4] ?? "").trim(),
    }));

/** Parses the Environment-Variables-style section out of a catalog entry's `full_description` markdown. */
const parseEnvVars = (markdown: string): readonly DockerMCPEnvVar[] => {
  const sections = markdown.split(/^## /m).slice(1);
  const target = sections.find((section) =>
    /^(Environment Variables|Configuration|Secrets)\s*$/m.test(section.split("\n")[0] ?? ""),
  );
  return target ? parseTableRows(target) : [];
};

// ─── Injectable HTTP dependency ─────────────────────────────────────────────

/**
 * Fetches Docker Hub repository metadata. Injected so tests never hit the
 * real network — `DockerHubHttpLive` is the only implementation that calls
 * `fetch`, and it is wrapped in `Effect.tryPromise`.
 */
export class DockerHubHttp extends Context.Tag("DockerHubHttp")<
  DockerHubHttp,
  {
    readonly fetchRepository: (
      name: string,
    ) => Effect.Effect<DockerHubRepositoryResponse, MCPRegistryFetchError>;
  }
>() {}

export const DockerHubHttpLive: Layer.Layer<DockerHubHttp> = Layer.succeed(
  DockerHubHttp,
  DockerHubHttp.of({
    fetchRepository: (name) =>
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`https://hub.docker.com/v2/repositories/mcp/${name}/`);
          if (!res.ok) {
            const httpError = new Error(
              `Docker Hub repository "mcp/${name}" returned HTTP ${res.status}`,
            ) as Error & { status: number };
            httpError.status = res.status;
            throw httpError;
          }
          return (await res.json()) as DockerHubRepositoryResponse;
        },
        catch: (cause) =>
          new MCPRegistryFetchError({
            message: cause instanceof Error ? cause.message : `Failed to fetch Docker Hub repository "mcp/${name}"`,
            name,
            status: (cause as { status?: number } | undefined)?.status,
            cause,
          }),
      }),
  }),
);

// ─── Digest resolution (documented MVP limitation) ──────────────────────────

/**
 * Docker Hub's repository-detail endpoint (`/v2/repositories/mcp/<name>/`)
 * does not return an image digest — only a separate tag/manifest endpoint
 * does, and this MVP does not call it (the design spec's "Digest pinning"
 * point is V2/V3 scope). Until a real manifest-digest lookup is wired in,
 * the fully-qualified image name is used as a documented placeholder
 * "digest" for approval-store keying. This means the approval gate today
 * only detects "have I approved this name before," not "has the underlying
 * image changed since" — revisit when a real digest lookup lands.
 */
const resolveDigest = (image: string): string => image;

// ─── Resolution pipeline ─────────────────────────────────────────────────────

/**
 * `registryId` is a required, explicit parameter (not read off `request` or
 * a hardcoded literal) so that two different registry instances resolving
 * the identical catalog `name` never collide — neither on the resolved
 * `MCPRegistryServerConfig.name` nor on the approval-store key.
 *
 * `name` format: `${registryId}:${request.name}` (`:` separator). This is
 * deliberately different from `tool-service.ts`'s `${server.name}/${toolName}`
 * tool-naming convention (`/` separator) — a resolved server name can
 * therefore never be misparsed as (or collide with) a `server/tool` pair.
 */
export const resolveDockerHubToolkitRequest = (
  request: MCPToolkitRequest,
  registryId: string,
): Effect.Effect<
  MCPRegistryServerConfig,
  | MCPMissingEnvVarError
  | MCPApprovalRequiredError
  | MCPDigestMismatchError
  | MCPRegistryFetchError
  | MCPApprovalStoreError,
  DockerHubHttp | MCPApprovalStore
> =>
  Effect.gen(function* () {
    const http = yield* DockerHubHttp;
    const approvalStore = yield* MCPApprovalStore;

    const image = `mcp/${request.name}`;
    const digest = resolveDigest(image);
    const approvalKey = buildApprovalKey(registryId, image);

    const repo = yield* http.fetchRepository(request.name);
    const envVars = parseEnvVars(repo.full_description ?? "");

    const providedEnv = request.env ?? {};
    const missing = envVars.filter((v) => v.required && providedEnv[v.name] === undefined);
    if (missing.length > 0) {
      return yield* Effect.fail(
        new MCPMissingEnvVarError({
          message: `Missing required config for ${image}: ${missing.map((v) => v.name).join(", ")}`,
          image,
          missing: missing.map((v) => v.name),
        }),
      );
    }

    const validatedEnv: Record<string, string> = Object.fromEntries(
      envVars
        .filter((v) => providedEnv[v.name] !== undefined)
        .map((v) => [v.name, providedEnv[v.name] as string]),
    );

    if (request.requireApproval ?? true) {
      const approval = yield* approvalStore.getApproval(approvalKey);
      if (!approval) {
        return yield* Effect.fail(
          new MCPApprovalRequiredError({
            message:
              `MCP server image "${image}" requires approval before it can be used ` +
              `(digest: ${digest}). Run: rax mcp approve ${image}`,
            registryId,
            image,
            digest,
          }),
        );
      }
      if (approval.digest !== digest) {
        return yield* Effect.fail(
          new MCPDigestMismatchError({
            message:
              `MCP server image "${image}" changed since it was approved ` +
              `(approved ${approval.digest}, now ${digest}). Re-run: rax mcp approve ${image}`,
            image,
            approvedDigest: approval.digest,
            currentDigest: digest,
          }),
        );
      }
    }

    const volumeArgs = (request.volumes ?? []).flatMap((v) => [
      "-v",
      `${v.host}:${v.container}${v.readOnly ? ":ro" : ""}`,
    ]);
    const envArgs = Object.keys(validatedEnv).flatMap((name) => ["-e", name]);

    const config: MCPRegistryServerConfig = {
      name: `${registryId}:${request.name}`,
      transport: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", ...volumeArgs, ...envArgs, image],
      env: validatedEnv,
      // Design spec's "Risk-tier elevation" — resolved images run arbitrary
      // pulled containers, so default the tier to high unless the caller
      // overrides it in a future runtime.MCPServerConfig.defaultRiskLevel.
      defaultRiskLevel: "high",
    };
    return config;
  });

// ─── Registry ────────────────────────────────────────────────────────────────

export interface DockerHubMCPRegistryOptions {
  /**
   * Override for a second/alternate Docker-Hub-shaped registry instance —
   * defaults to `"docker-hub"`. Scopes both the resolved config's `name`
   * and the approval-store key, so two differently-`id`'d instances never
   * collide even when resolving the identical catalog `name`.
   */
  readonly id?: string;
  /** Override for tests — defaults to `DockerHubHttpLive` (real `fetch`). */
  readonly httpLayer?: Layer.Layer<DockerHubHttp>;
  /** Override for tests — defaults to the file-backed live approval store. */
  readonly approvalStoreLayer?: Layer.Layer<MCPApprovalStore>;
}

/**
 * `MCPRegistry` implementation for Docker Hub's `mcp/*` catalog. `resolve()`
 * runs the Effect pipeline above via `Effect.runPromise` — the only place
 * this module crosses from Effect to `Promise` — to match the `MCPRegistry`
 * interface the (Promise-based) runtime builder consumes.
 */
export class DockerHubMCPRegistry implements MCPRegistry {
  readonly id: string;
  private readonly httpLayer: Layer.Layer<DockerHubHttp>;
  private readonly approvalStoreLayer: Layer.Layer<MCPApprovalStore>;

  constructor(options?: DockerHubMCPRegistryOptions) {
    this.id = options?.id ?? "docker-hub";
    this.httpLayer = options?.httpLayer ?? DockerHubHttpLive;
    this.approvalStoreLayer = options?.approvalStoreLayer ?? MCPApprovalStoreLive();
  }

  async resolve(request: MCPToolkitRequest): Promise<MCPRegistryServerConfig> {
    // `Effect.runPromiseExit` (not `Effect.runPromise`) is used deliberately:
    // `runPromise` rejects with an opaque `FiberFailureImpl` wrapper around a
    // typed `Effect.fail` value, which would hide the tagged error classes
    // (`MCPMissingEnvVarError` etc.) from Promise-based callers doing
    // `instanceof`/`_tag` checks. Unwrapping the `Exit` here re-throws the
    // original tagged error unwrapped, matching the `MCPRegistry.resolve()`
    // Promise-interop contract.
    const exit = await Effect.runPromiseExit(
      resolveDockerHubToolkitRequest(request, this.id).pipe(
        Effect.provide(this.httpLayer),
        Effect.provide(this.approvalStoreLayer),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw Cause.squash(exit.cause);
  }
}
