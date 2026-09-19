# Execution Retro: runtime-shim-workerd-createrequire
Date: 2026-09-19
Budget: 60 min | Actual: ~25 min

## Outcomes
- Issues closed: #205
- Issues descoped: none
- Net test delta: +7 / -0 (53 → 60 pass, 0 fail)
- Net LOC delta: +126 / -16 (commit `b905ce76`)

## What worked
- The "single-area mechanical-scaffold bundle" heuristic (N ≤ 10 sites, same package, identical scaffold → mechanical edit, not helper extraction) fit perfectly — 6 files, same 4-line pattern, no shared helper needed.
- `mock.module("node:module", ...)` reproduced the *exact* real-world crash (same error message, same stack shape) without needing an actual workerd sandbox — high-fidelity RED test for a runtime nobody can spin up in this environment.
- `database.ts`'s existing try/catch around the `node:sqlite` path was a template for adding the same guard to the previously-unguarded `bun:sqlite` path — small, in-scope hardening, not scope creep (same fix shape, same file, ≤5 LOC).

## What didn't
- First RED test run failed for the wrong file for the wrong reason: `database.ts` eagerly computes `export const Database = loadDatabase()` at module scope, and under `bun test` (`isBun === true`), that hit the *unguarded* Bun-sqlite branch — a real gap unrelated to the createRequire fix itself, only surfaced because the universal-throw mock made every `nodeRequire()` call fail. Took one extra read-and-diagnose pass to realize the fix was "add the missing try/catch," not "the lazy accessor is broken."
- No live `wrangler dev` verification available in this sandboxed environment — verification tier is unit-test + static reasoning only. A human (or a CI job with Cloudflare credentials) should re-run the original issue's `wrangler dev` repro against this branch before merge to close the loop on the actual reported symptom.

## Skill improvements (apply on next pass)
- `execute-backlog`'s "Single-area mechanical-scaffold bundle" section doesn't mention that a RED test simulating a *third* environment (here: workerd, simulated from a Bun test process) can produce a false-attribution failure when the target code branches on runtime-detection (`isBun`) and only one branch is actually reachable in the real target environment. Add a one-line note: when RED-testing environment-specific code via a mock that doesn't also emulate the runtime-detection flags the code branches on, read the failure's stack trace carefully before assuming the fix under test is wrong — it may be exposing an unrelated pre-existing gap in a branch that's unreachable in the real target environment but reachable in the test's actual environment.

## Process inflation guard (HS-18/22/31 lesson)
- No inflation: the issue's own verified-by (live `wrangler dev` trace) was not independently re-run, and this retro says so plainly rather than claiming full verification. Verified-by for this PR is explicitly downgraded to unit+static tier — noted in both the plan doc and the PR body.
