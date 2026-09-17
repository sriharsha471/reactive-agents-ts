/**
 * MCP client OAuth — loopback (`127.0.0.1`) redirect listener.
 *
 * Part of Task 4 of `wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md`.
 *
 * This is the browser-facing HTTP endpoint an OAuth authorization server
 * redirects the user's browser to after they approve (or deny) access. It is
 * treated as an attack surface: a malicious or compromised authorization
 * server controls every query parameter on the request this listener
 * receives.
 *
 * Threat-model decisions (see the Task 4 dispatch for the full rationale):
 * - Binds explicitly to `127.0.0.1` — never `0.0.0.0` — and self-verifies the
 *   bound address after `listen()` resolves; if the OS ever handed back
 *   anything else, the listener promise rejects instead of silently serving
 *   on an unexpected interface.
 * - `state` and (RFC 9207) `iss` are checked with the SAME rejection shape:
 *   a bad value on the callback rejects *that* request but keeps the
 *   listener open — a stray extension or bot hitting the port first must
 *   not kill a legitimate login that arrives moments later. Only a single
 *   *successful* callback (or the timeout) settles and closes the listener.
 * - Single-use: once a callback passes every check, the code promise
 *   resolves AND the HTTP server is closed in the same tick, so a second
 *   callback — replay, or a slow duplicate tab — hits a closed socket
 *   (connection refused), not a second success.
 */
import { createServer, type Server } from "node:http";

export interface LoopbackListenerOptions {
  /** Default: ephemeral (OS-assigned) port. */
  readonly port?: number;
  /** Callback path, e.g. `/callback`. Any other path on this listener 404s. */
  readonly path: string;
  /** The `state` value this listener's caller sent in the authorization request. */
  readonly expectedState: string;
  /**
   * RFC 9207 `iss` value the authorization server's own discovered metadata
   * reported as its `issuer`. `undefined` only if discovery never resolved
   * an issuer at all (should not happen in practice, but a callback
   * asserting `iss` still can't match `undefined`, so it fails closed).
   */
  readonly expectedIssuer?: string;
  /**
   * RFC 9207: true when the authorization server's metadata advertised
   * `authorization_response_iss_parameter_supported: true`. When true, a
   * callback missing `iss` is rejected (same shape as missing `state`).
   * When false, a callback with no `iss` at all is accepted (back-compat
   * with authorization servers not yet on RFC 9207) — but a present-but-
   * wrong `iss` is *always* rejected, regardless of this flag.
   */
  readonly issParameterRequired: boolean;
  /** Milliseconds to wait for a valid callback before failing closed. */
  readonly timeoutMs: number;
}

