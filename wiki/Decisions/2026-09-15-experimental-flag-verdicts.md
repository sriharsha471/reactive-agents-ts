---
title: Experimental flag verdicts — RA_OVERHAUL, RA_TOOL_INDEX, RA_THOUGHT_CONTINUITY, RA_TOOL_OBSERVE_SYMMETRY, RA_RATIONALE_AUDIT
date: 2026-09-15
status: decided
author: ablation-warden (dispatched, Task 6 of wave/wire-or-delete-2026-09)
---

# Experimental flag verdicts (2026-09-15)

Ablation-warden dispatch, Task 6 of the 2026-09-14 wire-or-delete hardening wave.
Scope: **Steps 1-4 only** (measure + verdict). Steps 5-6 (deletions, framework
edits, commit) are a separate follow-up dispatch — nothing under
`packages/**/src/**` was touched to produce this doc.

## Summary

| Flag | Verdict |
|---|---|
| `RA_OVERHAUL` | **DELETE** |
| `RA_TOOL_INDEX` | **KEEP-OPT-IN** (insufficient measurement power, disclosed) |
| `RA_THOUGHT_CONTINUITY` | **DELETE** |
| `RA_TOOL_OBSERVE_SYMMETRY` | **DELETE** |
| `RA_RATIONALE_AUDIT` | **KEEP-OPT-IN** (non-accuracy/audit purpose, cost bounded) |

None of the five clears PROMOTE. Three are outright DELETE candidates (INERT
on replay + no live lift + no token win, one with a >30% token blowup). Two are
KEEP-OPT-IN for different reasons: `RA_TOOL_INDEX` because this pass could not
build the wide-tool-surface arm the mechanism is designed for (a real gap in
measurement power, not a finding of benefit); `RA_RATIONALE_AUDIT` because it
is explicitly a non-accuracy audit mechanism by design and its cost, while
real, is bounded and it was never a default-on candidate.

## Scope limitation disclosed up front

Every live cell in this pass scored **100% accuracy in every run, both arms,
all 5 flags** (haiku-4-5, n=3 per arm, 1 task per flag). This is a real result,
not an error — the tasks chosen for feasibility inside the session's API/time
budget (`t1-js-typeof`, `m4-remove-duplicates`, `m5-tool-search`,
`c1-distributed-queue`, `c5-multi-tool`) all sit comfortably inside Claude
Haiku 4.5's competence on the `ra-full` variant, so there was no accuracy
signal available in either direction for ANY flag at this n. That ceiling
means **no live cell in this pass could have produced a PROMOTE verdict** —
a PROMOTE requires ≥3pp measured lift, and a 0/0 gap against a 100% ceiling is
not measurable lift, it's an absent signal. This is disclosed rather than
papered over: verdicts below rely on (a) rung-1 replay divergence, (b) the
live billed-token delta (which the ceiling does not mask), and (c) the
project's own default of DELETE for a harness mechanism carrying no proven
benefit. Where the honest state is "not enough power either way," the doc says
so and returns KEEP-OPT-IN per the mission's own fallback rule rather than
forcing a DELETE or PROMOTE it can't support.

A second (local, `gemma4:12b`) tier was not run for any of the 4 flags that
needed one, given session budget — this does not block any verdict here
because none of the 5 flags qualifies for PROMOTE (which is the only verdict
requiring cross-tier confirmation); it is disclosed as a scope limit rather
than silently skipped.

## Rung 1 — zero-token replay sweep

```
cd /home/tylerbuell/Documents/AIProjects/reactive-agents-ts
timeout 580 bun run packages/benchmarks/src/replay-ablate-sweep.ts | tee /tmp/claude-1000/flag-sweep-2026-09-15.txt
```

Full output: `/tmp/claude-1000/flag-sweep-2026-09-15.txt` (not repo-tracked —
scratch path; the relevant lines are reproduced below).

**Toggle-literal verification** (done before trusting the sweep, per the
sweep's own header warning about 3 past false-INERT faults from wrong
literals/polarity): `packages/reasoning/src/harness-flags.ts` was read
directly for all 5 flags:

