import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DeterministicPostDestructionBehavioralReleaseProducer,
  hashHiddenPrivacyBudgetState,
  hashTrustedBehavioralReleaseOrphanFinalization,
  type BehavioralReleaseArtifact,
  type TrustedBehavioralPrivacyArtifactStore,
} from "../../src/evaluator/behavioral-release-producer.js";
import type { TrustedPrivateBehavioralPreparation } from "../../src/evaluator/deriver.js";
import { createPrivacyBudget } from "../../src/evaluation/privacy.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import { canonicalHash } from "../../src/schemas/canonical.js";
import {
  behaviorWithFailure,
  behaviorWithoutFailure,
  digest,
} from "../evaluation/fixtures.js";

const keys = generateKeyPairSync("ed25519");
const CREATED_AT = "2026-07-01T00:12:00.000Z";

function artifactSetHash(
  artifacts: readonly BehavioralReleaseArtifact[],
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

class AtomicMemoryBehavioralStore
  implements TrustedBehavioralPrivacyArtifactStore
{
  readonly boundary = "test-only-in-memory" as const;
  state = createPrivacyBudget(8);
  readonly artifacts = new Map<
    string,
    BehavioralReleaseArtifact
  >();
  readonly authorizations = new Map<
    string,
    {
      readonly requestHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly releaseHash: string;
      readonly privacyStateHash: string;
      readonly artifactSetHash: string;
      readonly artifactReferences: readonly [
        {
          readonly purpose: BehavioralReleaseArtifact["purpose"];
          readonly contentHash: string;
        },
        {
          readonly purpose: BehavioralReleaseArtifact["purpose"];
          readonly contentHash: string;
        },
        {
          readonly purpose: BehavioralReleaseArtifact["purpose"];
          readonly contentHash: string;
        },
        {
          readonly purpose: BehavioralReleaseArtifact["purpose"];
          readonly contentHash: string;
        },
      ];
    }
  >();
  readonly orphaned = new Set<string>();
  readonly orphanTimes = new Map<string, string>();
  failCommit = false;

  load() {
    return Promise.resolve({
      privacyState: this.state,
      privacyStateHash: hashHiddenPrivacyBudgetState(this.state),
    });
  }

  commit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0],
  ) {
    if (this.failCommit) {
      return Promise.reject(new Error("transaction aborted"));
    }
    const release = input.artifacts.find(
      (artifact) => artifact.purpose === "behavioral-release",
    );
    if (release === undefined) {
      return Promise.reject(new Error("release missing"));
    }
    if (release.document.contentHash !== input.releaseContentHash) {
      return Promise.reject(new Error("release binding mismatch"));
    }
    const bindingHash = canonicalHash({
      domain: "dark-factory.behavioral-release-one-use-binding.v1",
      authorizationHash: input.authorizationHash,
      requestHash: input.requestHash,
      sourceResultEnvelopeHash: input.sourceResultEnvelopeHash,
      releaseContentHash: input.releaseContentHash,
    });
    const previous = this.authorizations.get(input.authorizationHash);
    if (previous !== undefined) {
      if (
        previous.requestHash !== input.requestHash ||
        previous.sourceResultEnvelopeHash !==
          input.sourceResultEnvelopeHash ||
        previous.releaseHash !== input.releaseContentHash
      ) {
        return Promise.reject(new Error("authorization conflict"));
      }
      return Promise.resolve({
        status: "already-committed" as const,
        authorizationHash: input.authorizationHash,
        bindingHash,
        privacyStateHash: previous.privacyStateHash,
        artifactSetHash: previous.artifactSetHash,
      });
    }
    if (
      input.priorPrivacyStateHash !==
      hashHiddenPrivacyBudgetState(this.state)
    ) {
      return Promise.reject(new Error("privacy CAS conflict"));
    }
    if (
      [...this.authorizations.values()].some(
        (binding) =>
          binding.releaseHash === release.document.contentHash ||
          binding.requestHash === input.requestHash ||
          binding.sourceResultEnvelopeHash ===
            input.sourceResultEnvelopeHash,
      )
    ) {
      return Promise.reject(new Error("release cannot be rebound"));
    }
    this.state = input.nextPrivacyState;
    for (const artifact of input.artifacts) {
      this.artifacts.set(artifact.document.contentHash, artifact);
    }
    const committedArtifactSetHash = artifactSetHash(input.artifacts);
    const committedPrivacyStateHash =
      hashHiddenPrivacyBudgetState(this.state);
    this.authorizations.set(input.authorizationHash, {
      requestHash: input.requestHash,
      sourceResultEnvelopeHash: input.sourceResultEnvelopeHash,
      releaseHash: release.document.contentHash,
      privacyStateHash: committedPrivacyStateHash,
      artifactSetHash: committedArtifactSetHash,
      artifactReferences: [
        {
          purpose: input.artifacts[0].purpose,
          contentHash: input.artifacts[0].document.contentHash,
        },
        {
          purpose: input.artifacts[1].purpose,
          contentHash: input.artifacts[1].document.contentHash,
        },
        {
          purpose: input.artifacts[2].purpose,
          contentHash: input.artifacts[2].document.contentHash,
        },
        {
          purpose: input.artifacts[3].purpose,
          contentHash: input.artifacts[3].document.contentHash,
        },
      ],
    });
    return Promise.resolve({
      status: "committed" as const,
      authorizationHash: input.authorizationHash,
      bindingHash,
      privacyStateHash: committedPrivacyStateHash,
      artifactSetHash: committedArtifactSetHash,
    });
  }

  inspectCommit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
    >[0],
  ): ReturnType<
    TrustedBehavioralPrivacyArtifactStore["inspectCommit"]
  > {
    const exact = this.authorizations.get(input.authorizationHash);
    const related = [...this.authorizations.entries()].filter(
      ([authorizationHash, binding]) =>
        authorizationHash === input.authorizationHash ||
        binding.requestHash === input.requestHash ||
        binding.sourceResultEnvelopeHash ===
          input.sourceResultEnvelopeHash ||
        binding.releaseHash === input.releaseContentHash ||
        binding.artifactSetHash === input.artifactSetHash,
    );
    if (related.length === 0) {
      return Promise.resolve({ status: "absent" });
    }
    if (
      exact === undefined ||
      exact.requestHash !== input.requestHash ||
      exact.sourceResultEnvelopeHash !==
        input.sourceResultEnvelopeHash ||
      exact.releaseHash !== input.releaseContentHash ||
      exact.artifactSetHash !== input.artifactSetHash ||
      exact.artifactReferences.length !== 4
    ) {
      return Promise.resolve({ status: "conflict" });
    }
    return Promise.resolve({
      status: "committed",
      receipt: {
        status: "already-committed",
        authorizationHash: input.authorizationHash,
        bindingHash: canonicalHash({
          domain:
            "dark-factory.behavioral-release-one-use-binding.v1",
          authorizationHash: input.authorizationHash,
          requestHash: input.requestHash,
          sourceResultEnvelopeHash:
            input.sourceResultEnvelopeHash,
          releaseContentHash: input.releaseContentHash,
        }),
        privacyStateHash: exact.privacyStateHash,
        artifactSetHash: exact.artifactSetHash,
      },
      artifactReferences: exact.artifactReferences,
      orphanedAt: this.orphaned.has(input.authorizationHash)
        ? CREATED_AT
        : null,
    });
  }

  orphan(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["orphan"]
    >[0],
  ) {
    const binding = this.authorizations.get(input.authorizationHash);
    if (
      binding === undefined ||
      binding.requestHash !== input.requestHash ||
      binding.releaseHash !== input.releaseContentHash
    ) {
      return Promise.reject(new Error("orphan binding mismatch"));
    }
    const status = this.orphaned.has(input.authorizationHash)
      ? ("already-orphaned" as const)
      : ("orphaned" as const);
    this.orphaned.add(input.authorizationHash);
    const orphanedAt =
      this.orphanTimes.get(input.authorizationHash) ??
      input.orphanedAt;
    this.orphanTimes.set(input.authorizationHash, orphanedAt);
    return Promise.resolve({
      status,
      authorizationHash: input.authorizationHash,
      requestHash: input.requestHash,
      releaseContentHash: input.releaseContentHash,
      orphanedAt,
    });
  }

  resolveByContentHash(input: {
    readonly purpose: BehavioralReleaseArtifact["purpose"];
    readonly contentHash: string;
  }): Promise<BehavioralReleaseArtifact | undefined> {
    const authorization = [...this.authorizations.entries()].find(
      ([, binding]) => binding.releaseHash === input.contentHash,
    );
    if (
      authorization !== undefined &&
      this.orphaned.has(authorization[0])
    ) {
      return Promise.resolve(undefined);
    }
    const artifact = this.artifacts.get(input.contentHash);
    return Promise.resolve(
      artifact?.purpose === input.purpose ? artifact : undefined,
    );
  }
}

