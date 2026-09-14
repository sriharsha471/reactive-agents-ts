---
title: Entropy System Hardening — Audit Debrief
date: 2026-09-14
status: complete
tags: [entropy, reactive-intelligence, trace, kernel, debrief, ablation]
---

# Entropy System Hardening — Audit Debrief

Closing debrief for `wiki/Planning/Implementation-Plans/2026-09-14-entropy-system-hardening.md`
(6 tasks, commits `286bb628..30be765a`). Tasks 1–4 are observability-only;
Task 5 is the only behavior-changing task; Task 6 is this ablation + debrief.

**Headline:** the four observability root causes are fixed and verified live in
real benchmark traces. Task 5's guard is **structurally verified but not
ablation-promoted** — the ablation could not exercise it, because the evaluator
it guards never fired in any of the 15 harnessed runs measured here. It is kept
as shipped on structural grounds, explicitly labeled unmeasured, with a powered
follow-up ablation recorded as open debt.

---

## 1. The four confirmed root causes (verified against source, 2026-09-14)

Five root causes were identified in the audit; four were fixed in this plan and
the fifth (RC-4) was deliberately deferred as blocked on the first three.

**RC-1 — Null-vs-zero conflation at the trace boundary.**
`EntropyScore.sources.token` / `.semantic` are `number | null` in the domain
type (`packages/reactive-intelligence/src/types.ts:84-90`), but
`packages/trace/src/normalize.ts:101,103` coerced both with `?? 0`, and
`EntropyScoredEvent.sources` (`packages/trace/src/events.ts:123-129`) typed
every source as non-nullable `number`. "This source was structurally
unavailable" and "this source measured exactly 0" were the same bytes on disk.
*Fixed by Task 1.*

**RC-2 — Confidence computed, published, discarded.** `computeCompositeEntropy`
returns `confidence: "high" | "medium" | "low"`; `reactive-observer.ts:144-147`
published `confidence`, `trajectory`, `modelTier`, `iterationWeight` onto the
event bus; `normalize.ts:93-108` mapped none of them, and
`REQUIRED_FIELDS_BY_KIND["entropy-scored"]` was `["composite","sources"]`. No
consumer anywhere read entropy `confidence`. *Fixed by Task 2 (carry-through)
and Task 3 (degradation aggregation in `rax:diagnose analyze`).*

**RC-3 — Two uncoordinated loop-stuck detectors.** Kernel-side: the
repeated-identical-failure streak redirect in
`packages/reasoning/src/kernel/loop/iterate-pass.ts` fired at iteration 2
(streak=2) in run `01M2GM1SZ0FVXDD3TNN0F9FZ5A`. RI-side:
`evaluateStrategySwitch` (`strategy-switch.ts:30,35` pre-plan numbering) fired
at iteration 3 (`behavioralLoopScore` 0.63) and again at 6 (0.69). Both answer
"is the agent stuck?" independently, on different cadences, and both inject
guidance the model must reconcile in one context window; two switches inside
four iterations exhausted the switch budget. *Addressed by Task 5 — see §5 for
the narrowed, honest statement of what the fix actually closes.*

**RC-5 — `decision-evaluated.confidence` degenerates to 0 for strategy
switches.** `normalize.ts:113,121` computed confidence as
`hasImprovement ? Math.max(0, 1 - entropyAfter/entropyBefore) : 0`.
`ReactiveDecision` bus events for `switch-strategy` carry no
`entropyBefore`/`entropyAfter`, so the `: 0` fallback always won — even though
the decision's own `reason` string carried real magnitude (loop score 0.63 vs
0.69). *Fixed by Task 4.*

**RC-4 — Weight and threshold tables asserted, never measured.**
`CATEGORY_WEIGHTS` (`composite.ts:22-32`, 8 categories × 4 sources = 32
constants), `WEIGHTS_WITH_LOGPROBS` / `WEIGHTS_WITHOUT_LOGPROBS`
(`composite.ts:5-20`), `strategy-switch.ts`'s `flatEntropy < 0.35` and
`behavioralLoopScore <= 0.45` bars, and `ENTROPY_CONVERGENCE_THRESHOLDS`
(`arbitrator.ts:274-279`). Several carry rationale comments; none cites an
ablation run. Conformal calibration (`conformal.ts`) recalibrates *thresholds*
only — it never touches these weight tables. **Deliberately not fixed in this
plan** — see §8.

## 2. Evidence base — the three probe runIds

