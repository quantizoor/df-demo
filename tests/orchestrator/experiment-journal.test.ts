import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BudgetSnapshot,
  ChampionPointers,
  ExperimentIdentity,
} from "../../src/domain/models.js";
import { readAndVerifyEventChain } from "../../src/evidence/events.js";
import { ExperimentStore } from "../../src/evidence/store.js";
import type {
  GateResult,
  OptimizerProposal,
  ValidationAggregate,
} from "../../src/orchestrator/contracts.js";
import {
  type AtomicExperimentJournalStateStore,
  assertDurableExperimentJournalState,
  type DurableExperimentJournalState,
  emptyExperimentJournalState,
  latestJournalBudgetForExperiment,
  ProductionExperimentJournal,
  type ReleaseSafeFinalExperimentSnapshot,
} from "../../src/orchestrator/experiment-journal.js";
import { canonicalJson } from "../../src/schemas/canonical.js";

const BASELINE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const PROTOCOL = "d".repeat(64);
const NOW = "2026-07-26T12:00:00.000Z";
const EXPERIMENT_NAME = "001-journal-test";

const temporaryDirectories: string[] = [];

class MemoryJournalStateStore implements AtomicExperimentJournalStateStore {
  state: DurableExperimentJournalState = emptyExperimentJournalState();

