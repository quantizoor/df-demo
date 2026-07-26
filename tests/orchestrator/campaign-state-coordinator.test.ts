import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CampaignStateStore,
  type CampaignStateData,
} from "../../src/campaign/index.js";
import type { BudgetSnapshot } from "../../src/domain/models.js";
import {
  hashOnlineErrorBudgetReconciliation,
  onlineErrorBudgetCampaignIdHash,
} from "../../src/evaluator/online-error-authority.js";
import {
  CampaignStateOptimizationCoordinator,
  type OptimizationInterruptionRecord,
  type TrustedOptimizationCompletionMaterialPort,
  type TrustedOptimizationInputFactory,
  type TrustedOptimizationInterruptionPort,
  type TrustedOptimizationResumeVerifier,
} from "../../src/orchestrator/campaign-state-coordinator.js";
import type {
  ExperimentRunInput,
  ExperimentRunResult,
} from "../../src/orchestrator/contracts.js";
import { canonicalHash } from "../../src/schemas/canonical.js";
import {
  HASH_A,
  HASH_B,
  HASH_C,
  HASH_D,
  LATER,
  campaignSeed,
} from "../campaign/fixtures.js";

const RESULT_SEAL_HASH = "6".repeat(64);
const ACCOUNTING_HASH = "7".repeat(64);
const DECISION_HASH = "8".repeat(64);
const HOLDOUT_HASH = "9".repeat(64);
const INTERRUPTION_BROKER_HASH = "0".repeat(64);
const PAUSE_HASH = "1".repeat(64);

const temporaryDirectories: string[] = [];

async function initializedStore(
  seed: CampaignStateData = campaignSeed(),
): Promise<CampaignStateStore> {
  const root = await mkdtemp(
    join(tmpdir(), "df-coordinator-test-"),
  );
  temporaryDirectories.push(root);
  const store = new CampaignStateStore(root, "campaign-001", {
    now: () => new Date(LATER),
    ledgerTransitionVerifier: {
      verify: async () => undefined,
    },
    decisionAttestationVerifier: {
      verify: async () => undefined,
    },
    controlAttestationVerifier: {
      verify: async () => undefined,
    },
  });
  await store.initialize(seed);
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
  );
});

function preparedInput(
  context: Parameters<
    TrustedOptimizationInputFactory["prepareOrResume"]
  >[0],
  repairAttemptOrdinal: 1 | 2 = 1,
): ExperimentRunInput {
  return {
    experiment: {
      number: context.experimentNumber,
      slug: context.sourceOnlyBootstrap
        ? "source-only-bootstrap"
        : "diagnostic-repair",
      kind: "optimization",
      parentExperiment:
        context.allocationSnapshot.activeChampion.activeExperiment,
      lineageId: context.lineageId,
      protocolHash: context.protocolHash,
    },
    activeChampion: context.allocationSnapshot.activeChampion,
    budget: context.allocationSnapshot.budget,
    diagnosticBrief: context.sourceOnlyBootstrap
      ? null
      : {
          hash: HASH_A,
          releaseId: "diagnostic:001",
          actionable: true,
        },
    previousDiscoveryAttestationHash:
      context.sourceOnlyBootstrap ? null : HASH_B,
    repairAttemptOrdinal,
    stop: { requested: false },
  };
}

function inputFactory(
  repairAttemptOrdinal: 1 | 2 = 1,
): TrustedOptimizationInputFactory {
  let persistedBinding: Parameters<
    TrustedOptimizationInputFactory["bindClaim"]
  >[0] | null = null;
  return {
    boundary: "trusted-cloud",
    prepareOrResume: vi.fn(async (context) =>
      preparedInput(context, repairAttemptOrdinal),
    ),
    bindClaim: vi.fn(async (binding) => {
      if (
        persistedBinding !== null &&
        canonicalHash(persistedBinding) !==
          canonicalHash(binding)
      ) {
        throw new Error("Conflicting persisted claim binding.");
      }
      persistedBinding = binding;
    }),
  };
}

function resumeVerifier(): TrustedOptimizationResumeVerifier {
  return {
    boundary: "trusted-cloud",
    verify: vi.fn(async () => undefined),
  };
}

