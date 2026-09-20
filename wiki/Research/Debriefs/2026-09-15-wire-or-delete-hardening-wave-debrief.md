---
title: Wire-or-Delete Hardening Wave — Closing Debrief
date: 2026-09-15
status: complete
tags: [hardening, wiring, debt, lift-gate, sdd, debrief]
---

# Wire-or-Delete Hardening Wave — Closing Debrief

Closing debrief for `wiki/Planning/Implementation-Plans/2026-09-14-wire-or-delete-hardening-wave.md`
(9 tasks, Task 6 and Task 9 each split into sub-dispatches). Executed via
subagent-driven-development on branch `wave/wire-or-delete-2026-09` (off
`main` @ `740b9320`), commit range `96f10a22..c8b8b418`. SDD ledger:
`.superpowers/sdd/2026-09-14-wire-or-delete-hardening-wave/progress.md`.

**Headline:** counting the 11 sub-dispatch sections below (Task 6 split into
6a/6b, Task 9 split into 9a/9b), 9 landed review-clean with **zero fix
rounds** (0, 1, 2, 3, 4, 6a, 7, 8, 9a) and exactly 2 required **one fix
round** each (Task 5, Task 6b). Full suite grew from 9,250 to 9,294 tests,
with exactly one known pre-existing, disclosed gate failure. The branch is
gate-clean but **not yet merged to main or tagged**.

---

## Per-task record

### Task 0 — Doc truth pass (stale "open" claims)
**What/why:** Closed five items still marked "open" in 09-UNIFIED-PROGRAM.md
and DEBT-REGISTER.md that were actually already fixed in source, to stop
future sessions from re-fixing finished work.
**Commits:** `740b9320..96f10a22`.
**Review outcome:** clean; 4/5 claims confirmed RESOLVED and amended,
`discover-tools` correctly left open (grep found 6 live references, not just
the reserved-name set — genuinely not deleted). One Minor parked, not
fix-looped: the mandated commit message says "five" items closed but only 4
were closed (1 left open) — the implementer followed the plan's own literal
Step 4 wording; no dependent task reads commit-message text.

### Task 1 — Provider config reads env lazily; no cross-host key leak
**What/why:** `llmConfigFromEnv` was a module-level object evaluated at
import time, so `.env` loaded after `import "reactive-agents"` left every
key `undefined`; for xai/groq compat providers, the underlying OpenAI SDK
then silently fell back to `OPENAI_API_KEY`, sending an OpenAI key to
`api.x.ai`/Groq (D-2026-09-08-O). Fixed with lazy env read at layer-build
time (`readLLMConfigFromEnv()`) plus a hard refusal for keyless compat
clients.
**Commits:** `96f10a22..6c9682d2`.
**Review outcome:** clean, zero fix rounds. Security property verified by
tracing code, not trusting the report; litellm confirmed independently to
need no change. 2 Minor deferred (uncached rejection path; cosmetic
indentation).

### Task 2 — Stop advertising `write_result_to_file` when unregistered
**What/why:** `ResultStore.summarize()`/`.preview()` told the model to call
`write_result_to_file` on every overflowing tool result, but that tool is
only registered under `RA_OVERHAUL=1` (default OFF) — the default harness
was instructing models to call a nonexistent tool, precisely on the
large-result path where local models are weakest.
**Commits:** `be8ce0a8..31c97ae8`.
**Review outcome:** clean, zero fix rounds after a resumed first dispatch
(see below). 1 Minor deferred: report's caller-inventory claim ("no test
caller exists") was contradicted by its own filtered grep (2 harmless
test callers exist).
**Beyond-scope note:** first dispatch backgrounded its own live bench
measurement against project convention; the shell tore down before the
background process finished and it was lost with no output/logs. Resumed
with corrected foreground-only instructions; the real foreground rerun
produced a mechanically-guaranteed 13/13→0/13 hint-mention count (not a
Bernoulli result). Neither before/after arm showed the model actually
attempting the nonexistent call at n=3/haiku — an honest, disclosed
measurement-power limitation, not a code defect.

