import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type TrustedArtifactBridge,
  type TrustedArtifactRuntimeGuard,
  VerifyingTrustedArtifactBridge,
} from "../../src/cloud/artifact-bridge.js";
import {
  type EvaluationReleaseRegistryPublication,
  MountedVolumeCampaignAttestationArtifactSource,
  MountedVolumeEvaluationReleaseArtifactSource,
  MountedVolumeOptimizerReleasedEvidenceMetadataSource,
  MountedVolumeProductionCompositionAttestationArtifactSource,
  MountedVolumeProductionOptimizePrerequisiteSource,
  MountedVolumeTrustedArtifactJsonReader,
  MountedVolumeTrustedArtifactRegistry,
  MountedVolumeTrustedArtifactRegistryError,
  type ProductionOptimizeCampaignGenesisQuery,
} from "../../src/cloud/mounted-volume-artifact-registry.js";
import { MountedVolumeTrustedArtifactBackend } from "../../src/cloud/mounted-volume-backend.js";
import type {
  MountedVolumeDurableStateOptions,
  MountedVolumeStateSemanticsGuard,
} from "../../src/cloud/mounted-volume-state.js";
import type {
  ProductionCompositionAttestationArtifactSet,
  ProductionCompositionAttestationQuery,
} from "../../src/cloud/production-composition-attestation-verifier.js";
import type { SignedProductionOptimizeCampaignGenesis } from "../../src/cloud/production-optimize-bootstrap-or-reconstruct.js";
import {
  createUnsignedTrustedCampaignAttestationEvidence,
  type SignedTrustedCampaignAttestationEvidence,
  type TrustedCampaignAttestationArtifactQuery,
} from "../../src/cloud/trusted-campaign-attestations.js";
import { VerifyingTrustedJsonArtifactReader } from "../../src/cloud/trusted-json-reader.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import type {
  OptimizerProposalDiagnosticEvidenceMetadata,
  OptimizerProposalDiagnosticEvidenceQuery,
} from "../../src/optimizer/artifact-backed-resolver.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../../src/schemas/artifacts.js";
import { canonicalHash, withContentHash } from "../../src/schemas/canonical.js";
import type { SignedBehavioralRelease } from "../../src/schemas/trusted.js";

const NOW = "2026-07-26T10:00:00.000Z";
const LATER = "2026-07-26T11:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const SIGNATURE = {
  algorithm: "ed25519" as const,
  keyId: "registry-test-key",
  signedAt: NOW,
  signature: "A".repeat(86),
};

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
    storeId: "artifact-registry-test",
    controllerInstanceIdHash: controller,
    runtimeGuard,
    semanticsGuard,
    now: () => new Date(NOW),
    nonceFactory: () => nonce,
  };
}

function infrastructure(
  root: string,
  state: MountedVolumeDurableStateOptions = durableState(root),
  bridgeTransform?: (bridge: TrustedArtifactBridge) => TrustedArtifactBridge,
) {
  const artifactRoot = join(root, "artifact-objects");
  const baseBridge = new VerifyingTrustedArtifactBridge(
    new MountedVolumeTrustedArtifactBackend({
      volumeRoot: artifactRoot,
      runtimeGuard,
    }),
    runtimeGuard,
  );
  const bridge = bridgeTransform?.(baseBridge) ?? baseBridge;
  const verifyingReader = new VerifyingTrustedJsonArtifactReader(baseBridge);
  const registry = new MountedVolumeTrustedArtifactRegistry({
    durableState: state,
    bridge,
    reader: verifyingReader,
  });
  return {
    artifactRoot,
    baseBridge,
    reader: new MountedVolumeTrustedArtifactJsonReader(verifyingReader),
    registry,
  };
}

function cacheAttestation(derivationHash = HASH_A): CacheAttestation {
  return withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    experimentNumber: 1,
    cachePolicyVersion: "cache-v1",
    protocolHash: HASH_B,
    aggregateUseStatus: "not-used",
    freshnessAgeBands: [],
    driftStatus: "not-applicable",
    smallCountSuppressionApplied: true,
    sealedWindow: {
      openedAt: NOW,
      closedAt: LATER,
    },
    repairBudgetCompliant: true,
    aggregateRepairCost: {
      inputTokens: 0,
      outputTokens: 0,
      modelUsd: 0,
      sandboxUsd: 0,
      totalUsd: 0,
      wallTimeMs: 0,
    },
    derivationHash,
    signature: SIGNATURE,
  }) as CacheAttestation;
}

