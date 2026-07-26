import { describe, expect, it, vi } from "vitest";
import { updateChampionPointers } from "../../src/core/lifecycle.js";
import type {
  BudgetSnapshot,
  ChampionPointers,
  ExperimentIdentity,
} from "../../src/domain/models.js";
import type {
  BlindBroker,
  ExperimentJournal,
  OptimizerAdapter,
  ValidationAggregate,
} from "../../src/orchestrator/contracts.js";
import { ExperimentRunner } from "../../src/orchestrator/experiment-runner.js";

const BASELINE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const HASH = "c".repeat(64);
const protocolHash = "d".repeat(64);

const champions: ChampionPointers = {
  baselineCommit: BASELINE,
  activeExperiment: 0,
  activeCommit: BASELINE,
  certifiedExperiment: null,
  certifiedCommit: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  sourceSealHash: "e".repeat(64),
};

const budget: BudgetSnapshot = {
  limits: {
    maximumUsd: 100,
    maximumTokens: 1_000_000,
    maximumWallTimeMs: 1_000_000,
    maximumAttempts: 100,
    maximumPrivacyReleases: 5,
    maximumPromotionLooks: 5,
  },
  usage: {
    spentUsd: 0,
    tokens: 0,
    wallTimeMs: 0,
    attempts: 0,
    privacyReleases: 0,
    promotionLooks: 0,
  },
};

function experiment(number: number): ExperimentIdentity {
  return {
    number,
    slug: number === 1 ? "bootstrap" : "repair",
    kind: "optimization",
    parentExperiment: 0,
    lineageId: "lineage",
    protocolHash,
  };
}

function optimizer(sourceBriefHash: string | null): OptimizerAdapter {
  return {
    propose: vi.fn(async () => ({
      hypothesis: {
        hash: HASH,
        sourceBriefHash,
        causalClaim: "Generic recovery policy is incomplete.",
        intervention: "Improve generic recovery policy.",
        predictedRepairBehavior: "More failures are inspected before retry.",
        predictedFreshEffect: "Small broad accuracy improvement.",
        falsificationCriteria: ["No behavioral improvement."],
        rollbackCondition: "Broad regression.",
      },
      candidate: {
        commit: CANDIDATE,
        patchHash: HASH,
        changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
        mutationCategory: "prompt",
      },
    })),
    analyze: vi.fn(async () => ({ hash: HASH, rollbackRequired: false })),
  };
}

function validation(
  disposition: ValidationAggregate["disposition"] = "promoted",
): ValidationAggregate {
  const decisionInputs =
    disposition === "promoted"
      ? { probabilityPositive: 0.96, medianAccuracyDelta: 0.06 }
      : disposition === "rejected"
        ? { probabilityPositive: 0.1, medianAccuracyDelta: -0.06 }
        : { probabilityPositive: 0.7, medianAccuracyDelta: 0.01 };
  return {
    disposition,
    validPairs: 12,
    validArms: 24,
    replacementAttempts: 0,
    ...decisionInputs,
    requiredPosteriorProbability: 0.95,
    onlineGateAuthorized: true,
    stratumRegressionVeto: false,
    integrityVeto: false,
    correctnessVeto: false,
    capabilityVeto: false,
    costWithinGuardrail: true,
    latencyWithinGuardrail: true,
    accuracyTradeoffPredeclared: false,
    aggregateCostUsd: 10,
    tokens: 1000,
    wallTimeMs: 10_000,
    attestationHash: HASH,
    releasedEvidenceHash: HASH,
    attemptAccounting: {
      policyVersion: "validation-attempt-ledger-v1",
      terminalStatus: "complete",
      presealedPairCount: 12,
      presealedArmCount: 24,
      validArmCount: 24,
      attemptedArmCount: 24,
      unresolvedArmCount: 0,
      totalAttemptCount: 24,
      replacementAttemptCount: 0,
      infrastructureFailureCount: 0,
      nonInfrastructureFailureCount: 0,
      containsPanelHandle: false,
      containsTaskIdentifiers: false,
      containsCellIdentifiers: false,
      containsAttemptIdentifiers: false,
      containsEvidenceIdentifiers: false,
    },
  };
}