export interface LoopbackListener {
  /** The full `http://127.0.0.1:<port><path>` URL to register as the OAuth redirect_uri. */
  readonly redirectUrl: URL;
  /** Resolves with the `code` query parameter on the first VALID callback; rejects on timeout or `close()`. */
  readonly code: Promise<string>;
  /**
   * Idempotent. Stops the server. If no valid callback has arrived yet,
   * also rejects {@link code} so a caller `await`ing it doesn't hang forever.
   */
  close(): Promise<void>;
  /**
   * The address Node actually bound to, as reported by `server.address()`.
   * Exists so callers (tests, primarily) can independently verify the
   * "never `0.0.0.0`" invariant beyond trusting this module's own
   * self-check below — not part of the plan's minimal interface, but a
   * strictly additive field (extra properties on an object are always
   * assignable to a narrower type), so it doesn't change how any other
   * consumer of {@link startLoopbackRedirectListener} type-checks.
   */
  readonly boundAddress: string;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; text-align: center;">` +
  `<h1>${title}</h1><p>${body}</p></body></html>`;

const SUCCESS_PAGE = page(
  "Login complete",
  "You may close this window and return to the application.",
);
const FAILURE_PAGE = (reason: string): string =>
  page("Login failed", `${reason} You may close this window and retry from the application.`);

/**
 * Starts a one-shot, loopback-only HTTP server to receive an OAuth
 * authorization redirect. Resolves once the server is listening (so
 * {@link LoopbackListener.redirectUrl} is known and can be used to build the
 * authorization request) — it does NOT wait for a callback to arrive.
 */
export function startLoopbackRedirectListener(
  opts: LoopbackListenerOptions,
): Promise<LoopbackListener> {
  return new Promise<LoopbackListener>((resolveListener, rejectListener) => {
    let settled = false;
    let closed = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    // Node/Bun flag a promise as an "unhandled rejection" if nothing has
    // attached a handler by the time it settles. A real caller normally
    // does (via `waitForAuthorizationCode()`), but not necessarily
    // synchronously relative to this rejection — e.g. a test that
    // constructs the listener and only awaits `.code` afterward. This
    // no-op catch is a second, independent handler purely to suppress that
    // warning; it does not swallow the rejection for any other consumer,
    // since every `.then`/`.catch` attached to a promise runs independently.
    codePromise.catch(() => {
      /* see comment above */
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const server: Server = createServer((req, res) => {
      if (settled) {
        // Single-use: the server is closed synchronously with settlement
        // below, so in practice a request never reaches this branch — a
        // second connection attempt gets ECONNREFUSED instead. Kept as a
        // defensive fallback for any request already in-flight the instant
        // settlement happens.
        res.writeHead(409, { "Content-Type": "text/html" }).end(FAILURE_PAGE("This login link has already been used."));
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400).end("Bad Request");
        return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { "Content-Type": "text/html" }).end(FAILURE_PAGE("Unknown callback path."));
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { Allow: "GET", "Content-Type": "text/html" }).end(FAILURE_PAGE("Unsupported method."));
        return;
      }

      const state = url.searchParams.get("state");
      const iss = url.searchParams.get("iss");
      const code = url.searchParams.get("code");
      const errorParam = url.searchParams.get("error");

      // `state` mismatch/absence: reject this request, keep listening. Do
      // not distinguish "attacker" from "benign retry" — same shape either way.
      if (state === null || state !== opts.expectedState) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          FAILURE_PAGE("Missing or invalid state parameter."),
        );
        return;
      }

      // RFC 9207 `iss` validation — same reject-and-keep-waiting shape as `state`.
      if (opts.issParameterRequired && iss === null) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          FAILURE_PAGE("Missing iss parameter."),
        );
        return;
      }
      if (iss !== null && iss !== opts.expectedIssuer) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          FAILURE_PAGE("Issuer mismatch."),
        );
        return;
      }
      // `issParameterRequired === false && iss === null` falls through —
      // back-compat with authorization servers not yet on RFC 9207.

      if (errorParam !== null || code === null) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(
          FAILURE_PAGE("Authorization was not completed."),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" }).end(SUCCESS_PAGE);
      settled = true;
      resolveCode(code);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      closed = true;
      server.close();
    });

    server.on("error", (err: Error) => {
      if (!settled) rejectListener(err);
    });

    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        server.close();
        rejectListener(new Error("loopback redirect listener: could not determine the bound address"));
        return;
      }
      // Security-critical invariant: this listener must never be reachable
      // from anything other than the local loopback interface. We already
      // requested "127.0.0.1" explicitly above; this is a fail-loud
      // self-check in case a platform/Node quirk ever handed back something
      // broader (e.g. an IPv6 wildcard).
      if (addr.address !== "127.0.0.1") {
        server.close();
        rejectListener(
          new Error(`loopback redirect listener bound to unexpected address "${addr.address}" (expected 127.0.0.1)`),
        );
        return;
      }

      timeoutHandle = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectCode(new Error(`OAuth login timed out after ${opts.timeoutMs}ms waiting for the browser redirect`));
        closed = true;
        server.close();
      }, opts.timeoutMs);

      resolveListener({
        redirectUrl: new URL(`http://127.0.0.1:${addr.port}${opts.path}`),
        code: codePromise,
        boundAddress: addr.address,
        close: (): Promise<void> =>
          new Promise<void>((resolveClose) => {
            if (!settled) {
              settled = true;
              if (timeoutHandle) clearTimeout(timeoutHandle);
              rejectCode(new Error("loopback redirect listener closed before a callback arrived"));
            }
            // Idempotent: `close()` may run after the server already closed
            // itself (success/timeout above) — Node's `Server.close()`
            // errors if called on a server that was never listening, but is
            // safe to call again on one that's already closed; the `closed`
            // guard exists for clarity and to avoid a redundant callback
            // registration, not to work around an actual double-close bug.
            if (closed) {
              resolveClose();
              return;
            }
            closed = true;
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