class DoubleLostCommitAcknowledgementStore extends AtomicMemoryBehavioralStore {
  loseAcknowledgements = true;
  lastCommit:
    | Parameters<
        TrustedBehavioralPrivacyArtifactStore["commit"]
      >[0]
    | undefined;

  override async commit(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["commit"]
    >[0],
  ) {
    this.lastCommit = input;
    if (!this.loseAcknowledgements) {
      return super.commit(input);
    }
    await super.commit(input);
    await super.commit(input);
    throw new Error("both commit acknowledgements were lost");
  }
}

class DetachedOrphanReceiptStore extends AtomicMemoryBehavioralStore {
  override async orphan(
    input: Parameters<
      TrustedBehavioralPrivacyArtifactStore["orphan"]
    >[0],
  ) {
    const receipt = await super.orphan(input);
    return {
      ...receipt,
      requestHash: digest(199),
    };
  }
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
      openedAt: "2026-07-01T00:01:00.000Z",
      closedAt: "2026-07-01T00:10:00.000Z",
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
    forbiddenReleaseLiterals: ["secret-task-literal"],
    forbiddenContentFingerprints: [],
    graderCanaryFingerprints: [],
    ...overrides,
  };
}

function producer(
  store: TrustedBehavioralPrivacyArtifactStore,
  now = CREATED_AT,
) {
  return new DeterministicPostDestructionBehavioralReleaseProducer({
    deployment: "test-only",
    store,
    keyId: "behavioral-release-key-1",
    privateKeys: {
      boundary: "test-only-in-memory",
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
      boundary: "test-only-in-memory",
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
    now: () => new Date(now),
  });
}

const destructionReceipt = {
  destroyedAt: "2026-07-01T00:11:00.000Z",
  verifierAttestationHash: digest(103),
};

describe("post-destruction behavioral release producer", () => {
  it("atomically spends privacy and persists a task-free signed bundle", async () => {
    const store = new AtomicMemoryBehavioralStore();
    const finalized = await producer(store).finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    expect(finalized).toMatchObject({
      sourceSetHash: digest(102),
      privacyThresholdPassed: true,
      requestHash: digest(100),
    });
    expect(store.state.releasesUsed).toBe(1);
    expect(store.artifacts.size).toBe(4);
    const serialized = JSON.stringify([...store.artifacts.values()]);
    for (let index = 1; index <= 12; index += 1) {
      expect(serialized).not.toContain(digest(index));
    }
    await expect(
      store.resolveByContentHash({
        purpose: "behavioral-release",
        contentHash: finalized?.contentHash ?? "",
      }),
    ).resolves.toMatchObject({ purpose: "behavioral-release" });
    await expect(
      store.resolveByContentHash({
        purpose: "failure-cards",
        contentHash: finalized?.contentHash ?? "",
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects finalization before confirmed raw destruction", async () => {
    const store = new AtomicMemoryBehavioralStore();
    await expect(
      producer(store).finalize({
        preparation: preparation(),
        sourceResultEnvelopeHash: digest(104),
        destructionReceipt: {
          ...destructionReceipt,
          destroyedAt: "2026-07-01T00:09:00.000Z",
        },
      }),
    ).rejects.toMatchObject({
      name: "TrustedBehavioralReleaseProducerError",
    });
    expect(store.state.releasesUsed).toBe(0);
    expect(store.artifacts.size).toBe(0);
  });

  it("leaves no artifact prefix when the atomic transaction fails", async () => {
    const store = new AtomicMemoryBehavioralStore();
    store.failCommit = true;
    await expect(
      producer(store).finalize({
        preparation: preparation(),
        sourceResultEnvelopeHash: digest(104),
        destructionReceipt,
      }),
    ).rejects.toMatchObject({
      name: "TrustedBehavioralReleaseProducerError",
    });
    expect(store.state.releasesUsed).toBe(0);
    expect(store.artifacts.size).toBe(0);
  });

  it("recovers an exact commit after two acknowledgements are lost without refund, orphan, or rebind", async () => {
    const store = new DoubleLostCommitAcknowledgementStore();
    const finalized = await producer(store).finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    const committed = store.lastCommit;
    if (finalized === null || committed === undefined) {
      throw new Error("Expected an exactly recovered commit.");
    }
    expect(store.state.releasesUsed).toBe(1);
    expect(store.authorizations.size).toBe(1);
    expect(store.orphaned.size).toBe(0);
    await expect(
      store.inspectCommit({
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
        authorizationHash: finalized.authorizationHash,
      },
    });
    store.loseAcknowledgements = false;
    await expect(
      store.commit({
        ...committed,
        authorizationHash: digest(111),
      }),
    ).rejects.toThrow(/rebound/u);
    expect(store.state.releasesUsed).toBe(1);
    expect(store.orphaned.size).toBe(0);
  });

  it("suppresses an overlapping follow-up instead of enabling differencing", async () => {
    const store = new AtomicMemoryBehavioralStore();
    const value = producer(store);
    await expect(
      value.finalize({
        preparation: preparation(),
        sourceResultEnvelopeHash: digest(104),
        destructionReceipt,
      }),
    ).resolves.not.toBeNull();
    await expect(
      value.finalize({
        preparation: preparation({
          requestHash: digest(105),
          experimentNumber: 2,
          behaviorSourceSetHash: digest(106),
        }),
        sourceResultEnvelopeHash: digest(107),
        destructionReceipt,
      }),
    ).resolves.toBeNull();
    expect(store.state.releasesUsed).toBe(1);
    expect(store.artifacts.size).toBe(4);
  });

  it("permanently hides a complete bundle orphaned after result issuance failure", async () => {
    const store = new AtomicMemoryBehavioralStore();
    const value = producer(store);
    const finalized = await value.finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    if (finalized === null) {
      throw new Error("Expected behavioral release");
    }
    const orphaned = await value.orphan(finalized);
    const orphanBinding = {
      authorizationHash: finalized.authorizationHash,
      requestHash: finalized.requestHash,
      releaseContentHash: finalized.contentHash,
      sourceSetHash: finalized.sourceSetHash,
      orphanedAt: CREATED_AT,
    };
    expect(orphaned).toEqual({
      status: "orphaned",
      ...orphanBinding,
      orphanFinalizationHash:
        hashTrustedBehavioralReleaseOrphanFinalization(
          orphanBinding,
        ),
    });
    const serializedReceipt = JSON.stringify(orphaned);
    expect(serializedReceipt).not.toContain("secret-task-literal");
    for (let index = 1; index <= 12; index += 1) {
      expect(serializedReceipt).not.toContain(digest(index));
    }
    await expect(
      store.resolveByContentHash({
        purpose: "behavioral-release",
        contentHash: finalized.contentHash,
      }),
    ).resolves.toBeUndefined();
    await expect(
      producer(
        store,
        "2026-07-01T00:13:00.000Z",
      ).orphan(finalized),
    ).resolves.toEqual(orphaned);
    expect(store.state.releasesUsed).toBe(1);
    expect(store.artifacts.size).toBe(4);
  });

  it("fails unsafe when the durable orphan receipt is detached", async () => {
    const store = new DetachedOrphanReceiptStore();
    const value = producer(store);
    const finalized = await value.finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    if (finalized === null) {
      throw new Error("Expected behavioral release");
    }
    await expect(value.orphan(finalized)).rejects.toMatchObject({
      name: "TrustedBehavioralReleaseProducerError",
      finalizationDisposition: "unsafe-to-consume",
    });
    expect(
      store.orphaned.has(finalized.authorizationHash),
    ).toBe(true);
    expect(store.state.releasesUsed).toBe(1);
  });

  it("cannot rebind a committed bundle to another request or result", async () => {
    const store = new AtomicMemoryBehavioralStore();
    const finalized = await producer(store).finalize({
      preparation: preparation(),
      sourceResultEnvelopeHash: digest(104),
      destructionReceipt,
    });
    if (finalized === null) {
      throw new Error("Expected behavioral release");
    }
    const byPurpose = new Map(
      [...store.artifacts.values()].map((artifact) => [
        artifact.purpose,
        artifact,
      ]),
    );
    const artifacts = [
      byPurpose.get("behavioral-evidence"),
      byPurpose.get("failure-cards"),
      byPurpose.get("diagnostic-brief"),
      byPurpose.get("behavioral-release"),
    ];
    if (artifacts.some((artifact) => artifact === undefined)) {
      throw new Error("Expected complete artifact set");
    }
    await expect(
      store.commit({
        authorizationHash: digest(120),
        requestHash: digest(121),
        sourceResultEnvelopeHash: digest(122),
        releaseContentHash: finalized.contentHash,
        priorPrivacyStateHash: hashHiddenPrivacyBudgetState(store.state),
        nextPrivacyState: store.state,
        artifacts: artifacts as [
          BehavioralReleaseArtifact,
          BehavioralReleaseArtifact,
          BehavioralReleaseArtifact,
          BehavioralReleaseArtifact,
        ],
      }),
    ).rejects.toThrow(/rebound/u);
  });
});
