/**
 * MCP client OAuth — open the user's browser at an authorization URL.
 *
 * Part of Task 4 of `wiki/Planning/Implementation-Plans/2026-09-17-mcp-client-oauth.md`.
 *
 * Security-critical: `url` is the authorization server's advertised
 * `authorization_endpoint`, chosen by whatever MCP server RA is connecting
 * to — a malicious or compromised server fully controls this string before
 * it ever reaches this function. This is the exact shape of CVE-2025-6514
 * (`mcp-remote`): a crafted `authorization_endpoint` handed to a
 * shell-invoking "open a URL" helper achieved remote code execution,
 * primarily via Windows `cmd.exe` reinterpreting shell metacharacters in
 * what the caller believed was an opaque single argument.
 *
 * Two independent mitigations, both required:
 * 1. Scheme allowlist ENFORCED BEFORE `spawn` is ever reached — only
 *    `http:`/`https:` are permitted. `file:`, `javascript:`, `data:`, and
 *    anything else throw synchronously (this function never gets as far as
 *    resolving a platform command for them).
 * 2. `spawn(..., { shell: false })` with the URL as its own, single argv
 *    element — never built into a command string. `shell: false` is
 *    Node's default, but is passed explicitly here so this invariant is
 *    visible at the call site and can't regress silently if Node's default
 *    ever changed.
 *
 * Windows note: the plan's sketch names `cmd /c start ""` as the Windows
 * opener. That command re-enters `cmd.exe`, which — independently of
 * Node's `shell: false` — re-parses its OWN argv for shell metacharacters
 * (`&`, `|`, `%VAR%`, …) because Windows has no true argv at the OS level;
 * `cmd.exe` is itself a shell no matter how it's invoked. Using it here
 * would reintroduce exactly the class of bug this file exists to close.
 * `explorer.exe <url>` is used instead: it hands the URL to the registered
 * protocol handler directly and does not interpret shell syntax in its
 * argument. This is a deliberate deviation from the plan's literal
 * suggestion, made for this reason — see the Task 4 report.
 */
import { spawn } from "node:child_process";

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

function resolveOpener(): { command: string; argsPrefix: readonly string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", argsPrefix: [] };
    case "win32":
      // See the file-level doc comment: deliberately NOT `cmd /c start ""`.
      return { command: "explorer.exe", argsPrefix: [] };
    default:
      return { command: "xdg-open", argsPrefix: [] };
  }
}

/**
 * Opens `url` in the user's default browser. Throws (never spawns anything)
 * if `url`'s scheme is not `http:`/`https:`, or if it contains a raw CR/LF/NUL
 * control character (defense in depth beyond the scheme check — irrelevant
 * to `shell: false` argv passing, but a cheap extra guard against whatever
 * eventually consumes the resulting argv on any given platform).
 */
export async function openBrowser(url: URL): Promise<void> {
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(
      `openBrowser: refusing to open a URL with scheme "${url.protocol}" — only http/https are allowed`,
    );
  }

  const raw = url.toString();
  if (/[\r\n\0]/.test(raw)) {
    throw new Error("openBrowser: refusing to open a URL containing control characters");
  }

  const { command, argsPrefix } = resolveOpener();
  const args = [...argsPrefix, raw];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => resolve());
  });
}
