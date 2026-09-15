---
title: Entropy Weight Validation — Debrief
date: 2026-09-14
status: complete
tags: [entropy, reactive-intelligence, composite, debrief, open-item]
---

# Entropy Weight Validation — Debrief

Closing debrief for Task 4 of
`.superpowers/sdd/2026-09-14-entropy-weight-validation/task-4-brief.md`, applying
the brief's decision rule to Task 3's output,
`wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json`.

**Headline: the rule could not evaluate.** This is not "weak evidence" or
"inconclusive" — it is a structural gap. The evidence file contains **zero**
rows in either the `claimed-but-wrong` or `dishonest` trust bucket, so
`separation` (the quantity every other branch of the rule needs) has nothing to
subtract. Per Step 1 of the rule, an absent bucket is not evaluable and must be
recorded as an open item, not a "keep as-is" verdict. No weight change was made.

---

## 1. What the evidence file actually contains (verified independently)

```json
{
  "rows": [
    {"taskId":"rw-1","modelVariantId":"qwen3.5:latest","trust":"verified-correct","status":"pass","entropyLast":0.6938766442217351,"entropyShape":"diverging","earlyStopFired":false, ...},
    {"taskId":"rw-1","modelVariantId":"qwen3.5:latest","trust":"verified-correct","status":"pass","entropyLast":0.5749514001388567,"entropyShape":"flat","earlyStopFired":false, ...},
    {"taskId":"rw-1","modelVariantId":"qwen3.5:latest","trust":"verified-correct","status":"pass","entropyLast":0.5983333333333333,"entropyShape":"flat","earlyStopFired":false, ...}
  ],
  "summary": {
    "totalRows": 3,
    "meanEntropyLastByTrust": {"verified-correct": 0.622387125897975},
    "earlyStopFireCount": 0,
    "unknownShapeCount": 0
  }
}
```

(`wiki/Research/Harness-Reports/2026-09-14-entropy-correlation-report.json`,
re-read and re-parsed for this task, not taken on trust from the plan.)

**Row count and trust-bucket distribution:**

| trust bucket | rows | mean `entropyLast` |
|---|---|---|
| `verified-correct` | 3 | 0.6224 |
| `claimed-but-wrong` | 0 | — (key absent from `meanEntropyLastByTrust`) |
| `dishonest` | 0 | — (key absent from `meanEntropyLastByTrust`) |

All 3 rows: `taskId: "rw-1"`, `modelVariantId: "qwen3.5:latest"`, `status: "pass"`.
This is one task, one model, three `ra-full` repeats, all passing.

## 2. Rule application — Step 1 fires, Steps 2–4 do not apply

Per the brief's decision rule, Step 1:

> Compute `separation = meanEntropyLastByTrust["claimed-but-wrong"] -
> meanEntropyLastByTrust["verified-correct"]` ... If either bucket is absent (0
> rows), the rule cannot evaluate — write that up as an explicit open item in
> the debrief (not a "keep as-is" verdict, since there's no evidence either
> way) and stop; do not fabricate a separation value.

Both `claimed-but-wrong` and `dishonest` are absent (0 rows each) — not merely
smaller than `verified-correct`, but entirely unrepresented. `separation` is
**not computable** from this data. This is exactly the branch that fires; Steps
2 (`separation >= 0.15`), 3 (`0 <= separation < 0.15`), and 4 (`separation <
0`) all require a numeric `separation` and do not apply — there is no
separation number to report, weak, strong, or inverted, and no comparison is
attempted here.

**Why the data structurally cannot produce a `claimed-but-wrong` example:** a
correlation extractor that only ever runs one deterministic-ish local model
against one task, three times, and gets a pass every time, cannot surface a
bucket that requires a wrong-but-confident outcome — no matter how many times
`n` is repeated at this scope. More repeats of the same (model, task) pair add
`verified-correct` rows only; they do not manufacture the missing bucket.

**Open item (per Step 1, explicit, not a "keep as-is" verdict):** whether
entropy separates good from bad outcomes is **unevaluated**, not "probably
fine." `CATEGORY_WEIGHTS` (`packages/reactive-intelligence/src/sensor/composite.ts:22-32`)
remains exactly as unvalidated as RC-4 found it in the prior audit
(`wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md:64-72`) — this
task neither confirms nor refutes that finding.

