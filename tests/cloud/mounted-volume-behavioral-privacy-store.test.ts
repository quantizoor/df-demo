import { generateKeyPairSync } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TrustedArtifactRuntimeGuard } from "../../src/cloud/artifact-bridge.js";
import {
  MountedVolumeBehavioralPrivacyArtifactStore,
} from "../../src/cloud/mounted-volume-behavioral-privacy-store.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import {
  DeterministicPostDestructionBehavioralReleaseProducer,
  type TrustedBehavioralPrivacyArtifactStore,
} from "../../src/evaluator/behavioral-release-producer.js";
import type { TrustedPrivateBehavioralPreparation } from "../../src/evaluator/deriver.js";
import { createPrivacyBudget } from "../../src/evaluation/privacy.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  canonicalHash,
  canonicalJson,
  withContentHash,
} from "../../src/schemas/canonical.js";
import {
  behaviorWithFailure,
  behaviorWithoutFailure,
  digest,
} from "../evaluation/fixtures.js";

const CREATED_AT = "2026-07-26T10:12:00.000Z";
const keys = generateKeyPairSync("ed25519");
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
    storeId: "campaign-behavioral",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    nonceFactory: () => nonce,
  };
}

function store(
  root: string,
  state = durableState(root),
): MountedVolumeBehavioralPrivacyArtifactStore {
  return new MountedVolumeBehavioralPrivacyArtifactStore({
    durableState: state,
    initialPrivacyState: createPrivacyBudget(8),
  });
}

function preparation(
  overrides: Partial<TrustedPrivateBehavioralPreparation> = {},
): TrustedPrivateBehavioralPreparation {
  const observations = Array.from({ length: 12 }, (_, index) => {
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
  }).flat();
  return {
    sensitivity: "trusted-private-behavioral-preparation",
    requestHash: digest(100),
    protocolHash: digest(101),
    experimentNumber: 1,
    behaviorSourceSetHash: digest(102),
    analysisWindow: {
      openedAt: "2026-07-26T10:01:00.000Z",
      closedAt: "2026-07-26T10:10:00.000Z",
    },
    observations,
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
    forbiddenReleaseLiterals: ["private-evaluator-literal"],
    forbiddenContentFingerprints: [],
    graderCanaryFingerprints: [],
    ...overrides,
  };
}

function producer(
  behavioralStore: TrustedBehavioralPrivacyArtifactStore,
): DeterministicPostDestructionBehavioralReleaseProducer {
  return new DeterministicPostDestructionBehavioralReleaseProducer({
    deployment: "trusted-cloud",
    store: behavioralStore,
    keyId: "behavioral-release-key-1",
    privateKeys: {
      boundary: "trusted-cloud",
      resolve: (input) =>
        Promise.resolve({
          boundary: "trusted-cloud-key-material",
          algorithm: "Ed25519",
          purpose: input.purpose,
          keyId: input.keyId,
          keyVersion: "test-v1",
          privateKey: keys.privateKey,
        }),
    },
    publicKeys: {
      boundary: "trusted-cloud",
      resolve: (input) =>
        Promise.resolve({
          boundary: "trusted-cloud-key-material",
          algorithm: "Ed25519",
          purpose: input.purpose,
          keyId: input.keyId,
          keyVersion: "test-v1",
          publicKey: keys.publicKey,
        }),
    },
    now: () => new Date(CREATED_AT),
  });
}

const destructionReceipt = {
  destroyedAt: "2026-07-26T10:11:00.000Z",
  verifierAttestationHash: digest(103),
};

function artifactSetHash(
  artifacts: Parameters<
    TrustedBehavioralPrivacyArtifactStore["commit"]
  >[0]["artifacts"],
): string {
  return canonicalHash({
    domain: "dark-factory.behavioral-release-artifact-set.v1",
    artifacts: artifacts
      .map(({ purpose, document }) => ({
        purpose,
        contentHash: document.contentHash,
      }))
      .sort((left, right) =>
        left.purpose.localeCompare(right.purpose),
      ),
  });
}