Live probes, `qwen3.5:latest` via Ollama, tracing on, from the 2026-09-14 audit
session:

| runId | Task shape | Iters | Outcome |
|---|---|---|---|
| `01M2GKEDSXXVGRFAGBC7CE2HEK` | 3-topic web-search synthesis | 10/12 | success, maxEntropy 0.635, 0 interventions |
| `01M2GKFRM9C5VJANHPK1VYP1DR` | FP-language-history research | 10/15 | success, maxEntropy 0.673, 0 interventions |
| `01M2GM1SZ0FVXDD3TNN0F9FZ5A` | adversarial: forced repeat `http-get` to a blocked address | 7 | failed, `terminatedBy: "switching_exhausted"` |

Observed in all three: every `entropy-scored` event reported
`token:0, semantic:0, contextPressure:0`. Only `structural` (~0.55, near-static)
and `behavioral` (0.5→0.33) ever moved. RC-1 is precisely why those probes could
not tell degradation from genuine zeros.

Task 5 added two further live probe runs against the same adversarial shape:
`01M2GSR6JRPJ9B67FFAWC88AWA` (post-fix) and `01M2GSW6Y701MSASEG9MQVJNS2`
(guard-neutralized control, **inconclusive** — that run's trajectory came out
`oscillating` rather than `flat`, so the evaluator's precondition never
engaged). Task 6 adds 21 benchmark runs (§6).

## 3. Corrections to earlier session claims — do not propagate these