function evaluationPublication(document: CacheAttestation): EvaluationReleaseRegistryPublication {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.evaluation-release-artifact-query.v1" as const,
    purpose: "cache-attestation" as const,
    contentHash: document.contentHash,
  };
  return {
    query: { ...unsigned, queryHash: canonicalHash(unsigned) },
    document,
  };
}

function behavioralPublications(): readonly EvaluationReleaseRegistryPublication[] {
  const policyVersions = {
    protocol: "protocol-v1",
    broker: "broker-v1",
    extraction: "extraction-v1",
    statistics: "statistics-v1",
    privacy: "privacy-v1",
    weighting: "weighting-v1",
    cache: "cache-v1",
    repeatedTesting: "testing-v1",
    leakScanner: "scanner-v1",
  };
  const support = {
    distinctTaskCountBand: "10-19" as const,
    trajectoryCountBand: "20-39" as const,
    minimumComparedGroupSizeBand: "10-19" as const,
    complementaryCountSuppressionPassed: true,
    differencingBudgetPassed: true,
  };
  const evidence = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    experimentNumber: 1,
    sourceEnvelopeHash: HASH_A,
    protocolHash: HASH_B,
    policyVersions,
    analysisWindow: {
      openedAt: NOW,
      closedAt: LATER,
      support,
    },
    metrics: [],
    suppressedFindingCountBand: "0" as const,
    releaseChecksPassed: true,
    derivationHash: HASH_C,
  }) as BehavioralEvidence;
  const cards = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    experimentNumber: 1,
    behavioralEvidenceHash: evidence.contentHash,
    cards: [],
    suppressionApplied: true,
    policyVersions,
  }) as FailureCards;
  const brief = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    experimentNumber: 1,
    releaseId: "release-001",
    sourceExperimentNumber: 1,
    aggregateEvidenceHash: evidence.contentHash,
    failureCardsHash: cards.contentHash,
    policyVersions,
    status: "no-actionable-evidence" as const,
    cards: [],
    limitations: ["No generic pattern passed the release threshold."],
    oneUse: true as const,
    expiresAt: LATER,
  }) as DiagnosticBrief;
  const release = withContentHash({
    schemaVersion: "1.0.0",
    createdAt: NOW,
    provenanceRefs: [],
    releaseId: brief.releaseId,
    experimentNumber: 1,
    sourceResultEnvelopeHash: HASH_D,
    protocolHash: HASH_B,
    policyVersions,
    support,
    aggregateArtifactHashes: {
      behavioralEvidence: evidence.contentHash,
      failureCards: cards.contentHash,
      diagnosticBrief: brief.contentHash,
    },
    suppressedFindingCountBand: "0" as const,
    releaseOnce: true as const,
    signature: SIGNATURE,
  }) as SignedBehavioralRelease;
  const documents = [
    ["behavioral-release", release],
    ["behavioral-evidence", evidence],
    ["failure-cards", cards],
    ["diagnostic-brief", brief],
  ] as const;
  return documents.map(([purpose, document]) => {
    const unsigned = {
      schemaVersion: 1 as const,
      domain: "dark-factory.evaluation-release-artifact-query.v1" as const,
      purpose,
      contentHash: document.contentHash,
    };
    return {
      query: { ...unsigned, queryHash: canonicalHash(unsigned) },
      document,
    };
  });
}

function optimizerFixture(): {
  readonly query: OptimizerProposalDiagnosticEvidenceQuery;
  readonly metadata: OptimizerProposalDiagnosticEvidenceMetadata;
} {
  const queryUnsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-proposal-evidence-query.v1" as const,
    purpose: "proposal-diagnostic" as const,
    campaignId: "campaign-001",
    experimentId: "001-registry-test",
    diagnosticHash: HASH_A,
    releaseId: "release-001",
    actionable: false,
  };
  const query: OptimizerProposalDiagnosticEvidenceQuery = {
    ...queryUnsigned,
    queryHash: canonicalHash(queryUnsigned),
  };
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.optimizer-proposal-diagnostic-evidence.v1" as const,
    purpose: "proposal-diagnostic" as const,
    artifact: {
      uri: "trusted://released-evidence/proposal-001" as const,
      sha256: HASH_B,
      mediaType: "application/x-tar",
      byteLength: 1024,
    },
    releaseSafetyAttestationHash: HASH_C,
    containsTaskIdentifiers: false as const,
    containsPanelIdentifiers: false as const,
    containsCellIdentifiers: false as const,
    containsRawEvidence: false as const,
    containsGraderIdentifiers: false as const,
    issuedAt: NOW,
    keyVersion: "key-v1",
    campaignId: query.campaignId,
    experimentId: query.experimentId,
    diagnosticHash: query.diagnosticHash,
    releaseId: query.releaseId,
    actionable: query.actionable,
  };
  const metadataHash = canonicalHash(unsigned);
  return {
    query,
    metadata: {
      ...unsigned,
      metadataHash,
      signature: SIGNATURE,
    },
  };
}