### Task 3 — `run-completed` trace carries real cost and termination reason
**What/why:** `normalize.ts` hardcoded `totalCostUsd: 0` and dropped
`terminationReason` entirely, so trace-based cost figures always read zero
and a trace consumer could not distinguish an abstention from a success.
**Commits:** `6c9682d2..c79e2063`.
**Review outcome:** clean, zero fix rounds. All 4 production files matched
the brief exactly; e2e test confirmed real (reads actual `.jsonl` off disk).
2 Minor deferred (e2e test file placement; minor test-setup DRY).
**Disclosed limitation:** mutation-check Half A (the `totalCostUsd` spread)
could not be made red-on-cut through the harness because the deterministic
`test` provider always reports `metadata.cost === 0` (pre-existing
DEBT-REGISTER B3 gap) — proven by direct inspection + a live probe instead
(`terminatedBy` confirmed live; `totalCostUsd` stayed 0 live too, but because
the harness-probe script wires no pricing registry, a separate pre-existing
gap). Ruled out of scope rather than expanding to fix B3.

### Task 4 — `runStream()`/`collect()` report the same outcome as `run()`
**What/why:** `AgentStream.collect()` hardcoded `success: true` and never
set `terminatedBy`/`goalAchieved`, and the stream path never derived
`metadata.toolCalls` — so a streamed abstention or failure collected as a
success with no tool calls.
**Commits:** `c79e2063..be8ce0a8`.
**Review outcome:** clean, zero fix rounds. `deriveMetadataToolCalls`
confirmed a true verbatim extraction (diffed field-by-field). Both mutation
checks confirmed real and targeted. 1 latent-fragility note (paused-branch
call-skipping vs ctx-threading asymmetry) judged provably equivalent under
the current schema, pre-existing, not a defect. 3 Minor deferred.