| Flag | Source comparison | Sweep's on-literal | Match? |
|---|---|---|---|
| `RA_OVERHAUL` | `readFlag("RA_OVERHAUL") === "1"` (line 249) | `"1"` | yes |
| `RA_TOOL_INDEX` | `readFlag("RA_TOOL_INDEX")` truthy path (line 86) | **not present in sweep** | **N/A — flag is absent from both the `BEHAVIOURAL` and `UNTESTABLE` tables in `replay-ablate-sweep.ts`.** This is a gap in the sweep itself, not a false-INERT — the flag was never exercised by rung 1 at all. Flagging this as a finding for the follow-up dispatch: `RA_TOOL_INDEX` should be added to one of the two tables. |
| `RA_THOUGHT_CONTINUITY` | `readFlag("RA_THOUGHT_CONTINUITY") === "1"` (line 158) | `"1"` | yes |
| `RA_TOOL_OBSERVE_SYMMETRY` | `readFlag("RA_TOOL_OBSERVE_SYMMETRY") === "1"` (line 174) | `"1"` | yes |
| `RA_RATIONALE_AUDIT` | `readFlag("RA_RATIONALE_AUDIT") === "1"` (line 191) | `"1"` | yes |

**Result** (baseline: 4/4 goldens match, `planned-tool-loop` excluded as a
pre-existing known argsHash divergence unrelated to any flag, per
`D-2026-07-28-D`):

```
·  RA_THOUGHT_CONTINUITY=1 — no divergence on 4 goldens
·  RA_TOOL_OBSERVE_SYMMETRY=1 — no divergence on 4 goldens
·  RA_RATIONALE_AUDIT=1 — no divergence on 4 goldens
·  RA_OVERHAUL=1 — no divergence on 4 goldens
```

4 of 5 flags report **INERT** on the golden corpus (16/16 behavioural flags in
the sweep were INERT this run — 0 LIVE). `RA_TOOL_INDEX` was not exercised at
all (see table above). Per the sweep's own header and this doc's mandate,
INERT-on-replay is **not** a standalone deletion authorization for a
prompt-affecting mechanism — it only means "no divergence on the recorded
golden shapes," which is why every flag below also has a live cell.

## Rung 2 — live cells (Claude Haiku 4.5, n=3 per arm)

All 5 flags below were run OFF vs ON, same task, same `--variant ra-full`,
`--runs 3`, `--provider anthropic --model claude-haiku-4-5-20251001`, each
command a single foreground `timeout 580` call. Raw JSON for every cell is at
`wiki/Research/Harness-Reports/2026-09-15-flag-<FLAG>-{off,on}-haiku.json`.

Token overhead below uses **billed tokens** (`billedTokens` field in the
report JSON — Anthropic's `input_tokens + output_tokens` for that exchange;
`cacheReadTokens` was `0` on every run here, so billed reduces to raw tokens
for this cell set) — the metric the lift rule specifies, not the
harness-internal `tokensUsed` estimate (also reported, slightly lower, for
cross-reference).

### `RA_OVERHAUL` — task `m4-remove-duplicates`

Tool-surface check: OFF trace (`01M2JM4F949RJ1Z223DMBYNS8B.jsonl`) has zero
mentions of `write_result_to_file`; ON trace (`01M2JMB9H8NBM3AH1XJTPE1HK9.jsonl`)
has 8. This is the mechanism itself (it registers that tool) — not a confound,
it's the manipulation check passing as expected.

| Arm | Runs (pass/fail) | Mean billed tokens |
|---|---|---|
| OFF | pass, pass, pass (3/3) | 3926.0 |
| ON | pass, pass, pass (3/3) | 4398.3 |

Accuracy lift: 0pp (3/3 both arms — ceiling, see disclosure above). Billed
overhead: (4398.3 − 3926.0) / 3926.0 = **+12.0%**.