Carried forward verbatim from the plan's own corrections section
(`2026-09-14-entropy-system-hardening.md`, "Corrections to earlier session
claims"). These are wrong claims made earlier in the audit session and corrected
against source:

1. **`switching_exhausted` with empty output is INTENTIONAL, not a bug.**
   `packages/reasoning/src/kernel/loop/runner-helpers/deliverable.ts:165-187`
   documents at length why the passthrough must stay falsy (a truthy sentinel
   would skip `runner.ts`'s lastThought fallback and trip truthy-output verifier
   gates). Do not "fix" this.
2. **`strategy-switch.ts` thresholds are at lines 30 and 35, not 45** (line 45
   was the `reason` template string), and they *do* carry rationale comments
   explaining the chosen values. They lack ablation evidence, not documentation.
3. **`trajectory` is NOT unused.** `strategy-switch.ts:23` (pre-plan numbering)
   reads `e.trajectory.shape === "flat"`. It was dropped only at the trace
   boundary.
4. **Entropy `confidence` is a categorical enum** (`"high" | "medium" | "low"`),
   not a numeric score. It is a different concept from
   `DecisionEvaluatedEvent.confidence` (numeric) and from `arbitrator.ts`'s
   `verdict.confidence` (evaluator enum). Three distinct things; do not unify
   them.

A fifth correction was ruled during execution and belongs with these:

5. **Task 5's guard does not prevent the baseline run's double trigger.** The
   plan's narrative claimed it stopped run `01M2GM1SZ0FVXDD3TNN0F9FZ5A`'s
   stacking of kernel redirect (iter 2) + RI switch (iter 3). Verified against
   that run's own harness-signal timestamps: the kernel redirect *is* at iter 2
   and the RI switch *is* at iter 3, so `kernelLoopSignal.redirectsIssued` was
   already ≥ 1 by iter 3 and the guard as specified **admits** exactly that
   corroborated, one-iteration-behind case. What the guard actually closes is
   the *uncorroborated* case: an entropy-only flat stall with no kernel failure
   evidence at all. That is a real and correct narrowing, but it is a narrower
   claim than the plan's causal framing implied.

## 4. What Tasks 1–5 changed

| Task | Commits | Change | Behavior-changing? |
|---|---|---|---|
| 1 | `286bb628..1ea66948` | `EntropyScoredEvent.sources.token`/`.semantic` widened to `number \| null`; `normalize.ts` stops coercing `null → 0`; new `sourcesPresent: number` (count of non-null sources, 0–5) | No (trace schema) |
| 2 | `1ea66948..b248cd96` | `confidence` (enum), `trajectoryShape`, `modelTier` carried through `normalize.ts` onto `EntropyScoredEvent` and into `REQUIRED_FIELDS_BY_KIND` | No |
| 3 | `b248cd96..a170d2c8` | `rax:diagnose analyze` aggregates degraded-source runs (`entropyDegradation`) so a degraded corpus is legible rather than silently averaged | No |
| 4 | `a170d2c8..d242f82f` | `decision-evaluated.confidence` gets a real value for `switch-strategy`: `LOOP_SCORE_BAR = 0.45` extracted, confidence scaled by headroom above the bar, propagated through `reactive-observer.ts`, `event-bus.ts`'s `AgentEvent`, and RI's own `events.ts` | No (bus/trace value only) |
| 5 | `d242f82f..30be765a` | `ControllerEvalParams.kernelLoopSignal?: { redirectsIssued: number }`; `evaluateStrategySwitch` returns `null` unless `redirectsIssued >= 1`; kernel threads its existing `failureRecoveryRedirects` counter through `reactive-observer.ts` from `iterate-pass.ts:948`. Fail-closed when absent. | **Yes** |

Tasks 1–4 landed review-clean (Tasks 1 and 2 after one fix round each, Tasks 3
and 4 with zero). Task 5 landed review-clean with zero fix rounds; its reviewer
additionally found an unremarked bonus mechanism: `SWITCH_RESET_COUNTERS` zeroes
`failureRecoveryRedirects` on every switch, so a *second* entropy switch now
requires fresh kernel corroboration.

### Tasks 1–3 verified live in real benchmark traces (this task)

Not asserted from unit tests — read out of the 20 trace files this task's bench
runs produced (`benchmark-traces/`, gitignored). A representative
`entropy-scored` event from run `01M2GWF2X1S1YYZR3XS4R7A19T` (cogito:8b,
ra-full, rw-9):

```json
{"kind":"entropy-scored","iter":1,"composite":0.594,
 "sources":{"token":null,"structural":0.775,"semantic":null,
            "behavioral":0.5,"contextPressure":0},
 "sourcesPresent":3,"confidence":"low","trajectoryShape":"flat",
 "modelTier":"unknown"}
```

`token` and `semantic` survive to disk as `null` rather than `0` (RC-1 closed),
and `sourcesPresent`/`confidence`/`trajectoryShape`/`modelTier` are present
(RC-2 closed) — 147 occurrences of each across the corpus. Note two incidental
findings this exposed, both new and neither in scope here:

- **`modelTier: "unknown"`** on every local-model event — the tier is not being
  resolved for the ollama provider. RC-4's deferred note assumed a *known* local
  tier; the field is currently unusable for local-tier weighting.
- `sourcesPresent: 3` on every local event confirms RC-4's deferred premise
  empirically: on local models the five-source composite is a three-term
  expression wearing a five-term coat.
- **Task 4's real confidence stays unverified in this corpus.** Task 4 only
  wired `switch-strategy` decisions, and no `switch-strategy` decision occurred
  in any bench run (§6). Every `decision-evaluated` here is `early-stop` or
  `tool-inject`, which still carry `confidence: 0`. The only live evidence for
  Task 4 remains `conf=0.15` in Task 5's probe `01M2GSR6JRPJ9B67FFAWC88AWA`.

## 5. Task 5 — what it actually closes

Precisely, per the execution ruling (correction 5 above): the guard closes the
**fully uncorroborated** entropy switch — an entropy-only flat stall with zero
kernel failure evidence. It does *not* close the corroborated
one-iteration-behind stacking that the plan's narrative described, and it does
*not* make the kernel and RI cadences agree.

A structural limit found by Task 5's reviewer bounds it further:
`failureRecoveryRedirects` only increments when
`recovery.failedUnresolved.length > 0` (`iterate-pass.ts:1106`,
`runner-helpers/loop-resolution.ts:106-108`,
`runner-helpers/stall-deliverable.ts:293` — all gated on that same condition).
The guard is therefore **unreachable for thought-only loops, no-tool reasoning
stalls, and tool calls that succeed but return useless results** (the classic
search loop). "The kernel is the sole loop-stuck trigger authority" holds only
for the tool-failure class of stuck.

## 6. The ablation

### Judge health — real `/judge` POST, not `/version`

No `.env` exists in this worktree (worktrees do not inherit untracked files), so
no frontier key was available and the Ollama judge recipe was used:

```
JUDGE_LAYER=live JUDGE_PROVIDER=ollama JUDGE_MODEL=gemma4:12b \
  JUDGE_MODEL_SHA=gemma4:12b JUDGE_CODE_SHA=dev PORT=8910 \
  bun run packages/judge-server/src/index.ts
→ judge-server listening on :8910 (model=gemma4:12b code=dev layer=live)
```

Two paired `/judge` POSTs prove the LLM backend is live and *discriminating* — a
stub scores ~0.95 on everything:

```
correct answer ("The capital of France is Paris.")
→ {"passed":true,"overallScore":1,"recommendation":"accept",
   "layerResults":[{"layerName":"Content Accuracy","score":1,
     "details":"The response correctly states that the capital of France is Paris."}]}

wrong answer ("I am unable to determine anything. Bananas are purple.")
→ {"passed":false,"overallScore":0,"recommendation":"reject",
   "layerResults":[{"score":0,
     "details":"...fails to mention Paris."}]}
```

`gemma4:12b` is not among the models under test (Rule 4: judge ≠ SUT).

### Session and task-coverage decision

The plan's `--session cross-tier-stress` was **rejected** for three
independently disqualifying reasons: it declares `ra-full` only (no `bare-llm`
baseline, so `evaluateLiftGate` yields `tiersCovered === 0`); five of its seven
models are frontier and unreachable without a key; and all five of its tasks are
no-tool reasoning tasks, so the guard could never engage.

Chosen instead: **`--session local-models --task rw-9`**. `local-models`
declares both `bare-llm` and `ra-full`, both models are local, and `rw-9`
("Resilience under tool failure") is the tool-failure-loop-inducing shape the
guard requires: `runner.ts:970-987`'s `startFlakyPriceServer` returns HTTP 503
for the first two calls before serving data, and `runner.ts:1006` injects that
server's URL into the prompt. Its `accuracy` metric is `verifiable` (an
11-check partial-credit `bun hidden-check.ts`), not judge-scored — so the gate's
scored metric is deterministic while the judge still scores the `resilience` and
`tool-mastery` dimensions.

