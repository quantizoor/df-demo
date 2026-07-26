import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createOnlineErrorBudget,
  evaluateFreshValidation,
  evaluateRepairGate,
  evaluateShadowCertification,
  makeReleaseSafeRepairGateResult,
  validateExperimentAttemptBudget,
  validateShadowAttemptBudget,
  type FreshValidationArm,
  type FreshValidationPair,
  type RepairTaskEvidence,
} from "../../src/evaluation/index.js";
import { digest, taskId } from "./fixtures.js";

describe("repair gate", () => {
  it("creates a challenger from non-inferior evidence and a presealed fresh fail-to-pass", () => {
    const result = evaluateRepairGate({
      tasks: repairEvidence("fresh", false),
      alternatingBucket: "easy",
      presealedStratumWeights: { shell: 0.6, filesystem: 0.4 },
      integrityVeto: false,
      capabilityRegressionVeto: false,
      costRegressionVeto: false,
      latencyRegressionVeto: false,
      aggregateCostUsd: 0.5,
      integrationPoints: 512,
    });
    expect(result.disposition).toBe("pass");
    expect(result.challengerCreated).toBe(true);
    expect(result.evidenceRoute).toBe("confirmed-transition");
    expect(result.nonInferiorityProbability).toBeGreaterThanOrEqual(0.8);
    expect(result.repairHasPositivePromotionWeight).toBe(false);
  });

  it("never lets cached evidence claim a binary fail-to-pass", () => {
    const input = {
      tasks: repairEvidence("cache", false),
      alternatingBucket: "easy",
      presealedStratumWeights: { shell: 0.6, filesystem: 0.4 },
      integrityVeto: false,
      capabilityRegressionVeto: false,
      costRegressionVeto: false,
      latencyRegressionVeto: false,
      aggregateCostUsd: 0.5,
      integrationPoints: 512,
    } as const;
    const result = evaluateRepairGate(input);
    expect(result.disposition).toBe("fail");
    expect(result.evidenceRoute).toBe("none");
    expect(result.cacheCanEstablishFailToPass).toBe(false);
    const release = makeReleaseSafeRepairGateResult(result, input);
    const serialized = JSON.stringify(release);
    expect(serialized).not.toContain("nonInferiorityProbability");
    expect(serialized).not.toContain("evidenceRoute");
    expect(release.diagnosticEvidenceReleased).toBe(false);
  });

  it("allows the preregistered target behavior route only at three of five tasks", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (improvedCount) => {
        const tasks = repairEvidence("cache", false).map((task, index) => ({
          ...task,
          targetBehaviorImproved: index < improvedCount,
        }));
        const result = evaluateRepairGate({
          tasks,
          alternatingBucket: "easy",
          presealedStratumWeights: { shell: 0.6, filesystem: 0.4 },
          integrityVeto: false,
          capabilityRegressionVeto: false,
          costRegressionVeto: false,
          latencyRegressionVeto: false,
          aggregateCostUsd: 0.5,
          integrationPoints: 256,
        });
        expect(result.evidenceRoute === "target-behavior").toBe(improvedCount >= 3);
      }),
      { numRuns: 12 },
    );
  });

  it("fails closed on hard integrity, capability, cost, or latency vetoes", () => {
    for (const veto of [
      "integrityVeto",
      "capabilityRegressionVeto",
      "costRegressionVeto",
      "latencyRegressionVeto",
    ] as const) {
      const result = evaluateRepairGate({
        tasks: repairEvidence("fresh", false),
        alternatingBucket: "easy",
        presealedStratumWeights: { shell: 0.6, filesystem: 0.4 },
        integrityVeto: veto === "integrityVeto",
        capabilityRegressionVeto: veto === "capabilityRegressionVeto",
        costRegressionVeto: veto === "costRegressionVeto",
        latencyRegressionVeto: veto === "latencyRegressionVeto",
        aggregateCostUsd: 0.5,
        integrationPoints: 256,
      });
      expect(result.disposition).toBe("fail");
    }
  });
});