function compositionFixture(): {
  readonly query: ProductionCompositionAttestationQuery;
  readonly document: ProductionCompositionAttestationArtifactSet;
} {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-composition-attestation-query.v1" as const,
    campaignId: "campaign-001",
    manifestId: "manifest-001",
    manifestHash: HASH_A,
    componentBindingsHash: HASH_B,
    operationalBindingsHash: HASH_C,
    runtimePortBindingsHash: HASH_D,
  };
  const query: ProductionCompositionAttestationQuery = {
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  };
  const document = withContentHash({
    schemaVersion: 1 as const,
    domain: "dark-factory.production-composition-attestation-artifact-set.v1" as const,
    sensitivity: "release-safe-control" as const,
    deployment: "trusted-cloud" as const,
    campaignId: query.campaignId,
    manifestId: query.manifestId,
    manifestHash: query.manifestHash,
    queryHash: query.queryHash,
    componentAttestations: [],
    operationalBindingsAttestation: {
      operationalBindingsHash: query.operationalBindingsHash,
      artifact: {
        uri: "trusted://composition/operational" as const,
        sha256: HASH_E,
        mediaType: "application/json",
        byteLength: 1024,
      },
    },
    runtimePortAttestations: [],
    issuedAt: NOW,
    expiresAt: LATER,
    signature: SIGNATURE,
  }) as unknown as ProductionCompositionAttestationArtifactSet;
  return { query, document };
}

function campaignFixture(): {
  readonly query: TrustedCampaignAttestationArtifactQuery;
  readonly document: SignedTrustedCampaignAttestationEvidence;
} {
  const payload = {
    kind: "resume" as const,
    campaignId: "campaign-001",
    protocolHash: HASH_A,
    currentStateHash: HASH_B,
    authorizationOrAttestationHash: HASH_C,
    previousRunEpoch: 1,
    nextRunEpoch: 2,
  };
  const unsigned = createUnsignedTrustedCampaignAttestationEvidence({
    evidence: { evidenceKind: "control", payload },
    issuedAt: NOW,
  });
  const { privateKey } = generateKeyPairSync("ed25519");
  const signature = createEd25519Signature(
    unsigned as unknown as Readonly<Record<string, unknown>>,
    privateKey,
    "campaign-key",
    NOW,
  );
  const document = withContentHash({
    ...unsigned,
    signature,
  }) as unknown as SignedTrustedCampaignAttestationEvidence;
  return {
    query: {
      evidenceKind: "control",
      campaignId: unsigned.campaignId,
      protocolHash: unsigned.protocolHash,
      lookupHash: unsigned.lookupHash,
      payloadHash: unsigned.payloadHash,
    },
    document,
  };
}

function campaignGenesisFixture(): {
  readonly query: ProductionOptimizeCampaignGenesisQuery;
  readonly document: SignedProductionOptimizeCampaignGenesis;
} {
  const draft = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimize-campaign-genesis.v1" as const,
    sensitivity: "release-safe-control" as const,
    deployment: "trusted-cloud" as const,
    campaignId: "campaign-001",
    lineageId: "campaign-001",
    protocolHash: HASH_A,
    sourcePrerequisiteHash: HASH_B,
    initialCampaignStateHash: HASH_C,
    genesisPolicyHash: HASH_D,
    issuedAt: NOW,
    expiresAt: LATER,
    signature: SIGNATURE,
  };
  const document = withContentHash(draft) as unknown as SignedProductionOptimizeCampaignGenesis;
  return {
    query: {
      purpose: "production-optimize-campaign-genesis",
      campaignId: document.campaignId,
      lineageId: document.lineageId,
      protocolHash: document.protocolHash,
      sourcePrerequisiteHash: document.sourcePrerequisiteHash,
      genesisPrerequisiteHash: document.contentHash,
    },
    document,
  };
}

