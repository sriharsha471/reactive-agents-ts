import type { EntropyScore, EntropyTrajectory } from "../types.js";
import { iterationWeight } from "./entropy-trajectory.js";

// Default weights — replaced by conformal calibration after MIN_CALIBRATION_RUNS
const WEIGHTS_WITH_LOGPROBS = {
  token: 0.30,
  structural: 0.25,
  semantic: 0.15,
  behavioral: 0.20,
  contextPressure: 0.10,
};

const WEIGHTS_WITHOUT_LOGPROBS = {
  token: 0,
  structural: 0.40,
  semantic: 0.25,
  behavioral: 0.25,
  contextPressure: 0.10,
};

// Per-category weight overrides (without logprobs — the common case for local models).
// These tune which entropy sources matter most for each task shape.
const CATEGORY_WEIGHTS: Record<string, { structural: number; semantic: number; behavioral: number; contextPressure: number }> = {
  "quick-lookup":   { structural: 0.30, semantic: 0.20, behavioral: 0.35, contextPressure: 0.15 },
  "deep-research":  { structural: 0.35, semantic: 0.30, behavioral: 0.20, contextPressure: 0.15 },
  "code-write":     { structural: 0.30, semantic: 0.35, behavioral: 0.20, contextPressure: 0.15 },
  "code-debug":     { structural: 0.30, semantic: 0.35, behavioral: 0.25, contextPressure: 0.10 },
  "data-analysis":  { structural: 0.35, semantic: 0.25, behavioral: 0.25, contextPressure: 0.15 },
  "file-operation": { structural: 0.30, semantic: 0.15, behavioral: 0.40, contextPressure: 0.15 },
  "communication":  { structural: 0.25, semantic: 0.20, behavioral: 0.40, contextPressure: 0.15 },
  "multi-step":     { structural: 0.30, semantic: 0.20, behavioral: 0.35, contextPressure: 0.15 },
};

type CompositeInput = {
  token: number | null;
  structural: number;
  semantic: number | null;
  behavioral: number;
  contextPressure: number;
  logprobsAvailable: boolean;
  iteration: number;
  maxIterations: number;
  trajectory?: EntropyTrajectory;
  modelTier?: "frontier" | "local" | "unknown";
  temperature?: number;
  taskCategory?: string;
};

type CompositeWeights = {
  token: number;
  structural: number;
  semantic: number;
  behavioral: number;
  contextPressure: number;
};

function resolveWeights(input: Pick<CompositeInput, "logprobsAvailable" | "semantic" | "temperature" | "taskCategory">): CompositeWeights {
  const categoryOverride = input.taskCategory ? CATEGORY_WEIGHTS[input.taskCategory] : undefined;
  const weights: CompositeWeights = input.logprobsAvailable
    ? { ...WEIGHTS_WITH_LOGPROBS }
    : categoryOverride
      ? { token: 0, ...categoryOverride }
      : { ...WEIGHTS_WITHOUT_LOGPROBS };

  if (input.logprobsAvailable && input.temperature === 0) {
    weights.token = 0.15;
    weights.structural += 0.15;
  }

  if (input.semantic === null) {
    const redistribution = weights.semantic;
    weights.semantic = 0;
    weights.structural += redistribution * 0.5;
    weights.behavioral += redistribution * 0.5;
  }

  return weights;
}

function weightedComposite(
  input: Pick<CompositeInput, "token" | "structural" | "semantic" | "behavioral" | "contextPressure">,
  weights: CompositeWeights,
): number {
  return Math.max(0, Math.min(1,
    (input.token ?? 0) * weights.token +
    input.structural * weights.structural +
    (input.semantic ?? 0) * weights.semantic +
    input.behavioral * weights.behavioral +
    input.contextPressure * weights.contextPressure,
  ));
}

export function computeCompositeEntropy(input: CompositeInput): EntropyScore {
  const {
    token, structural, semantic, behavioral, contextPressure,
    logprobsAvailable, iteration, maxIterations,
    trajectory, modelTier = "unknown", temperature, taskCategory,
  } = input;

  // Short-run bypass: ≤2 iterations doesn't have enough data points for meaningful
  // trajectory analysis. Compute a real weighted composite from available sources
  // but mark confidence as "low" so decision-makers (stall-detect) know the
  // signal is preliminary. Previously hardcoded composite to 0.15 with "high"
  // confidence — stall-detect's local-tier window=2 evaluated entirely on that
  // synthetic value, and Grade B "stalled" messages were misleading on 1-2
  // iteration runs that completed successfully.
  if (iteration <= 2) {
    const iWeight = iterationWeight(iteration, maxIterations);
    const defaultTrajectory: EntropyTrajectory = {
      history: [], derivative: 0, momentum: 0.15, shape: "flat",
    };
    // Use the same category-aware weights as normal scoring. The only
    // short-run difference is lower confidence because trajectory evidence is
    // not yet available.
    const shortRunComposite = weightedComposite(
      { token, structural, semantic, behavioral, contextPressure },
      resolveWeights({ logprobsAvailable, semantic, temperature, taskCategory }),
    );
    return {
      composite: shortRunComposite,
      sources: {
        token: token,
        structural,
        semantic: semantic,
        behavioral,
        contextPressure,
      },
      trajectory: trajectory ?? defaultTrajectory,
      confidence: "low" as const,
      modelTier,
      iteration,
      iterationWeight: iWeight,
      timestamp: Date.now(),
    };
  }

  const weights = resolveWeights({ logprobsAvailable, semantic, temperature, taskCategory });

  // Compute weighted sum
  const composite = weightedComposite(
    { token, structural, semantic, behavioral, contextPressure },
    weights,
  );

  // Determine confidence tier
  const sourcesPresent =
    (token !== null ? 1 : 0) +
    1 + // structural always present
    (semantic !== null ? 1 : 0) +
    1; // behavioral always present

  const confidence: "high" | "medium" | "low" =
    sourcesPresent >= 4 ? "high" :
    sourcesPresent >= 3 ? "medium" : "low";

  const iWeight = iterationWeight(iteration, maxIterations);

  const defaultTrajectory: EntropyTrajectory = {
    history: [], derivative: 0, momentum: composite, shape: "flat",
  };

  return {
    composite,
    sources: {
      token: token,
      structural,
      semantic: semantic,
      behavioral,
      contextPressure,
    },
    trajectory: trajectory ?? defaultTrajectory,
    confidence,
    modelTier,
    iteration,
    iterationWeight: iWeight,
    timestamp: Date.now(),
  };
}
