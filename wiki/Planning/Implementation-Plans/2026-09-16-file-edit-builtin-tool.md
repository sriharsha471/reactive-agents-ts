# `file-edit` Builtin Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `file-edit` builtin tool that replaces a text region inside an existing file, so agents stop re-emitting entire file contents to change one line.

**Architecture:** Search/replace-block format (Aider-style `oldText` → `newText`), no new dependency. The tool lives in `packages/tools/src/skills/file-operations.ts` alongside its siblings so it can reuse the module-private `HARNESS_ECHO_PATTERNS` guard and the exported `confinePath()` sandbox without duplicating either. Registration follows the existing `builtinTools` array; a second wave of edits teaches the ~8 downstream name-lists that hardcode `"file-write"` about the new tool.

**Tech Stack:** TypeScript (strict), Effect-TS, `bun:test`, `node:fs/promises`.

**Spec:** No separate spec — scoping doc is `wiki/Planning/Implementation-Plans/2026-09-16-capability-expansion-scoping.md` (Track A).

## Global Constraints

- Strict TypeScript. No `any` casts, no new `as unknown as` (a repo gate counts these: ceiling 78, currently 79 — do not add).
- No new runtime dependencies. The search/replace format was chosen specifically to avoid a diff library.
- `file-edit` MUST declare `requiresApproval: true` and `riskLevel: "high"`, matching `file-write`. Rationale: anything weaker is an approval-gate bypass — an agent blocked from `file-write` could otherwise mutate the same file through `file-edit`. This is a security property, not a style choice.
- Every new tool name added to a list must be added as the literal `"file-edit"`; do not introduce alias spellings (`edit-file`, `fs-edit`) — the repo already suffers from inconsistent alias coverage (see Task 3).
- Tests go in `packages/tools/tests/` (65 files), NOT `packages/tools/test/` (2 orphan files). The split is real; do not add to the minority directory.
- Test files carry a `// Run: bun test <path>` header comment, per existing convention.

---

### Task 1: The tool — definition, handler, and the extracted echo guard

**Files:**
- Modify: `packages/tools/src/skills/file-operations.ts`
- Test: `packages/tools/tests/file-edit.test.ts` (create)

**Interfaces:**
- Consumes: `confinePath(filePath): Promise<string>` (file-operations.ts:81), `toToolError(toolName, label)` (`../errors.js`), `ToolDefinition` (`../types.js`).
- Produces: `fileEditTool: ToolDefinition`, `fileEditHandler: (args) => Effect.Effect<unknown, ToolExecutionError>`, and a newly exported `harnessEchoRejection(content: string): string | undefined`. Task 2 imports the first two; nothing else consumes the third yet.

- [ ] **Step 1: Extract the harness-echo check into its own exported function**

`writeContentRejection` (file-operations.ts:379) currently inlines the echo loop and then does a JSON-validity check. The echo half applies to an edit's replacement text; the JSON half does not (an edit fragment is partial by definition and can never parse). Extract the echo half so both callers share one implementation rather than copy-pasting the loop.

Add immediately above `writeContentRejection`:

```ts
/**
 * Refuse content that is a harness message echoed back, not real content.
 * Shared by file-write (whole-file) and file-edit (replacement text) — an
 * echoed error string is the same corruption in either position.
 */
export function harnessEchoRejection(content: string): string | undefined {
  const trimmed = content.trim();
  for (const { re, what } of HARNESS_ECHO_PATTERNS) {
    if (re.test(trimmed)) {
      return (
        `Refusing to write ${what}, not content: ${JSON.stringify(trimmed.slice(0, 80))}. ` +
        `Pass the actual text you want saved. If you meant to save a stored result, ` +
        `recall() it first and pass the returned text.`
      );
    }
  }
  return undefined;
}
```

Then replace the loop inside `writeContentRejection` with a delegation, leaving the JSON block untouched:

```ts
export function writeContentRejection(
  filePath: string,
  content: string,
): string | undefined {
  const echo = harnessEchoRejection(content);
  if (echo !== undefined) return echo;

  const trimmed = content.trim();
  if (JSON_EXT.has(path.extname(filePath).toLowerCase())) {
    try {
      JSON.parse(trimmed);
    } catch (e) {
      return (
        `Refusing to write ${path.basename(filePath)}: the content is not valid JSON ` +
        `(${e instanceof Error ? e.message : String(e)}). ` +
        `Write the JSON value itself — no prose, no explanation, no code fence.`
      );
    }
  }
  return undefined;
}
```