function broker(result = validation()): BlindBroker {
  return {
    prepareRepair: vi.fn(async () => ({
      leaseToken: "repair-token",
      attestationHash: HASH,
      expectedValidArms: 5,
      maximumAttempts: 9,
    })),
    runRepair: vi.fn(async () => ({
      disposition: "passed",
      attemptOrdinal: 1,
      integrityPassed: true,
      cacheStatus: "eligible",
      aggregateCostUsd: 2,
      tokens: 100,
      wallTimeMs: 1000,
      attempts: 5,
      attestationHash: HASH,
    })),
    prepareValidation: vi.fn(async ({ remainingExperimentAttempts }) => ({
      leaseToken: "validation-token",
      attestationHash: HASH,
      expectedValidArms: 24,
      maximumAttempts: Math.min(28, remainingExperimentAttempts),
    })),
    runValidation: vi.fn(async () => result),
    consumeOrQuarantine: vi.fn(async () => ({
      dispositionAttestationHash: HASH,
    })),
    releaseDiagnosticBrief: vi.fn(async () => ({
      hash: HASH,
      releaseId: "release",
      actionable: true,
    })),
  };
}

function journal(): ExperimentJournal & {
  readonly events: string[];
} {
  const events: string[] = [];
  return {
    events,
    create: vi.fn(async () => {
      events.push("create");
    }),
    freezeProposal: vi.fn(async () => {
      events.push("freeze");
    }),
    recordGates: vi.fn(async () => {
      events.push("gates");
    }),
    recordRepair: vi.fn(async () => {
      events.push("repair");
    }),
    recordValidation: vi.fn(async () => {
      events.push("validation");
    }),
    recordAnalysis: vi.fn(async () => {
      events.push("analysis");
    }),
    updateBudget: vi.fn(async () => {
      events.push("budget");
    }),
    seal: vi.fn(async (input) => {
      events.push("seal");
      const sealHash = "f".repeat(64);
      return {
        sealHash,
        activeChampionAfter:
          input.promotedCandidate === null
            ? input.activeChampionBefore
            : updateChampionPointers(input.activeChampionBefore, {
                experimentNumber: input.promotedCandidate.experimentNumber,
                commit: input.promotedCandidate.commit,
                state: "promoted",
                sealedAt: input.promotedCandidate.decidedAt,
                sealHash,
              }),
      };
    }),
    interrupt: vi.fn(async () => {
      events.push("interrupt");
    }),
  };
}

