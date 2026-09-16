---
aliases: [Recent Context]
tags: [meta, session-start]
updated: 2026-09-15
---

# Hot (Recent Context Cache)

**Purpose:** Quick lookup of last session state. Read this first at session start.

---

## 2026-09-15 — wire-or-delete hardening wave (9 tasks, `96f10a22..84d43fcf`)

Doc-truth pass (Task 0) plus 8 code tasks on `wave/wire-or-delete-2026-09`, not
yet merged to `main`/tagged. Shipped: lazy provider env-config reads +
**a real keyless-refusal security fix** (compat LLM clients could silently
borrow another provider's API key when their own env var was unset — now
refused, Task 1, `6c9682d2`); `write_result_to_file` hint gated to only
advertise when the tool is actually registered (Task 2, `31c97ae8`);
`run-completed` trace now carries real cost + termination reason instead of
placeholders (Task 3, `c79e2063`); `runStream()`/`.collect()` outcome now
matches `run()` (Task 4, `be8ce0a8`); strategy-switch handoff minted as a
typed ledger fact, closing the `ORPHAN_BASELINE=("handoff")` gap — **and a
real bug found along the way**: the prior strategy's entire ledger was
silently dropped on every switch, not just the handoff write (Task 5,
`cfc3126b`); 3 experimental flags measured and **deleted** for zero lift —
`RA_OVERHAUL`, `RA_THOUGHT_CONTINUITY`, `RA_TOOL_OBSERVE_SYMMETRY` — with 2
kept opt-in (`RA_TOOL_INDEX`, `RA_RATIONALE_AUDIT` — insufficient
measurement power, not non-viability) (Task 6/6b, `ad04e1b8` +
`fe7fae32` fix-round); opt-in demand-driven `num_ctx` for Ollama, measured
not defaulted (Task 7, `90a13519`); a wither-proof census gate classifying
all 85 public builder withers (48 PROVEN / 32 UNOBSERVABLE-DETERMINISTIC / 5
INFRA) plus 6 new behavioral seam tests for batch 1 (Task 8, `84d43fcf`).
Task 9 (this entry) ran full gates with `.env` moved aside (CI parity):
build 72/72, typecheck clean, full suite 9294 tests / 9264 pass / 25 skip /
4 todo / **1 fail** (the known, disclosed, pre-existing `as-unknown-as`
ceiling gap — 79 sites vs ceiling 78, confirmed via `git stash` in Task 6b
to predate this whole wave), all 21 `check-*.sh` gates green,
`docs:examples:check` clean (372/372), `release:dry 0.16.1` clean (34 pkgs).
One real finding during the full-suite run: the North Star gate
(`packages/testing/tests/gate/north-star-gate.test.ts`) flagged 14 scenario
divergences — `terminatedBy` changed from `"unknown"`/`"missing"` to
`"end_turn"`, a direct and correct consequence of Task 3's fix. Regenerated
the baseline via `bun run gate:update` (the gate's own sanctioned path for
an intentional change) — see the `BASELINE-UPDATE:` trailer on this commit.
Test total grew from the pre-wave baseline (9,250 → 9,294) as expected — the
wave added many new tests, no regressions beyond the one known gap.
Debrief: [[Research/Debriefs/2026-09-15-wire-or-delete-hardening-wave-debrief]]
(filed separately by the controller session).

## 2026-08-16 bundles (condensed)