- [ ] **Step 2: Run the existing write-boundary tests to confirm the extraction changed nothing**

Run: `bun test packages/tools/tests/write-boundary-corruption.test.ts`
Expected: PASS, same count as before the edit. This is a pure refactor — if it goes red, the extraction is wrong.

- [ ] **Step 3: Write the failing tests for file-edit**

Create `packages/tools/tests/file-edit.test.ts`. Pattern B (`mkdtemp` + `withFileRoot`) from `write-boundary-corruption.test.ts` is the model — it re-roots confinement so the temp dir does not need to live under cwd.

```ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `bun test packages/tools/tests/file-edit.test.ts`
Expected: FAIL — `fileEditHandler`/`fileEditTool` are not exported from `file-operations.ts`.

- [ ] **Step 5: Implement the tool definition**

Add to `file-operations.ts`, after `fileWriteTool`. Parameter descriptions are deliberately long and prescriptive — the sibling tools show this is the house style, and it measurably reduces small-model parameter-naming errors (see the `file-write` description's "do NOT use 'file', 'filename'" note and issue #201 in the module header).

```ts
export const fileEditTool: ToolDefinition = {
  name: "file-edit",
  description:
    "Replace an exact block of text inside an existing file, leaving the rest untouched. " +
    "Use this instead of file-write whenever the file already exists and you are changing part of it — " +
    "file-write overwrites the WHOLE file and will destroy content you did not re-send. " +
    "Returns { edited: true, path: '...', replacements: n } on success. " +
    "The edit is refused (and the file left untouched) if 'oldText' is missing from the file, " +
    "or appears more than once without 'replaceAll'.",
  parameters: [
    {
      name: "path",
      type: "string",
      description:
        "REQUIRED. Path of the existing file to edit, RELATIVE to the working root. " +
        "Examples: './src/main.ts', './notes.md'. " +
        "Never invent absolute paths — they resolve outside the working root and the call is refused.",
      required: true,
    },
    {
      name: "oldText",
      type: "string",
      description:
        "REQUIRED. The exact text to find, copied verbatim from the file including indentation and newlines. " +
        "It must match ONE place in the file. If it appears more than once, add surrounding lines " +
        "until the block is unique, or set replaceAll to change every occurrence.",
      required: true,
    },
    {
      name: "newText",
      type: "string",
      description:
        "REQUIRED. The text that replaces oldText. Pass an empty string to delete the block.",
      required: true,
    },
    {
      name: "replaceAll",
      type: "boolean",
      description:
        "Replace every occurrence of oldText instead of requiring a unique match. Default: false.",
      required: false,
      default: false,
    },
  ],
  returnType:
    "{ edited: true, path: string, replacements: number } — confirms the file was modified in place",
  category: "file",
  riskLevel: "high",
  timeoutMs: 5_000,
  // Same posture as file-write deliberately: a weaker gate here would let an
  // agent mutate an approval-gated file by editing it instead of writing it.
  requiresApproval: true,
  source: "builtin",
  produces: "file",
};
```

- [ ] **Step 6: Implement the handler**

```ts
/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export const fileEditHandler = (
  args: Record<string, unknown>,
): Effect.Effect<unknown, ToolExecutionError> =>
  Effect.tryPromise({
    try: async () => {
      const filePath = args.path as string;
      const oldText = args.oldText as string;
      const newText = args.newText as string;
      const replaceAll = args.replaceAll === true;

      if (typeof oldText !== "string" || oldText.length === 0) {
        throw new Error(
          "'oldText' must be the exact, non-empty text to replace. " +
            "To create a new file or replace its entire contents, use file-write instead.",
        );
      }

      // An echoed harness message is not content in this position either.
      const rejection = harnessEchoRejection(newText);
      if (rejection !== undefined) throw new Error(rejection);

      const resolved = await confinePath(filePath);
      const original = await fs.readFile(resolved, "utf-8");

      const count = countOccurrences(original, oldText);
      if (count === 0) {
        throw new Error(
          `'oldText' was not found in ${path.basename(resolved)}, so nothing was changed. ` +
            `Read the file first and copy the block verbatim — whitespace and indentation must match exactly.`,
        );
      }
      if (count > 1 && !replaceAll) {
        throw new Error(
          `'oldText' matches ${count} times in ${path.basename(resolved)}, so the edit is ambiguous ` +
            `and nothing was changed. Add surrounding lines until the block is unique, ` +
            `or set replaceAll: true to change all ${count} occurrences.`,
        );
      }

      const updated = replaceAll
        ? original.split(oldText).join(newText)
        : original.replace(oldText, newText);

      await fs.writeFile(resolved, updated, { encoding: "utf-8" });
      return { edited: true, path: resolved, replacements: replaceAll ? count : 1 };
    },
    catch: toToolError("file-edit", "File edit"),
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test packages/tools/tests/file-edit.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Run the whole tools package to catch collateral damage**

Run: `bun test packages/tools`
Expected: PASS except any count-based assertion — `tool-service.test.ts` is expected to stay green at this point because the tool is not registered yet (Task 2). If anything else is red, fix it before committing.

- [ ] **Step 9: Commit**

```bash
git add packages/tools/src/skills/file-operations.ts packages/tools/tests/file-edit.test.ts
git commit -m "feat(tools): add file-edit builtin for in-place region replacement"
```

---

### Task 2: Register the builtin and de-hardcode the builtin count

**Files:**
- Modify: `packages/tools/src/skills/builtin.ts` (import ~L9-11, `builtinTools` array ~L150-165, `BUILTIN_TOOLSET_ALIASES.file` ~L200)
- Modify: `packages/tools/src/index.ts` (re-export block ~L115-123)
- Modify: `packages/tools/tests/tool-service.test.ts:253-255`

**Interfaces:**
- Consumes: `fileEditTool`, `fileEditHandler` from Task 1.
- Produces: `"file-edit"` present in `BUILTIN_TOOL_NAMES` (derived, no manual edit) and in the `file` toolset alias, so `.withTools({ builtins: ["file"] })` surfaces it.

- [ ] **Step 1: Register the tool**

In `builtin.ts`, add to the existing import from `./file-operations.js`:

```ts
  fileEditTool,
  fileEditHandler,
```

and add one entry to the `builtinTools` array, directly after the `fileWriteTool` row so the file group stays contiguous:

```ts
  { definition: fileEditTool, handler: fileEditHandler },
```

`BUILTIN_TOOL_NAMES` (builtin.ts:183) is derived from this array — no second edit.

- [ ] **Step 2: Add it to the `file` toolset alias**

`builtin.ts:200`, change:

```ts
  file: ["file-read", "file-write", "list-directory", "grep"],
```

to:

```ts
  file: ["file-read", "file-write", "file-edit", "list-directory", "grep"],
```

Without this, `.withTools({ builtins: ["file"] })` registers the tool but never shows it to the model. `resolveBuiltinNames()` (builtin.ts:217) is shared by both the runtime and build-time schema paths, so this one change propagates to both.

- [ ] **Step 3: Re-export from the package index**

`packages/tools/src/index.ts`, alongside the existing `fileWriteTool` / `fileWriteHandler` exports (~L115-123), add `fileEditTool`, `fileEditHandler`, and `harnessEchoRejection`.

- [ ] **Step 4: Fix the hardcoded builtin count so it stops being a merge trap**

`packages/tools/tests/tool-service.test.ts:253-255` currently reads:

```ts
      const all = yield* tools.listTools();
      // 11 capability built-ins (web-search, crypto-price, http-get, file-read,
      // list-directory, file-write, grep, code-execute, git-cli, gh-cli, gws-cli) + 2 registered = 13
      expect(all).toHaveLength(13);
```

The hand-maintained list of names goes stale on every builtin added. Derive it instead:

```ts
      const all = yield* tools.listTools();
      // Every capability builtin, plus the 2 registered by this test.
      expect(all).toHaveLength(builtinTools.length + 2);
```

Add `import { builtinTools } from "../src/skills/builtin.js";` to the test's imports.

- [ ] **Step 5: Run the affected tests**

Run: `bun test packages/tools`
Expected: PASS. `builtin-tools.test.ts` uses `toContain` and is unaffected; `tool-service.test.ts` now self-maintains.

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/skills/builtin.ts packages/tools/src/index.ts packages/tools/tests/tool-service.test.ts
git commit -m "feat(tools): register file-edit builtin; derive builtin count in test"
```

---

### Task 3: Teach the downstream name-lists about file-edit

**Context for the implementer:** roughly eight places in the repo hardcode `"file-write"` to mean "a tool that mutates a file." A new file-mutating tool is invisible to all of them until listed. This task is mostly one-line additions, but two of them are real pre-existing defects worth fixing while here (Steps 5 and 6) — both were found during research for this plan, both are independently verifiable, neither is speculative.

**Files:**
- Modify: `packages/tools/src/caching/tool-result-cache.ts:41`
- Modify: `packages/reasoning/src/kernel/capabilities/verify/post-conditions.ts:171`
- Modify: `packages/reasoning/src/kernel/capabilities/act/act.ts:74` and `packages/reasoning/src/strategies/plan-execute/step-executor.ts:165`
- Modify: `packages/reasoning/src/kernel/capabilities/act/tool-execution.ts:174` and `:356`
- Modify: `packages/reasoning/src/types/observation.ts` (~L7, L98, L113)
- Modify: `packages/observability/src/telemetry/telemetry-schema.ts:150-159`

- [ ] **Step 1: Make file-edit uncacheable**

`tool-result-cache.ts:41`, `DEFAULT_UNCACHEABLE` — add `"file-edit"`. A side-effecting tool whose result is served from cache silently skips the write.

While here: the same set covers only `"file-write"` where two other sites (`post-conditions.ts:171`, `artifact-contract.ts:199-203`) cover four alias spellings (`file-write`/`write-file`/`fs-write`/`writefile`). That inconsistency means a tool named `write-file` is treated as artifact-producing but IS cacheable. Add the three missing aliases here too, so all three sites agree.

- [ ] **Step 2: Let an edit satisfy an ArtifactProduced post-condition**

`post-conditions.ts:171`, `WRITING_TOOL_NAMES` — add `"file-edit"`. Without this, an agent that correctly edits a file fails its own "did you produce the artifact" verification.

Do NOT change `pickWritingTool()` (`derive-conditions.ts:55`) — its `"file-write"` default is correct for "create a deliverable from nothing."

- [ ] **Step 3: Fix the duplicated FILE_TOOL_NAMES at the boundary, not at both sites**

`act.ts:74` and `step-executor.ts:165` hold byte-identical copies of `FILE_TOOL_NAMES`, the second commented `/** ... (mirrors act.ts). */`. Both feed the HealingPipeline's relative-path resolution. Adding `"file-edit"` to only one produces a path-healing behavior that depends on which strategy is running.

Per the repo's boundary-first rule (a second instance of a defect class means fixing the boundary, not the third site): export the set once from `act.ts` and have `step-executor.ts` import it, rather than editing two copies. Then add `"file-edit"` to the single remaining definition.

If the import direction is illegal under the layer rules (`strategies/` importing from `kernel/capabilities/`), verify before assuming — check what `step-executor.ts` already imports from `act.ts` or its siblings. If it genuinely cannot import, leave both copies, add `"file-edit"` to both, and note the constraint in the task report rather than forcing a bad dependency.

- [ ] **Step 4: Teach the failure and observation paths**

`tool-execution.ts:174` — the ENOENT recovery hint (which suggests running `list-directory`) currently triggers for `file-read`/`file-write`. An edit against a missing file is the same failure; add `"file-edit"`.

`tool-execution.ts:356` — `normalizeObservation` turns `file-write` + `written: true` into `"✓ Written to X"`. Add the parallel case: `file-edit` + `edited: true` → `"✓ Edited X (n replacements)"`. Without this the model sees a raw JSON blob instead of a clean confirmation.

- [ ] **Step 5: Categorize the observation**

`packages/reasoning/src/types/observation.ts` — `TOOL_CATEGORY_MAP` (~L98) maps tool names to an `ObservationCategory`; `SIDE_EFFECT_CATEGORIES` (~L113) marks which categories mutate state. Map `"file-edit"` to whatever category `"file-write"` uses. Unmapped tools fall through to `"custom"` and lose side-effect classification.

- [ ] **Step 6: Fix two phantom names in the telemetry allowlist (pre-existing defect)**

`packages/observability/src/telemetry/telemetry-schema.ts:150-159`, `SAFE_TOOL_NAMES` lists `"file-list"` and `"http-request"`. Neither tool exists — the real names are `list-directory` and `http-get`. Net effect today: two real builtins are stripped from telemetry as unsafe/unknown, while two names that can never appear are allowed.

Fix both names, and add `"file-edit"`.

Verify the claim before editing (do not take this plan's word for it):

```bash
grep -rn '"file-list"\|"http-request"' packages/ --include=*.ts | grep -v test
grep -rn 'name: "list-directory"\|name: "http-get"' packages/tools/src
```

- [ ] **Step 7: Run the affected packages**

Run: `bun test packages/tools packages/reasoning packages/observability`
Expected: PASS. If a snapshot or count assertion in `reasoning` trips on the new observation category, update it deliberately — confirm the new value is correct rather than re-baselining blindly.

- [ ] **Step 8: Commit**

```bash
git add packages/tools/src/caching/tool-result-cache.ts packages/reasoning/src packages/observability/src/telemetry/telemetry-schema.ts
git commit -m "fix(tools,reasoning,observability): wire file-edit through downstream tool-name lists"
```

---

### Task 4: Changeset and user-facing docs

**Files:**
- Create: `.changeset/file-edit-builtin.md`
- Modify: whichever `apps/docs/src/content/docs/` page enumerates the builtin tools (find it — `grep -rln "file-write" apps/docs/src/content/docs/`)
- Modify: `README.md` only if it enumerates builtin tools

- [ ] **Step 1: Write the changeset**

```markdown
---
"@reactive-agents/tools": minor
"@reactive-agents/reasoning": patch
"@reactive-agents/observability": patch
---

Add a `file-edit` builtin tool that replaces an exact block of text inside an
existing file, instead of overwriting the whole file like `file-write`. Agents
editing a large file no longer need to re-emit its entire contents, which cuts
token cost and removes a class of accidental-truncation bugs.

`file-edit` refuses ambiguous edits: if `oldText` is missing from the file, or
appears more than once without `replaceAll: true`, the call fails and the file
is left untouched. It declares the same `requiresApproval: true` /
`riskLevel: "high"` posture as `file-write`, so it cannot be used to bypass an
approval gate.
```

- [ ] **Step 2: Document the tool where the other builtins are documented**

Find the page with the grep above and add `file-edit` to the builtin tool table/list, matching the surrounding format. Include the "use this instead of file-write for existing files" guidance — that is the whole point of the tool and the docs are where a user learns it.

- [ ] **Step 3: Verify the docs gates**

Run: `bun run docs:examples:check` and `bun run check-docs-sync` (or the equivalent named in `AGENTS.md`)
Expected: clean. The repo has a mechanical code↔doc drift detector; a new builtin that is undocumented may trip it.

- [ ] **Step 4: Commit**

```bash
git add .changeset/file-edit-builtin.md apps/docs README.md
git commit -m "docs(tools): document the file-edit builtin"
```

---

## Deferred — found during research, not in scope here

These are real, verified, and deliberately NOT bundled into this plan. Each is
independent of `file-edit` and would dilute its review surface.

1. **`produces` migration is incomplete and its doc overstates it.** `types.ts:222-226`
   claims `produces` "REPLACES the old 4-name `WRITING_TOOL_NAMES` / 15-key path
   guess", but `WRITING_TOOL_NAMES` is still live at `post-conditions.ts:171` and
   `artifact-contract.ts` still leads with a name switch. Either finish the
   migration or correct the doc — right now the comment misleads.
2. **`packages/tools` test-directory split.** 65 test files in `tests/`, 2 orphans
   in `test/` (`file-read-errors.test.ts`, `list-directory.test.ts`) — both
   file-operations tests, i.e. exactly where a new contributor would look. Move
   the two and delete the directory.
3. **`listDirectoryHandler`'s error omits the working root** (`file-operations.ts:247-252`),
   while `fileReadHandler`'s deliberately includes it (`:181`, with a comment
   explaining why). `list-directory` is the tool the ENOENT hint points models at,
   so it is the single place the root matters most.
