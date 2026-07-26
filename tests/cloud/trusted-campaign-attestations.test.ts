import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  CampaignControlAttestation,
  CampaignDecisionAttestation,
  CampaignLedgerPointers,
  CampaignLedgerTransition,
} from "../../src/campaign/store.js";
import {
  ArtifactBackedCampaignAttestationVerifier,
  createUnsignedTrustedCampaignAttestationEvidence,
  type SignedTrustedCampaignAttestationEvidence,
  type TrustedCampaignAttestationArtifactQuery,
  type TrustedCampaignAttestationEvidenceInput,
  TrustedCampaignAttestationVerificationError,
  trustedCampaignAttestationLookupHash,
} from "../../src/cloud/trusted-campaign-attestations.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
  withContentHash,
} from "../../src/schemas/canonical.js";

const NOW = "2026-07-26T10:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function ledgers(brokerExposureStateAttestationHash = HASH_A): CampaignLedgerPointers {
  return {
    brokerExposureStateAttestationHash,
    repeatedTestingLedgerHash: HASH_B,
    privacyLedgerHash: HASH_C,
    cacheStateAttestationHash: HASH_D,
    publicationQueueHash: null,
  };
}

function ledgerTransition(): CampaignLedgerTransition {
  return {
    campaignId: "campaign-001",
    protocolHash: HASH_A,
    currentStateHash: HASH_B,
    currentRevision: 4,
    reason: "checkpoint",
    previousExperimentSealHash: HASH_C,
    operation: { kind: "checkpoint" },
    previous: ledgers(HASH_D),
    next: ledgers(HASH_E),
  };
}

function decisionAttestation(): CampaignDecisionAttestation {
  return {
    campaignId: "campaign-001",
    baselineLineageId: "lineage-001",
    protocolHash: HASH_A,
    currentStateHash: HASH_B,
    currentRevision: 5,
    experimentNumber: 3,
    stage: "validation",
    disposition: "promoted",
    candidateCommit: COMMIT_B,
    activeChampion: {
      experimentNumber: 2,
      commit: COMMIT_A,
      sourceSealHash: HASH_C,
    },
    previousExperimentSealHash: HASH_D,
    sealHash: HASH_E,
    decisionAttestationHash: HASH_F,
    holdoutGeneration: 0,
    priorHoldoutAvailabilityAttestationHash: HASH_A,
    holdoutAvailabilityAttestationHash: HASH_B,
    sealedAt: NOW,
    ledgers: ledgers(HASH_F),
  };
}

function genesisAttestation(): Extract<CampaignControlAttestation, { readonly kind: "genesis" }> {
  return {
    kind: "genesis",
    campaignId: "campaign-001",
    protocolHash: HASH_A,
    initialStateHash: HASH_B,
    harnessRegistrationHash: HASH_C,
    budgetPolicyHash: HASH_D,
    budgetAuthorizationHash: HASH_E,
    budgetAccountingAttestationHash: HASH_F,
    holdoutPolicyHash: HASH_A,
    holdoutAvailabilityAttestationHash: HASH_B,
    baselineChampion: {
      experimentNumber: 0,
      commit: COMMIT_A,
      sourceSealHash: HASH_C,
    },
    initialLedgers: ledgers(HASH_D),
  };
}