function completionMaterial(
  interruptedOnlineErrorSpent = 0,
  interruptedUsage: Partial<BudgetSnapshot["usage"]> = {},
): TrustedOptimizationCompletionMaterialPort {
  return {
    boundary: "trusted-cloud",
    createBudgetAccountingAttestation: vi.fn(
      async (request) => ({
        accountingAttestationHash: ACCOUNTING_HASH,
        nextUsage: {
          ...request.previousUsage,
          ...request.reportedUsage,
        },
      }),
    ),
    createInterruptedBudgetAccountingAttestation: vi.fn(
      async (request) => {
        const maximumOnlineError = 0.05;
        const gatesSpent =
          interruptedOnlineErrorSpent === 0 ? 0 : 1;
        const unsigned = {
          sensitivity:
            "release-safe-online-error-reconciliation" as const,
          schemaVersion: 1 as const,
          campaignIdHash: onlineErrorBudgetCampaignIdHash(
            request.campaignId,
          ),
          storeRevision: gatesSpent,
          policyVersion: "online-alpha-spending-v1" as const,
          maximumOnlineError,
          onlineErrorSpent: interruptedOnlineErrorSpent,
          onlineErrorRemaining:
            maximumOnlineError - interruptedOnlineErrorSpent,
          gatesSpent,
          resultingStateHash: HASH_C,
          durableStateCommitment: HASH_D,
          observedAt: LATER,
        };
        return {
          accountingAttestationHash: ACCOUNTING_HASH,
          nextUsage: {
            ...request.previousUsage,
            ...interruptedUsage,
            onlineErrorSpent: interruptedOnlineErrorSpent,
          },
          onlineErrorReconciliation: {
            ...unsigned,
            reconciliationHash:
              hashOnlineErrorBudgetReconciliation(unsigned),
          },
        };
      },
    ),
    createSealMaterial: vi.fn(async (request) => ({
      decisionAttestationHash: DECISION_HASH,
      holdoutAvailabilityAttestationHash:
        request.stage === "validation" ? HOLDOUT_HASH : null,
      sealedAt: LATER,
      ledgers: {
        brokerExposureStateAttestationHash: HASH_B,
        repeatedTestingLedgerHash: HASH_C,
        privacyLedgerHash: HASH_D,
        cacheStateAttestationHash: null,
        publicationQueueHash: null,
      },
    })),
  };
}

interface MutableInterruptionPort
  extends TrustedOptimizationInterruptionPort {
  pending: OptimizationInterruptionRecord | null;
}

function interruptionPort(
  control:
    | {
        readonly kind: "pause";
        readonly reason: "infrastructure";
        readonly attestationHash: string;
      }
    | {
        readonly kind: "stop";
        readonly reason: "operator";
      } = {
    kind: "pause",
    reason: "infrastructure",
    attestationHash: PAUSE_HASH,
  },
): MutableInterruptionPort {
  const port: MutableInterruptionPort = {
    boundary: "trusted-cloud",
    pending: null,
    begin: vi.fn(async (draft) => {
      const recordDraft = {
        ...draft,
        brokerExposureStateAttestationHash:
          INTERRUPTION_BROKER_HASH,
      };
      const record: OptimizationInterruptionRecord = {
        ...recordDraft,
        recordHash: canonicalHash(recordDraft),
      };
      port.pending = record;
      return record;
    }),
    findPending: vi.fn(async () => port.pending),
    prepareControl: vi.fn(async () => control),
    markApplied: vi.fn(async () => {
      port.pending = null;
    }),
  };
  return port;
}

function coordinator(input: {
  readonly store: CampaignStateStore;
  readonly inputFactory?: TrustedOptimizationInputFactory;
  readonly resumeVerifier?: TrustedOptimizationResumeVerifier;
  readonly completionMaterial?: TrustedOptimizationCompletionMaterialPort;
  readonly interruption?: TrustedOptimizationInterruptionPort;
}) {
  return new CampaignStateOptimizationCoordinator({
    store: input.store,
    inputFactory: input.inputFactory ?? inputFactory(),
    resumeVerifier: input.resumeVerifier ?? resumeVerifier(),
    completionMaterial:
      input.completionMaterial ?? completionMaterial(),
    interruption: input.interruption ?? interruptionPort(),
  });
}

function spentBudget(
  before: BudgetSnapshot,
  input: {
    readonly attempts: number;
    readonly promotionLooks: 0 | 1;
  },
): BudgetSnapshot {
  return {
    limits: before.limits,
    usage: {
      ...before.usage,
      spentUsd: before.usage.spentUsd + 1,
      tokens: before.usage.tokens + 100,
      wallTimeMs: before.usage.wallTimeMs + 1_000,
      attempts: before.usage.attempts + input.attempts,
      promotionLooks:
        before.usage.promotionLooks + input.promotionLooks,
    },
  };
}