class CapturingBehavioralStore
  implements TrustedBehavioralPrivacyArtifactStore
{
  readonly boundary = "trusted-cloud" as const;
  commitInput:
    | Parameters<
        TrustedBehavioralPrivacyArtifactStore["commit"]
      >[0]
    | undefined;

  constructor(
    readonly inner: MountedVolumeBehavioralPrivacyArtifactStore,
  ) {}

  load(): ReturnType<TrustedBehavioralPrivacyArtifactStore["load"]> {
    return this.inner.load();
  }

  resolveByContentHash(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["resolveByContentHash"]
    >[0],
  ): ReturnType<
    TrustedBehavioralPrivacyArtifactStore["resolveByContentHash"]
  > {
    return this.inner.resolveByContentHash(input);
  }

  inspectCommit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
    >[0],
  ): ReturnType<
    TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
  > {
    return this.inner.inspectCommit(input);
  }

  commit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0],
  ): ReturnType<TrustedBehavioralPrivacyArtifactStore["commit"]> {
    this.commitInput = JSON.parse(
      canonicalJson(input),
    ) as typeof input;
    return this.inner.commit(input);
  }

  orphan(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["orphan"]
    >[0],
  ): ReturnType<TrustedBehavioralPrivacyArtifactStore["orphan"]> {
    return this.inner.orphan(input);
  }
}

class DoubleLostCommitAcknowledgementStore
  implements TrustedBehavioralPrivacyArtifactStore
{
  readonly boundary = "trusted-cloud" as const;
  commitAttempts = 0;
  orphanAttempts = 0;
  commitInput:
    | Parameters<
        TrustedBehavioralPrivacyArtifactStore["commit"]
      >[0]
    | undefined;

  constructor(
    readonly inner: MountedVolumeBehavioralPrivacyArtifactStore,
  ) {}

  load(): ReturnType<TrustedBehavioralPrivacyArtifactStore["load"]> {
    return this.inner.load();
  }

  resolveByContentHash(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["resolveByContentHash"]
    >[0],
  ): ReturnType<
    TrustedBehavioralPrivacyArtifactStore["resolveByContentHash"]
  > {
    return this.inner.resolveByContentHash(input);
  }

  inspectCommit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
    >[0],
  ): ReturnType<
    TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
  > {
    return this.inner.inspectCommit(input);
  }

  async commit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0],
  ): Promise<never> {
    this.commitInput = input;
    this.commitAttempts += 1;
    await this.inner.commit(input);
    this.commitAttempts += 1;
    await this.inner.commit(input);
    throw new Error("both durable commit acknowledgements were lost");
  }

  orphan(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["orphan"]
    >[0],
  ): ReturnType<TrustedBehavioralPrivacyArtifactStore["orphan"]> {
    this.orphanAttempts += 1;
    return this.inner.orphan(input);
  }
}

async function finalize(
  behavioralStore: TrustedBehavioralPrivacyArtifactStore,
) {
  const result = await producer(behavioralStore).finalize({
    preparation: preparation(),
    sourceResultEnvelopeHash: digest(104),
    destructionReceipt,
  });
  if (result === null) {
    throw new Error("Expected a behavioral release.");
  }
  return result;
}

