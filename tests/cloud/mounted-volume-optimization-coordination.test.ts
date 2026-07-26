import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  AttestedTrustedOptimizationResumeVerifier,
  DurableTrustedOptimizationInputFactory,
  DurableTrustedOptimizationInterruptionPort,
  MountedVolumeOptimizationCoordinationPorts,
  assertDurableOptimizationCoordinationState,
  emptyOptimizationCoordinationState,
  optimizationResumeCheckpointChainHash,
  type AtomicOptimizationCoordinationStateStore,
  type DurableOptimizationCoordinationState,
  type TaskFreeOptimizationDiagnosticDiscovery,
  type TrustedOptimizationInterruptionAuthority,
  type TrustedOptimizationResumeAttestationAuthority,
  type TrustedTaskFreeOptimizationDiagnosticResolver,
} from "../../src/cloud/mounted-volume-optimization-coordination.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type {
  OptimizationInputPreparationContext,
  OptimizationInterruptionRecordDraft,
  OptimizationResumeVerification,
  PersistedOptimizationClaimBinding,
} from "../../src/orchestrator/campaign-state-coordinator.js";
import type {
  ExperimentRunInput,
} from "../../src/orchestrator/contracts.js";
import { canonicalHash } from "../../src/schemas/canonical.js";

const CAMPAIGN_ID = "campaign-a";
const LINEAGE_ID = "lineage-a";
const PROTOCOL_HASH = "1".repeat(64);
const DISCOVERY_HASH = "2".repeat(64);
const DIAGNOSTIC_HASH = "3".repeat(64);
const BROKER_EXPOSURE_HASH = "4".repeat(64);
const BROKER_AUTHORIZATION_HASH = "5".repeat(64);
const CONTROL_ATTESTATION_HASH = "6".repeat(64);
const CONTROL_AUTHORIZATION_HASH = "7".repeat(64);
const FINAL_STATE_HASH = "8".repeat(64);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
  );
});