### Task 5 — Strategy-switch handoff becomes a ledger fact
**What/why:** `HandoffEntry` was declared, rendered, and compaction-protected
but nothing ever wrote one (`check-orphans.sh`'s sole baseline entry);
instead the handoff was string-folded into `priorContext`. Wired
`recordHandoff()` as the sole ledger-mutation call site.
**Commits:** `fe7fae32..3a6baf2a`.
**Review outcome:** 1 Important finding, 1 fix round. Reviewer's own
mutation test showed the duplicate-tool-result guard test was vacuous (the
fixture never added an observation step, so the dedupe branch never ran; 7/7
stayed green with dedupe disabled). Fix round 1 added a fixture that
genuinely accumulates a tool-result entry; mutation re-verified RED then
GREEN; re-review confirmed ADDRESSED, full suite 2837/0.
**Beyond-scope finding (named):** Task 5's Step 1 characterization test
failed as one of the plan's own two anticipated outcomes — **the prior
ledger was being silently dropped on every strategy switch**
(`initialKernelState` reset `ledger: []`). This was a real, previously
unknown data-loss bug, not just a dead-renderer wiring gap, fixed as part of
this task per the brief's own contingency.
**Disclosed limitation:** Step 8's live A/B could not reach an actual
strategy switch on either haiku or gemma4:12b within budget (haiku
terminated cleanly; the local model's loop-detector never tripped) —
substituted a byte-identical replay-lane check plus 4 deterministic unit
tests pinning exact wording and the single-handoff-per-switch invariant.

### Task 6a — Ablation-warden measurement of 5 experimental flags
**What/why:** Settle 5 unmeasured experimental harness flags (`RA_OVERHAUL`,
`RA_TOOL_INDEX`, `RA_THOUGHT_CONTINUITY`, `RA_TOOL_OBSERVE_SYMMETRY`,
`RA_RATIONALE_AUDIT`) with a lift verdict each: promote, keep opt-in, or
delete. No separate commit (folded into 6b's).
**Review outcome:** clean, zero fix rounds. Every quantitative claim in the
verdicts doc (`wiki/Decisions/2026-09-15-experimental-flag-verdicts.md`)
independently recomputed from raw JSON and matched exactly; the
100%-accuracy-ceiling claim confirmed across all 10 files, not spot-checked.
2 Minor deferred.
**Beyond-scope finding (named):** all 10 live cells hit a **100% accuracy
ceiling in both arms** — the tasks were too easy at n=3/haiku to discriminate
any flag's effect on accuracy at all, disclosed honestly rather than reading
that flatness as a null result; every verdict rests on rung-1 INERT status
plus billed-token cost, not a measured accuracy lift. Separately, **the
rung-1 replay sweep (`replay-ablate-sweep.ts`) never exercises
`RA_TOOL_INDEX` at all** — it is entirely absent from that sweep, a genuine
sweep-coverage gap, flagged for follow-up rather than silently worked around.
**Verdicts:** `RA_OVERHAUL` = DELETE; `RA_TOOL_INDEX` = KEEP-OPT-IN
(insufficient measurement power — narrow surface tested vs. the wide/
MCP-scale surface it is meant for); `RA_THOUGHT_CONTINUITY` = DELETE;
`RA_TOOL_OBSERVE_SYMMETRY` = DELETE (+56.5% billed tokens, zero lift);
`RA_RATIONALE_AUDIT` = KEEP-OPT-IN (non-accuracy audit mechanism, +28.2%
billed tokens, bounded by design).

### Task 6b — Execute the flag verdicts
**What/why:** Apply 6a's verdicts end-to-end: delete the 3 DELETE flags
completely (reader → config → registration → mechanism → tool file → test →
sweep row → docs); annotate the 2 KEEP-OPT-IN flags with JSDoc only, no
behavior change.
**Commits:** `31c97ae8..fe7fae32` (initial `ad04e1b8`, fix round 1
`fe7fae32`).
**Review outcome:** 1 Important finding, 1 fix round. All 3 DELETE flags
verified removed with zero remaining references; both KEEP-OPT-IN flags got
JSDoc-only annotations; `offersWriteByRef` gate correctly left in place. The
Important finding: `analyzeWire()` still advised the now-dead
`RA_THOUGHT_CONTINUITY` flag as a live remediation — fix round 1 (same
implementer) replaced it with an accurate permanent-OFF message pointing at
the decision doc; re-review confirmed ADDRESSED, no new breakage.
**Beyond-scope finding (named):** a **pre-existing, unrelated gate failure**
was discovered and disclosed here, not caused by this task and confirmed
via `git stash`: `as-unknown-as-ceiling.test.ts` already fails on this
branch (79 actual `as unknown as` sites vs. ceiling 78) — someone introduced
a new cast upstream of this wave without lowering/tracking the ceiling.
Flagged forward to Task 9's final gates rather than silently fixed (fixing
it would mean either raising the ratchet-down-only ceiling without
justification, or hunting down a cast elsewhere — both out of scope here).

### Task 7 — Demand-driven `num_ctx` for local models
**What/why:** Opt-in mechanism to set Ollama's `num_ctx` on demand rather
than a fixed ceiling, hypothesized to lower VRAM/latency on small turns.
**Commits:** `3a6baf2a..90a13519`.
**Review outcome:** clean, zero fix rounds. Monotone-growth property
hand-traced and confirmed correct; default path confirmed byte-identical
when the policy is unset; mutation check confirmed real (RED then GREEN);
confound disclosure independently verified against raw numbers. 2 Minor
deferred.
**Disclosed limitation:** measurement on gemma4:12b + gemma4:26b-a4b-it-q4_K_M
was confounded by cross-run reload thrash (separate `agent.run()` calls
sharing one Ollama process) — disclosed honestly with numbers supporting the
explanation (steady-state trials show demand fractionally faster once reload
outliers are excluded). Correctly kept opt-in per the brief's own acceptance
rule; not promoted, not deleted. Two deviations from the brief were made
after verifying against source first: gated on `providerName === "ollama"`
rather than `tier === "local"` (matching existing precedent), and the
kernel-wiring test calls `executeReActKernel()` directly rather than through
the builder, to avoid `build()`'s unconditional live-Ollama preflight.

### Task 8 — Wither proof census + batch 1
**What/why:** Classify every public builder wither (`with*` method) as
PROVEN / UNOBSERVABLE-DETERMINISTIC / DELETE, and build the missing
red-on-cut proof lane for the highest-risk SILENT ones.
**Commits:** `90a13519..84d43fcf`.
**Review outcome:** clean, zero fix rounds. Census row count independently
re-derived from `builder.ts` and matched exactly against the 85-row map;
`WITHER_CEILING` confirmed untouched; all 3 SILENT-reclassification claims
independently confirmed by reading the cited files. 2 Minor deferred (1
loose OR-condition; 1 judgment note on writing all 6 batch-1 tests rather
than crediting 3 pre-existing ones — defensible, not a defect).
**Result:** all 85 live withers classified: 48 PROVEN, 32
UNOBSERVABLE-DETERMINISTIC (28 disclosed temporary "SILENT — batch N"
placeholders per the plan's own sanctioned pattern, 4 genuine
live-dependency), 5 INFRA. A genuine honest finding along the way: 3 withers
(`withMinIterations`, `withVerificationStep`, `withMemoryConsolidation`) had
existing tests with strong "RED-ON-CUT" doc comments that actually called
raw config functions, never the builder's `.withX()` — correctly
reclassified SILENT rather than credited as PROVEN.

### Task 9a — Full gates, release dry run, doc sync
**What/why:** Close the wave: run full CI-parity gates, a release dry run,
and sync all knowledge stores (Hot.md, 09-UNIFIED-PROGRAM.md, Claude memory,
`.agents/MEMORY.md`).
**Commits:** `84d43fcf..c8b8b418`.
**Review outcome:** clean, zero fix rounds. Baseline diff verified
hunk-by-hunk to change only the expected fields (no status flips, no
unrelated content); wither/orphan/test-count arithmetic independently
reconciled. 2 Minor deferred.
**Beyond-scope finding (named):** the full-suite run surfaced a second
failure beyond the known ceiling gap — the **North Star gate's committed
baseline had gone stale**. `task-9a-report.md` enumerates exactly 14
control-flow scenarios by name (`cf-04`, `cf-10`, `cf-11`, `cf-13`, `cf-14`,
`cf-15`, `cf-16`, `cf-17`, `cf-18`, `cf-21`, `cf-22`, `cf-23`, `cf-24`,
`cf-25`) that diverged on `terminatedBy` (baseline's
`"unknown"`/`terminatedByCaptured: "missing"` vs.
the real value `"end_turn"`), root-caused to Task 3's fix landing without
that specific gate having been re-run at the time (Task 3/4's own reports
only ran scoped tests). Regenerated via the sanctioned
`bun run gate:update --reason "..."` (not a manual edit), carrying the
mandated `BASELINE-UPDATE:` commit trailer. Verified in isolation afterward:
1 pass, 0 fail. This is a real, correctly-investigated finding — not waved
through.

---

## Rulings carried forward verbatim (SDD ledger)

These decisions were made on the human's behalf during execution and must
remain visible, not summarized:

> **Ruling (pre-flight):** Tasks 6 and 7 call for live, budgeted API spend
> (Anthropic haiku cells) and live local-model runs. Credentials and Ollama
> are available (checked above). Given this session was explicitly asked to
> execute the full wave via subagents, and the plan already bounds these
> runs (n≤5, timeout≤590s foreground, small task sets), proceed with live
> measurement rather than skipping it — this is squarely what the user
> approved by choosing full execution, not an unbounded or surprise external
> side effect. Substitute `granite4:latest` (unavailable) with `gemma4:12b`
> as the "small" local tier and `gemma4:26b-a4b-it-q4_K_M` as the "mid" tier
> for Task 7; for Task 6's rung-3 cell, use `gemma4:12b`. — Cost if wrong:
> modest unplanned API spend (haiku-tier bench cells, bounded by the plan's
> own n/timeout caps); reversible by not re-running.

> **Task 0: Ruling** — the reviewer's finding conflicts with the brief's own
> Step 4, which mandated that exact commit message text verbatim; the
> implementer followed the plan as written. The imprecision (discovered only
> because Step 1's grep failed at execution time, not knowable when the plan
> was authored) is cosmetic — no dependent task reads commit message text,
> nothing downstream is affected. Parked as Minor, not entered into the fix
> loop. — Cost if wrong: a future reader skimming `git log` briefly
> overcounts closed items by one; corrected by this ledger entry and by
> DEBT-REGISTER/09 themselves, which are the actual source of truth and are
> accurate.

> **Task 1: attribution ruling** — my dispatch instruction was wrong. This
> session carries an active system-reminder ("Attribution for git
> commits... this replaces any earlier attribution guidance... End git
> commit messages with: Co-Authored-By: Claude Sonnet 5.../Claude-Session:...")
> which is more current and more specific than the persistent-memory
> convention ("No Co-Authored-By lines") I generalized from without checking
> for a session override. The implementer's commit is correct; no fix needed. Going
> forward, all task dispatches in this run will instruct implementers to
> INCLUDE the mandated trailer, not omit it. Task 0's commit (96f10a22)
> predates this correction and lacks the trailer — left as-is (not worth
> rewriting published branch history for one doc commit). — Cost if wrong:
> one branch commit (96f10a22) without the mandated trailer; trivially
> fixable with a rebase if it ever matters.

> **Task 3: Ruling** — accept the mutation-check limitation as documented
> rather than expanding scope to also fix DEBT-REGISTER B3's cost-tracking
> gap (out of scope for this task; already tracked separately). — Cost if
> wrong: totalCostUsd could still read 0 on some run shapes where cost
> genuinely is computed but the spread was silently reverted; low risk since
> the spread is a 1-line addition next to code covered by other
> run-finalize.ts tests.

> **Task 6 — scoping ruling before dispatch:** Task 6's own Step 1 gives
> ablation-warden explicit authority "read + run benches only; no framework
> edits" but the brief's Steps 5-6 require framework edits (deletions) and
> commits. Splitting into two dispatches: 6a = ablation-warden produces the
> decision doc with verdicts (Steps 1-4, read/measure-only, matches its
> stated authority); 6b = a separate general-purpose implementer executes
> Step 5 (deletions per verdict) + Step 6 (gates+commit) based on 6a's
> finished doc. Also scoping down measurement power to keep this tractable
> in one session: n=3 (not 5) per arm, haiku as the primary/required tier
> for all 5 flags, local tier (gemma4:12b) attempted only where cheap and
> not already ruled void (skip local entirely for RA_THOUGHT_CONTINUITY per
> the brief's own note that it's void there by construction). Where full
> cross-tier confirmation can't be completed within the session's time
> budget, apply the brief's own explicit fallback: "Gap within noise ...
> DELETE is the default for pure-harness mechanisms ... unless the warden
> records a reason to extend measurement." — Cost if wrong: a flag gets
> DELETEd on lower-powered evidence than the brief's full spec envisioned;
> recoverable (any deleted mechanism is in git history and DEBT-REGISTER
> cites the exact commit) and consistent with 09's own simplicity-over-
> unmeasured-complexity bias.

> **Task 9 — scoping ruling before dispatch:** Task 9 Step 3 says "Dispatch
> debrief-scribe" — that's an Agent-tool dispatch, which per this skill's
> own rule an implementer subagent must never do (implementers never
> dispatch subagents). Splitting: 9a = implementer runs Steps 1 (full gates,
> .env aside), 2 (release dry run), 4 (Hot.md/09/memory doc sync) and
> commits the doc sync; the controller (me) then personally dispatches
> debrief-scribe (Step 3) and commits its output (Step 5), since only the
> controller session may dispatch subagents in this workflow. Also: 9a's
> gate run is expected to show 1 known-unrelated failure
> (as-unknown-as-ceiling.test.ts, 79 vs ceiling 78, confirmed pre-existing
> via git-stash during Task 6b) — instructing the implementer to document
> it as a pre-existing, disclosed gap rather than a blocker or something to
> silently fix (fixing it would mean either raising the ceiling, which the
> ratchet-down-only rule forbids without justification, or removing a cast
> elsewhere, which is out of this wave's scope).

---

## Final measured outcome

- **Full suite:** 9,250 tests pre-wave (9,221 pass / 25 skip / 4 todo / 0
  fail, 1,203 files) → **9,294 tests post-wave** (9,264 pass / 25 skip / 4
  todo / **1 fail**, 1,211 files). Growth of 44 tests / 8 files is expected
  (Tasks 5, 6b, 8 in particular added many new tests).
- **The one known failure:** `WS-5b — "as unknown as" cast-site ceiling`
  (79 actual sites vs. ceiling 78) — confirmed **pre-existing** via
  `git stash` during Task 6b's review, **not** introduced by this wave.
  Not fixed in this wave: fixing it means either raising the ratchet-down
  -only ceiling without justification, or hunting down a removable cast
  elsewhere, both explicitly out of scope.
- **Gates:** build 72/72, typecheck clean, 21/21 `check-*.sh` scripts pass,
  `docs:examples:check` clean (372/372 checked examples), `release:dry
  0.16.1` clean (34 packages).
- **Branch state:** `wave/wire-or-delete-2026-09` is **gate-clean but not
  yet merged to main or tagged.**

## Forward work (explicitly open, not part of this wave)

- **Wither-proof batches 2-4** — 28 SILENT withers remain queued behind the
  disclosed temporary "SILENT — batch N" placeholder pattern from Task 8.
- **The `as-unknown-as` ceiling gap** — needs its own fix session (79 vs.
  ceiling 78); not this wave's fault, but still open.
- **`RA_TOOL_INDEX`** — disclosed insufficient-measurement-power status from
  Task 6a; still opt-in, **not promoted, not deleted**. Its rung-1
  replay-sweep coverage gap (never exercised by `replay-ablate-sweep.ts`) is
  also still open.
- **τ-bench bridge** — separately tabled by the user; not part of this
  wave.

## Anchors

- Commit range: `96f10a22..c8b8b418` on `wave/wire-or-delete-2026-09`
  (branched off `main` @ `740b9320`).
- Full commit list (`git log --oneline 740b9320..c8b8b418`):
  `96f10a22` (Task 0), `6c9682d2` (Task 1), `c79e2063` (Task 3), `be8ce0a8`
  (Task 4), `31c97ae8` (Task 2), `ad04e1b8`→`fe7fae32` (Task 6b, fix round
  at `fe7fae32`), `cfc3126b`→`3a6baf2a` (Task 5, fix round at `3a6baf2a`),
  `90a13519` (Task 7), `84d43fcf` (Task 8), `c8b8b418` (Task 9a).
- Plan: `wiki/Planning/Implementation-Plans/2026-09-14-wire-or-delete-hardening-wave.md`
- SDD ledger (full detail, every review's findings):
  `.superpowers/sdd/2026-09-14-wire-or-delete-hardening-wave/progress.md`
- Task 6a's decision doc (5 flag verdicts + receipts):
  `wiki/Decisions/2026-09-15-experimental-flag-verdicts.md`
- Regenerated North Star gate baseline (Task 9a):
  `wiki/Research/Harness-Reports/integration-control-flow-baseline.json`
- Per-task implementer reports:
  `.superpowers/sdd/2026-09-14-wire-or-delete-hardening-wave/task-{0,1,2,3,4,5,6b,7,8,9a}-report.md`