describe("mounted-volume behavioral privacy artifact store", () => {
  it("recovers after two lost commit acknowledgements without orphaning, refunding, or rebinding", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-behavioral-double-lost-ack-"),
    );
    const durable = store(root);
    const lossy = new DoubleLostCommitAcknowledgementStore(durable);
    const finalization = await finalize(lossy);
    const committed = lossy.commitInput;
    if (committed === undefined) {
      throw new Error("Expected a captured durable commit.");
    }
    expect(lossy.commitAttempts).toBe(2);
    expect(lossy.orphanAttempts).toBe(0);
    await expect(durable.load()).resolves.toMatchObject({
      privacyState: { releasesUsed: 1, maximumReleases: 8 },
    });
    await expect(
      durable.inspectCommit({
        authorizationHash: committed.authorizationHash,
        requestHash: committed.requestHash,
        sourceResultEnvelopeHash:
          committed.sourceResultEnvelopeHash,
        releaseContentHash: committed.releaseContentHash,
        artifactSetHash: artifactSetHash(committed.artifacts),
      }),
    ).resolves.toMatchObject({
      status: "committed",
      orphanedAt: null,
      receipt: {
        authorizationHash: finalization.authorizationHash,
      },
    });
    await expect(
      durable.resolveByContentHash({
        purpose: "behavioral-release",
        contentHash: finalization.contentHash,
      }),
    ).resolves.toMatchObject({ purpose: "behavioral-release" });
    await expect(
      durable.commit({
        ...committed,
        authorizationHash: digest(160),
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPrivacyArtifactStoreError",
    });
    await expect(durable.load()).resolves.toMatchObject({
      privacyState: { releasesUsed: 1 },
    });
    expect(lossy.orphanAttempts).toBe(0);
    await durable.close();
  });

  it("atomically persists privacy spend and all four exact artifacts across handoff", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-behavioral-privacy-"),
    );
    const first = store(root);
    const capture = new CapturingBehavioralStore(first);
    const finalization = await finalize(capture);
    const committed = capture.commitInput;
    if (committed === undefined) {
      throw new Error("Expected a captured commit.");
    }
    const beforeInspection = await first.load();
    const exactQuery = {
      authorizationHash: committed.authorizationHash,
      requestHash: committed.requestHash,
      sourceResultEnvelopeHash:
        committed.sourceResultEnvelopeHash,
      releaseContentHash: committed.releaseContentHash,
      artifactSetHash: artifactSetHash(committed.artifacts),
    };
    await expect(first.inspectCommit(exactQuery)).resolves.toMatchObject({
      status: "committed",
      orphanedAt: null,
      receipt: {
        authorizationHash: finalization.authorizationHash,
        artifactSetHash: exactQuery.artifactSetHash,
      },
      artifactReferences: expect.arrayContaining([
        {
          purpose: "behavioral-release",
          contentHash: finalization.contentHash,
        },
      ]),
    });
    for (const field of [
      "authorizationHash",
      "requestHash",
      "sourceResultEnvelopeHash",
      "releaseContentHash",
      "artifactSetHash",
    ] as const) {
      await expect(
        first.inspectCommit({
          ...exactQuery,
          [field]: digest(150),
        }),
      ).resolves.toEqual({ status: "conflict" });
    }
    await expect(
      first.inspectCommit({
        authorizationHash: digest(151),
        requestHash: digest(152),
        sourceResultEnvelopeHash: digest(153),
        releaseContentHash: digest(154),
        artifactSetHash: digest(155),
      }),
    ).resolves.toEqual({ status: "absent" });
    expect(canonicalJson(await first.load())).toBe(
      canonicalJson(beforeInspection),
    );
    await expect(first.commit(committed)).resolves.toMatchObject({
      status: "already-committed",
      authorizationHash: finalization.authorizationHash,
    });
    await first.close();

    const successor = store(
      root,
      durableState(
        root,
        "2".repeat(64),
        "b".repeat(48),
      ),
    );
    await expect(successor.load()).resolves.toMatchObject({
      privacyState: { releasesUsed: 1, maximumReleases: 8 },
    });
    const release = await successor.resolveByContentHash({
      purpose: "behavioral-release",
      contentHash: finalization.contentHash,
    });
    expect(release?.purpose).toBe("behavioral-release");
    if (release?.purpose !== "behavioral-release") {
      throw new Error("Expected the signed release.");
    }
    const hashes = release.document.aggregateArtifactHashes;
    await expect(
      successor.resolveByContentHash({
        purpose: "behavioral-evidence",
        contentHash: hashes.behavioralEvidence,
      }),
    ).resolves.toMatchObject({ purpose: "behavioral-evidence" });
    await expect(
      successor.resolveByContentHash({
        purpose: "failure-cards",
        contentHash: hashes.failureCards,
      }),
    ).resolves.toMatchObject({ purpose: "failure-cards" });
    await expect(
      successor.resolveByContentHash({
        purpose: "diagnostic-brief",
        contentHash: hashes.diagnosticBrief,
      }),
    ).resolves.toMatchObject({ purpose: "diagnostic-brief" });
    await expect(successor.commit(committed)).resolves.toMatchObject({
      status: "already-committed",
    });
    await successor.close();
  });

  it("makes post-commit orphaning permanent, nonrefundable, and non-rebindable", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-behavioral-orphan-"),
    );
    const first = store(root);
    const capture = new CapturingBehavioralStore(first);
    const releaseProducer = producer(capture);
    const finalization = await releaseProducer.finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    if (finalization === null || capture.commitInput === undefined) {
      throw new Error("Expected a committed release.");
    }
    const committed = capture.commitInput;
    await releaseProducer.orphan(finalization);
    await expect(
      first.resolveByContentHash({
        purpose: "behavioral-release",
        contentHash: finalization.contentHash,
      }),
    ).resolves.toBeUndefined();
    await expect(first.load()).resolves.toMatchObject({
      privacyState: { releasesUsed: 1 },
    });
    await expect(
      first.inspectCommit({
        authorizationHash: committed.authorizationHash,
        requestHash: committed.requestHash,
        sourceResultEnvelopeHash:
          committed.sourceResultEnvelopeHash,
        releaseContentHash: committed.releaseContentHash,
        artifactSetHash: artifactSetHash(committed.artifacts),
      }),
    ).resolves.toMatchObject({
      status: "committed",
      orphanedAt: CREATED_AT,
    });
    await expect(
      first.orphan({
        authorizationHash: finalization.authorizationHash,
        requestHash: finalization.requestHash,
        releaseContentHash: finalization.contentHash,
        orphanedAt: "2026-07-26T10:13:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "already-orphaned",
      requestHash: finalization.requestHash,
      orphanedAt: CREATED_AT,
    });
    await expect(first.commit(committed)).resolves.toMatchObject({
      status: "already-committed",
    });
    await expect(
      first.commit({
        ...committed,
        authorizationHash: digest(110),
      }),
    ).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPrivacyArtifactStoreError",
    });
    await expect(
      first.resolveByContentHash({
        purpose: "behavioral-release",
        contentHash: finalization.contentHash,
      }),
    ).resolves.toBeUndefined();
    await first.close();
  });

  it("publishes no artifact prefix and spends no privacy on a malformed set", async () => {
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "df-behavioral-source-"),
    );
    const source = store(sourceRoot);
    const capture = new CapturingBehavioralStore(source);
    await finalize(capture);
    if (capture.commitInput === undefined) {
      throw new Error("Expected a captured commit.");
    }
    const valid = capture.commitInput;
    await source.close();

    const targetRoot = await mkdtemp(
      join(tmpdir(), "df-behavioral-target-"),
    );
    const target = store(targetRoot);
    const malformed = {
      ...valid,
      artifacts: [
        valid.artifacts[0],
        valid.artifacts[1],
        valid.artifacts[2],
        valid.artifacts[2],
      ],
    } as unknown as Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0];
    await expect(target.commit(malformed)).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPrivacyArtifactStoreError",
    });
    await expect(target.load()).resolves.toMatchObject({
      privacyState: { releasesUsed: 0 },
    });
    for (const artifact of valid.artifacts) {
      await expect(
        target.resolveByContentHash({
          purpose: artifact.purpose,
          contentHash: artifact.document.contentHash,
        }),
      ).resolves.toBeUndefined();
    }
    await target.close();
  });

  it(
    "requires provider destruction proof after a crash and fences the prior owner",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "df-behavioral-recovery-"),
      );
      const prior = store(root);
      const finalization = await finalize(prior);

      const unauthorized = store(
        root,
        durableState(
          root,
          "2".repeat(64),
          "b".repeat(48),
        ),
      );
      await expect(unauthorized.load()).rejects.toThrow(
        /provider-attested recovery is required/u,
      );

      const recovered = store(root, {
        ...durableState(
          root,
          "3".repeat(64),
          "c".repeat(48),
        ),
        recoveryAuthority: {
          authorize: ({ observedLock, observedLockHash }) =>
            Promise.resolve({
              schemaVersion: 1 as const,
              domain:
                "dark-factory.mounted-volume-lock-recovery.v1" as const,
              namespace: observedLock.namespace,
              authorizationId:
                "provider-destruction-behavioral-1",
              priorLockHash: observedLockHash,
              priorFenceEpoch: observedLock.fenceEpoch,
              providerTerminationAttestationHash: digest(120),
              authorizedAt: "2026-07-26T10:00:00.000Z",
              signerKeyId: "provider-termination-key",
              signatureHash: digest(121),
            }),
        },
      });
      await expect(
        recovered.resolveByContentHash({
          purpose: "behavioral-release",
          contentHash: finalization.contentHash,
        }),
      ).resolves.toMatchObject({ purpose: "behavioral-release" });
      await expect(prior.load()).rejects.toThrow(
        /ownership|continuity/u,
      );
      await recovered.close();
    },
  );

  it("revalidates cross-artifact bindings even when outer hashes are recomputed", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "df-behavioral-corruption-"),
    );
    const first = store(root);
    await finalize(first);
    await first.close();
    const statePath = join(
      root,
      "mutable-state",
      "stores",
      "behavioral-privacy-campaign-behavioral",
      "state.json",
    );
    const envelope = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as Record<string, unknown>;
    const state = envelope["state"] as Record<string, unknown>;
    const commits = state["commits"] as Record<
      string,
      Record<string, unknown>
    >;
    const commit = Object.values(commits)[0];
    if (commit === undefined) {
      throw new Error("Expected a durable commit.");
    }
    const artifacts = commit["artifacts"] as Array<
      Record<string, unknown>
    >;
    const firstArtifact = artifacts[0];
    if (firstArtifact === undefined) {
      throw new Error("Expected a durable artifact.");
    }
    firstArtifact["purpose"] = "failure-cards";
    envelope["stateHash"] = canonicalHash(state);
    delete envelope["contentHash"];
    const rehashed = withContentHash(envelope);
    await writeFile(statePath, `${canonicalJson(rehashed)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const successor = store(
      root,
      durableState(
        root,
        "2".repeat(64),
        "b".repeat(48),
      ),
    );
    await expect(successor.load()).rejects.toMatchObject({
      name: "MountedVolumeBehavioralPrivacyArtifactStoreError",
    });
    await successor.close();
  });
});
