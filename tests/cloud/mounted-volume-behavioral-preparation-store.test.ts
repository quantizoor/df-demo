import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import { MountedVolumeBehavioralPreparationStore } from "../../src/cloud/mounted-volume-behavioral-preparation-store.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "../../src/cloud/production-optimize-composition-owner.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  hashTrustedBehavioralPreparation,
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
} from "../../src/evaluator/behavioral-preparation-store.js";
import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
} from "../../src/evaluator/behavioral-release-producer.js";
import type { TrustedPrivateBehavioralPreparation } from "../../src/evaluator/deriver.js";
import { behaviorWithFailure, behaviorWithoutFailure, digest } from "../evaluation/fixtures.js";

const runtimeGuard: TrustedArtifactRuntimeGuard = {
  assertTrustedCloudRuntime() {},
};
const semanticsGuard: MountedVolumeStateSemanticsGuard = {
  assertLinearizableStateVolume() {},
};

function durableState(
  root: string,
  controller = "1".repeat(64),
  nonce = "a".repeat(48),
): MountedVolumeDurableStateOptions {
  return {
    volumeRoot: root,
    storeId: "campaign-preparation",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function preparation(
  overrides: Partial<TrustedPrivateBehavioralPreparation> = {},
): TrustedPrivateBehavioralPreparation {
  return {
    sensitivity: "trusted-private-behavioral-preparation",
    requestHash: digest(201),
    protocolHash: digest(202),
    experimentNumber: 1,
    behaviorSourceSetHash: digest(203),
    analysisWindow: {
      openedAt: "2026-07-26T10:01:00.000Z",
      closedAt: "2026-07-26T10:10:00.000Z",
    },
    observations: Array.from({ length: 12 }, (_, index) => {
      const taskId = hiddenTaskId(digest(index + 1));
      return [
        {
          taskId,
          arm: "candidate" as const,
          outcome: "fail" as const,
          behavior: behaviorWithFailure(),
        },
        {
          taskId,
          arm: "champion" as const,
          outcome: "pass" as const,
          behavior: behaviorWithoutFailure(),
        },
      ];
    }).flat(),
    policy: {
      diagnosticsEnabled: true,
      comparison: "candidate-vs-champion",
      maximumPrivacyReleases: 8,
      diagnosticTtlMs: 2 * 60 * 60_000,
      policyVersions: {
        protocol: "protocol-v1",
        broker: "broker-v1",
        extraction: "extraction-v1",
        statistics: "statistics-v1",
        privacy: "privacy-v1",
        weighting: "weighting-v1",
        cache: "cache-v1",
        repeatedTesting: "testing-v1",
        leakScanner: "scanner-v1",
      },
    },
    forbiddenReleaseLiterals: ["task-private-preparation-literal"],
    forbiddenContentFingerprints: [digest(204)],
    graderCanaryFingerprints: [digest(205)],
    ...overrides,
  };
}

function finalization(
  value: TrustedPrivateBehavioralPreparation = preparation(),
): TrustedBehavioralReleaseFinalization {
  return {
    contentHash: digest(206),
    sourceSetHash: value.behaviorSourceSetHash,
    privacyThresholdPassed: true,
    authorizationHash: digest(207),
    requestHash: value.requestHash,
  };
}

function orphanFinalization(
  release: TrustedBehavioralReleaseFinalization,
  orphanedAt = "2026-07-26T10:12:00.000Z",
): TrustedBehavioralReleaseOrphanFinalizationReceipt {
  const binding = {
    authorizationHash: release.authorizationHash,
    requestHash: release.requestHash,
    releaseContentHash: release.contentHash,
    sourceSetHash: release.sourceSetHash,
    orphanedAt,
  };
  return {
    status: "orphaned",
    ...binding,
    orphanFinalizationHash: hashTrustedBehavioralReleaseOrphanFinalization(binding),
  };
}

function store(
  root: string,
  state = durableState(root),
  lifecycle?: ProductionOptimizeLifecycleRegistrar,
): MountedVolumeBehavioralPreparationStore {
  return new MountedVolumeBehavioralPreparationStore({
    durableState: state,
    ...(lifecycle === undefined ? {} : { lifecycle }),
  });
}

describe("mounted-volume private behavioral preparation store", () => {
  it("durably resolves only an exact request and registers lifecycle ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-"));
    const registered: TrustedProductionOptimizeCloseable[] = [];
    const lifecycle: ProductionOptimizeLifecycleRegistrar = {
      boundary: "production-optimize-composition-owner",
      register: (resource) => {
        registered.push(resource);
      },
    };
    const first = store(root, durableState(root), lifecycle);
    const value = preparation();
    const expectedHash = hashTrustedBehavioralPreparation(value);

    await expect(first.prepare(value)).resolves.toEqual({
      status: "prepared",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash: expectedHash,
    });
    await expect(first.prepare(structuredClone(value))).resolves.toEqual({
      status: "already-prepared",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash: expectedHash,
    });
    expect(registered).toHaveLength(1);
    expect(registered[0]?.lifecycleId).toBe(first.lifecycleId);
    expect(
      Object.getOwnPropertyNames(MountedVolumeBehavioralPreparationStore.prototype),
    ).not.toEqual(expect.arrayContaining(["list", "scan", "entries", "values"]));

    await first.close();
    const successor = store(root, durableState(root, "2".repeat(64), "b".repeat(48)));
    await expect(
      successor.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "prepared",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash: expectedHash,
      preparation: value,
    });
    await expect(
      successor.resolve({
        requestHash: digest(299),
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "missing",
      requestHash: digest(299),
      protocolHash: value.protocolHash,
    });
    await expect(
      successor.resolve({
        requestHash: value.requestHash,
        protocolHash: digest(298),
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await successor.close();
  });

  it("erases private observations on exact finalization and cannot rebind or consume them", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-final-"));
    const durable = store(root);
    const value = preparation();
    const preparationHash = hashTrustedBehavioralPreparation(value);
    const release = finalization(value);
    const sourceResultEnvelopeHash = digest(208);
    const finalizationHash = hashTrustedBehavioralPreparationFinalization({
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalization: release,
    });
    await durable.prepare(value);

    await expect(
      durable.finalize({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash,
        sourceResultEnvelopeHash,
        finalization: release,
      }),
    ).resolves.toEqual({
      status: "finalized",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
    });
    await expect(
      durable.finalize({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash,
        sourceResultEnvelopeHash,
        finalization: structuredClone(release),
      }),
    ).resolves.toMatchObject({ status: "already-finalized" });
    await expect(
      durable.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "finalized",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      finalization: release,
    });
    await expect(
      durable.consume({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toMatchObject({
      status: "already-finalized",
      finalizationHash,
    });
    await expect(durable.prepare(value)).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await expect(
      durable.finalize({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash,
        sourceResultEnvelopeHash: digest(209),
        finalization: release,
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });

    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "behavioral-preparation-campaign-preparation",
      "state.json",
    );
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("task-private-preparation-literal");
    for (const observation of value.observations) {
      expect(persisted).not.toContain(observation.taskId);
    }
    await durable.close();
  });

  it("makes consumption durable, idempotent, and non-resurrectable", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-consumed-"));
    const durable = store(root);
    const value = preparation();
    const preparationHash = hashTrustedBehavioralPreparation(value);
    await durable.prepare(value);

    await expect(
      durable.consume({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "consumed",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
    });
    await expect(
      durable.consume({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toMatchObject({ status: "already-consumed" });
    await expect(
      durable.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "consumed",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
    });
    await expect(durable.prepare(value)).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await expect(
      durable.finalize({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash,
        sourceResultEnvelopeHash: digest(208),
        finalization: finalization(value),
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });

    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "behavioral-preparation-campaign-preparation",
      "state.json",
    );
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("task-private-preparation-literal");
    for (const observation of value.observations) {
      expect(persisted).not.toContain(observation.taskId);
    }
    await durable.close();
  });

  it("durably abandons only the exact finalized release and never makes it consumable or reusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-abandoned-"));
    const first = store(root);
    const value = preparation();
    const preparationHash = hashTrustedBehavioralPreparation(value);
    const release = finalization(value);
    const sourceResultEnvelopeHash = digest(208);
    const finalizationHash = hashTrustedBehavioralPreparationFinalization({
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalization: release,
    });
    const orphan = orphanFinalization(release);
    const abandonmentHash = hashTrustedBehavioralPreparationAbandonment({
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      orphanFinalizationHash: orphan.orphanFinalizationHash,
    });
    await first.prepare(value);
    await first.finalize({
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalization: release,
    });

    const abandonInput = {
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      orphanFinalization: orphan,
    } as const;
    await expect(first.abandon(abandonInput)).resolves.toEqual({
      status: "abandoned",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      orphanFinalizationHash: orphan.orphanFinalizationHash,
      abandonmentHash,
    });
    await expect(first.abandon(structuredClone(abandonInput))).resolves.toMatchObject({
      status: "already-abandoned",
      abandonmentHash,
    });
    await expect(
      first.consume({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "already-abandoned",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      orphanFinalizationHash: orphan.orphanFinalizationHash,
      abandonmentHash,
    });
    await expect(
      first.abandon({
        ...abandonInput,
        orphanFinalization: orphanFinalization(release, "2026-07-26T10:13:00.000Z"),
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await expect(
      first.finalize({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash,
        sourceResultEnvelopeHash,
        finalization: release,
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await expect(first.prepare(value)).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });

    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "behavioral-preparation-campaign-preparation",
      "state.json",
    );
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain("task-private-preparation-literal");
    expect(persisted).not.toContain("privacyThresholdPassed");
    for (const observation of value.observations) {
      expect(persisted).not.toContain(observation.taskId);
    }

    await first.close();
    const successor = store(root, durableState(root, "2".repeat(64), "b".repeat(48)));
    await expect(
      successor.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toEqual({
      status: "abandoned",
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash,
      sourceResultEnvelopeHash,
      finalizationHash,
      orphanFinalizationHash: orphan.orphanFinalizationHash,
      abandonmentHash,
      orphanFinalization: orphan,
    });
    await successor.close();
  });

  it("rejects conflicting replays without changing the original private preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-conflict-"));
    const durable = store(root);
    const value = preparation();
    await durable.prepare(value);
    const conflicting = preparation({
      behaviorSourceSetHash: digest(210),
    });

    await expect(durable.prepare(conflicting)).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPreparationStoreError",
    });
    await expect(
      durable.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toMatchObject({
      status: "prepared",
      preparationHash: hashTrustedBehavioralPreparation(value),
      preparation: {
        behaviorSourceSetHash: value.behaviorSourceSetHash,
      },
    });
    await durable.close();
  });

  it("requires provider termination proof for crash recovery and fences the predecessor", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-behavioral-preparation-recovery-"));
    const prior = store(root);
    const value = preparation();
    await prior.prepare(value);

    const unauthorized = store(root, durableState(root, "2".repeat(64), "b".repeat(48)));
    await expect(
      unauthorized.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).rejects.toThrow(/provider-attested recovery is required/u);

    const recovered = store(root, {
      ...durableState(root, "3".repeat(64), "c".repeat(48)),
      recoveryAuthority: {
        authorize: ({ observedLock, observedLockHash }) =>
          Promise.resolve({
            schemaVersion: 1 as const,
            domain: "dark-factory.mounted-volume-lock-recovery.v1" as const,
            namespace: observedLock.namespace,
            authorizationId: "provider-destruction-preparation-1",
            priorLockHash: observedLockHash,
            priorFenceEpoch: observedLock.fenceEpoch,
            providerTerminationAttestationHash: digest(211),
            authorizedAt: "2026-07-26T10:00:00.000Z",
            signerKeyId: "provider-termination-key",
            signatureHash: digest(212),
          }),
      },
    });
    await expect(
      recovered.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).resolves.toMatchObject({
      status: "prepared",
      preparation: { requestHash: value.requestHash },
    });
    await expect(
      prior.resolve({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
      }),
    ).rejects.toThrow(/ownership|continuity/u);
    await recovered.close();
  });
});