function rejectedResult(
  claim: Awaited<
    ReturnType<CampaignStateOptimizationCoordinator["claimNext"]>
  >,
  budget: BudgetSnapshot,
): ExperimentRunResult {
  if (claim.kind !== "claimed") {
    throw new Error("Expected a claimed experiment.");
  }
  return {
    disposition: "rejected",
    activeChampion: claim.input.activeChampion,
    budget,
    diagnosticBrief: claim.input.diagnosticBrief,
    sealHash: RESULT_SEAL_HASH,
  };
}

describe("CampaignStateOptimizationCoordinator", () => {
  it("atomically allocates before returning a content-bound claim", async () => {
    const store = await initializedStore();
    const factory = inputFactory();
    const control = coordinator({ store, inputFactory: factory });
    const before = await control.load();

    const claim = await control.claimNext(before.stateHash);

    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    const durable = await store.read();
    expect(claim).toMatchObject({
      priorStateHash: before.stateHash,
      allocationStateHash: durable.contentHash,
      currentStateHash: durable.contentHash,
    });
    expect(claim.snapshot).toMatchObject({
      nextExperimentNumber: 2,
      inFlightExperimentNumber: 1,
      inFlightKind: "optimization",
    });
    expect(claim.claimHash).toBe(
      canonicalHash({
        domain: "dark-factory.optimization-claim.v2",
        priorStateHash: claim.priorStateHash,
        allocationStateHash: claim.allocationStateHash,
        input: claim.input,
      }),
    );
    expect(Object.keys(claim.input)).not.toContain("task");
    expect(factory.prepareOrResume).toHaveBeenCalledOnce();
    expect(factory.bindClaim).toHaveBeenCalledOnce();
  });

  it("surfaces CampaignState-only online-error exhaustion as a hard terminal budget", async () => {
    const seed = campaignSeed();
    const store = await initializedStore({
      ...seed,
      budget: {
        ...seed.budget,
        usage: {
          ...seed.budget.usage,
          onlineErrorSpent:
            seed.budget.limits.maximumOnlineError,
        },
      },
    });
    const control = coordinator({ store });

    const loaded = await control.load();
    const terminal = await control.claimNext(loaded.stateHash);

    expect(loaded.hardBudgetExhausted).toBe(true);
    expect(terminal).toMatchObject({
      kind: "terminal",
      reason: "budget-exhausted",
    });
    expect(
      (await store.read()).numbering.inFlightExperimentNumber,
    ).toBeNull();
  });

  it("resumes the same allocation and ordinal after an attested budget checkpoint", async () => {
    const store = await initializedStore();
    const factory = inputFactory(1);
    const verifier = resumeVerifier();
    const control = coordinator({
      store,
      inputFactory: factory,
      resumeVerifier: verifier,
    });
    const initial = await control.load();
    const first = await control.claimNext(initial.stateHash);
    if (first.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    const allocated = await store.read();
    const checkpoint = await store.recordBudgetUsage(
      allocated.contentHash,
      {
        ...allocated.budget.usage,
        spentUsd: 1,
        tokens: 100,
        wallTimeMs: 1_000,
        attempts: 5,
      },
      ACCOUNTING_HASH,
    );

    const resumed = await control.claimNext(checkpoint.contentHash);

    expect(resumed.kind).toBe("claimed");
    if (resumed.kind !== "claimed") return;
    expect(resumed.claimHash).toBe(first.claimHash);
    expect(resumed.allocationStateHash).toBe(
      first.allocationStateHash,
    );
    expect(resumed.currentStateHash).toBe(checkpoint.contentHash);
    expect(resumed.input).toEqual(first.input);
    expect(resumed.input.repairAttemptOrdinal).toBe(1);
    expect(factory.bindClaim).toHaveBeenCalledTimes(2);
    expect(resumed.snapshot.budget.usage.attempts).toBe(5);
    expect(
      vi.mocked(verifier.verify).mock.calls.at(-1)?.[0]
        .checkpoints,
    ).toHaveLength(1);
  });

  it.each([
    {
      label: "pre-validation",
      promotionLooks: 0 as const,
      expectedPanels: 6,
    },
    {
      label: "validation",
      promotionLooks: 1 as const,
      expectedPanels: 5,
    },
  ])(
    "seals $label completion with exact holdout accounting",
    async ({ promotionLooks, expectedPanels }) => {
      const store = await initializedStore();
      const materials = completionMaterial();
      const control = coordinator({
        store,
        completionMaterial: materials,
      });
      const initial = await control.load();
      const claim = await control.claimNext(initial.stateHash);
      if (claim.kind !== "claimed") {
        throw new Error("Expected a claimed experiment.");
      }
      const result = rejectedResult(
        claim,
        spentBudget(claim.input.budget, {
          attempts: promotionLooks === 1 ? 24 : 5,
          promotionLooks,
        }),
      );

      const completed = await control.complete({
        claimHash: claim.claimHash,
        currentStateHash: claim.currentStateHash,
        result,
      });
      const idempotentRetry = await control.complete({
        claimHash: claim.claimHash,
        currentStateHash: claim.currentStateHash,
        result,
      });

      expect(completed).toMatchObject({
        nextExperimentNumber: 2,
        inFlightExperimentNumber: null,
        inFlightKind: null,
        freshValidationPanelsRemaining: expectedPanels,
        budget: result.budget,
      });
      expect(idempotentRetry).toEqual(completed);
      expect(
        vi.mocked(materials.createSealMaterial).mock.calls[0]?.[0],
      ).toMatchObject({
        stage:
          promotionLooks === 1
            ? "validation"
            : "pre-validation",
        promotionLookDelta: promotionLooks,
      });
      expect(materials.createSealMaterial).toHaveBeenCalledOnce();
    },
  );

  it("rejects a stale pre-allocation state without mutating in-flight work", async () => {
    const store = await initializedStore();
    const control = coordinator({ store });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    const result = rejectedResult(
      claim,
      spentBudget(claim.input.budget, {
        attempts: 5,
        promotionLooks: 0,
      }),
    );

    await expect(
      control.complete({
        claimHash: claim.claimHash,
        currentStateHash: claim.priorStateHash,
        result,
      }),
    ).rejects.toThrow(/stale or detached/u);
    expect(
      (await store.read()).numbering.inFlightExperimentNumber,
    ).toBe(1);
  });

  it("archives an interrupted claim before applying its trusted pause", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort();
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }

    const interrupted = await control.interrupt({
      claimHash: claim.claimHash,
      currentStateHash: claim.currentStateHash,
      failureClass: "infrastructure",
    });

    const durable = await store.read();
    expect(interrupted).toMatchObject({
      status: "paused",
      inFlightExperimentNumber: null,
      inFlightKind: null,
    });
    expect(
      durable.numbering.lastInterruptedExperimentNumber,
    ).toBe(1);
    expect(durable.control).toMatchObject({
      status: "paused",
      pauseReason: "infrastructure",
      pauseAttestationHash: PAUSE_HASH,
    });
    expect(interruption.markApplied).toHaveBeenCalledOnce();
  });

  it("recovers an external stop by reconciling and archiving in-flight work before acknowledging it", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort({
      kind: "stop",
      reason: "operator",
    });
    const materials = completionMaterial(0.01, {
      spentUsd: 2,
      tokens: 200,
      wallTimeMs: 2_000,
      attempts: 5,
      promotionLooks: 1,
    });
    const control = coordinator({
      store,
      interruption,
      completionMaterial: materials,
    });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    const requested = await store.requestStop(
      claim.currentStateHash,
      "operator",
    );

    const recovered = await control.load();
    const durable = await store.read();

    expect(requested.control.status).toBe("stop-requested");
    expect(recovered).toMatchObject({
      status: "stopped",
      inFlightExperimentNumber: null,
      budget: {
        usage: {
          spentUsd: 2,
          tokens: 200,
          wallTimeMs: 2_000,
          attempts: 5,
          promotionLooks: 1,
          onlineErrorSpent: 0.01,
        },
      },
    });
    expect(durable.numbering.lastInterruptedExperimentNumber).toBe(1);
    expect(durable.control).toMatchObject({
      status: "stopped",
      stopReason: "operator",
    });
    expect(
      materials.createInterruptedBudgetAccountingAttestation,
    ).toHaveBeenCalledOnce();
    expect(interruption.begin).toHaveBeenCalledOnce();
    expect(interruption.markApplied).toHaveBeenCalledOnce();
  });

  it("lets a durable external stop supersede a pending infrastructure pause after archival", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort();
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    await interruption.begin({
      schemaVersion: 1,
      domain: "dark-factory.optimization-interruption.v1",
      campaignId: "campaign-001",
      lineageId: "lineage-001",
      protocolHash: claim.input.experiment.protocolHash,
      experimentNumber: claim.input.experiment.number,
      claimHash: claim.claimHash,
      allocationStateHash: claim.allocationStateHash,
      failureClass: "infrastructure",
    });
    await store.requestStop(claim.currentStateHash, "operator");

    const recovered = await control.load();
    const durable = await store.read();

    expect(recovered).toMatchObject({
      status: "stopped",
      inFlightExperimentNumber: null,
    });
    expect(durable.numbering.lastInterruptedExperimentNumber).toBe(1);
    expect(durable.control).toMatchObject({
      status: "stopped",
      stopReason: "operator",
    });
    expect(interruption.prepareControl).toHaveBeenCalledOnce();
    expect(interruption.markApplied).toHaveBeenCalledOnce();
  });

  it("reuses the archive-state control binding after a crash between stop acknowledgement and interruption finalization", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort({
      kind: "stop",
      reason: "operator",
    });
    let preparedStateHash: string | null = null;
    Object.assign(interruption, {
      prepareControl: vi.fn(
        async (
          input: Parameters<
            TrustedOptimizationInterruptionPort["prepareControl"]
          >[0],
        ) => {
          if (
            preparedStateHash !== null &&
            preparedStateHash !== input.currentStateHash
          ) {
            throw new Error("Control binding changed during recovery.");
          }
          preparedStateHash = input.currentStateHash;
          return { kind: "stop" as const, reason: "operator" as const };
        },
      ),
      markApplied: vi
        .fn()
        .mockRejectedValueOnce(
          new Error("Simulated crash before interruption finalization."),
        )
        .mockImplementationOnce(async () => {
          interruption.pending = null;
        }),
    });
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    await store.requestStop(claim.currentStateHash, "operator");

    await expect(control.load()).rejects.toThrow(
      /Simulated crash before interruption finalization/u,
    );
    expect((await store.read()).control.status).toBe("stopped");

    const recovered = await control.load();

    expect(recovered.status).toBe("stopped");
    expect(interruption.prepareControl).toHaveBeenCalledTimes(2);
    const preparedHashes = vi
      .mocked(interruption.prepareControl)
      .mock.calls.map(([input]) => input.currentStateHash);
    expect(new Set(preparedHashes).size).toBe(1);
    expect(interruption.markApplied).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an operator-stop authorization conflicts with the durable external stop reason", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort({
      kind: "stop",
      reason: "operator",
    });
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    await store.requestStop(claim.currentStateHash, "sigterm");

    await expect(control.load()).rejects.toThrow(
      /coordination failed/u,
    );
    expect((await store.read()).control).toMatchObject({
      status: "stop-requested",
      stopReason: "sigterm",
    });
    expect(interruption.markApplied).not.toHaveBeenCalled();
  });

  it("finishes and seals an in-flight result after an external stop, then acknowledges the campaign", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort({
      kind: "stop",
      reason: "operator",
    });
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    await store.requestStop(claim.currentStateHash, "operator");
    const result = rejectedResult(
      claim,
      spentBudget(claim.input.budget, {
        attempts: 5,
        promotionLooks: 0,
      }),
    );

    const completed = await control.complete({
      claimHash: claim.claimHash,
      currentStateHash: claim.currentStateHash,
      result,
    });
    const repeated = await control.complete({
      claimHash: claim.claimHash,
      currentStateHash: claim.currentStateHash,
      result,
    });
    const durable = await store.read();

    expect(completed).toMatchObject({
      status: "stopped",
      inFlightExperimentNumber: null,
      nextExperimentNumber: 2,
    });
    expect(repeated).toEqual(completed);
    expect(durable.numbering.lastInterruptedExperimentNumber).toBeNull();
    expect(
      durable.reconstruction.lastFullySealedExperimentNumber,
    ).toBe(1);
    expect(durable.control).toMatchObject({
      status: "stopped",
      stopReason: "operator",
    });
    expect(interruption.begin).not.toHaveBeenCalled();
  });

  it("acknowledges an external idle stop without manufacturing an interruption", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort({
      kind: "stop",
      reason: "operator",
    });
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    await store.requestStop(initial.stateHash, "operator");

    const stopped = await control.load();

    expect(stopped).toMatchObject({
      status: "stopped",
      inFlightExperimentNumber: null,
      nextExperimentNumber: 1,
    });
    expect(interruption.begin).not.toHaveBeenCalled();
    expect(interruption.markApplied).not.toHaveBeenCalled();
  });

  it("reconciles evaluator-burned online error before archiving an interrupted claim", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort();
    const materials = completionMaterial(0.01, {
      spentUsd: 2,
      tokens: 200,
      wallTimeMs: 2_000,
      attempts: 5,
      promotionLooks: 1,
    });
    const control = coordinator({
      store,
      interruption,
      completionMaterial: materials,
    });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }

    const interrupted = await control.interrupt({
      claimHash: claim.claimHash,
      currentStateHash: claim.currentStateHash,
      failureClass: "infrastructure",
    });

    const durable = await store.read();
    expect(interrupted.budget.usage.onlineErrorSpent).toBe(0.01);
    expect(durable.budget.usage.onlineErrorSpent).toBe(0.01);
    expect(durable.budget.usage).toMatchObject({
      spentUsd: 2,
      tokens: 200,
      wallTimeMs: 2_000,
      attempts: 5,
      promotionLooks: 1,
    });
    expect(durable.budget.accountingAttestationHash).toBe(
      ACCOUNTING_HASH,
    );
    expect(
      materials.createInterruptedBudgetAccountingAttestation,
    ).toHaveBeenCalledOnce();
    expect(durable.numbering.inFlightExperimentNumber).toBeNull();
    expect(durable.numbering.lastInterruptedExperimentNumber).toBe(1);
  });

  it("does not double-charge a reconciled online-error checkpoint after a crash", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort();
    const materials = completionMaterial(0.01);
    const control = coordinator({
      store,
      interruption,
      completionMaterial: materials,
    });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    const record = await interruption.begin({
      schemaVersion: 1,
      domain: "dark-factory.optimization-interruption.v1",
      campaignId: "campaign-001",
      lineageId: "lineage-001",
      protocolHash: claim.input.experiment.protocolHash,
      experimentNumber: claim.input.experiment.number,
      claimHash: claim.claimHash,
      allocationStateHash: claim.allocationStateHash,
      failureClass: "infrastructure",
    });
    const checkpoint = await store.recordBudgetUsage(
      claim.currentStateHash,
      {
        ...claim.input.budget.usage,
        onlineErrorSpent: 0.01,
      },
      ACCOUNTING_HASH,
    );

    const recovered = await control.load();

    expect(recovered.status).toBe("paused");
    expect(recovered.budget.usage.onlineErrorSpent).toBe(0.01);
    expect(
      (await store.read()).budget.accountingAttestationHash,
    ).toBe(ACCOUNTING_HASH);
    expect(
      materials.createInterruptedBudgetAccountingAttestation,
    ).toHaveBeenCalledOnce();
    expect(
      vi.mocked(
        materials.createInterruptedBudgetAccountingAttestation,
      ).mock.calls[0]?.[0].currentStateHash,
    ).toBe(checkpoint.contentHash);
    expect(record.recordHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("finishes a pending pause when a crash occurred after archival", async () => {
    const store = await initializedStore();
    const interruption = interruptionPort();
    const control = coordinator({ store, interruption });
    const initial = await control.load();
    const claim = await control.claimNext(initial.stateHash);
    if (claim.kind !== "claimed") {
      throw new Error("Expected a claimed experiment.");
    }
    const record = await interruption.begin({
      schemaVersion: 1,
      domain: "dark-factory.optimization-interruption.v1",
      campaignId: "campaign-001",
      lineageId: "lineage-001",
      protocolHash: claim.input.experiment.protocolHash,
      experimentNumber: claim.input.experiment.number,
      claimHash: claim.claimHash,
      allocationStateHash: claim.allocationStateHash,
      failureClass: "infrastructure",
    });
    await store.archiveInterruptedExperiment(
      claim.currentStateHash,
      claim.input.experiment.number,
      record.brokerExposureStateAttestationHash,
    );

    const recovered = await control.load();

    expect(recovered.status).toBe("paused");
    expect(recovered.inFlightExperimentNumber).toBeNull();
    expect(interruption.prepareControl).toHaveBeenCalledOnce();
    expect(interruption.markApplied).toHaveBeenCalledOnce();
  });
});
