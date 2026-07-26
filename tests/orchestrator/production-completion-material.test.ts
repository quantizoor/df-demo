import { describe, expect, it, vi } from "vitest";

import type { CampaignLedgerPointers } from "../../src/campaign/store.js";
import type {
  BudgetSnapshot,
  BudgetUsage,
  ChampionPointers,
  ExperimentIdentity,
} from "../../src/domain/models.js";
import {
  hashOnlineErrorBudgetReconciliation,
  onlineErrorBudgetCampaignIdHash,
  type TrustedOnlineErrorBudgetAuthority,
  type TrustedOnlineErrorBudgetReconciliation,
} from "../../src/evaluator/online-error-authority.js";
import type {
  BudgetAccountingMaterialRequest,
  InterruptedBudgetAccountingMaterialRequest,
  SealMaterialRequest,
} from "../../src/orchestrator/campaign-state-coordinator.js";
import {
  assertDurableExperimentJournalState,
  type AtomicExperimentJournalStateStore,
  type DurableExperimentJournalRecord,
  type DurableExperimentJournalState,
} from "../../src/orchestrator/experiment-journal.js";
import {
  ProductionOptimizationCompletionMaterial,
  ProductionOptimizationCompletionMaterialError,
  type TrustedCampaignSealAuthorization,
  type TrustedCampaignSealAuthorizationRequest,
  type TrustedCompletionAccountingAttestation,
  type TrustedCompletionAccountingAttestationRequest,
  type TrustedInFlightOperationLedgerUsage,
  type TrustedInFlightOperationLedgerUsageRequest,
  type TrustedInterruptedAccountingAttestation,
  type TrustedInterruptedAccountingAttestationRequest,
} from "../../src/orchestrator/production-completion-material.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);
const H4 = "4".repeat(64);
const H5 = "5".repeat(64);
const H6 = "6".repeat(64);
const H7 = "7".repeat(64);
const H8 = "8".repeat(64);
const H9 = "9".repeat(64);
const HA = "a".repeat(64);
const HB = "b".repeat(64);
const HC = "c".repeat(64);
const HD = "d".repeat(64);
const HE = "e".repeat(64);
const HF = "f".repeat(64);
const BASELINE = "a".repeat(40);
const CANDIDATE = "b".repeat(40);
const CAMPAIGN = "campaign-001";
const LINEAGE = "lineage-001";
const PROTOCOL = HD;
const STARTED_AT = "2026-07-26T10:00:00.000Z";
const SEALED_AT = "2026-07-26T10:05:00.000Z";

const experiment: ExperimentIdentity = {
  number: 1,
  slug: "completion-material",
  kind: "optimization",
  parentExperiment: 0,
  lineageId: LINEAGE,
  protocolHash: PROTOCOL,
};

const champion: ChampionPointers = {
  baselineCommit: BASELINE,
  activeExperiment: 0,
  activeCommit: BASELINE,
  certifiedExperiment: null,
  certifiedCommit: null,
  updatedAt: "2026-07-26T09:00:00.000Z",
  sourceSealHash: H1,
};

const limits: BudgetSnapshot["limits"] = {
  maximumUsd: 100,
  maximumTokens: 100_000,
  maximumWallTimeMs: 3_600_000,
  maximumAttempts: 100,
  maximumPrivacyReleases: 5,
  maximumPromotionLooks: 5,
  maximumOnlineError: 0.05,
};

const initialUsage: BudgetUsage = {
  spentUsd: 2,
  tokens: 20,
  wallTimeMs: 100,
  attempts: 0,
  privacyReleases: 0,
  promotionLooks: 0,
  onlineErrorSpent: 0,
};

const journalUsage: BudgetUsage = {
  spentUsd: 3,
  tokens: 30,
  wallTimeMs: 150,
  attempts: 0,
  privacyReleases: 0,
  promotionLooks: 0,
  onlineErrorSpent: 0,
};

const ledgers: CampaignLedgerPointers = {
  brokerExposureStateAttestationHash: H7,
  repeatedTestingLedgerHash: H8,
  privacyLedgerHash: H9,
  cacheStateAttestationHash: HA,
  publicationQueueHash: HB,
};