**Verdict: DELETE.** Rung 1 confirms INERT post the Task-2 prompt-hint fix (no
divergence on the golden corpus). The live cell adds no measurable accuracy
lift (both arms at ceiling) and costs +12.0% billed tokens for a tool that
registers but produces no observed behavioral difference on either the
replay corpus or the live task. Gap is within the ~26pp noise band at n=3 and
there is no token win — DELETE is this plan's own default for that state.

### `RA_TOOL_INDEX` — task `m5-tool-search`

Rung 1: **not tested** (absent from the sweep — see table above, disclosed as
a sweep gap, not an INERT finding).

Tool-surface check: both arms' `discover-tools` calls return the harness's
default builtin roster (`web-search, crypto-price, http-get, file-read,
list-directory, ...`) — same roster, same count, in both arms. This task
exercises the *default* builtin surface (~10 tools), not the wide/MCP-scale
surface (40+) that `RA_TOOL_INDEX` disclosure is designed to matter at
(`packages/benchmarks/src/wide-surface-ablation.ts` exists in-repo for exactly
that future measurement and was not run this pass — budget).

| Arm | Runs (pass/fail) | Mean billed tokens |
|---|---|---|
| OFF | pass, pass, pass (3/3) | 2338.3 |
| ON | pass, pass, pass (3/3) | 2346.3 |

Accuracy lift: 0pp (ceiling). Billed overhead: +0.34% (noise).

**Verdict: KEEP-OPT-IN — insufficient measurement power, not a proven-void
finding.** Rung 1 gives no signal at all (flag untested by the sweep). The
live cell shows no effect in either direction, but it was run against a
narrow (default) tool surface where the mechanism has no obvious lever to
pull — this is not the surface size the mechanism claims to matter at. This
doc does not have the budget to stand up the wide-surface arm this pass, so
per the mission's own fallback rule this is recorded as "insufficient
measurement power to confirm either PROMOTE or DELETE with confidence, and no
cheap way to get more power in this pass" rather than defaulting to DELETE on
a test that could not have detected the effect either way. Follow-up: run
`RA_TOOL_INDEX` through `wide-surface-ablation.ts` before revisiting.

### `RA_THOUGHT_CONTINUITY` — task `c1-distributed-queue`

Prior finding (cited, not re-run): confirmed **void on local tier by
construction** — 2026-07-27, Ollama discards the model's `thinking` field
entirely, so on/off produced byte-identical prompts, n=3, `qwen3:14b`. Local
tier is not re-measured here per the mission brief's explicit instruction not
to re-run a doomed measurement.

Rung 1 (frontier-agnostic replay corpus): INERT — no divergence on 4 goldens.

Live cell is the one required frontier arm (haiku):

| Arm | Runs (pass/fail) | Mean billed tokens |
|---|---|---|
| OFF | pass, pass, pass (3/3) | 5173.0 |
| ON | pass, pass, pass (3/3) | 4840.7 |