**Imperfection, stated rather than hidden:** rw-9's failure is *transient by
design* — exactly two 503s, then success. It is a mild tool-failure episode, not
a persistent failure loop, and it contains no thought-only-stall arm at all. The
coverage warning carried into this task was therefore only partly satisfiable
from existing presets, and §6's null result shows the gap is real and larger
than anticipated.

### Gate 1 — the plan's prescribed command (`bare-llm` vs `ra-full`)

12 cells (2 models × 2 variants × 3 runs), run foreground under `timeout 580`,
one `(model, variant)` cell per invocation because a full 12-run matrix exceeds
the 590 s foreground ceiling. Per-cell reports were merged by concatenating
`taskReports` — lossless, because `projectTierEvidence` (`gate/gate.ts:357`)
reads only that array, keyed by `(modelVariantId, variantId)`.

| model | variant | accuracy | raw tokens | mean duration |
|---|---|---|---|---|
| qwen3-4b | bare-llm | 0% (0/3) | 5209 | 84.3 s |
| qwen3-4b | ra-full | 100% (3/3) | 10294 | 51.8 s |
| cogito-8b | bare-llm | 0% (0/3) | 2312 | 29.4 s |
| cogito-8b | ra-full | 33% | 7339 | 36.4 s |

```
LIFT GATE · ra-full vs bare-llm
  tier                 base    cand      lift       tok  verdict
  qwen3-4b              0.0   100.0  +100.0pp    +97.6%  PASS
    · tokens raw +97.6% | billed +0.8% (scored: billed) | cacheHit 0.0%
  cogito-8b             0.0    33.3   +33.3pp   +217.4%  BELOW
    · tokens raw +217.4% | billed +215.6% (scored: billed) | cacheHit 0.0%
  AGGREGATE  66.7pp · 108.2% billed tok · tiers=2
  DECISION: OPT-IN — 2 tier(s) · 66.7pp lift · 108.2% billed tok — below the promotion bar
```

**This verdict is not about Task 5.** `bare-llm` vs `ra-full` measures the whole
harness; on a `requiresTools: true` task the baseline is pinned at 0% because it
has no tools, so the comparison reduces to "does the harness have tools" (yes)
at a large token cost. The plan's prescribed command cannot isolate a one-line
guard *inside* `ra-full`, and acting on its `opt-in` verdict by flagging Task 5
would be a category error.

### Gate 2 — the arm that actually isolates Task 5

Same `ra-full` variant, same task, same models, same n=3, same judge — two code
states. The guard line in `strategy-switch.ts:29` was commented out, both `src`
and `dist` rebuilt (RI exports `dist`), the two `ra-full` cells re-run, then the
line restored and both rebuilt again. Restoration verified three ways:
`git diff --stat` empty against `30be765a`, the line present in both `src` and
`dist` by grep, and the 13 guard unit tests green. The guard-off cells were
relabeled `ra-noguard` for the gate's variant comparison.