describe("fresh matched validation", () => {
  it("promotes only from twelve strong fresh matched pairs across strata", () => {
    const result = evaluateFreshValidation({
      pairs: validationPairs(true, false),
      presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
      expectedProtocolHash: digest(900),
      candidateFrozenAt: "2026-07-26T08:00:00.000Z",
      panelSealedAt: "2026-07-26T09:00:00.000Z",
      integrityVeto: false,
      correctnessVeto: false,
      capabilityRegressionVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
      integrationPoints: 1024,
    });
    expect(result.disposition).toBe("promote");
    expect(result.validPairCount).toBe(12);
    expect(result.freshArmCount).toBe(24);
    expect(result.cacheArmCount).toBe(0);
    expect(result.panelConsumed).toBe(true);
    expect(result.probabilityAccuracyDeltaPositive).toBeGreaterThanOrEqual(
      result.requiredPosteriorProbability,
    );
    expect(result.posteriorMedianAccuracyDelta).toBeGreaterThanOrEqual(0.05);
    expect(result.repairCacheHistoryPositiveWeight).toBe(0);
  });

  it("consumes inconclusive and rejected panels without promoting the observed winner", () => {
    const inconclusive = evaluateFreshValidation({
      pairs: validationPairs(false, false),
      presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
      expectedProtocolHash: digest(900),
      candidateFrozenAt: "2026-07-26T08:00:00.000Z",
      panelSealedAt: "2026-07-26T09:00:00.000Z",
      integrityVeto: false,
      correctnessVeto: false,
      capabilityRegressionVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
      integrationPoints: 512,
    });
    expect(inconclusive.disposition).toBe("inconclusive");
    expect(inconclusive.panelConsumed).toBe(true);

    const rejected = evaluateFreshValidation({
      pairs: validationPairs(true, false),
      presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
      expectedProtocolHash: digest(900),
      candidateFrozenAt: "2026-07-26T08:00:00.000Z",
      panelSealedAt: "2026-07-26T09:00:00.000Z",
      integrityVeto: true,
      correctnessVeto: false,
      capabilityRegressionVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
      integrationPoints: 512,
    });
    expect(rejected.disposition).toBe("reject");
    expect(rejected.panelConsumed).toBe(true);
  });

  it("rejects a cached arm, protocol mismatch, or unbalanced arm order", () => {
    const cachedPairs = validationPairs(true, false);
    const first = cachedPairs[0];
    if (first === undefined) {
      throw new Error("Missing validation fixture");
    }
    const invalidCandidate = {
      ...first.candidate,
      fresh: false,
      cacheUsed: true,
    } as unknown as FreshValidationArm;
    expect(() =>
      evaluateFreshValidation({
        pairs: [{ ...first, candidate: invalidCandidate }, ...cachedPairs.slice(1)],
        presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
        expectedProtocolHash: digest(900),
        candidateFrozenAt: "2026-07-26T08:00:00.000Z",
        panelSealedAt: "2026-07-26T09:00:00.000Z",
        integrityVeto: false,
        correctnessVeto: false,
        capabilityRegressionVeto: false,
        costWithinGuardrail: true,
        latencyWithinGuardrail: true,
        accuracyTradeoffPredeclared: false,
        onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
        integrationPoints: 256,
      }),
    ).toThrow(/fresh/u);

    const allAb = cachedPairs.map((pair) => ({ ...pair, order: "AB" as const }));
    expect(() =>
      evaluateFreshValidation({
        pairs: allAb,
        presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
        expectedProtocolHash: digest(900),
        candidateFrozenAt: "2026-07-26T08:00:00.000Z",
        panelSealedAt: "2026-07-26T09:00:00.000Z",
        integrityVeto: false,
        correctnessVeto: false,
        capabilityRegressionVeto: false,
        costWithinGuardrail: true,
        latencyWithinGuardrail: true,
        accuracyTradeoffPredeclared: false,
        onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
        integrationPoints: 256,
      }),
    ).toThrow(/six AB/u);
  });

  it("collapses shadow evidence to a feedback-dark certification disposition", () => {
    const result = evaluateShadowCertification({
      pairs: validationPairs(true, false),
      presealedStratumWeights: { shell: 0.5, filesystem: 0.5 },
      expectedProtocolHash: digest(900),
      candidateFrozenAt: "2026-07-26T08:00:00.000Z",
      panelSealedAt: "2026-07-26T09:00:00.000Z",
      integrityVeto: false,
      correctnessVeto: false,
      capabilityRegressionVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      onlineErrorBudget: createOnlineErrorBudget(0.05, "null-simulation-v1"),
      integrationPoints: 512,
      aggregateCostUsd: 4.5,
      complianceFlagsPassed: true,
    });
    expect(result.disposition).toBe("certified");
    expect(result.scoreReleased).toBe(false);
    expect(result.diagnosticsReleased).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("probability");
    expect(serialized).not.toContain("delta");
    expect(serialized).not.toContain(digest(100));
    expect(
      validateShadowAttemptBudget({
        freshValidArms: 24,
        infrastructureReplacementAttempts: 4,
      }),
    ).toBe(true);
    expect(
      validateShadowAttemptBudget({
        freshValidArms: 24,
        infrastructureReplacementAttempts: 5,
      }),
    ).toBe(false);
  });

  it("enforces the 38-attempt fail-closed campaign ceiling", () => {
    expect(
      validateExperimentAttemptBudget({
        repairCandidateValidArms: 5,
        repairChampionFreshValidArms: 5,
        validationFreshValidArms: 24,
        infrastructureReplacementAttempts: 4,
      }).withinBudget,
    ).toBe(true);
    expect(
      validateExperimentAttemptBudget({
        repairCandidateValidArms: 5,
        repairChampionFreshValidArms: 5,
        validationFreshValidArms: 24,
        infrastructureReplacementAttempts: 5,
      }).withinBudget,
    ).toBe(false);
  });
});