## 3. `earlyStopFireCount` — reported verbatim, weaker framing than the brief's ≥10 case

`summary.earlyStopFireCount = 0`, `summary.totalRows = 3`. All three rows carry
`earlyStopFired: false`.

The brief's Step 5 describes a stronger closing claim available **only** when
`totalRows >= 10`:

> If it is 0 across `totalRows >= 10`, state plainly ... that
> `convergenceThreshold` early-stop has now been OBSERVED to never fire in a
> real cross-tier run ... "never observed firing across N real bench runs,
> tier-aware, post-modelTier-fix".

`totalRows` here is **3**, not `>= 10`. That threshold is not met, and the
stronger claim is not being made. The accurate, weaker statement is:

**Early-stop fired 0 times out of 3 runs in this sample.** This is consistent
with — but does not newly confirm at any statistical weight beyond — the prior
audit's RC-4/open-items note that `ENTROPY_CONVERGENCE_THRESHOLDS` "may never
fire at all" and had not engaged in any of the three original probe runs nor
the 20-trace corpus from that session
(`wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md:422-427`). Three
more zero-fire runs, all on the same (task, model) pair, is not a new
cross-tier, tier-aware observation — it is one more data point on the same
open question, still open.

## 4. Why only 3 rows were feasible (methodology)

Task 3 ran a single local model, `qwen3.5:latest` — the only
STATIC_CAPABILITIES-calibrated Ollama model actually pulled in this
environment. `real-world-full`'s declared local models `qwen3:4b` and
`cogito:8b` were not pulled locally and were too slow to complete even one
`ra-full` run under the foreground timeout cap in this session (consistent with
the prior audit's own note on local-Ollama-bench instability,
`wiki/Research/Debriefs/2026-09-14-entropy-audit-debrief.md:318-324`, "Instrument
before conclusion" — local models here are not a uniformly reliable
instrument). Task 3 ran a single task (`rw-1`) for 3 separate `ra-full`-variant
runs; no `bare-llm` baseline was collected because it was not needed for this
comparison. No frontier-tier model was run — a mid-task rate-limit interruption
constrained scope before a frontier arm could be added.

The consequence is mechanical, not a modeling failure: a corpus of
(one model, one task, three repeats, all pass) cannot contain a
`claimed-but-wrong` or `dishonest` row by construction, regardless of how the
composite entropy score itself behaves.

## 5. Action taken

**No code change.** `packages/reactive-intelligence/src/sensor/composite.ts`
is untouched by this task. Branch 4 (inverted separation, the only branch that
would trigger Step 3's conditional weight adjustment) did not fire — there is
no `separation` value of any sign to act on. Touching `CATEGORY_WEIGHTS` here
would be exactly the "hand-picked, unevidenced knob" problem this validation
plan exists to prevent, applied in the blind: there is no evidence in either
direction, so there is nothing to validate a change against.

## 6. What would resolve this open item

To make `separation` computable, a future session needs bench runs that can
actually produce a `claimed-but-wrong` or `dishonest` outcome:

1. **More tasks, including at least one known-hard or failure-inducing case.**
   `rw-1` alone, run repeatedly, only ever produces `verified-correct` at this
   model's current success rate. A task chosen for its capacity to induce a
   plausible-but-wrong answer (not just a tool-failure timeout) is needed to
   populate the `claimed-but-wrong` bucket at all.
2. **A second locally-pulled, calibrated model**, to get model-tier spread
   without depending on a frontier API key or an unpulled/too-slow model.
   `qwen3:4b` or `cogito:8b`, actually pulled ahead of time, would both work if
   runtime budget allows completing a `ra-full` run under the foreground cap.
3. **A larger time budget in a future session** — this task's scope (3 rows,
   one model, one task) was itself constrained by local-model runtime and a
   mid-session rate-limit interruption, per §4. Reaching even the brief's
   `totalRows >= 10` early-stop threshold, let alone a bucket with any
   `claimed-but-wrong`/`dishonest` rows, needs more wall-clock time than this
   session had.

Until one of these lands, `CATEGORY_WEIGHTS` should be treated the same way the
prior audit left it: asserted, not measured, and this task adds no evidence
that changes that status in either direction.