| model | arm | accuracy | raw tokens | note |
|---|---|---|---|---|
| qwen3-4b | ra-noguard | — | — | 3/3 `execution-timeout` at the 180 s cap; excluded from all means |
| qwen3-4b | ra-full | 100% (3/3) | 10294 | |
| cogito-8b | ra-noguard | 30.3% | 10806 | |
| cogito-8b | ra-full | 33.3% | 7339 | |

```
LIFT GATE · ra-full vs ra-noguard
  tier                 base    cand      lift       tok  verdict
  qwen3-4b              0.0   100.0  +100.0pp     +0.0%  INCONCLUSIVE
  cogito-8b            30.3    33.3    +3.0pp    -32.1%  BELOW
    · tokens raw -32.1% | billed +7.5% (scored: billed) | cacheHit 0.0%
  AGGREGATE  3.0pp · 7.5% billed tok · tiers=2 · PARTIAL
  DECISION: UNDERPOWERED — 2 tier(s) · 3.0pp lift · 7.5% billed tok
            — too few runs to resolve ≥3pp; this is NOT evidence of no effect
```

### Two findings that void any causal reading of Gate 2

**(a) The qwen3-4b timeout is environmental, not the guard.** The obvious
reading — "removing the guard makes qwen3-4b blow up 3/3" — is wrong. A
replication control re-ran the *identical* guard-**on** cell after restoration
and it also timed out 3/3 at 180 s, having scored 100%/51.8 s earlier in the
same session. Same code, opposite outcome: the local Ollama bench drifted over
the session (model swap thrash is the likely cause) and is not a stable enough
instrument for an n=3 verdict on that tier. Instrument before conclusion.

**(b) The guarded evaluator never fired, in either arm.** Across all 15
harnessed runs, `grep '"decision":"switch-strategy"'` over the trace corpus
returns **zero** hits — guard on and guard off alike. The strategy switches that
did occur (`"kind":"strategy-switched"`, 4 of them) all came from the *kernel's*
loop detector, reason `"Loop detected: same tool call repeated 3 times"`, not
from RI's entropy evaluator. `entropy-scored` events are present (12 in one run)
with `trajectoryShape: "flat"`, so the sensor is live — but
`evaluateStrategySwitch` returned `null` before reaching its decision on every
call.

Since the evaluator never fired with the guard *removed*, the blocking
precondition is upstream of the guard — `allFlat` over the last 3 history
entries, or `behavioralLoopScore <= 0.45`, not the kernel-corroboration line.
Determining which needs instrumentation this task did not add.

Consequence: **Task 5's guard was never exercised by this ablation.** No verdict
about it is derivable from this data at any n. The null result is the finding.

## 7. Verdict and action taken

Gate 2's decision is `underpowered`, which the gate's own types document as
"NOT a synonym for 'no effect'" (`gate/types.ts:5-11`) — it is not one of the
three outcomes the plan's Step 5 anticipated.

**Action: Task 5 is KEPT AS SHIPPED (unconditional), recorded as
structurally-verified but NOT ablation-promoted.** This is a judgment call that
departs from a literal reading of Step 5, and the reasoning is on the record so
it can be overruled:

1. There is no measured lift to promote on, and no measured harm to revert for.
   Non-regression is the strongest claim the data supports, and even that rests
   on one stable tier.
2. `opt-in` — gating the guard behind a flag — would be acting on a measurement
   that did not measure the guard. Worse, the flag's off-default would restore
   the *less* corroborated path, which has no ablation evidence either (RC-4).
   The lift rule exists to stop unmeasured mechanisms shipping default-on;
   applying it to a fail-closed *narrowing* of an already-unmeasured default-on
   mechanism inverts its purpose.
3. A killswitch for a single `return null` also buys real API surface against
   the project's simplicity rule, for no resolved question.
4. Task 5's structural verification is strong and independent of the bench:
   unit tests on both sides of the package boundary, the absent-vs-explicit-zero
   distinction pinned in `kernel-loop-signal-wiring.test.ts`, a `dist` grep, and
   captured `evaluate()` params.