function repairEvidence(
  source: "fresh" | "cache",
  targetBehaviorImproved: boolean,
): readonly RepairTaskEvidence[] {
  const buckets = ["hard", "hard", "hard", "uncertain", "easy"] as const;
  return buckets.map((bucket, index) => ({
    taskId: taskId(index + 1),
    bucket,
    stratum: index < 3 ? "shell" : "filesystem",
    candidatePass: true,
    candidateObservationFresh: true,
    candidateAttempts: 1,
    championEvidence: {
      source,
      passes: 0,
      failures: source === "fresh" ? 1 : 3,
      presealedFreshControl: source === "fresh",
    },
    targetBehaviorImproved,
  }));
}

function validationPairs(
  candidatePass: boolean,
  championPass: boolean,
): readonly FreshValidationPair[] {
  return Array.from({ length: 12 }, (_, index) => {
    const order = index % 2 === 0 ? ("AB" as const) : ("BA" as const);
    return {
      taskId: taskId(index + 100),
      stratum: index < 6 ? "shell" : "filesystem",
      order,
      candidate: arm(candidatePass, index * 2 + (order === "AB" ? 0 : 1)),
      champion: arm(championPass, index * 2 + (order === "BA" ? 0 : 1)),
    };
  });
}

function arm(pass: boolean, offsetMinutes: number): FreshValidationArm {
  const started = new Date(Date.parse("2026-07-26T10:00:00.000Z") + offsetMinutes * 60_000);
  const completed = new Date(started.getTime() + 5 * 60_000);
  return {
    pass,
    fresh: true,
    cacheUsed: false,
    protocolHash: digest(900),
    environmentFingerprintHash: digest(901),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  };
}