  transact<Result>(
    operation: (state: DurableExperimentJournalState) => {
      readonly next: DurableExperimentJournalState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transition = operation(structuredClone(this.state));
    assertDurableExperimentJournalState(transition.next);
    this.state = structuredClone(transition.next);
    return Promise.resolve(transition.result);
  }
}

const experiment: ExperimentIdentity = {
  number: 1,
  slug: "journal-test",
  kind: "optimization",
  parentExperiment: 0,
  lineageId: "lineage-001",
  protocolHash: PROTOCOL,
};

const champions: ChampionPointers = {
  baselineCommit: BASELINE,
  activeExperiment: 0,
  activeCommit: BASELINE,
  certifiedExperiment: null,
  certifiedCommit: null,
  updatedAt: "2026-07-26T10:00:00.000Z",
  sourceSealHash: HASH_A,
};

const initialBudget: BudgetSnapshot = {
  limits: {
    maximumUsd: 100,
    maximumTokens: 100_000,
    maximumWallTimeMs: 3_600_000,
    maximumAttempts: 100,
    maximumPrivacyReleases: 5,
    maximumPromotionLooks: 5,
    maximumOnlineError: 0.05,
  },
  usage: {
    spentUsd: 0,
    tokens: 0,
    wallTimeMs: 0,
    attempts: 0,
    privacyReleases: 0,
    promotionLooks: 0,
    onlineErrorSpent: 0,
  },
};

const proposal: OptimizerProposal = {
  hypothesis: {
    hash: HASH_C,
    sourceBriefHash: null,
    causalClaim: "Generic recovery guidance is incomplete.",
    intervention: "Strengthen generic recovery and verification guidance.",
    predictedRepairBehavior: "More failures are inspected before retry.",
    predictedFreshEffect: "A small broad accuracy improvement.",
    falsificationCriteria: ["No aggregate recovery improvement is observed."],
    rollbackCondition: "Roll back after a broad capability regression.",
  },
  candidate: {
    commit: CANDIDATE,
    patchHash: HASH_B,
    changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
    mutationCategory: "recovery",
  },
};

const gates: GateResult = {
  passed: true,
  integrityPassed: true,
  protocolHash: PROTOCOL,
  checksHash: HASH_A,
  aggregateCostUsd: 1,
  tokens: 10,
  wallTimeMs: 100,
  failureCode: null,
};

const validation: ValidationAggregate = {
  disposition: "promoted",
  validPairs: 12,
  validArms: 24,
  replacementAttempts: 0,
  probabilityPositive: 0.995,
  medianAccuracyDelta: 0.06,
  requiredPosteriorProbability: 0.99,
  onlineGateAuthorized: true,
  onlineErrorBudget: {
    policyVersion: "online-alpha-spending-v1",
    maximumOnlineError: 0.05,
    gateOrdinal: 1,
    alphaSpent: 0.01,
    cumulativeSpentBefore: 0,
    cumulativeSpentAfter: 0.01,
    remainingAfter: Math.max(0, 0.05 - 0.01),
    reservationHash: HASH_A,
    priorStateHash: HASH_B,
    resultingStateHash: HASH_C,
  },
  stratumRegressionVeto: false,
  integrityVeto: false,
  correctnessVeto: false,
  capabilityVeto: false,
  costWithinGuardrail: true,
  latencyWithinGuardrail: true,
  accuracyTradeoffPredeclared: false,
  aggregateCostUsd: 10,
  tokens: 1_000,
  wallTimeMs: 10_000,
  attestationHash: HASH_A,
  releasedEvidenceHash: null,
  behavioralSourceCommitmentHash: null,
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

function budgetWith(usage: Partial<BudgetSnapshot["usage"]>): BudgetSnapshot {
  return {
    limits: initialBudget.limits,
    usage: { ...initialBudget.usage, ...usage },
  };
}

async function journalFixture() {
  const root = await mkdtemp(join(tmpdir(), "df-journal-test-"));
  temporaryDirectories.push(root);
  const stateStore = new MemoryJournalStateStore();
  const evidenceStore = new ExperimentStore(root, {
    now: () => new Date(NOW),
  });
  const interruptionAttestor = vi.fn(async () => ({
    reasonCode: "cloud-stage-failed",
    attestationHash: HASH_B,
  }));
  const artifactAssembler = vi.fn(async (_snapshot: ReleaseSafeFinalExperimentSnapshot) => {
    throw new Error("Artifact assembly stopped after snapshot capture.");
  });
  const journal = new ProductionExperimentJournal({
    evidenceStore,
    stateStore,
    artifactAssembler: {
      assemble: artifactAssembler,
    },
    sealAuthority: {
      authorize: vi.fn(async () => {
        throw new Error("Seal authorization is outside this focused test.");
      }),
    },
    interruptionAttestor: { attest: interruptionAttestor },
    now: () => new Date(NOW),
  });
  return {
    journal,
    stateStore,
    evidenceStore,
    artifactAssembler,
    interruptionAttestor,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("ProductionExperimentJournal", () => {
  it("records exact idempotent stage order and separates budget stages", async () => {
    const { journal, stateStore, evidenceStore, artifactAssembler } = await journalFixture();
    const gateBudget = budgetWith({
      spentUsd: 1,
      tokens: 10,
      wallTimeMs: 100,
    });
    const preValidationBudget = budgetWith({
      spentUsd: 1,
      tokens: 10,
      wallTimeMs: 100,
      promotionLooks: 1,
    });
    const validationBudget = budgetWith({
      spentUsd: 11,
      tokens: 1_010,
      wallTimeMs: 10_100,
      attempts: 24,
      promotionLooks: 1,
      onlineErrorSpent: 0.01,
    });

    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    await journal.freezeProposal({ experiment, proposal });
    await journal.freezeProposal({ experiment, proposal });
    await journal.recordGates({ experiment, gates });
    await journal.recordGates({ experiment, gates });
    await journal.updateBudget(gateBudget);
    await journal.updateBudget(gateBudget);
    await journal.updateBudget(preValidationBudget);
    await journal.updateBudget(preValidationBudget);
    await journal.updateBudget(validationBudget);
    await journal.updateBudget(validationBudget);
    await journal.recordValidation({
      experiment,
      validation,
      panelDispositionAttestationHash: HASH_B,
    });
    await journal.recordValidation({
      experiment,
      validation,
      panelDispositionAttestationHash: HASH_B,
    });
    await journal.recordAnalysis({ experiment, analysisHash: HASH_C });
    await journal.recordAnalysis({ experiment, analysisHash: HASH_C });

    const record = stateStore.state.records[EXPERIMENT_NAME];
    expect(record).toMatchObject({
      status: "active",
      phase: "analysis-recorded",
      gatesBudget: gateBudget,
      preValidationBudget,
      validationBudget,
      diagnosticBudget: null,
    });
    expect(record?.validation?.panelDispositionAttestationHash).toBe(HASH_B);
    expect(latestJournalBudgetForExperiment(stateStore.state, experiment)).toEqual(
      validationBudget,
    );
    expect(() =>
      latestJournalBudgetForExperiment(stateStore.state, {
        ...experiment,
        protocolHash: HASH_B,
      }),
    ).toThrow(/absent or detached/u);
    const chain = await readAndVerifyEventChain(
      join(evidenceStore.root, EXPERIMENT_NAME, "events.jsonl"),
    );
    expect(chain.records).toHaveLength(8);
    expect(chain.records.map((entry) => entry.payload.messageCode)).toEqual([
      "journal-create",
      "journal-proposal",
      "journal-gates",
      "journal-gates-budget",
      "journal-pre-validation-budget",
      "journal-validation-budget",
      "journal-validation",
      "journal-analysis",
    ]);

    await expect(
      journal.seal({
        experiment,
        disposition: "promoted",
        activeChampionBefore: champions,
        promotedCandidate: {
          experimentNumber: 1,
          commit: CANDIDATE,
          decidedAt: "2026-07-26T12:01:00.000Z",
        },
        diagnosticBrief: null,
      }),
    ).rejects.toThrow(/snapshot capture/u);
    expect(artifactAssembler).toHaveBeenCalledWith(
      expect.objectContaining({
        evaluationStage: "validation",
        initialBudget,
        finalBudget: validationBudget,
      }),
    );
    const firstAssembly = artifactAssembler.mock.calls[0]?.[0];
    await expect(
      journal.seal({
        experiment,
        disposition: "promoted",
        activeChampionBefore: champions,
        promotedCandidate: {
          experimentNumber: 1,
          commit: CANDIDATE,
          decidedAt: "2026-07-26T12:02:00.000Z",
        },
        diagnosticBrief: null,
      }),
    ).rejects.toThrow(/snapshot capture/u);
    expect(artifactAssembler.mock.calls[1]?.[0]).toEqual(firstAssembly);
  });

  it("rejects out-of-order validation and aggregate-detached budget checkpoints", async () => {
    const { journal } = await journalFixture();
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    await journal.freezeProposal({ experiment, proposal });
    await journal.recordGates({ experiment, gates });

    await expect(
      journal.recordValidation({
        experiment,
        validation,
        panelDispositionAttestationHash: HASH_B,
      }),
    ).rejects.toThrow(/invalid during gates-recorded/u);
    await expect(
      journal.updateBudget(budgetWith({ spentUsd: 2, tokens: 10, wallTimeMs: 100 })),
    ).rejects.toThrow(/does not bind its recorded aggregate/u);
  });

  it("accepts harmless floating-point drift in cumulative USD accounting", async () => {
    const { journal, stateStore } = await journalFixture();
    const fractionalInitialBudget = budgetWith({ spentUsd: 0.1 });
    const fractionalGates: GateResult = {
      ...gates,
      aggregateCostUsd: 0.2,
    };
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget: fractionalInitialBudget,
    });
    await journal.freezeProposal({ experiment, proposal });
    await journal.recordGates({
      experiment,
      gates: fractionalGates,
    });
    await journal.updateBudget(budgetWith({ spentUsd: 0.1 + 0.2, tokens: 10, wallTimeMs: 100 }));

    expect(stateStore.state.records[EXPERIMENT_NAME]?.phase).toBe("gates-budgeted");
  });

  it("labels a gate rejection as pre-validation without spending a promotion look", async () => {
    const { journal, artifactAssembler } = await journalFixture();
    const failedGates: GateResult = {
      ...gates,
      passed: false,
      failureCode: "CANDIDATE_BUILD_FAILED",
    };
    const gateBudget = budgetWith({
      spentUsd: 1,
      tokens: 10,
      wallTimeMs: 100,
    });
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    await journal.freezeProposal({ experiment, proposal });
    await journal.recordGates({ experiment, gates: failedGates });
    await journal.updateBudget(gateBudget);
    await journal.recordAnalysis({ experiment, analysisHash: HASH_C });

    await expect(
      journal.seal({
        experiment,
        disposition: "rejected",
        activeChampionBefore: champions,
        promotedCandidate: null,
        diagnosticBrief: null,
      }),
    ).rejects.toThrow(/snapshot capture/u);
    expect(artifactAssembler).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "rejected",
        evaluationStage: "pre-validation",
        finalBudget: gateBudget,
        validation: null,
      }),
    );
  });