describe("mounted-volume trusted artifact registry", () => {
  it("publishes canonical immutable bytes and replays exact registrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    const { registry, reader } = infrastructure(root);
    const publication = evaluationPublication(cacheAttestation());
    const [published] = await registry.publishEvaluationReleaseArtifacts([publication]);
    const [replayed] = await registry.publishEvaluationReleaseArtifacts([publication]);
    expect(published?.status).toBe("published");
    expect(replayed).toEqual({
      ...published,
      status: "already-published",
    });

    const source = new MountedVolumeEvaluationReleaseArtifactSource(registry);
    const artifact = await source.locate(publication.query);
    expect(artifact).toEqual(published?.artifact);
    expect(JSON.parse(await reader.readUtf8(artifact!, 1024 * 1024))).toEqual(publication.document);
    expect("list" in registry).toBe(false);
    expect("findByPrefix" in registry).toBe(false);
    await registry.close();
  });

  it("rejects binding collisions, purpose swaps, and lookup ambiguity", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    const { registry } = infrastructure(root);
    const first = evaluationPublication(cacheAttestation());
    await registry.publishEvaluationReleaseArtifacts([first]);
    const changed = cacheAttestation(HASH_F);
    await expect(
      registry.publishEvaluationReleaseArtifacts([{ query: first.query, document: changed }]),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);
    const swappedUnsigned = {
      ...first.query,
      purpose: "behavioral-release" as const,
    };
    const swapped = {
      ...swappedUnsigned,
      queryHash: canonicalHash({
        schemaVersion: swappedUnsigned.schemaVersion,
        domain: swappedUnsigned.domain,
        purpose: swappedUnsigned.purpose,
        contentHash: swappedUnsigned.contentHash,
      }),
    };
    await expect(
      registry.publishEvaluationReleaseArtifacts([{ query: swapped, document: first.document }]),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);

    const optimizer = optimizerFixture();
    await registry.publishOptimizerReleasedEvidenceMetadata(optimizer.query, optimizer.metadata);
    const { metadataHash: _metadataHash, signature, ...metadataBody } = optimizer.metadata;
    const changedMetadataBody = {
      ...metadataBody,
      releaseSafetyAttestationHash: HASH_F,
    };
    const collidingMetadata: OptimizerProposalDiagnosticEvidenceMetadata = {
      ...changedMetadataBody,
      metadataHash: canonicalHash(changedMetadataBody),
      signature,
    };
    await expect(
      registry.publishOptimizerReleasedEvidenceMetadata(optimizer.query, collidingMetadata),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);
    const source = new MountedVolumeOptimizerReleasedEvidenceMetadataSource(registry);
    await expect(source.locate(optimizer.query)).resolves.toHaveLength(1);
    await expect(
      source.locate({
        ...optimizer.query,
        queryHash: HASH_F,
      }),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);
    await registry.close();
  });

  it("keeps a partly written behavioral batch completely invisible", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    let writes = 0;
    const { registry } = infrastructure(root, durableState(root), (base) => ({
      assertTrustedRuntime: () => base.assertTrustedRuntime(),
      openVerified: (artifact, signal) => base.openVerified(artifact, signal),
      persistVerified: async (input) => {
        writes += 1;
        if (writes === 3) throw new Error("injected storage failure");
        return base.persistVerified(input);
      },
    }));
    const publications = behavioralPublications();
    await expect(registry.publishEvaluationReleaseArtifacts(publications)).rejects.toBeInstanceOf(
      MountedVolumeTrustedArtifactRegistryError,
    );
    const source = new MountedVolumeEvaluationReleaseArtifactSource(registry);
    for (const publication of publications) {
      await expect(source.locate(publication.query)).resolves.toBeUndefined();
    }
    expect(writes).toBe(3);
    await registry.close();
  });

  it("fails closed on caller mutation across an awaited object write", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    let releaseWrite: (() => void) | undefined;
    let startedWrite: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedWrite = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const { registry } = infrastructure(root, durableState(root), (base) => ({
      assertTrustedRuntime: () => base.assertTrustedRuntime(),
      openVerified: (artifact, signal) => base.openVerified(artifact, signal),
      persistVerified: async (input) => {
        startedWrite?.();
        await gate;
        return base.persistVerified(input);
      },
    }));
    const publication = evaluationPublication(cacheAttestation());
    const pending = registry.publishEvaluationReleaseArtifacts([publication]);
    await started;
    (
      publication.document as unknown as {
        signature: { keyId: string };
      }
    ).signature.keyId = "mutated-key";
    releaseWrite?.();
    await expect(pending).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);
    const source = new MountedVolumeEvaluationReleaseArtifactSource(registry);
    await expect(source.locate(publication.query)).resolves.toBeUndefined();
    await registry.close();
  });

  it("detects URI, hash, length, and stored-byte mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    const { artifactRoot, registry, reader } = infrastructure(root);
    const publication = evaluationPublication(cacheAttestation());
    const [receipt] = await registry.publishEvaluationReleaseArtifacts([publication]);
    const artifact = receipt!.artifact;
    await expect(
      reader.readUtf8({ ...artifact, uri: "trusted://artifact-registry/missing" }, 1024 * 1024),
    ).rejects.toThrow();
    await expect(reader.readUtf8({ ...artifact, sha256: HASH_F }, 1024 * 1024)).rejects.toThrow();
    await expect(
      reader.readUtf8({ ...artifact, byteLength: artifact.byteLength + 1 }, 1024 * 1024),
    ).rejects.toThrow();

    const objectDigest = createHash("sha256").update(artifact.uri).digest("hex");
    const dataPath = join(artifactRoot, "objects", objectDigest.slice(0, 2), objectDigest, "data");
    const original = await readFile(dataPath);
    await writeFile(dataPath, Buffer.from("x".repeat(original.length)));
    await expect(reader.readUtf8(artifact, 1024 * 1024)).rejects.toThrow();
    await registry.close();
  });

  it("serves each exact typed source without exposing storage discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    const { registry } = infrastructure(root);

    const optimizer = optimizerFixture();
    await registry.publishOptimizerReleasedEvidenceMetadata(optimizer.query, optimizer.metadata);
    const composition = compositionFixture();
    await registry.publishProductionCompositionAttestationSet(
      composition.query,
      composition.document,
    );
    const campaign = campaignFixture();
    await registry.publishCampaignAttestation(campaign.query, campaign.document);
    const genesis = campaignGenesisFixture();
    await registry.publishCampaignGenesis(genesis.query, genesis.document);

    await expect(
      new MountedVolumeProductionCompositionAttestationArtifactSource(registry).locate(
        composition.query,
      ),
    ).resolves.toEqual(composition.document);
    await expect(
      new MountedVolumeCampaignAttestationArtifactSource(registry).locate(campaign.query),
    ).resolves.toBeDefined();
    await expect(
      new MountedVolumeProductionOptimizePrerequisiteSource(registry).locateCampaignGenesis(
        genesis.query,
      ),
    ).resolves.toEqual(genesis.document);
    await registry.close();
  });

  it("requires clean handoff or provider-attested crash recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-artifact-registry-"));
    const first = infrastructure(root);
    const publication = evaluationPublication(cacheAttestation());
    await first.registry.publishEvaluationReleaseArtifacts([publication]);

    const unauthorized = infrastructure(root, durableState(root, "2".repeat(64), "b".repeat(48)));
    await expect(
      new MountedVolumeEvaluationReleaseArtifactSource(unauthorized.registry).locate(
        publication.query,
      ),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);

    const recoveredState = {
      ...durableState(root, "3".repeat(64), "c".repeat(48)),
      recoveryAuthority: {
        authorize: ({
          observedLock,
          observedLockHash,
        }: {
          observedLock: {
            namespace: string;
            fenceEpoch: number;
          };
          observedLockHash: string;
        }) =>
          Promise.resolve({
            schemaVersion: 1 as const,
            domain: "dark-factory.mounted-volume-lock-recovery.v1" as const,
            namespace: observedLock.namespace,
            authorizationId: "provider-destruction-registry-1",
            priorLockHash: observedLockHash,
            priorFenceEpoch: observedLock.fenceEpoch,
            providerTerminationAttestationHash: HASH_D,
            authorizedAt: NOW,
            signerKeyId: "provider-termination-key",
            signatureHash: HASH_E,
          }),
      },
    };
    const recovered = infrastructure(root, recoveredState);
    await expect(
      new MountedVolumeEvaluationReleaseArtifactSource(recovered.registry).locate(
        publication.query,
      ),
    ).resolves.toBeDefined();
    await expect(
      new MountedVolumeEvaluationReleaseArtifactSource(first.registry).locate(publication.query),
    ).rejects.toBeInstanceOf(MountedVolumeTrustedArtifactRegistryError);
    await recovered.registry.close();

    const clean = infrastructure(root, durableState(root, "4".repeat(64), "d".repeat(48)));
    await expect(
      new MountedVolumeEvaluationReleaseArtifactSource(clean.registry).locate(publication.query),
    ).resolves.toBeDefined();
    await clean.registry.close();
  });
});
