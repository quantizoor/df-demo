export type FreshValidationDisposition = "promote" | "reject" | "inconclusive";

export interface FreshValidationDecisionInputs {
  readonly probabilityPositive: number;
  readonly medianAccuracyDelta: number;
  readonly requiredPosteriorProbability: number;
  readonly onlineGateAuthorized: boolean;
  readonly stratumRegressionVeto: boolean;
  readonly integrityVeto: boolean;
  readonly correctnessVeto: boolean;
  readonly capabilityVeto: boolean;
  readonly costWithinGuardrail: boolean;
  readonly latencyWithinGuardrail: boolean;
  readonly accuracyTradeoffPredeclared: boolean;
}

function unitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite unit-interval probability`);
  }
}

/**
 * Single source of truth for the preregistered fresh matched promotion gate.
 * Repair evidence and cache entries are deliberately absent from the inputs.
 */
export function reproduceFreshValidationDisposition(
  input: FreshValidationDecisionInputs,
): FreshValidationDisposition {
  unitInterval(input.probabilityPositive, "probabilityPositive");
  unitInterval(
    input.requiredPosteriorProbability,
    "requiredPosteriorProbability",
  );
  if (
    !Number.isFinite(input.medianAccuracyDelta) ||
    input.medianAccuracyDelta < -1 ||
    input.medianAccuracyDelta > 1
  ) {
    throw new Error("medianAccuracyDelta must be finite and bounded");
  }

  const costAndLatencyAllowed =
    (input.costWithinGuardrail && input.latencyWithinGuardrail) ||
    input.accuracyTradeoffPredeclared;
  const hardVeto =
    input.integrityVeto ||
    input.correctnessVeto ||
    input.capabilityVeto ||
    !costAndLatencyAllowed;
  if (hardVeto) {
    return "reject";
  }

  const statisticallyPromotable =
    input.probabilityPositive >= input.requiredPosteriorProbability &&
    input.probabilityPositive >= 0.95 &&
    input.medianAccuracyDelta >= 0.05 &&
    !input.stratumRegressionVeto;
  if (input.onlineGateAuthorized && statisticallyPromotable) {
    return "promote";
  }
  if (
    input.probabilityPositive <= 0.2 ||
    input.medianAccuracyDelta <= -0.05
  ) {
    return "reject";
  }
  return "inconclusive";
}