describe("walk-forward experiment runner", () => {
  it("runs experiment 001 without feedback or repair and promotes only after fresh pairs", async () => {
    const fakeBroker = broker();
    const fakeJournal = journal();
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: fakeJournal,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await runner.run({
      experiment: experiment(1),
      activeChampion: champions,
      budget,
      diagnosticBrief: null,
      previousDiscoveryAttestationHash: null,
      repairAttemptOrdinal: 1,
      stop: { requested: false },
    });

    expect(fakeBroker.prepareRepair).not.toHaveBeenCalled();
    expect(fakeBroker.runValidation).toHaveBeenCalledOnce();
    expect(fakeBroker.consumeOrQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "decided" }),
    );
    expect(result.activeChampion.activeCommit).toBe(CANDIDATE);
    expect(result.budget.usage.attempts).toBe(24);
    expect(result.budget.usage.promotionLooks).toBe(1);
    expect(result.budget.usage.privacyReleases).toBe(1);
    expect(fakeJournal.events.at(-1)).toBe("seal");
  });

  it("rejects at repair without buying a fresh validation panel", async () => {
    const fakeBroker = broker();
    vi.mocked(fakeBroker.runRepair).mockResolvedValue({
      disposition: "rejected",
      attemptOrdinal: 1,
      integrityPassed: true,
      cacheStatus: "eligible",
      aggregateCostUsd: 2,
      tokens: 100,
      wallTimeMs: 1000,
      attempts: 5,
      attestationHash: HASH,
    });
    const runner = new ExperimentRunner({
      optimizer: optimizer(HASH),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    const result = await runner.run({
      experiment: experiment(2),
      activeChampion: champions,
      budget,
      diagnosticBrief: { hash: HASH, releaseId: "release", actionable: true },
      previousDiscoveryAttestationHash: HASH,
      repairAttemptOrdinal: 1,
      stop: { requested: false },
    });
    expect(result.disposition).toBe("rejected");
    expect(fakeBroker.prepareValidation).not.toHaveBeenCalled();
    expect(result.activeChampion).toEqual(champions);
  });

  it("quarantines a started validation panel after evaluator failure", async () => {
    const fakeBroker = broker();
    vi.mocked(fakeBroker.runValidation).mockRejectedValue(new Error("provider failed"));
    const fakeJournal = journal();
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: fakeJournal,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/provider failed/u);
    expect(fakeBroker.consumeOrQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "started-abandoned" }),
    );
    expect(fakeJournal.interrupt).toHaveBeenCalledOnce();
  });

  it("rejects a promotion disposition that does not reproduce from thresholds", async () => {
    const inconsistent = {
      ...validation("promoted"),
      probabilityPositive: 0.5,
    };
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: broker(inconsistent),
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/does not reproduce/u);
  });

  it("preauthorizes no diagnostic release when the privacy budget is exhausted", async () => {
    const noReleaseResult = {
      ...validation(),
      releasedEvidenceHash: null,
    };
    const fakeBroker = broker(noReleaseResult);
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });
    const exhaustedPrivacyBudget: BudgetSnapshot = {
      ...budget,
      usage: {
        ...budget.usage,
        privacyReleases: budget.limits.maximumPrivacyReleases,
      },
    };

    const result = await runner.run({
      experiment: experiment(1),
      activeChampion: champions,
      budget: exhaustedPrivacyBudget,
      diagnosticBrief: null,
      previousDiscoveryAttestationHash: null,
      repairAttemptOrdinal: 1,
      stop: { requested: false },
    });

    expect(fakeBroker.prepareValidation).toHaveBeenCalledWith(
      expect.objectContaining({ diagnosticReleaseAuthorized: false }),
    );
    expect(fakeBroker.releaseDiagnosticBrief).not.toHaveBeenCalled();
    expect(result.diagnosticBrief).toBeNull();
    expect(result.budget.usage.privacyReleases).toBe(
      budget.limits.maximumPrivacyReleases,
    );
  });

  it("persists the promotion look before requesting a fresh panel", async () => {
    const fakeBroker = broker();
    vi.mocked(fakeBroker.prepareValidation).mockRejectedValue(
      new Error("panel allocation failed"),
    );
    const fakeJournal = journal();
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: fakeJournal,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/panel allocation failed/u);

    expect(fakeJournal.updateBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({ promotionLooks: 1 }),
      }),
    );
  });

  it("returns an allocated but invalid validation lease as sealed and unstarted", async () => {
    const fakeBroker = broker();
    vi.mocked(fakeBroker.prepareValidation).mockResolvedValue({
      leaseToken: "invalid-validation-token",
      attestationHash: HASH,
      expectedValidArms: 24,
      maximumAttempts: 27,
    });
    const fakeJournal = journal();
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: fakeJournal,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/preseal 24 valid arms/u);
    expect(fakeBroker.runValidation).not.toHaveBeenCalled();
    expect(fakeBroker.consumeOrQuarantine).toHaveBeenCalledWith({
      leaseToken: "invalid-validation-token",
      attestationHash: HASH,
      outcome: "sealed-unstarted",
    });
  });

  it("rejects fractional replacement accounting and quarantines the started panel", async () => {
    const invalidAccounting = {
      ...validation(),
      replacementAttempts: 0.5,
    };
    const fakeBroker = broker(invalidAccounting);
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/twelve bounded fresh matched pairs/u);
    expect(fakeBroker.consumeOrQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "started-abandoned" }),
    );
  });

  it("rejects validation that is not backed by complete terminal attempt accounting", async () => {
    const incompleteAccounting = {
      ...validation(),
      attemptAccounting: {
        ...validation().attemptAccounting,
        validArmCount: 23,
        unresolvedArmCount: 1,
      },
    };
    const fakeBroker = broker(incompleteAccounting);
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/complete release-safe attempt ledger/u);
    expect(fakeBroker.consumeOrQuarantine).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "started-abandoned" }),
    );
  });

  it("rejects extra broker fields before they can reach optimizer analysis", async () => {
    const leakedAggregate = {
      ...validation(),
      hiddenTaskIds: ["forbidden"],
    };
    const fakeOptimizer = optimizer(null);
    const runner = new ExperimentRunner({
      optimizer: fakeOptimizer,
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: broker(leakedAggregate),
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/non-canonical fields/u);
    expect(fakeOptimizer.analyze).not.toHaveBeenCalled();
  });

  it("rejects a diagnostic release that does not bind the signed aggregate", async () => {
    const fakeBroker = broker();
    vi.mocked(fakeBroker.releaseDiagnosticBrief).mockResolvedValue({
      hash: "9".repeat(64),
      releaseId: "release",
      actionable: true,
    });
    const runner = new ExperimentRunner({
      optimizer: optimizer(null),
      gates: {
        run: vi.fn(async () => ({
          passed: true,
          integrityPassed: true,
          protocolHash,
          checksHash: HASH,
          aggregateCostUsd: 1,
          tokens: 10,
          wallTimeMs: 100,
          failureCode: null,
        })),
      },
      broker: fakeBroker,
      journal: journal(),
      now: () => new Date("2026-01-02T00:00:00.000Z"),
    });

    await expect(
      runner.run({
        experiment: experiment(1),
        activeChampion: champions,
        budget,
        diagnosticBrief: null,
        previousDiscoveryAttestationHash: null,
        repairAttemptOrdinal: 1,
        stop: { requested: false },
      }),
    ).rejects.toThrow(/does not match the signed validation evidence hash/u);
  });
});