Accuracy lift: 0pp (ceiling). Billed tokens actually **decreased** 6.4% on
(noise-level, not a designed saving — the mechanism replays prior reasoning,
it doesn't compress it).

**Verdict: DELETE.** Void by construction on local tier (prior finding, cited
not re-run), INERT on the replay corpus, and the one frontier tier this budget
could measure shows no accuracy lift and no token cost either way. No tier
measured shows any benefit; nothing here argues for keeping a maintained
opt-in surface over deleting it.

### `RA_TOOL_OBSERVE_SYMMETRY` — task `c5-multi-tool`

Rung 1: INERT — no divergence on 4 goldens.

Tool-surface check: same tool roster available to both arms (`recall`,
etc. — both arms hit the identical "Tool `recall` not found" error on this
task, i.e. an identical, task-caused tool-resolution gap present in both
arms equally — not something either arm's tool surface differs on).

| Arm | Runs (pass/fail) | Billed tokens (each run) | Mean billed |
|---|---|---|---|
| OFF | pass, pass, pass (3/3) | 2804, 2958, 15830 | 7197.3 |
| ON | pass, pass, pass (3/3) | 2810, 14673, 16306 | 11263.0 |

Accuracy lift: 0pp (ceiling). Billed overhead: (11263.0 − 7197.3) / 7197.3 =
**+56.5%**.

Note the run-to-run variance itself: both arms are bimodal — one run per
arm resolves single-shot in the `reactive` strategy (~2.8k tokens) while the
other two escalate into `plan-execute` with multiple reflect/refine loops
(~15-16k tokens). That instability is present in the OFF arm too, so it is
not solely attributable to the flag, but n=3 is too thin to separate "flag
effect" from "which strategy this run happened to escalate into" — the
headline +56.5% number should be read as noisy, not precise.

**Verdict: DELETE.** Independent of the exact percentage, the billed-token
overhead is unambiguously over the 30% REWORK/DELETE line under this
project's general lift rule (09 §2), with zero accuracy lift on either arm.
Combined with rung-1 INERT, there is no dimension (accuracy, tokens, or
replay divergence) on which this mechanism shows benefit, and its cost when
it does move is large. DELETE, not OPT-IN — an opt-in mechanism that is
expensive AND has never shown benefit is exactly the "kill it" case, not the
"keep it behind a flag" case.

### `RA_RATIONALE_AUDIT` — task `t1-js-typeof`

This flag is explicitly non-accuracy-purpose (audit, not quality) per its own
JSDoc — the lift rule's accuracy clause does not govern it; this is a
token/latency-cost-only measurement per the mission brief.

Rung 1: INERT — no divergence on 4 goldens (expected: an audit block that
doesn't change the model's tool-call trajectory is exactly the INERT case,
not evidence of a defect).

Tool-surface check: both arms' `discover-tools` calls return "No tools
registered" — `t1-js-typeof` is a toolless task, so tool surface is trivially
identical (empty) in both arms; no confound possible on this task.

| Arm | Runs (pass/fail) | Mean billed tokens |
|---|---|---|
| OFF | pass, pass, pass (3/3) | 1932.0 |
| ON | pass, pass, pass (3/3) | 2476.0 |

Billed overhead: (2476.0 − 1932.0) / 1932.0 = **+28.2%**.

**Verdict: KEEP-OPT-IN.** Accuracy is unaffected either way (as expected,
since this isn't a quality mechanism) and the cost is real (+28.2% billed
tokens for one extra rationale block per call) but bounded to a single,
predictable decode-tax rather than compounding across a loop the way
`RA_TOOL_OBSERVE_SYMMETRY`'s variance does. This matches the mechanism's own
stated purpose (auditability for audit-mode runs, not a default-on quality
lever) — KEEP-OPT-IN as designed, cost documented here for anyone deciding
whether to turn it on for a given audited run.

## Receipts

- Rung-1 sweep output: `/tmp/claude-1000/flag-sweep-2026-09-15.txt`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_OVERHAUL-off-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_OVERHAUL-on-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_TOOL_INDEX-off-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_TOOL_INDEX-on-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_THOUGHT_CONTINUITY-off-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_THOUGHT_CONTINUITY-on-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_TOOL_OBSERVE_SYMMETRY-off-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_TOOL_OBSERVE_SYMMETRY-on-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_RATIONALE_AUDIT-off-haiku.json`
- `wiki/Research/Harness-Reports/2026-09-15-flag-RA_RATIONALE_AUDIT-on-haiku.json`
- Trace files cited by ID under `benchmark-traces/` (repo-root, gitignored —
  not carried forward; re-run to reproduce if needed after this session).

Per this dispatch's authority bounds: no file under `packages/**/src/**` was
edited to produce this doc, nothing was committed, and no framework
config (`harness-flags.ts`, `harness-config.ts`, tool registration) was
touched. Steps 5-6 of the parent plan (executing the DELETE verdicts,
updating the flag JSDoc for the two KEEP-OPT-IN verdicts, gates, and the
commit) are left to the named follow-up dispatch.
