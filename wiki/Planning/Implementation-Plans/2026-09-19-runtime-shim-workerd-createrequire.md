# Bundle: runtime-shim-workerd-createrequire
Date: 2026-09-19
Budget: 60 min
Issues: #205

## Acceptance criteria

- #205: importing any of `packages/runtime-shim/src/{fs,hash,database,spawn,serve,glob}.ts` (directly or via the `index.ts` barrel) no longer calls `createRequire(import.meta.url)` at module evaluation time. `createRequire` is only invoked lazily, inside the Node-fallback branch, the first time it's actually needed.

## Root cause

All 6 files declare `const require = createRequire(import.meta.url);` at module top level. On workerd, `import.meta.url` is `undefined`, so `createRequire` throws during module evaluation — before any request handler runs, regardless of whether the Node-fallback path is ever exercised. Because each of the 6 modules has this top-level side effect, esbuild can't tree-shake any of them out of the `index.ts` barrel; importing one name (e.g. `hash`) drags in all 6 evaluations.

## Fix shape (mechanical, single scaffold, 6 sites)

Per skill's "Single-area mechanical-scaffold bundle" heuristic (N ≤ 10 sites, same package, identical scaffold → mechanical edit, not helper extraction):

Replace, in each of the 6 files:
```ts
const require = createRequire(import.meta.url);
```
with a lazily-memoized accessor:
```ts
let _require: NodeJS.Require | undefined;
function nodeRequire(): NodeJS.Require {
  return (_require ??= createRequire(import.meta.url));
}
```
and change each call site from `require("node:x")` to `nodeRequire()("node:x")`.

This defers the `createRequire(import.meta.url)` call to first actual use. On workerd, nothing calls the Node-fallback path (nothing invokes `nodeRequire()`), so the module evaluates cleanly. If something explicitly calls a Node-fallback function while running on workerd, it will still throw at that point — out of scope for #205, which is specifically about the startup crash.

## Execution units

1. **Unit 1 (RED):** add `packages/runtime-shim/tests/lazy-require.test.ts` — mocks `node:module`'s `createRequire` export to throw unconditionally (matching the real workerd failure mode), then dynamically imports each of the 6 modules + the barrel and asserts no throw. Pre-fix, this fails (matches the real bug exactly).
2. **Unit 2 (GREEN):** apply the mechanical edit to all 6 files.
3. **Unit 3 (REVIEW/VERIFY):** `bun test packages/runtime-shim/`, `bunx turbo run typecheck --filter=@reactive-agents/runtime-shim`, re-run the RED test to confirm GREEN, grep-based verified-by.

## Risk register

- Bun's `mock.module` scope/cleanup across the test file → mitigate by scoping the mock to this one test file and confirming other runtime-shim tests (unmocked) still pass in the same `bun test packages/runtime-shim/` run.
- `database.ts` also calls `require("bun:sqlite")` inside its `isBun` branch — included in the same lazy-accessor pattern for consistency, not because it's workerd-affected (Bun never runs on workerd).

## Verification protocol

- `bun test packages/runtime-shim/` — 53 existing + new lazy-require tests, 0 fail
- `bunx turbo run typecheck --filter=@reactive-agents/runtime-shim` — green
- `grep -c "^const require = createRequire" packages/runtime-shim/src/*.ts` → 0 (was 6)
- No real `wrangler dev` smoke test in this environment (no Cloudflare account/binding available to a sandboxed agent) — verification tier is unit + static reasoning, not live workerd. Flagged explicitly in retro.

## Out-of-scope (explicit)

- Actually calling a Node-fallback function while running on workerd (e.g. `hash()` on a request path) is not fixed here — #205 is scoped to the startup crash only, per the issue body's own "Suggested fix" framing.
- No changes to `packages/runtime-shim/src/index.ts` (barrel) — tree-shaking concern is resolved as a side effect of removing the module-scope side effect, no barrel change needed.