class MemoryCoordinationState
  implements AtomicOptimizationCoordinationStateStore
{
  public value: DurableOptimizationCoordinationState;

  public constructor() {
    this.value = emptyOptimizationCoordinationState(
      canonicalHash({ scope: "test" }),
    );
  }

  public async transact<Result>(
    operation: (state: DurableOptimizationCoordinationState) => {
      readonly next: DurableOptimizationCoordinationState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transition = operation(structuredClone(this.value));
    assertDurableOptimizationCoordinationState(
      transition.next,
      this.value.storeScopeHash,
    );
    this.value = structuredClone(transition.next);
    return structuredClone(transition.result);
  }
}

function budget() {
  return {
    limits: {
      maximumUsd: 100,
      maximumTokens: 1_000_000,
      maximumWallTimeMs: 3_600_000,
      maximumAttempts: 100,
      maximumPrivacyReleases: 10,
      maximumPromotionLooks: 10,
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
}

function context(
  experimentNumber: number,
  input: {
    readonly allocationStateHash?: string;
    readonly priorStateHash?: string;
    readonly activeExperiment?: number;
    readonly activeCommit?: string;
  } = {},
): OptimizationInputPreparationContext {
  const allocationStateHash =
    input.allocationStateHash ??
    (experimentNumber + 1).toString(16).repeat(64);
  const priorStateHash =
    input.priorStateHash ??
    (experimentNumber + 8).toString(16).repeat(64);
  const activeExperiment = input.activeExperiment ?? 0;
  const activeCommit = input.activeCommit ?? "a".repeat(40);
  return {
    schemaVersion: 1,
    domain: "dark-factory.optimization-input-preparation.v1",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    priorStateHash,
    allocationStateHash,
    allocationSnapshot: {
      schemaVersion: 1,
      campaignId: CAMPAIGN_ID,
      lineageId: LINEAGE_ID,
      protocolHash: PROTOCOL_HASH,
      stateHash: allocationStateHash,
      status: "running",
      nextExperimentNumber: experimentNumber + 1,
      inFlightExperimentNumber: experimentNumber,
      inFlightKind: "optimization",
      activeChampion: {
        baselineCommit: "b".repeat(40),
        activeExperiment,
        activeCommit,
        certifiedExperiment: null,
        certifiedCommit: null,
        updatedAt: "2026-07-26T10:00:00.000Z",
        sourceSealHash: "c".repeat(64),
      },
      budget: budget(),
      hardBudgetExhausted: false,
      freshValidationPanelsRemaining: 6,
    },
    experimentNumber,
    sourceOnlyBootstrap: experimentNumber === 1,
  };
}

function diagnosticBindingHash() {
  return canonicalHash({
    domain: "dark-factory.task-free-diagnostic-binding.v1",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    diagnosticBrief: {
      hash: DIAGNOSTIC_HASH,
      releaseId: "diagnostic:001",
      actionable: true,
    },
    previousDiscoveryAttestationHash: DISCOVERY_HASH,
  });
}

function discovery(
  preparation: OptimizationInputPreparationContext,
  input: {
    readonly ordinal?: 1 | 2;
    readonly priorAllocationStateHash?: string | null;
    readonly priorClaimHash?: string | null;
    readonly resolutionHash?: string;
  } = {},
): TaskFreeOptimizationDiagnosticDiscovery {
  const ordinal = input.ordinal ?? 1;
  return {
    schemaVersion: 1,
    domain:
      "dark-factory.task-free-optimization-diagnostic-discovery.v1",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    experimentNumber: preparation.experimentNumber,
    allocationStateHash: preparation.allocationStateHash,
    diagnosticBrief: {
      hash: DIAGNOSTIC_HASH,
      releaseId: "diagnostic:001",
      actionable: true,
    },
    previousDiscoveryAttestationHash: DISCOVERY_HASH,
    repairAttemptOrdinal: ordinal,
    priorAllocationStateHash:
      input.priorAllocationStateHash ??
      (ordinal === 1 ? null : "d".repeat(64)),
    priorClaimHash:
      input.priorClaimHash ??
      (ordinal === 1 ? null : "e".repeat(64)),
    diagnosticBindingHash: diagnosticBindingHash(),
    resolutionAttestationHash:
      input.resolutionHash ??
      (ordinal === 1 ? "f" : "0").repeat(64),
    containsTaskIdentifiers: false,
  };
}

function claimBinding(
  preparation: OptimizationInputPreparationContext,
  runInput: ExperimentRunInput,
): PersistedOptimizationClaimBinding {
  return {
    schemaVersion: 1,
    domain: "dark-factory.optimization-claim-binding.v1",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    experimentNumber: preparation.experimentNumber,
    priorStateHash: preparation.priorStateHash,
    allocationStateHash: preparation.allocationStateHash,
    claimHash: canonicalHash({
      domain: "dark-factory.optimization-claim.v2",
      priorStateHash: preparation.priorStateHash,
      allocationStateHash: preparation.allocationStateHash,
      input: runInput,
    }),
    inputHash: canonicalHash(runInput),
    previousDiscoveryAttestationHash:
      runInput.previousDiscoveryAttestationHash,
    repairAttemptOrdinal: runInput.repairAttemptOrdinal,
  };
}

function resolver(
  implementation: TrustedTaskFreeOptimizationDiagnosticResolver["resolve"],
): TrustedTaskFreeOptimizationDiagnosticResolver {
  return {
    boundary: "trusted-cloud",
    resolve: implementation,
  };
}

function resumeAttestation(
  path: OptimizationResumeVerification,
  authorizationHash = "9".repeat(64),
) {
  return {
    schemaVersion: 1 as const,
    sensitivity:
      "release-safe-optimization-resume-path-attestation" as const,
    pathHash: canonicalHash(path),
    checkpointChainHash:
      optimizationResumeCheckpointChainHash(path),
    checkpointCount: path.checkpoints.length,
    authorizationAttestationHash: authorizationHash,
    signerKeyId: "campaign-resume-key",
    containsTaskIdentifiers: false as const,
  };
}

function resumeAuthority(
  implementation?: TrustedOptimizationResumeAttestationAuthority["verifyAndAttest"],
): TrustedOptimizationResumeAttestationAuthority {
  return {
    boundary: "trusted-cloud-attestation-authority",
    verifyAndAttest:
      implementation ??
      (async (path) => resumeAttestation(path)),
  };
}

function interruptionDraft() {
  return {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.optimization-interruption.v1" as const,
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    experimentNumber: 2,
    claimHash: "a".repeat(64),
    allocationStateHash: "b".repeat(64),
    failureClass: "infrastructure" as const,
  };
}

function draftHash(
  draft: Omit<
    OptimizationInterruptionRecordDraft,
    "brokerExposureStateAttestationHash"
  >,
) {
  return canonicalHash({
    domain:
      "dark-factory.optimization-interruption-draft-binding.v1",
    draft,
  });
}

function interruptionAuthority(input: {
  readonly brokerAuthorizationHash?: string;
  readonly attestBrokerExposure?: TrustedOptimizationInterruptionAuthority["attestBrokerExposure"];
  readonly authorizeControl?: TrustedOptimizationInterruptionAuthority["authorizeControl"];
} = {}): TrustedOptimizationInterruptionAuthority {
  return {
    boundary: "trusted-cloud-attestation-authority",
    attestBrokerExposure:
      input.attestBrokerExposure ??
      (async (draft) => ({
        schemaVersion: 1,
        sensitivity:
          "release-safe-optimization-broker-exposure-attestation",
        draftHash: draftHash(draft),
        brokerExposureStateAttestationHash:
          BROKER_EXPOSURE_HASH,
        authorizationAttestationHash:
          input.brokerAuthorizationHash ??
          BROKER_AUTHORIZATION_HASH,
        containsTaskIdentifiers: false,
      })),
    authorizeControl:
      input.authorizeControl ??
      (async ({ record, currentStateHash }) => {
        const control = {
          kind: "pause" as const,
          reason: "infrastructure" as const,
          attestationHash: CONTROL_ATTESTATION_HASH,
        };
        return {
          schemaVersion: 1,
          sensitivity:
            "release-safe-optimization-interruption-control-authorization",
          recordHash: record.recordHash,
          currentStateHash,
          control,
          controlHash: canonicalHash(control),
          authorizationAttestationHash:
            CONTROL_AUTHORIZATION_HASH,
          containsTaskIdentifiers: false,
        };
      }),
  };
}

function resumePath(
  checkpoints: OptimizationResumeVerification["checkpoints"] = [],
): OptimizationResumeVerification {
  const allocationStateHash = "b".repeat(64);
  return {
    schemaVersion: 1,
    domain: "dark-factory.optimization-resume-path.v1",
    campaignId: CAMPAIGN_ID,
    lineageId: LINEAGE_ID,
    protocolHash: PROTOCOL_HASH,
    experimentNumber: 2,
    priorStateHash: "a".repeat(64),
    allocationStateHash,
    currentStateHash:
      checkpoints.at(-1)?.stateHash ?? allocationStateHash,
    checkpoints,
  };
}

describe("durable optimization input factory", () => {
  it("persists one byte-identical source-only claim preparation", async () => {
    const state = new MemoryCoordinationState();
    const resolve = vi.fn(async () => {
      throw new Error("Bootstrap must not query diagnostics.");
    });
    const factory =
      new DurableTrustedOptimizationInputFactory({
        state,
        diagnosticResolver: resolver(resolve),
      });
    const preparation = context(1);

    const first = await factory.prepareOrResume(preparation);
    const retry = await factory.prepareOrResume(
      structuredClone(preparation),
    );
    await factory.bindClaim(
      claimBinding(preparation, first),
    );
    await factory.bindClaim(
      claimBinding(preparation, first),
    );

    expect(retry).toEqual(first);
    expect(resolve).not.toHaveBeenCalled();
    expect(state.value.revision).toBe(2);
    expect(JSON.stringify(state.value)).not.toMatch(
      /taskId|panelId|packageTaskName/u,
    );
  });

  it("allows exactly one ordinal-2 continuation of the same task-free discovery", async () => {
    const state = new MemoryCoordinationState();
    let priorAllocation: string | null = null;
    let priorClaim: string | null = null;
    const factory =
      new DurableTrustedOptimizationInputFactory({
        state,
        diagnosticResolver: resolver(async (preparation) =>
          discovery(preparation, {
            ordinal:
              preparation.experimentNumber === 2 ? 1 : 2,
            priorAllocationStateHash: priorAllocation,
            priorClaimHash: priorClaim,
            resolutionHash:
              preparation.experimentNumber === 2
                ? "d".repeat(64)
                : "e".repeat(64),
          }),
      });
    const firstContext = context(2, {
      allocationStateHash: "2".repeat(64),
    });
    const first = await factory.prepareOrResume(firstContext);
    const binding = claimBinding(firstContext, first);
    await factory.bindClaim(binding);
    priorAllocation = firstContext.allocationStateHash;
    priorClaim = binding.claimHash;
    const secondContext = context(3, {
      allocationStateHash: "3".repeat(64),
      activeCommit:
        firstContext.allocationSnapshot.activeChampion.activeCommit,
    });

    const second =
      await factory.prepareOrResume(secondContext);

    expect(second.repairAttemptOrdinal).toBe(2);
    expect(second.diagnosticBrief).toEqual(
      first.diagnosticBrief,
    );
    expect(
      second.previousDiscoveryAttestationHash,
    ).toBe(first.previousDiscoveryAttestationHash);

    const resetFactory =
      new DurableTrustedOptimizationInputFactory({
        state,
        diagnosticResolver: resolver(async (preparation) =>
          discovery(preparation, {
            ordinal: 1,
            resolutionHash: "0".repeat(64),
          }),
        ),
      });
    await expect(
      resetFactory.prepareOrResume(
        context(4, {
          allocationStateHash: "4".repeat(64),
        }),
      ),
    ).rejects.toThrow();
  });

  it("linearizes concurrent preparation and rejects a conflicting claim rebind", async () => {
    const state = new MemoryCoordinationState();
    const preparation = context(2, {
      allocationStateHash: "5".repeat(64),
    });
    const resolve = vi.fn(async () =>
      discovery(preparation, {
        resolutionHash: "6".repeat(64),
      }),
    );
    const factory =
      new DurableTrustedOptimizationInputFactory({
        state,
        diagnosticResolver: resolver(resolve),
      });

    const [left, right] = await Promise.all([
      factory.prepareOrResume(preparation),
      factory.prepareOrResume(preparation),
    ]);
    const binding = claimBinding(preparation, left);
    await factory.bindClaim(binding);

    expect(right).toEqual(left);
    expect(state.value.revision).toBe(2);
    await expect(
      factory.bindClaim({
        ...binding,
        claimHash: "7".repeat(64),
      }),
    ).rejects.toThrow();
  });
});

describe("attested optimization resume verifier", () => {
  it("persists only authorized strict checkpoint-chain extensions", async () => {
    const state = new MemoryCoordinationState();
    let calls = 0;
    const authority = resumeAuthority(async (path) => {
      calls += 1;
      return resumeAttestation(
        path,
        (calls + 8).toString(16).repeat(64),
      );
    });
    const verifier =
      new AttestedTrustedOptimizationResumeVerifier({
        state,
        authority,
      });
    const initial = resumePath();
    const checkpoint = {
      stateHash: "c".repeat(64),
      previousStateHash: initial.allocationStateHash,
      budgetAccountingAttestationHash: "d".repeat(64),
      brokerExposureStateAttestationHash: null,
      repeatedTestingLedgerHash: "e".repeat(64),
      privacyLedgerHash: "f".repeat(64),
      cacheStateAttestationHash: null,
      publicationQueueHash: null,
    };
    const extended = resumePath([checkpoint]);

    await verifier.verify(initial);
    await verifier.verify(initial);
    await verifier.verify(extended);

    expect(calls).toBe(2);
    expect(state.value.revision).toBe(2);
    await expect(verifier.verify(initial)).rejects.toThrow();
    await expect(
      verifier.verify(
        resumePath([
          {
            ...checkpoint,
            previousStateHash: "0".repeat(64),
          },
        ]),
      ),
    ).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("rejects a mismatched authority binding without committing it", async () => {
    const state = new MemoryCoordinationState();
    const verifier =
      new AttestedTrustedOptimizationResumeVerifier({
        state,
        authority: resumeAuthority(async (path) => ({
          ...resumeAttestation(path),
          pathHash: "0".repeat(64),
        })),
      });

    await expect(verifier.verify(resumePath())).rejects.toThrow();
    expect(state.value.revision).toBe(0);
  });
});

describe("durable optimization interruption port", () => {
  it("persists intent before return and CAS-binds one authorized final state", async () => {
    const state = new MemoryCoordinationState();
    const port =
      new DurableTrustedOptimizationInterruptionPort({
        state,
        authority: interruptionAuthority(),
      });
    const draft = interruptionDraft();

    const record = await port.begin(draft);
    const retry = await port.begin(draft);
    const pending = await port.findPending({
      campaignId: CAMPAIGN_ID,
      lineageId: LINEAGE_ID,
      protocolHash: PROTOCOL_HASH,
      currentStateHash: "c".repeat(64),
    });
    const control = await port.prepareControl({
      record,
      currentStateHash: "d".repeat(64),
    });
    const controlRetry = await port.prepareControl({
      record,
      currentStateHash: "d".repeat(64),
    });
    await port.markApplied({
      recordHash: record.recordHash,
      finalStateHash: FINAL_STATE_HASH,
    });
    await port.markApplied({
      recordHash: record.recordHash,
      finalStateHash: FINAL_STATE_HASH,
    });

    expect(retry).toEqual(record);
    expect(pending).toEqual(record);
    expect(controlRetry).toEqual(control);
    expect(state.value.revision).toBe(3);
    await expect(
      port.markApplied({
        recordHash: record.recordHash,
        finalStateHash: "9".repeat(64),
      }),
    ).rejects.toThrow();
    await expect(
      port.findPending({
        campaignId: CAMPAIGN_ID,
        lineageId: LINEAGE_ID,
        protocolHash: PROTOCOL_HASH,
        currentStateHash: FINAL_STATE_HASH,
      }),
    ).resolves.toBeNull();
  });

  it("rejects adversarial broker and control authority responses", async () => {
    const brokerState = new MemoryCoordinationState();
    const brokerPort =
      new DurableTrustedOptimizationInterruptionPort({
        state: brokerState,
        authority: interruptionAuthority({
          attestBrokerExposure: async (draft) => ({
            schemaVersion: 1,
            sensitivity:
              "release-safe-optimization-broker-exposure-attestation",
            draftHash: canonicalHash(draft),
            brokerExposureStateAttestationHash:
              BROKER_EXPOSURE_HASH,
            authorizationAttestationHash:
              BROKER_AUTHORIZATION_HASH,
            containsTaskIdentifiers: false,
          }),
        }),
      });
    await expect(
      brokerPort.begin(interruptionDraft()),
    ).rejects.toThrow();
    expect(brokerState.value.revision).toBe(0);

    const controlState = new MemoryCoordinationState();
    const controlPort =
      new DurableTrustedOptimizationInterruptionPort({
        state: controlState,
        authority: interruptionAuthority({
          authorizeControl: async ({
            record,
            currentStateHash,
          }) => {
            const control = {
              kind: "pause" as const,
              reason: "infrastructure" as const,
              attestationHash: CONTROL_ATTESTATION_HASH,
            };
            return {
              schemaVersion: 1,
              sensitivity:
                "release-safe-optimization-interruption-control-authorization",
              recordHash: record.recordHash,
              currentStateHash,
              control,
              controlHash: "0".repeat(64),
              authorizationAttestationHash:
                CONTROL_AUTHORIZATION_HASH,
              containsTaskIdentifiers: false,
            };
          },
        }),
      });
    const record = await controlPort.begin(
      interruptionDraft(),
    );
    await expect(
      controlPort.prepareControl({
        record,
        currentStateHash: "d".repeat(64),
      }),
    ).rejects.toThrow();
    expect(controlState.value.revision).toBe(1);
  });

  it("detects corruption and forbidden identity-shaped fields", () => {
    const state = emptyOptimizationCoordinationState(
      canonicalHash({ scope: "corruption-test" }),
    );
    const corrupted = {
      ...state,
      taskId: "hidden-task",
    };

    expect(() =>
      assertDurableOptimizationCoordinationState(corrupted),
    ).toThrow();
  });
});

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};
const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function durableOptions(
  root: string,
  controllerHash: string,
  nonce: string,
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-a",
    controllerInstanceIdHash: controllerHash,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function unusedResolver(): TrustedTaskFreeOptimizationDiagnosticResolver {
  return resolver(async () => {
    throw new Error("Unexpected diagnostic resolution.");
  });
}

describe("mounted-volume optimization coordination handoff", () => {
  it("recovers each interruption crash window without re-authorizing", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-optimization-coordination-test-"),
    );
    temporaryDirectories.push(root);
    const first = new MountedVolumeOptimizationCoordinationPorts({
      durableState: durableOptions(
        root,
        "1".repeat(64),
        "a".repeat(48),
      ),
      diagnosticResolver: unusedResolver(),
      resumeAuthority: resumeAuthority(),
      interruptionAuthority: interruptionAuthority(),
    });
    const record = await first.interruption.begin(
      interruptionDraft(),
    );
    await first.close();

    const authorizeControl = vi.fn(
      interruptionAuthority().authorizeControl,
    );
    const second = new MountedVolumeOptimizationCoordinationPorts({
      durableState: durableOptions(
        root,
        "2".repeat(64),
        "b".repeat(48),
      ),
      diagnosticResolver: unusedResolver(),
      resumeAuthority: resumeAuthority(),
      interruptionAuthority: interruptionAuthority({
        authorizeControl,
      }),
    });
    const pending = await second.interruption.findPending({
      campaignId: CAMPAIGN_ID,
      lineageId: LINEAGE_ID,
      protocolHash: PROTOCOL_HASH,
      currentStateHash: "c".repeat(64),
    });
    expect(pending).toEqual(record);
    const control = await second.interruption.prepareControl({
      record,
      currentStateHash: "d".repeat(64),
    });
    expect(authorizeControl).toHaveBeenCalledOnce();
    await second.close();

    const third = new MountedVolumeOptimizationCoordinationPorts({
      durableState: durableOptions(
        root,
        "3".repeat(64),
        "c".repeat(48),
      ),
      diagnosticResolver: unusedResolver(),
      resumeAuthority: resumeAuthority(),
      interruptionAuthority: interruptionAuthority({
        authorizeControl: async () => {
          throw new Error("Persisted control must be reused.");
        },
      }),
    });
    await expect(
      third.interruption.prepareControl({
        record,
        currentStateHash: "d".repeat(64),
      }),
    ).resolves.toEqual(control);
    await third.interruption.markApplied({
      recordHash: record.recordHash,
      finalStateHash: FINAL_STATE_HASH,
    });
    await expect(
      third.interruption.findPending({
        campaignId: CAMPAIGN_ID,
        lineageId: LINEAGE_ID,
        protocolHash: PROTOCOL_HASH,
        currentStateHash: FINAL_STATE_HASH,
      }),
    ).resolves.toBeNull();
    await third.close();
  });

  it("reuses a committed input after a clean controller handoff", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-optimization-input-test-"),
    );
    temporaryDirectories.push(root);
    const first = new MountedVolumeOptimizationCoordinationPorts({
      durableState: durableOptions(
        root,
        "4".repeat(64),
        "d".repeat(48),
      ),
      diagnosticResolver: unusedResolver(),
      resumeAuthority: resumeAuthority(),
      interruptionAuthority: interruptionAuthority(),
    });
    const preparation = context(1, {
      allocationStateHash: "5".repeat(64),
      priorStateHash: "6".repeat(64),
    });
    const input =
      await first.inputFactory.prepareOrResume(preparation);
    await first.close();

    const successorResolver = vi.fn(async () => {
      throw new Error("Committed input must be read.");
    });
    const successor =
      new MountedVolumeOptimizationCoordinationPorts({
        durableState: durableOptions(
          root,
          "5".repeat(64),
          "e".repeat(48),
        ),
        diagnosticResolver: resolver(successorResolver),
        resumeAuthority: resumeAuthority(),
        interruptionAuthority: interruptionAuthority(),
      });
    await expect(
      successor.inputFactory.prepareOrResume(preparation),
    ).resolves.toEqual(input);
    expect(successorResolver).not.toHaveBeenCalled();
    await successor.close();
  });
});