function resumeAttestation(): Extract<CampaignControlAttestation, { readonly kind: "resume" }> {
  return {
    kind: "resume",
    campaignId: "campaign-001",
    protocolHash: HASH_A,
    currentStateHash: HASH_B,
    authorizationOrAttestationHash: HASH_F,
    previousRunEpoch: 1,
    nextRunEpoch: 2,
  };
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function signedEvidence(
  evidence: TrustedCampaignAttestationEvidenceInput,
  overrides: Partial<SignedTrustedCampaignAttestationEvidence> = {},
): SignedTrustedCampaignAttestationEvidence {
  const unsigned = createUnsignedTrustedCampaignAttestationEvidence({
    evidence,
    issuedAt: NOW,
  });
  const material = { ...unsigned, ...overrides };
  const signature = createEd25519Signature(
    material as Readonly<Record<string, unknown>>,
    privateKey,
    "campaign-key",
    NOW,
  );
  return withContentHash({
    ...material,
    signature,
  }) as unknown as SignedTrustedCampaignAttestationEvidence;
}

function verifierFixture(input: {
  readonly evidence: TrustedCampaignAttestationEvidenceInput;
  readonly document?: SignedTrustedCampaignAttestationEvidence;
  readonly rawTransform?: (raw: string) => string;
  readonly key?: typeof publicKey;
  readonly keyPurpose?: "campaign-attestation" | "result-envelope";
  readonly sourceBoundary?: "trusted-cloud" | "test-only";
  readonly artifactTransform?: (artifact: TrustedCloudArtifactRef) => TrustedCloudArtifactRef;
}) {
  const document = input.document ?? signedEvidence(input.evidence);
  const canonical = `${canonicalJson(document)}\n`;
  const raw = input.rawTransform?.(canonical) ?? canonical;
  const baseArtifact: TrustedCloudArtifactRef = {
    uri: "trusted://campaign-attestations/evidence",
    sha256: sha256(raw),
    byteLength: Buffer.byteLength(raw, "utf8"),
    mediaType: "application/json",
  };
  const artifact = input.artifactTransform?.(baseArtifact) ?? baseArtifact;
  const locate = vi.fn(
    async (
      _query: TrustedCampaignAttestationArtifactQuery,
    ): Promise<TrustedCloudArtifactRef | undefined> => artifact,
  );
  const readUtf8 = vi.fn(async () => raw);
  const resolve = vi.fn(
    async (request: { readonly purpose: "campaign-attestation"; readonly keyId: string }) =>
      request.keyId === "campaign-key"
        ? {
            boundary: "trusted-cloud-key-material" as const,
            algorithm: "Ed25519" as const,
            purpose: input.keyPurpose ?? "campaign-attestation",
            keyId: request.keyId,
            keyVersion: "campaign-key/1",
            publicKey: input.key ?? publicKey,
          }
        : undefined,
  );
  const source = {
    boundary: input.sourceBoundary ?? "trusted-cloud",
    locate,
  };
  const reader = { boundary: "trusted-cloud" as const, readUtf8 };
  const keyring = {
    boundary: "trusted-cloud" as const,
    resolve,
  };
  const verifier = new ArtifactBackedCampaignAttestationVerifier({
    source: source as never,
    reader,
    keyring: keyring as never,
    trustedKeyIds: ["campaign-key"],
  });
  return {
    verifier,
    locate,
    readUtf8,
    resolve,
    source,
    reader,
    keyring,
  };
}

describe("ArtifactBackedCampaignAttestationVerifier", () => {
  it.each<{
    readonly label: string;
    readonly evidence: TrustedCampaignAttestationEvidenceInput;
  }>([
    {
      label: "genesis",
      evidence: {
        evidenceKind: "control",
        payload: genesisAttestation(),
      },
    },
    {
      label: "control authorization",
      evidence: {
        evidenceKind: "control",
        payload: resumeAttestation(),
      },
    },
    {
      label: "ledger transition",
      evidence: {
        evidenceKind: "ledger-transition",
        payload: ledgerTransition(),
      },
    },
    {
      label: "decision",
      evidence: {
        evidenceKind: "decision",
        payload: decisionAttestation(),
      },
    },
  ])("verifies exact signed $label evidence", async ({ evidence }) => {
    const fixture = verifierFixture({ evidence });

    await expect(fixture.verifier.verify(evidence.payload)).resolves.toBeUndefined();

    expect(fixture.locate).toHaveBeenCalledWith({
      evidenceKind: evidence.evidenceKind,
      campaignId: evidence.payload.campaignId,
      protocolHash: evidence.payload.protocolHash,
      lookupHash: trustedCampaignAttestationLookupHash(evidence),
      payloadHash: canonicalHash(evidence.payload),
    });
    expect(fixture.readUtf8).toHaveBeenCalledTimes(1);
    expect(fixture.resolve).toHaveBeenCalledWith({
      purpose: "campaign-attestation",
      keyId: "campaign-key",
    });
  });

  it("rejects a valid signature over a different expected payload", async () => {
    const expected: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: resumeAttestation(),
    };
    const other: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: {
        ...resumeAttestation(),
        nextRunEpoch: 3,
      },
    };
    const fixture = verifierFixture({
      evidence: expected,
      document: signedEvidence(other),
    });

    await expect(fixture.verifier.verify(expected.payload)).rejects.toBeInstanceOf(
      TrustedCampaignAttestationVerificationError,
    );
  });

  it("rejects non-canonical JSON before key resolution", async () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "decision",
      payload: decisionAttestation(),
    };
    const fixture = verifierFixture({
      evidence,
      rawTransform: (raw) => ` ${raw}`,
    });

    await expect(fixture.verifier.verify(evidence.payload)).rejects.toBeInstanceOf(
      TrustedCampaignAttestationVerificationError,
    );
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "digest",
      transform: (artifact: TrustedCloudArtifactRef): TrustedCloudArtifactRef => ({
        ...artifact,
        sha256: HASH_A,
      }),
    },
    {
      label: "length",
      transform: (artifact: TrustedCloudArtifactRef): TrustedCloudArtifactRef => ({
        ...artifact,
        byteLength: artifact.byteLength + 1,
      }),
    },
  ])(
    "rejects a reader response detached from the sealed artifact $label",
    async ({ transform }) => {
      const evidence: TrustedCampaignAttestationEvidenceInput = {
        evidenceKind: "control",
        payload: resumeAttestation(),
      };
      const fixture = verifierFixture({
        evidence,
        artifactTransform: transform,
      });

      await expect(fixture.verifier.verify(evidence.payload)).rejects.toBeInstanceOf(
        TrustedCampaignAttestationVerificationError,
      );
      expect(fixture.resolve).not.toHaveBeenCalled();
    },
  );

  it("rejects a reader response that exceeds the independent byte ceiling", async () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: resumeAttestation(),
    };
    const fixture = verifierFixture({
      evidence,
      rawTransform: () => "x".repeat(4 * 1024 * 1024 + 1),
      artifactTransform: (artifact) => ({
        ...artifact,
        byteLength: 1,
      }),
    });

    await expect(fixture.verifier.verify(evidence.payload)).rejects.toBeInstanceOf(
      TrustedCampaignAttestationVerificationError,
    );
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("rejects mutation after signing even with a recomputed content hash", async () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "ledger-transition",
      payload: ledgerTransition(),
    };
    const original = signedEvidence(evidence);
    const { contentHash: _contentHash, ...originalWithoutContentHash } = original;
    expect(_contentHash).toBe(original.contentHash);
    const mutated = withContentHash({
      ...originalWithoutContentHash,
      issuedAt: "2026-07-26T10:00:01.000Z",
    }) as unknown as SignedTrustedCampaignAttestationEvidence;
    const fixture = verifierFixture({
      evidence,
      document: mutated,
    });

    await expect(fixture.verifier.verify(evidence.payload)).rejects.toBeInstanceOf(
      TrustedCampaignAttestationVerificationError,
    );
  });

  it("rejects non-cloud evidence sources at composition time", () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: genesisAttestation(),
    };

    expect(() =>
      verifierFixture({
        evidence,
        sourceBoundary: "test-only",
      }),
    ).toThrow(TrustedCampaignAttestationVerificationError);
  });

  it("rejects a valid signature resolved under another key purpose", async () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: resumeAttestation(),
    };
    const fixture = verifierFixture({
      evidence,
      keyPurpose: "result-envelope",
    });

    await expect(fixture.verifier.verify(evidence.payload)).rejects.toBeInstanceOf(
      TrustedCampaignAttestationVerificationError,
    );
  });

  it("captures trusted methods before injected objects can be redirected", async () => {
    const evidence: TrustedCampaignAttestationEvidenceInput = {
      evidenceKind: "control",
      payload: genesisAttestation(),
    };
    const fixture = verifierFixture({ evidence });
    Object.assign(fixture.source, {
      locate: vi.fn(async () => undefined),
    });
    Object.assign(fixture.reader, {
      readUtf8: vi.fn(async () => "{}\n"),
    });
    Object.assign(fixture.keyring, {
      resolve: vi.fn(async () => undefined),
    });

    await expect(fixture.verifier.verify(evidence.payload)).resolves.toBeUndefined();
    expect(fixture.locate).toHaveBeenCalledTimes(1);
    expect(fixture.readUtf8).toHaveBeenCalledTimes(1);
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });
});