function sealedRecord(): DurableExperimentJournalRecord {
  return {
    experimentName: "001-completion-material",
    experiment,
    status: "sealed",
    phase: "sealed",
    startedAt: STARTED_AT,
    activeChampionBefore: champion,
    initialBudget: { limits, usage: initialUsage },
    proposal: {
      hypothesis: {
        hash: H2,
        sourceBriefHash: null,
        causalClaim: "Generic recovery guidance is incomplete.",
        intervention: "Improve generic recovery guidance.",
        predictedRepairBehavior: "More failed actions are inspected.",
        predictedFreshEffect: "Broad task accuracy improves.",
        falsificationCriteria: ["No aggregate improvement is observed."],
        rollbackCondition: "Roll back on a broad regression.",
      },
      candidate: {
        commit: CANDIDATE,
        patchHash: H3,
        changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
        mutationCategory: "recovery",
      },
    },
    gates: {
      passed: false,
      integrityPassed: true,
      protocolHash: PROTOCOL,
      checksHash: H4,
      aggregateCostUsd: 1,
      tokens: 10,
      wallTimeMs: 50,
      failureCode: "cloud-gate-rejected",
    },
    repair: null,
    validation: null,
    analysisHash: H5,
    gatesBudget: { limits, usage: journalUsage },
    repairBudget: null,
    preValidationBudget: null,
    validationBudget: null,
    diagnosticBudget: null,
    operationHashes: {
      create: H1,
      proposal: H2,
      gates: H3,
      gatesBudget: H4,
      repair: null,
      repairBudget: null,
      preValidationBudget: null,
      validationBudget: null,
      validation: null,
      analysis: H5,
      diagnosticBudget: null,
      seal: H6,
      interrupt: null,
    },
    interruption: null,
    seal: {
      disposition: "rejected",
      evaluationStage: "pre-validation",
      diagnosticBrief: null,
      authorityAttestationHash: HC,
      attestationContentHash: HE,
      sealChainEntryHash: HF,
      previousExperimentSealHash: null,
      activeChampionAfter: champion,
      sealedAt: SEALED_AT,
    },
  };
}

function interruptedRecord(): DurableExperimentJournalRecord {
  const record = sealedRecord();
  return {
    ...record,
    status: "interrupted",
    phase: "analysis-recorded",
    operationHashes: {
      ...record.operationHashes,
      seal: null,
      interrupt: H6,
    },
    interruption: {
      phase: "optimizer-analysis",
      reasonCode: "cloud-stage-failed",
      attestationHash: HC,
      interruptedAt: SEALED_AT,
      abandonedOperation: null,
      abandonedOperationHash: null,
    },
    seal: null,
  };
}

function journalState(
  record: DurableExperimentJournalRecord,
): DurableExperimentJournalState {
  const sealed = record.status === "sealed";
  const state: DurableExperimentJournalState = {
    schemaVersion: 1,
    sensitivity: "release-safe-experiment-journal",
    revision: 10,
    lastSealedExperimentNumber: sealed ? 1 : null,
    sealChainHead: sealed ? HF : null,
    pendingOperation: null,
    records: {
      [record.experimentName]: record,
    },
  };
  assertDurableExperimentJournalState(state);
  return state;
}

class MemoryJournalStore implements AtomicExperimentJournalStateStore {
  public constructor(public state: DurableExperimentJournalState) {}

