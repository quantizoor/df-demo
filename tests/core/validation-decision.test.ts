import { describe, expect, it } from "vitest";

import { reproduceFreshValidationDisposition } from "../../src/core/validation-decision.js";

const promotable = {
  probabilityPositive: 0.99,
  medianAccuracyDelta: 0.1,
  requiredPosteriorProbability: 0.98,
  onlineGateAuthorized: true,
  stratumRegressionVeto: false,
  integrityVeto: false,
  correctnessVeto: false,
  capabilityVeto: false,
  costWithinGuardrail: true,
  latencyWithinGuardrail: true,
  accuracyTradeoffPredeclared: false,
};

describe("canonical fresh-validation decision", () => {
  it("promotes only when every preregistered condition passes", () => {
    expect(reproduceFreshValidationDisposition(promotable)).toBe("promote");
    expect(
      reproduceFreshValidationDisposition({
        ...promotable,
        probabilityPositive: 0.97,
      }),
    ).toBe("inconclusive");
    expect(
      reproduceFreshValidationDisposition({
        ...promotable,
        integrityVeto: true,
      }),
    ).toBe("reject");
  });

  it("distinguishes negative evidence from uncertainty", () => {
    expect(
      reproduceFreshValidationDisposition({
        ...promotable,
        probabilityPositive: 0.7,
        medianAccuracyDelta: 0.01,
      }),
    ).toBe("inconclusive");
    expect(
      reproduceFreshValidationDisposition({
        ...promotable,
        probabilityPositive: 0.2,
        medianAccuracyDelta: 0,
      }),
    ).toBe("reject");
  });
});
