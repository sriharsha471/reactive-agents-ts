// Wave 4 — red-on-cut mutation test for scripts/check-orphans.sh.
//
// Proves the declaration-orphan guard is not theater: pointed at a fixture tree
// where a declared ledger kind has NO writer, it must FAIL and name the orphan;
// add the writer and it must PASS. The guard takes [SEARCH_DIR] [LEDGER_FILE]
// args precisely so this test can drive its real logic against a throwaway tree
// instead of mutating the repo. It also asserts the guard is green on the real
// source (the CI invariant).

import { describe, it, expect, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../../../../scripts/check-orphans.sh", import.meta.url).pathname;

function runGuard(searchDir: string, ledgerFile: string, script: string = SCRIPT): { code: number; out: string } {
  try {
    const out = execFileSync("bash", [script, searchDir, ledgerFile], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: err.status ?? 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

/**
 * The real `ORPHAN_BASELINE` is empty (2026-09-15: `handoff`, its sole prior
 * entry, gained a writer — Task 5, wire-or-delete-hardening-wave). The
 * ratchet-tolerance behavior it implements is still live code, so these two
 * tests drive it against a scratch COPY of the script with a fixture-only
 * baseline entry, rather than depending on production ever having one.
 */
function scriptWithBaseline(baselineKinds: readonly string[]): string {
  const original = readFileSync(SCRIPT, "utf8");
  const patched = original.replace(
    /ORPHAN_BASELINE=\([^)]*\)/,
    `ORPHAN_BASELINE=(${baselineKinds.map((k) => `"${k}"`).join(" ")})`,
  );
  const dir = mkdtempSync(join(tmpdir(), "orphan-script-"));
  dirs.push(dir);
  const path = join(dir, "check-orphans.sh");
  writeFileSync(path, patched);
  return path;
}

const ledgerWith = (kinds: readonly string[]) =>
  kinds
    .map(
      (k, i) =>
        `export interface Entry${i} {\n  readonly seq: number;\n  readonly kind: "${k}";\n}\n`,
    )
    .join("\n");

const writerFor = (kinds: readonly string[]) =>
  `export const mint = () => [\n` +
  kinds.map((k) => `  { kind: "${k}", iteration: 0 },`).join("\n") +
  `\n];\n`;

const dirs: string[] = [];
function fixture(ledgerKinds: readonly string[], writtenKinds: readonly string[]): { dir: string; ledger: string } {
  const dir = mkdtempSync(join(tmpdir(), "orphan-guard-"));
  dirs.push(dir);
  const ledger = join(dir, "run-ledger.ts");
  writeFileSync(ledger, ledgerWith(ledgerKinds));
  writeFileSync(join(dir, "writer.ts"), writerFor(writtenKinds));
  return { dir, ledger };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("check-orphans.sh — declaration-orphan guard", () => {
  it("is GREEN on the real repository tree", () => {
    // No args → defaults to packages/reasoning/src + the real run-ledger.ts.
    // execFileSync throws on non-zero exit, so reaching the assertion == exit 0.
    const real = execFileSync("bash", [SCRIPT], { encoding: "utf8" });
    expect(real).toContain("every declared ledger kind has a writer");
  });

  it("FAILS (red-on-cut) when a declared kind has no writer, naming the orphan", () => {
    const { dir, ledger } = fixture(["alpha", "beta"], ["alpha"]); // beta unwritten
    const { code, out } = runGuard(dir, ledger);
    expect(code).toBe(1);
    expect(out).toContain("beta");
    expect(out).not.toContain(" alpha"); // alpha has a writer, must not be flagged
  });

  it("PASSES once the missing writer is added", () => {
    const { dir, ledger } = fixture(["alpha", "beta"], ["alpha", "beta"]);
    const { code } = runGuard(dir, ledger);
    expect(code).toBe(0);
  });

  it("TOLERATES a baselined orphan with no writer", () => {
    const script = scriptWithBaseline(["fixture-orphan"]);
    const { dir, ledger } = fixture(["fixture-orphan", "alpha"], ["alpha"]); // fixture-orphan unwritten but baselined
    const { code } = runGuard(dir, ledger, script);
    expect(code).toBe(0);
  });

  it("FAILS when a baselined kind GAINS a writer (ratchet — must be removed from baseline)", () => {
    const script = scriptWithBaseline(["fixture-orphan"]);
    const { dir, ledger } = fixture(["fixture-orphan", "alpha"], ["alpha", "fixture-orphan"]); // now written
    const { code, out } = runGuard(dir, ledger, script);
    expect(code).toBe(1);
    expect(out).toContain("remove from ORPHAN_BASELINE");
  });
});