  public transact<Result>(
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

function reconciliation(
  onlineErrorSpent = 0.02,
): TrustedOnlineErrorBudgetReconciliation {
  const unsigned = {
    sensitivity:
      "release-safe-online-error-reconciliation" as const,
    schemaVersion: 1 as const,
    campaignIdHash: onlineErrorBudgetCampaignIdHash(CAMPAIGN),
    storeRevision: onlineErrorSpent === 0 ? 0 : 1,
    policyVersion: "online-alpha-spending-v1" as const,
    maximumOnlineError: 0.05,
    onlineErrorSpent,
    onlineErrorRemaining: 0.05 - onlineErrorSpent,
    gatesSpent: onlineErrorSpent === 0 ? 0 : 1,
    resultingStateHash: H2,
    durableStateCommitment: H3,
    observedAt: "2026-07-26T10:06:00.000Z",
  };
  return {
    ...unsigned,
    reconciliationHash:
      hashOnlineErrorBudgetReconciliation(unsigned),
  };
}

function reobserveReconciliation(
  receipt: TrustedOnlineErrorBudgetReconciliation,
  observedAt: string,
): TrustedOnlineErrorBudgetReconciliation {
  const {
    reconciliationHash: _reconciliationHash,
    ...priorUnsigned
  } = receipt;
  const unsigned = { ...priorUnsigned, observedAt };
  return {
    ...unsigned,
    reconciliationHash:
      hashOnlineErrorBudgetReconciliation(unsigned),
  };
}

function completionRequest(
  changes: Partial<BudgetAccountingMaterialRequest> = {},
): BudgetAccountingMaterialRequest {
  return {
    schemaVersion: 1,
    domain: "dark-factory.optimization-budget-accounting.v1",
    campaignId: CAMPAIGN,
    lineageId: LINEAGE,
    protocolHash: PROTOCOL,
    claimHash: H4,
    experimentNumber: 1,
    currentStateHash: H5,
    previousUsage: initialUsage,
    reportedUsage: journalUsage,
    resultSealHash: HF,
    ...changes,
  };
}

function interruptionRequest(
  changes: Partial<InterruptedBudgetAccountingMaterialRequest> = {},
): InterruptedBudgetAccountingMaterialRequest {
  return {
    schemaVersion: 1,
    domain: "dark-factory.interrupted-budget-accounting.v1",
    campaignId: CAMPAIGN,
    lineageId: LINEAGE,
    protocolHash: PROTOCOL,
    claimHash: H4,
    experimentNumber: 1,
    currentStateHash: H5,
    previousUsage: initialUsage,
    ...changes,
  };
}

function sealRequest(
  changes: Partial<SealMaterialRequest> = {},
): SealMaterialRequest {
  return {
    schemaVersion: 1,
    domain: "dark-factory.optimization-seal-material.v1",
    campaignId: CAMPAIGN,
    lineageId: LINEAGE,
    protocolHash: PROTOCOL,
    claimHash: H4,
    experimentNumber: 1,
    currentStateHash: H5,
    stage: "pre-validation",
    disposition: "rejected",
    candidateCommit: null,
    resultSealHash: HF,
    promotionLookDelta: 0,
    ...changes,
  };
}

interface FixtureControls {
  operationBudget: BudgetSnapshot;
  reconciliation: TrustedOnlineErrorBudgetReconciliation;
  completionMutation:
    | ((
        value: TrustedCompletionAccountingAttestation,
      ) => TrustedCompletionAccountingAttestation)
    | null;
  interruptionMutation:
    | ((
        value: TrustedInterruptedAccountingAttestation,
      ) => TrustedInterruptedAccountingAttestation)
    | null;
  sealMutation:
    | ((
        value: TrustedCampaignSealAuthorization,
      ) => TrustedCampaignSealAuthorization)
    | null;
}

function fixture(record: DurableExperimentJournalRecord) {
  const controls: FixtureControls = {
    operationBudget: { limits, usage: journalUsage },
    reconciliation: reconciliation(),
    completionMutation: null,
    interruptionMutation: null,
    sealMutation: null,
  };
  const closeAndRead = vi.fn(
    async (
      request: TrustedInFlightOperationLedgerUsageRequest,
    ): Promise<TrustedInFlightOperationLedgerUsage> => ({
      schemaVersion: 1,
      sensitivity: "release-safe-in-flight-operation-ledger-usage",
      requestHash: request.requestHash,
      campaignId: request.request.campaignId,
      lineageId: request.request.lineageId,
      protocolHash: request.request.protocolHash,
      claimHash: request.request.claimHash,
      experimentNumber: request.request.experimentNumber,
      currentStateHash: request.request.currentStateHash,
      budget: structuredClone(controls.operationBudget),
      closed: true,
      operationLedgerAttestationHash: H7,
    }),
  );
  const attestCompletion = vi.fn(
    async (
      request: TrustedCompletionAccountingAttestationRequest,
    ): Promise<TrustedCompletionAccountingAttestation> => {
      const value: TrustedCompletionAccountingAttestation = {
        schemaVersion: 1,
        sensitivity:
          "release-safe-optimization-completion-accounting-attestation",
        requestHash: request.requestHash,
        accountingAttestationHash: H8,
        nextUsage: request.request.reportedUsage,
      };
      return controls.completionMutation?.(value) ?? value;
    },
  );
  const attestInterruption = vi.fn(
    async (
      request: TrustedInterruptedAccountingAttestationRequest,
    ): Promise<TrustedInterruptedAccountingAttestation> => {
      const value: TrustedInterruptedAccountingAttestation = {
        schemaVersion: 1,
        sensitivity:
          "release-safe-optimization-interruption-accounting-attestation",
        requestHash: request.requestHash,
        accountingAttestationHash: H8,
        nextUsage: request.mergedUsage,
        onlineErrorReconciliation:
          request.observedOnlineErrorReconciliation,
      };
      return controls.interruptionMutation?.(value) ?? value;
    },
  );
  const authorize = vi.fn(
    async (
      request: TrustedCampaignSealAuthorizationRequest,
    ): Promise<TrustedCampaignSealAuthorization> => {
      const value: TrustedCampaignSealAuthorization = {
        schemaVersion: 1,
        sensitivity:
          "release-safe-optimization-campaign-seal-authorization",
        requestHash: request.requestHash,
        decisionAttestationHash: H8,
        holdoutAvailabilityAttestationHash:
          request.request.stage === "validation" ? H9 : null,
        sealedAt: SEALED_AT,
        ledgers,
      };
      return controls.sealMutation?.(value) ?? value;
    },
  );
  const onlineErrorAuthority: TrustedOnlineErrorBudgetAuthority = {
    boundary: "trusted-cloud-online-error-authority",
    reserve: async () => {
      throw new Error("Not used by completion material.");
    },
    reconcile: vi.fn(async () =>
      structuredClone(controls.reconciliation),
    ),
  };
  const port = new ProductionOptimizationCompletionMaterial({
    journalStateStore: new MemoryJournalStore(journalState(record)),
    onlineErrorAuthority,
    operationLedgerUsage: {
      boundary: "trusted-cloud",
      closeAndRead,
    },
    accountingAuthority: {
      boundary: "trusted-cloud",
      attestCompletion,
      attestInterruption,
    },
    sealAuthority: {
      boundary: "trusted-cloud",
      authorize,
    },
  });
  return {
    port,
    controls,
    closeAndRead,
    attestCompletion,
    attestInterruption,
    authorize,
  };
}

describe("ProductionOptimizationCompletionMaterial", () => {
  it(
    "binds normal accounting and seal material to the exact sealed journal and replays exactly",
    async () => {
      const context = fixture(sealedRecord());

      const firstAccounting =
        await context.port.createBudgetAccountingAttestation(
          completionRequest(),
        );
      const secondAccounting =
        await context.port.createBudgetAccountingAttestation(
          completionRequest(),
        );
      expect(secondAccounting).toEqual(firstAccounting);
      expect(firstAccounting.nextUsage).toEqual(journalUsage);
      expect(context.attestCompletion).toHaveBeenCalledTimes(2);
      expect(
        context.attestCompletion.mock.calls.map(
          ([request]) => request.requestHash,
        ),
      ).toEqual([
        context.attestCompletion.mock.calls[0]?.[0].requestHash,
        context.attestCompletion.mock.calls[0]?.[0].requestHash,
      ]);

      const firstSeal =
        await context.port.createSealMaterial(sealRequest());
      const secondSeal =
        await context.port.createSealMaterial(sealRequest());
      expect(secondSeal).toEqual(firstSeal);
      expect(firstSeal).toEqual({
        decisionAttestationHash: H8,
        holdoutAvailabilityAttestationHash: null,
        sealedAt: SEALED_AT,
        ledgers,
      });
      expect(context.authorize).toHaveBeenCalledTimes(2);
      expect(context.authorize.mock.calls[1]?.[0].requestHash).toBe(
        context.authorize.mock.calls[0]?.[0].requestHash,
      );
    },
  );

  it(
    "rejects stale or detached journal identity, seal, and reported usage before attestation",
    async () => {
      const context = fixture(sealedRecord());
      await expect(
        context.port.createBudgetAccountingAttestation(
          completionRequest({ lineageId: "lineage-detached" }),
        ),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
      await expect(
        context.port.createBudgetAccountingAttestation(
          completionRequest({ resultSealHash: H1 }),
        ),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
      await expect(
        context.port.createBudgetAccountingAttestation(
          completionRequest({
            reportedUsage: { ...journalUsage, tokens: 31 },
          }),
        ),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
      expect(context.attestCompletion).not.toHaveBeenCalled();
    },
  );

  it(
    "burns evaluator alpha ahead of the journal and merges cost and promotion looks ahead in the operation ledger",
    async () => {
      const context = fixture(interruptedRecord());
      context.controls.operationBudget = {
        limits,
        usage: {
          ...journalUsage,
          spentUsd: 9,
          tokens: 90,
          promotionLooks: 1,
        },
      };
      context.controls.reconciliation = reconciliation(0.02);

      const material =
        await context.port.createInterruptedBudgetAccountingAttestation(
          interruptionRequest(),
        );

      expect(material.nextUsage).toEqual({
        ...context.controls.operationBudget.usage,
        onlineErrorSpent: 0.02,
      });
      expect(material.onlineErrorReconciliation).toEqual(
        context.controls.reconciliation,
      );
      expect(context.attestInterruption).toHaveBeenCalledWith(
        expect.objectContaining({
          mergedUsage: material.nextUsage,
          onlineErrorState: expect.objectContaining({
            onlineErrorSpent: 0.02,
          }),
        }),
      );
    },
  );

  it("rejects operation-ledger limit changes, resets, and evaluator-alpha detachment", async () => {
    const alteredLimits = fixture(interruptedRecord());
    alteredLimits.controls.operationBudget = {
      limits: { ...limits, maximumUsd: 99 },
      usage: journalUsage,
    };
    await expect(
      alteredLimits.port.createInterruptedBudgetAccountingAttestation(
        interruptionRequest(),
      ),
    ).rejects.toBeInstanceOf(
      ProductionOptimizationCompletionMaterialError,
    );

    const reset = fixture(interruptedRecord());
    reset.controls.operationBudget = {
      limits,
      usage: { ...initialUsage, spentUsd: 1 },
    };
    await expect(
      reset.port.createInterruptedBudgetAccountingAttestation(
        interruptionRequest(),
      ),
    ).rejects.toBeInstanceOf(
      ProductionOptimizationCompletionMaterialError,
    );

    const alphaReset = fixture(interruptedRecord());
    alphaReset.controls.reconciliation = reconciliation(0);
    await expect(
      alphaReset.port.createInterruptedBudgetAccountingAttestation(
        interruptionRequest({
          previousUsage: {
            ...initialUsage,
            onlineErrorSpent: 0.01,
          },
        }),
      ),
    ).rejects.toBeInstanceOf(
      ProductionOptimizationCompletionMaterialError,
    );
  });

  it(
    "rejects accounting-authority counter tamper and seal-authority timestamp or pointer tamper",
    async () => {
      const accounting = fixture(interruptedRecord());
      accounting.controls.interruptionMutation = (value) => ({
        ...value,
        nextUsage: {
          ...value.nextUsage,
          spentUsd: value.nextUsage.spentUsd - 1,
        },
      });
      await expect(
        accounting.port.createInterruptedBudgetAccountingAttestation(
          interruptionRequest(),
        ),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );

      const seal = fixture(sealedRecord());
      seal.controls.sealMutation = (value) => ({
        ...value,
        sealedAt: "2026-07-26T10:05:01.000Z",
      });
      await expect(
        seal.port.createSealMaterial(sealRequest()),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
      seal.controls.sealMutation = (value) => ({
        ...value,
        ledgers: {
          ...value.ledgers,
          privacyLedgerHash: "not-a-hash",
        },
      });
      await expect(
        seal.port.createSealMaterial(sealRequest()),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
    },
  );

  it(
    "replays interruption material with one stable request hash and rejects a changed authority replay",
    async () => {
      const context = fixture(interruptedRecord());
      const first =
        await context.port.createInterruptedBudgetAccountingAttestation(
          interruptionRequest(),
        );
      const second =
        await context.port.createInterruptedBudgetAccountingAttestation(
          interruptionRequest(),
        );
      expect(second).toEqual(first);
      expect(context.attestInterruption).toHaveBeenCalledTimes(2);
      expect(
        context.attestInterruption.mock.calls[1]?.[0].requestHash,
      ).toBe(
        context.attestInterruption.mock.calls[0]?.[0].requestHash,
      );

      context.controls.interruptionMutation = (value) => ({
        ...value,
        onlineErrorReconciliation: reobserveReconciliation(
          value.onlineErrorReconciliation,
          "2026-07-26T10:06:01.000Z",
        ),
      });
      await expect(
        context.port.createInterruptedBudgetAccountingAttestation(
          interruptionRequest(),
        ),
      ).rejects.toBeInstanceOf(
        ProductionOptimizationCompletionMaterialError,
      );
    },
  );
});