- **Health sweep** — HS-224 grounding-guard marker leak fixed, 2 robustness fixes; a reported P0 was FALSE on repro. [[Research/Debriefs/2026-08-16-health-sweep-debrief]]
- **code-action-worker-interruption** — closed #35, sandbox Worker now stops on fiber interrupt. [[Research/Debriefs/2026-08-16-code-action-worker-interruption-execution-debrief]]
- **replay-determinism-revalidation** — closed #30 (already-shipped) + #53 (44 tests, 0 fail). [[Research/Debriefs/2026-08-16-replay-determinism-revalidation-execution-debrief]]
- **v0.15.0 release-prep + tools-result-handling** — fixed `t0-deterministic` regression (`c2418864`); shipped `bundle/tools-result-handling` (#47/#57/#58). [[Research/Debriefs/2026-08-16-tools-result-handling-execution-debrief]]

## Active program (2026-07-28)

**A-TIER GAP CLOSURE** — [[Planning/Implementation-Plans/2026-07-28-a-tier-gap-closure]].
Supersedes the simplification program as the WIP=1 item; the simplification
program's motivating figure (555–640% harness overhead) was **retracted** on
2026-07-28 because the instrument was broken (`2f97ca1e`).

**F10 RESOLVED (2026-08-26, `4f7c4bc0`, closed `89bb8a43`):**
[[Failure-Modes/RUNNING-CATALOGUE#F10]] — was the request prefix churning every
iteration so the prompt cache never hit. Root cause: per-iteration harness
guidance appended to the system-prompt string tail still invalidated the
cache (system precedes messages in Anthropic's cache hierarchy); guidance
now rides as a trailing user message instead. Live-Sonnet rebaseline confirms
nonzero `cacheRead` on every disclosure arm. Do not cite the old 41%-tokens/
17%-more-money figure as current.

**Do not cite** any token-overhead figure predating `2f97ca1e`.

**Measurement ladder:** deterministic replay → haiku → fast non-reasoning local
tool-callers. Promotion requires rungs 2 and 3 to agree in sign.

**External gate:** τ-bench (ratified 2026-07-28).

## What's Next

1. **Tag + ship wire-or-delete wave** — `wave/wire-or-delete-2026-09` is gate-clean at `84d43fcf`; merge to `main` and cut the next release (`release:dry 0.16.1` clean).
2. **Wither batches 2-4** — Task 8's census left batches 2-4 as a disclosed backlog (queue produced by Task 8 Step 2); batch 1 (behavioral seams) shipped.
3. **`as-unknown-as` ceiling gap** — 79 actual sites vs ceiling 78, confirmed pre-existing (predates this wave); needs a future session to either remove a cast or deliberately ratchet the ceiling with justification.
4. **τ-bench environment bridge** — still tabled (owner decision, 2026-09-14), not touched by this wave.
5. **#39 per-entity requirements**, **#44 kernel→engine signal unification** — separate lift-gated items, untouched.
6. Bench P2 remainder (7 llm-judge → graded, re-baseline) + P3 `horizon:long` tasks; then #36 adaptive re-cut.

## Prior Sessions (compact pointers)

- **2026-07-05→12** — the harness root-cause fortnight: Arc 1, meta-loop, measurement rebuild, wiring audits ×4, probe fleet, receipt truth. Full map: the 07-12 snapshot above. Process lesson recorded there (§4): ~14% same-week rework, whack-a-mole before class-level prevention.
- **2026-07-02** — v0.13.0 RELEASED (35 pkgs); v0.13.5 + v0.13.6 followed 2026-07-05/06 (Groq+xAI, ui-core).
- **2026-07-01** — comprehensive framework review + v13 lift plan (superseded by 09-UNIFIED-PROGRAM).
- **Earlier** — see `git log -- wiki/Hot.md` and MEMORY-ARCHIVE.

## Authoritative Document Hierarchy

| Order | Doc | Role |
|---|---|---|
| 1 | `wiki/Architecture/Specs/09-UNIFIED-PROGRAM.md` | Program sequencing + convergence rulings (CANONICAL) |
| 2 | `wiki/Architecture/Specs/08-AGENTIC-OS-NORTH-STAR.md` v6.0 | Product-arc content, exit gates, honest-claims law |
| 3 | `wiki/Architecture/Design-Specs/2026-07-11-harness-north-star-architecture.md` | Kernel architecture (RATIFIED 07-11) |
| 4 | `wiki/Planning/Implementation-Plans/2026-07-10-harness-root-cause-closure-program.md` | Ranked open backlog (active) |
| 5 | `wiki/Research/Audit-Reports-2026-07-12/00-STATE-OF-THE-FRAMEWORK.md` | Current empirical state |

`04-PROJECT-STATE.md` is deprecated as the empirical-state read (banner added 07-12). Conflict rule: lower defers upward; changing a higher doc is a ratification event.

## How to Update This Note

At session end: replace "Latest Session" with new date + key updates, demote prior to one-line pointers, update "What's Next." Keep under 120 lines.

**Last Updated:** 2026-09-15
**Current Phase:** wire-or-delete wave gate-clean, awaiting merge/tag

## 2026-08-18 (condensed)
Closed #155 (health/umbrella export surface, 2 real fixes), #61 (v0.11.0 tracker, stale), #188 (AgentStreamEvent — found+fixed a live 3-way divergence bug across react/svelte/vue), #184+#200 (kernel import cycles, `bunx madge --circular src/kernel`: 9→14→2→0 across the session). See `wiki/Research/Debriefs/2026-08-18-*-execution-debrief.md` for the four retros.