Both gate runs are recorded in `wiki/Research/Harness-Reports/improvement-ledger.json`
(2 entries). **That file is gitignored** (`.gitignore:7`), so the plan's Step 7
`git add` of it cannot succeed and was not forced; Gate 1's entry is reproduced
here as the durable record:

```json
{
  "weakness": "An entropy-only strategy-switch with zero kernel corroboration can fire and stack with the kernel's own recovery guidance",
  "hypothesis": "Kernel redirect streak (failureRecoveryRedirects >= 1) is the sole trigger authority; RI's entropy loop score can only escalate a stall the kernel has already acted on",
  "baselineVariantId": "bare-llm", "candidateVariantId": "ra-full",
  "decision": "opt-in", "liftPp": 66.67, "tokenOverheadPct": 157.53,
  "rationale": "OPT-IN · 2 tier(s) · 66.7pp lift · 108.2% billed tok — below the promotion bar",
  "status": "opt-in"
}
```

Note: this entry's `tokenOverheadPct` (157.53) is the **raw**-token average
(the mean of 97.6% and 217.4%); the entry's own `rationale` string and every
console printout report the **billed**-token average (108.2% — the mean of 0.8%
and 215.6%) under the same nominal label. `recordGateOutcome`
(`packages/benchmarks/src/ledger.ts:88,97`) writes `agg.tokenOverheadPct`, which
`gate/types.ts` documents as "Mean RAW token overhead", whereas the receipt and
rationale render `scoredTokenOverheadPct(agg, policy)` — a labeling
inconsistency in `rax eval gate`'s ledger writer, not a measurement error.
Billed is the scored figure per the plan's Global Constraints
(`tokenLeg: "billed"`), so read 108.2% as the verdict's cost leg.

Ledger caveat: neither entry's `weakness`/`hypothesis` text is actually tested
by the gate it is attached to, for the reasons in §6. Read those two entries
only alongside this debrief.

### Cross-tier caveat

"≥2 tiers" was satisfied only in the mechanical sense the gate implements —
`TierEvidence.tier` is the *model id*, so two local Ollama models register as
two tiers. With no frontier key in this worktree there was no local+frontier
spread, and the replication control shows one of those two local tiers was not a
reliable instrument at all. Treat the tier coverage of both gates as **one
usable tier**, not two.

## 8. What remains open

- **RC-4 — the weight-table ablation.** Still deliberately deferred, and still
  blocked, though the blocker has moved: Tasks 1–3 have now landed and
  `sourcesPresent` *is* recorded across a corpus, which was the stated
  precondition. The new blocker is `modelTier: "unknown"` on every local event
  (§4) — a local-tier weighting cannot be specified against a tier the sensor
  cannot name. Fix tier resolution for the ollama provider first. The narrower
  right question remains: on local models only three of five sources are ever
  present, so the honest fix is probably a dedicated local-tier weighting rather
  than redistributing absent sources' weight. Separate spec.
- **`ENTROPY_CONVERGENCE_THRESHOLDS` may never fire at all.** It did not engage
  in any of the three original probe runs (the derivative never converged) and
  no convergence event appears in this task's 20-trace corpus either.
  Establish whether that evaluator ever fires on any tier before tuning its
  constants. An evaluator that never fires is a different problem from one that
  fires wrongly.
- **A powered, targeted ablation of Task 5.** Needs three things this task could
  not supply: (i) a task/model combination that actually makes
  `evaluateStrategySwitch` reach its decision — start by instrumenting which
  precondition blocks it, per §6(b); (ii) a stable instrument, since the local
  Ollama bench drifted mid-session; (iii) n ≥ 8 per cell, which is also what
  `pass^8` needs. Until then Task 5 stays "structurally verified, unmeasured".
- **The guard's blind spot.** Thought-only loops, no-tool reasoning stalls, and
  succeeding-but-useless tool calls remain outside the single-authority rule
  (§5). Whether the kernel should count those as redirects at all is an open
  design question, not a bug in Task 5.
- **Framework-level gaps surfaced incidentally**, none acted on:
  `modelTier: "unknown"` for ollama; `agent.run()`'s result exposes no `runId`
  (probes must recover it from `rax:diagnose list`); and
  `packages/benchmarks/src/run.ts:254` claims per-cell report accumulation
  ("results accumulate via the merge-by-cell writer") but `runner.ts:1581-1586`
  is a shallow `{...existing, ...sessionReport}` spread that **clobbers**
  `taskReports` — a stale comment that will mislead the next person who splits a
  session across invocations.
