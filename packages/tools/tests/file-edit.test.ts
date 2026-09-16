// Run: bun test packages/tools/tests/file-edit.test.ts
import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileEditHandler, fileEditTool, withFileRoot } from "../src/skills/file-operations.js";

/** Edits are confined to the active file root, so every case runs inside one. */
const edit = (root: string, args: Record<string, unknown>) =>
  withFileRoot(root, () => Effect.runPromise(Effect.either(fileEditHandler(args))));

const seed = async (contents: string) => {
  const dir = await mkdtemp(join(tmpdir(), "ra-edit-"));
  const file = join(dir, "target.txt");
  await writeFile(file, contents, "utf-8");
  return { dir, file };
};

describe("file-edit replaces a region without rewriting the file", () => {
  it("replaces a unique region and leaves the rest byte-identical", async () => {
    const { dir, file } = await seed("alpha\nbeta\ngamma\n");
    const r = await edit(dir, { path: file, oldText: "beta", newText: "BETA" });
    expect(r._tag).toBe("Right");
    expect(await readFile(file, "utf-8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("reports the replacement count on success", async () => {
    const { dir, file } = await seed("x\n");
    const r = await edit(dir, { path: file, oldText: "x", newText: "y" });
    expect(r._tag).toBe("Right");
    const value = (r as { right: { edited: boolean; replacements: number } }).right;
    expect(value.edited).toBe(true);
    expect(value.replacements).toBe(1);
  });

  it("REFUSES an ambiguous match rather than guessing which one to edit", async () => {
    const { dir, file } = await seed("dup\nmiddle\ndup\n");
    const r = await edit(dir, { path: file, oldText: "dup", newText: "X" });
    expect(r._tag).toBe("Left");
    expect(String((r as { left: { message: string } }).left.message)).toContain("2 times");
    // The file must be untouched — a refused edit never partially applies.
    expect(await readFile(file, "utf-8")).toBe("dup\nmiddle\ndup\n");
  });

  it("replaces every occurrence when replaceAll is set", async () => {
    const { dir, file } = await seed("dup\nmiddle\ndup\n");
    const r = await edit(dir, { path: file, oldText: "dup", newText: "X", replaceAll: true });
    expect(r._tag).toBe("Right");
    expect(await readFile(file, "utf-8")).toBe("X\nmiddle\nX\n");
    expect((r as { right: { replacements: number } }).right.replacements).toBe(2);
  });

  it("REFUSES when oldText is absent, naming the file", async () => {
    const { dir, file } = await seed("alpha\n");
    const r = await edit(dir, { path: file, oldText: "nope", newText: "X" });
    expect(r._tag).toBe("Left");
    expect(String((r as { left: { message: string } }).left.message)).toContain("not found");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
  });

  it("REFUSES an empty oldText instead of inserting at position 0", async () => {
    const { dir, file } = await seed("alpha\n");
    const r = await edit(dir, { path: file, oldText: "", newText: "X" });
    expect(r._tag).toBe("Left");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
  });

  it("REFUSES a harness-echoed error string as replacement text", async () => {
    const { dir, file } = await seed("alpha\n");
    const r = await edit(dir, {
      path: file,
      oldText: "alpha",
      newText: "[Tool error: something went wrong]",
    });
    expect(r._tag).toBe("Left");
    expect(await readFile(file, "utf-8")).toBe("alpha\n");
  });

  it("confines edits to the file root — an escaping path is refused", async () => {
    const { dir } = await seed("alpha\n");
    const r = await edit(dir, { path: "../escape.txt", oldText: "a", newText: "b" });
    expect(r._tag).toBe("Left");
    expect(String((r as { left: { message: string } }).left.message)).toContain("outside the");
  });

  it("declares the same approval posture as file-write (gate-bypass guard)", () => {
    expect(fileEditTool.requiresApproval).toBe(true);
    expect(fileEditTool.riskLevel).toBe("high");
  });
});
