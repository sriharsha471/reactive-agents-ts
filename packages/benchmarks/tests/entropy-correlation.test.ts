import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEntropyOutcomeRows, summarizeEntropyOutcome } from "../src/entropy-correlation.js";
import type { TaskVariantReport } from "../src/types.js";

describe("extractEntropyOutcomeRows", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test("joins a RunScore to its trace's entropy trajectory", async () => {
    dir = mkdtempSync(join(tmpdir(), "entropy-corr-test-"));
    const traceId = "trace-abc123";
    const events = [
      { kind: "entropy-scored", runId: traceId, timestamp: 1, iter: 0, seq: 0, composite: 0.6, sources: { token: null, structural: 0.6, semantic: null, behavioral: 0.5, contextPressure: 0 }, sourcesPresent: 2, confidence: "low", trajectoryShape: "flat", modelTier: "local" },
      { kind: "entropy-scored", runId: traceId, timestamp: 2, iter: 1, seq: 1, composite: 0.2, sources: { token: null, structural: 0.2, semantic: null, behavioral: 0.1, contextPressure: 0 }, sourcesPresent: 2, confidence: "medium", trajectoryShape: "converging", modelTier: "local" },
      { kind: "decision-evaluated", runId: traceId, timestamp: 3, iter: 1, seq: 2, decisionType: "early-stop", confidence: 0.8, reason: "entropy converged" },
      { kind: "run-completed", runId: traceId, timestamp: 4, iter: 1, seq: 3, status: "success", totalTokens: 1000, totalCostUsd: 0.01, durationMs: 1000 },
    ];
    writeFileSync(join(dir, `${traceId}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n"));

    const report: TaskVariantReport = {
      taskId: "rw-1",
      modelVariantId: "cogito:14b",
      variantId: "ra-full",
      variantLabel: "Full Harness",
      runs: [{
        runIndex: 0,
        dimensions: [],
        tokensUsed: 500,
        durationMs: 1000,
        status: "pass",
        output: "done",
        traceId,
        trust: "verified-correct",
      }],
      meanScores: [],
      variance: 0,
      meanTokens: 500,
    } as TaskVariantReport;

    const rows = await extractEntropyOutcomeRows([report], dir);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe("rw-1");
    expect(rows[0]!.modelVariantId).toBe("cogito:14b");
    expect(rows[0]!.trust).toBe("verified-correct");
    expect(rows[0]!.status).toBe("pass");
    expect(rows[0]!.entropyFirst).toBeCloseTo(0.6, 5);
    expect(rows[0]!.entropyLast).toBeCloseTo(0.2, 5);
    expect(rows[0]!.entropyShape).toBe("converging");
    expect(rows[0]!.earlyStopFired).toBe(true);
  });

  test("a run with no traceId is skipped, not thrown", async () => {
    dir = mkdtempSync(join(tmpdir(), "entropy-corr-test-notrace-"));
    const report: TaskVariantReport = {
      taskId: "rw-2",
      modelVariantId: "cogito:14b",
      variantId: "ra-full",
      variantLabel: "Full Harness",
      runs: [{ runIndex: 0, dimensions: [], tokensUsed: 10, durationMs: 10, status: "pass", output: "x" }],
      meanScores: [],
      variance: 0,
      meanTokens: 10,
    } as TaskVariantReport;

    const rows = await extractEntropyOutcomeRows([report], dir);
    expect(rows).toHaveLength(0);
  });

  test("summarizeEntropyOutcome buckets mean entropyLast by trust label", () => {
    const rows = [
      { taskId: "a", modelVariantId: "m", trust: "verified-correct" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.1, entropyShape: "converging" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 0, lowConfidenceIterations: 0, earlyStopFired: true },
      { taskId: "b", modelVariantId: "m", trust: "verified-correct" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.15, entropyShape: "converging" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 0, lowConfidenceIterations: 0, earlyStopFired: false },
      { taskId: "c", modelVariantId: "m", trust: "claimed-but-wrong" as const, status: "pass" as const, entropyFirst: 0.5, entropyLast: 0.5, entropyShape: "flat" as const, minSourcesPresent: 2, maxSourcesPresent: 4, degradedIterations: 1, lowConfidenceIterations: 1, earlyStopFired: false },
    ];
    const summary = summarizeEntropyOutcome(rows);
    expect(summary.meanEntropyLastByTrust["verified-correct"]).toBeCloseTo(0.125, 5);
    expect(summary.meanEntropyLastByTrust["claimed-but-wrong"]).toBeCloseTo(0.5, 5);
    expect(summary.earlyStopFireCount).toBe(1);
    expect(summary.totalRows).toBe(3);
  });
});
