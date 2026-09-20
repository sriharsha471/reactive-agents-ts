// File: src/entropy-correlation.ts
// Joins bench outcome data (RunScore.trust/status) with the same run's
// entropy trajectory (from its trace) to answer: does the composite score
// actually separate good outcomes from bad ones? Read-only over both inputs
// — this module never mutates a report or a trace.
import { loadTrace, analyzeRun } from "@reactive-agents/trace";
import { join } from "node:path";
import type { TaskVariantReport, TrustVerdict } from "./types.js";

export interface EntropyOutcomeRow {
  readonly taskId: string;
  readonly modelVariantId: string;
  readonly trust: TrustVerdict | undefined;
  readonly status: "pass" | "fail" | "error";
  readonly entropyFirst: number | undefined;
  readonly entropyLast: number | undefined;
  readonly entropyShape: "converging" | "flat" | "diverging" | "unknown";
  readonly minSourcesPresent: number;
  readonly maxSourcesPresent: number;
  readonly degradedIterations: number;
  readonly lowConfidenceIterations: number;
  readonly earlyStopFired: boolean;
}

/**
 * Join every RunScore that has a traceId to its trace's ReasoningTrajectory.
 * Runs with no traceId (tracing was off, or the run errored before any trace
 * write) are silently skipped — this is a best-effort correlation extractor,
 * not a completeness check.
 */
export async function extractEntropyOutcomeRows(
  reports: readonly TaskVariantReport[],
  traceDir: string,
): Promise<EntropyOutcomeRow[]> {
  const rows: EntropyOutcomeRow[] = [];
  for (const report of reports) {
    for (const run of report.runs) {
      if (!run.traceId) continue;
      let trace;
      try {
        trace = await loadTrace(join(traceDir, `${run.traceId}.jsonl`));
      } catch {
        continue;
      }
      if (trace.events.length === 0) continue;
      const analysis = analyzeRun(trace);
      rows.push({
        taskId: report.taskId,
        modelVariantId: report.modelVariantId,
        trust: run.trust,
        status: run.status,
        entropyFirst: analysis.reasoning.entropyFirst,
        entropyLast: analysis.reasoning.entropyLast,
        entropyShape: analysis.reasoning.entropyShape,
        minSourcesPresent: analysis.reasoning.entropyDegradation.minSourcesPresent,
        maxSourcesPresent: analysis.reasoning.entropyDegradation.maxSourcesPresent,
        degradedIterations: analysis.reasoning.entropyDegradation.degradedIterations,
        lowConfidenceIterations: analysis.reasoning.entropyDegradation.lowConfidenceIterations,
        earlyStopFired: (analysis.reasoning.decisionTypes["early-stop"] ?? 0) > 0,
      });
    }
  }
  return rows;
}

export interface EntropyOutcomeSummary {
  readonly totalRows: number;
  /** Mean `entropyLast` grouped by trust label (only labels present in rows). */
  readonly meanEntropyLastByTrust: Record<string, number>;
  readonly earlyStopFireCount: number;
  /** Rows where entropyShape was "unknown" (too short a run to have a shape). */
  readonly unknownShapeCount: number;
}

export function summarizeEntropyOutcome(rows: readonly EntropyOutcomeRow[]): EntropyOutcomeSummary {
  const byTrust = new Map<string, number[]>();
  let earlyStopFireCount = 0;
  let unknownShapeCount = 0;
  for (const row of rows) {
    const label = row.trust ?? "unknown";
    if (row.entropyLast !== undefined) {
      const list = byTrust.get(label) ?? [];
      list.push(row.entropyLast);
      byTrust.set(label, list);
    }
    if (row.earlyStopFired) earlyStopFireCount++;
    if (row.entropyShape === "unknown") unknownShapeCount++;
  }
  const meanEntropyLastByTrust: Record<string, number> = {};
  for (const [label, values] of byTrust) {
    meanEntropyLastByTrust[label] = values.reduce((a, b) => a + b, 0) / values.length;
  }
  return { totalRows: rows.length, meanEntropyLastByTrust, earlyStopFireCount, unknownShapeCount };
}
