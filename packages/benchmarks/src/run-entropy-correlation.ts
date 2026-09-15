// File: src/run-entropy-correlation.ts
// Reads an already-produced SessionReport JSON (written by `run.ts`'s CLI
// entrypoint, e.g. `bun run packages/benchmarks/src/run.ts --session
// real-world-full --output <path>`) and extracts the entropy/outcome
// correlation rows + summary from it. Deliberately does NOT invoke
// `runSession` itself — the bench run and the extraction are two separate
// steps, matching how the CLI already works and avoiding re-deriving
// session-loading logic that already exists in `run.ts`.
//
// Usage: bun run packages/benchmarks/src/run-entropy-correlation.ts <sessionReport.json> <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { extractEntropyOutcomeRows, summarizeEntropyOutcome } from "./entropy-correlation.js";
import type { SessionReport } from "./types.js";

async function main() {
  const sessionReportPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!sessionReportPath || !outputPath) {
    console.error("Usage: run-entropy-correlation.ts <sessionReport.json> <output.json>");
    process.exit(1);
  }

  const report = JSON.parse(readFileSync(sessionReportPath, "utf8")) as SessionReport;
  const traceDir = "benchmark-traces";

  const rows = await extractEntropyOutcomeRows(report.taskReports ?? [], traceDir);
  const summary = summarizeEntropyOutcome(rows);
  writeFileSync(outputPath, JSON.stringify({ rows, summary }, null, 2));
  console.log(`Wrote ${rows.length} rows. Summary:`, JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
