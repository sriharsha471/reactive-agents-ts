# Execution Retro: observability-exporters bundle (descoped, no bundle shipped)
Date: 2026-09-19
Budget: 90 min | Actual: ~15 min

## Outcomes
- Issues closed: none
- Issues descoped: #31, #32, #33 (grounding found stale premise — see comments on each issue)
- Net test delta: 0
- Net LOC delta: 0

## What happened
Attempted to bundle #31 (Langfuse exporter), #32 (Braintrust exporter), #33 (OTel
sampling + span nesting) per today's surface-high-leverage-work Sprint 4. All three
issue bodies describe integrating with `OpenInferenceTracerLayer` and a fixed
"5 event pairs" mapping table. Neither exists in the current codebase — tracing
now routes through a generic `Tracer`/`withSpan()` interface backed directly on
`@opentelemetry/api` (`packages/observability/src/tracing/tracer.ts`), and
exporters configure a `BasicTracerProvider` (`packages/observability/src/exporters/`)
rather than doing bespoke per-event mapping. This is a premise drift, not a minor
file:line drift — the actual fix shape today is almost certainly smaller (an OTLP
config preset pointed at Langfuse/Braintrust's OTLP ingestion endpoints) but that's
a design decision, not something to guess at inside a bundled execution pass.

Grounding comments posted on all three issues with the current-architecture findings
and a suggested new fix direction, so the next pass (or a human) can re-scope with
accurate information instead of the stale original description.

## What worked
- The skill's own SCAN grounding discipline caught this before any code was written
  against a design that no longer exists — would have produced an unreviewable PR.

## What didn't
- The existing filter rules only check for *cited-line* drift (grep count vs. claimed
  count), not *named-mechanism* drift (does the class/table the issue describes still
  exist at all). This gap let three issues get bundled before the grounding check
  caught it in PLAN instead of SCAN — wasted a small amount of budget re-reading the
  issues twice.

## Skill improvements (applied)
- Added Phase 1 filter rule 5 (stale-premise check): grep the specific
  class/module/mechanism an issue names as its integration point before bundling;
  if it doesn't exist, drop for re-scoping instead of forcing an implementation.
  Applied directly to `.claude/skills/execute-backlog/SKILL.md` (symlinked from
  `.agents/skills/execute-backlog/SKILL.md`).

## Process inflation guard (HS-18/22/31 lesson)
- No inflation found this pass — the issues weren't inflated, they were just old
  and the codebase moved on. Different failure class from HS-18/22/31 (worth keeping
  distinct: staleness vs. inflation).
