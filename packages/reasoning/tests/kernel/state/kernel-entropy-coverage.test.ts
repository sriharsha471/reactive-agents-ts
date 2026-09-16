// Run: bun test packages/reasoning/tests/kernel/state/kernel-entropy-coverage.test.ts --timeout 15000
import { describe, expect, test } from "bun:test";
import { scoresEntropyInline } from "../../../src/kernel/state/kernel-constants.js";

describe("kernel entropy coverage", () => {
  test("recognizes strategies scored by the kernel observer", () => {
    for (const strategy of [
      "direct",
      "reactive",
      "react",
      "reflexion",
      "tree-of-thought",
      "plan-execute-reflect",
    ]) {
      expect(scoresEntropyInline(strategy)).toBe(true);
    }
  });

  test("leaves event-scored strategies available for the runtime collector", () => {
    for (const strategy of ["adaptive", "blueprint", "rewoo", "code-action"]) {
      expect(scoresEntropyInline(strategy)).toBe(false);
    }
  });
});
