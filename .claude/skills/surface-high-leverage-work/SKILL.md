---
name: surface-high-leverage-work
description: Use when picking what to work on next — finding and ranking the bug fixes or new capabilities that would most impact users, before a sprint or backlog session. Triggers — "what should I work on next", "find high-leverage work", "prioritize the backlog", "update recommended enhancements", "/surface-high-leverage-work".
user-invocable: true
---

# Surface High-Leverage Work

**Purpose:** find the highest-impact work in this repo — grounded in real code, not stale docs — and hand the user a prioritized, sprint-sized execution queue. Feeds `execute-backlog`; does not execute.

**Loop:** DISCOVER → SCAN → GROUND → SCORE → DEDUPE → FILE → BATCH → PRESENT

**Don't use for:** executing a known bundle (`execute-backlog`), architecture/doc drift only (`architecture-audit`), a single known bug (`kernel-debug`).

## 0. DISCOVER — find what nobody's logged yet

SCAN below only re-reads trackers — it is blind to anything real that nobody has written down. This step runs fresh checks against the actual code so the queue isn't just a re-ranking of already-known items.

**Chain existing scan skills instead of hand-rolling this** — they already own code-level discovery; this skill owns triage/scoring/canonical tracking on top:
- Run `codebase-health-sweep`'s SCAN phase (build/test baseline, `as any`/`@ts-ignore`/TODO density, parallel bug sweep) for correctness/quality gaps.
- Run `architecture-audit`'s Phase 1 snapshot for dead code, layer violations, disabled systems, doc-vs-code drift.
- If neither skill is invocable in this context (e.g. dispatched as a bounded subagent), run their minimum equivalent directly: `bun run build`, `bun test`, and `grep -rn "TODO\|FIXME\|as any\|@ts-ignore"` across `packages/*/src`.

Every finding from this step is a new candidate, same as anything pulled from SCAN — it still goes through GROUND, SCORE, DEDUPE below. Don't skip this step because "the last sweep already covered the tracked backlog" — a clean tracked backlog with a broken build or dead code nobody filed is exactly the blind spot this step exists to close.

## 1. SCAN — read every source, every run

Skipping a source silently produces a queue blind to whatever lives there. Read all of:

| Source | Command/path |
|---|---|
| Open GH issues | `gh issue list --state open --limit 200` |
| Your own project memory | `~/.claude/projects/<project-slug>/memory/MEMORY.md` + linked files it points to |
| Running blockers | `wiki/Issues/Running Issues Log.md` |
| Recent session state | `wiki/Hot.md` |
| Canonical tech debt | `wiki/Architecture/DEBT-REGISTER.md` |
| Failure modes | `wiki/Failure-Modes/00 FM Catalog.md` |
| Prior sweep output | `wiki/Planning/Recommended-Enhancements.md` (created below if absent) |

Memory and wiki entries are claims frozen at write time, not current fact — see next step.

## 2. GROUND — verify every candidate you're about to rank

For each candidate, before scoring it: grep/read the actual file:line it names, or re-run the check it describes. A memory or wiki entry naming a function, flag, or bug is a claim that it existed *when written*; confirm it's still true now.

Record, per candidate, one of:
- **VERIFIED** — read the current code/test, claim holds
- **STALE** — code/behavior has moved on; drop it or file a "doc is wrong" note instead
- **UNVERIFIED (sampled out)** — didn't get to it this pass; say so explicitly in the output, never present it silently as verified

Time-box grounding, but never skip the record-keeping. Presenting an unverified item as verified is worse than leaving it out.

## 3. SCORE — same rubric, every candidate, written down

Rate each VERIFIED candidate 1–3 on each axis, multiply:

| Axis | 1 | 2 | 3 |
|---|---|---|---|
| Blast radius | one narrow path | one capability class | blocks a whole surface (all providers, all users of a feature) |
| Frequency | rare/edge case | common non-default path | routine/default path |
| Fix cost (inverse) | large/uncertain | moderate, isolated | small, isolated |

Score = product (max 27). Show the score per item in the final output — an invented "blast radius × frequency × cost" judgment call with no visible numbers can't be checked or repeated next sweep.

## 4. DEDUPE — three checks, not one

1. `gh issue list --state all --search "<keywords>"` — already filed?
2. Already listed in `wiki/Planning/Recommended-Enhancements.md`?
3. Does the wiki record an explicit prior decision to defer/not-build this? If yes, do **not** silently file it — that decision belongs to whoever made it. Note it in the output as "needs an explicit go/no-go" instead.

## 5. FILE — new GH issues only for what survives 2–4

- `gh label list` first; reuse this repo's existing label taxonomy, never invent new labels.
- Issue body cites the file:line evidence from GROUND, not just the wiki/memory claim.

## 6. BATCH — sprint-sized, not one flat list

Group VERIFIED, deduped, scored items into sprints:
- Sort by score descending.
- Cap each sprint at 3–5 items (small enough to actually ship, not a wishlist).
- A sprint mixes bug fixes and capabilities by score — don't segregate by type.

## 7. PRESENT — update the one canonical file, append don't rewrite

Canonical location: **`wiki/Planning/Recommended-Enhancements.md`**. If it doesn't exist, create it. Each sweep appends a new dated `## YYYY-MM-DD` section — never overwrites prior sweeps.

Each section contains:
- Sources actually read this pass, and what fraction of each was sampled vs exhaustive
- The scored, grounded candidate table (item, score, VERIFIED/STALE/UNVERIFIED, GH link)
- Items flagged "needs go/no-go" from step 4.3
- The sprint batches

Then present the same sprint batches to the user directly in your reply — the wiki file is the record, not a substitute for telling them what to do next.

## Common mistakes

- Scanning GH issues only and skipping memory/wiki — half the signal lives outside GH.
- Trusting a wiki/memory claim without re-checking the code it names.
- Inventing a new "Enhancements" file each sweep instead of appending to the canonical one — fragments the record.
- Filing a GH issue for something the wiki already records as a deliberate "don't build" call.
- Presenting one flat priority list instead of capped, shippable sprint batches.
- Only re-ranking already-tracked items (GH/wiki/memory) and calling it done — skipping DISCOVER means real, un-logged bugs/gaps never enter the queue.