  it("durably interrupts a pending operation without persisting raw failure text", async () => {
    const { journal, stateStore, evidenceStore, interruptionAttestor } = await journalFixture();
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    await journal.freezeProposal({ experiment, proposal });
    const rawReason =
      "A hidden evaluator failed at /trusted/private/material and emitted sensitive prose.";

    await journal.interrupt({
      experiment,
      phase: "fresh-validation",
      reason: rawReason,
    });
    await journal.interrupt({
      experiment,
      phase: "fresh-validation",
      reason: rawReason,
    });

    const record = stateStore.state.records[EXPERIMENT_NAME];
    expect(record).toMatchObject({
      status: "interrupted",
      phase: "proposal-frozen",
      interruption: {
        phase: "fresh-validation",
        reasonCode: "cloud-stage-failed",
        attestationHash: HASH_B,
      },
    });
    expect(canonicalJson(stateStore.state)).not.toContain(rawReason);
    expect(interruptionAttestor).toHaveBeenCalledTimes(1);
    const chain = await readAndVerifyEventChain(
      join(evidenceStore.root, EXPERIMENT_NAME, "events.jsonl"),
    );
    expect(chain.records.at(-1)?.eventType).toBe("interrupted");
    expect(chain.records).toHaveLength(3);
  });

  it("fails closed when a proposal tries to add a non-canonical hidden-data field", async () => {
    const { journal } = await journalFixture();
    await journal.create({
      experiment,
      activeChampionBefore: champions,
      initialBudget,
    });
    const leakedProposal = {
      ...proposal,
      hypothesis: {
        ...proposal.hypothesis,
        taskId: "hidden-001",
      },
    };

    await expect(
      journal.freezeProposal({
        experiment,
        proposal: leakedProposal as unknown as OptimizerProposal,
      }),
    ).rejects.toThrow(/non-canonical fields/u);
  });

  it("detects corruption in validation release-safety flags before transaction use", () => {
    const stateStore = new MemoryJournalStateStore();
    const corrupted = structuredClone(stateStore.state) as unknown as Record<string, unknown>;
    corrupted["sensitivity"] = "trusted-hidden-evaluator-state";

    expect(() => assertDurableExperimentJournalState(corrupted)).toThrow(/metadata is malformed/u);
  });
});
