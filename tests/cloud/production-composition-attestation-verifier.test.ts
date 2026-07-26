import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  ArtifactBackedProductionCompositionAttestationVerifier,
  PRODUCTION_OPERATIONAL_BINDING_IDS,
  type ProductionComponentAttestationArtifact,
  type ProductionCompositionAttestationArtifactSet,
  type ProductionCompositionAttestationQuery,
  ProductionCompositionAttestationVerificationError,
  type ProductionOperationalBindingsAttestationArtifact,
  type ProductionRuntimePortAttestationArtifact,
  productionRuntimePortAttestationBindingHash,
  type TrustedProductionCompositionAttestationArtifactReader,
  type TrustedProductionCompositionAttestationArtifactSource,
  type TrustedProductionCompositionEvidencePublicKey,
  type TrustedProductionCompositionEvidencePublicKeyAuthority,
  type TrustedProductionCompositionPublicKey,
  type TrustedProductionCompositionPublicKeyAuthority,
} from "../../src/cloud/production-composition-attestation-verifier.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";
import {
  PRODUCTION_RUNTIME_PORT_IDS,
  type ProductionOptimizationCompositionManifest,
  type ProductionRuntimeComponentManifest,
  type ProductionRuntimePortId,
  type ProductionRuntimeRole,
  productionRuntimePortBindingsHash,
} from "../../src/orchestrator/production-runtime.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
  withContentHash,
} from "../../src/schemas/canonical.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const ISSUED_AT = "2026-07-26T11:05:00.000Z";
const EXPIRES_AT = "2026-07-26T13:00:00.000Z";
const KEY_ID = "composition-key-2026-07";
const EVIDENCE_KEY_ID = "composition-evidence-key-2026-07";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const { privateKey: evidencePrivateKey, publicKey: evidencePublicKey } =
  generateKeyPairSync("ed25519");

const ROLES = ["control", "optimizer", "build", "evaluator"] as const;

const PORT_ROLES = {
  "control.campaign-state-store": "control",
  "control.optimization-input-factory": "control",
  "control.optimization-resume-verifier": "control",
  "control.optimization-completion-material": "control",
  "control.optimization-interruption-port": "control",
  "control.experiment-journal": "control",
  "optimizer.adapter": "optimizer",
  "build.correctness-gate": "build",
  "evaluator.blind-broker": "evaluator",
} as const satisfies Readonly<Record<ProductionRuntimePortId, ProductionRuntimeRole>>;

function hash(label: string): string {
  return canonicalHash({
    domain: "test.production-composition-attestation.v1",
    label,
  });
}

function component(role: ProductionRuntimeRole): ProductionRuntimeComponentManifest {
  const imageDigest = `sha256:${hash(`image:${role}`)}` as `sha256:${string}`;
  return {
    role,
    boundary: "trusted-cloud",
    componentId: `df-${role}`,
    imageReference: `ghcr.io/parallaxai/df-${role}@${imageDigest}`,
    imageDigest,
    sourceArtifactHash: hash(`source:${role}`),
    configurationHash: hash(`configuration:${role}`),
  };
}

function implementationBindingHash(portId: ProductionRuntimePortId): string {
  return hash(`implementation:${portId}`);
}

function manifest(): ProductionOptimizationCompositionManifest {
  const components = {
    control: component("control"),
    optimizer: component("optimizer"),
    build: component("build"),
    evaluator: component("evaluator"),
  };
  const runtimePortAttestations = PRODUCTION_RUNTIME_PORT_IDS.map((portId) => {
    const role = PORT_ROLES[portId];
    const descriptor = components[role];
    return {
      portId,
      attestationSha256: productionRuntimePortAttestationBindingHash({
        portId,
        role,
        componentBindingHash: canonicalHash(descriptor),
        sourceArtifactHash: descriptor.sourceArtifactHash,
        configurationHash: descriptor.configurationHash,
        implementationBindingHash: implementationBindingHash(portId),
      }),
    };
  });
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimization-composition.v1" as const,
    manifestId: "production-001",
    campaignId: "campaign-001",
    lineageId: "lineage-001",
    protocolHash: hash("protocol"),
    deployment: "trusted-cloud" as const,
    components,
    runtimePortAttestations,
    bindings: {
      harnessRegistrationHash: hash("harness-registration"),
      campaignGenesisHash: hash("campaign-genesis"),
      hiddenCatalogGenesisHash: hash("hidden-catalog-genesis"),
      providerReadinessHash: hash("provider-readiness"),
      volumeSemanticsHash: hash("volume-semantics"),
      optimizerPluginBundleHash: hash("optimizer-plugin-bundle"),
      correctnessPolicyHash: hash("correctness-policy"),
      brokerPolicyHash: hash("broker-policy"),
      evaluatorPolicyHash: hash("evaluator-policy"),
      journalPolicyHash: hash("journal-policy"),
    },
    informationBoundary: {
      containsTaskIdentities: false as const,
      containsPanelIdentities: false as const,
      containsCellIdentities: false as const,
      containsRawEvidence: false as const,
      optimizerHasBenchmarkCredentials: false as const,
      optimizerCanReachEvaluator: false as const,
    },
    maximumExperimentsPerInvocation: 3,
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: EXPIRES_AT,
  };
  const signed = {
    ...unsigned,
    manifestHash: canonicalHash(unsigned),
  };
  return {
    ...signed,
    signature: createEd25519Signature(signed, privateKey, KEY_ID, "2026-07-26T11:00:01.000Z"),
  };
}

function commonArtifact(value: ProductionOptimizationCompositionManifest) {
  return {
    schemaVersion: 1 as const,
    sensitivity: "release-safe-control" as const,
    deployment: "trusted-cloud" as const,
    campaignId: value.campaignId,
    manifestId: value.manifestId,
    manifestHash: value.manifestHash,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function componentDocument(
  value: ProductionOptimizationCompositionManifest,
  role: ProductionRuntimeRole,
): ProductionComponentAttestationArtifact {
  const descriptor = value.components[role];
  return withContentHash({
    ...commonArtifact(value),
    domain: "dark-factory.production-component-attestation.v1" as const,
    role,
    componentBindingHash: canonicalHash(descriptor),
    imageReference: descriptor.imageReference,
    imageDigest: descriptor.imageDigest,
    sourceArtifactHash: descriptor.sourceArtifactHash,
    configurationHash: descriptor.configurationHash,
    providerAttestationHash: hash(`provider:${role}`),
  });
}

function operationalValues(value: ProductionOptimizationCompositionManifest): readonly string[] {
  return [
    value.bindings.harnessRegistrationHash,
    value.bindings.campaignGenesisHash,
    value.bindings.hiddenCatalogGenesisHash,
    value.bindings.providerReadinessHash,
    value.bindings.volumeSemanticsHash,
    value.bindings.optimizerPluginBundleHash,
    value.bindings.correctnessPolicyHash,
    value.bindings.brokerPolicyHash,
    value.bindings.evaluatorPolicyHash,
    value.bindings.journalPolicyHash,
  ];
}

function operationalDocument(
  value: ProductionOptimizationCompositionManifest,
): ProductionOperationalBindingsAttestationArtifact {
  const values = operationalValues(value);
  return withContentHash({
    ...commonArtifact(value),
    domain: "dark-factory.production-operational-bindings-attestation.v1" as const,
    operationalBindingsHash: canonicalHash(value.bindings),
    bindingAttestations: PRODUCTION_OPERATIONAL_BINDING_IDS.map((bindingId, index) => ({
      bindingId,
      attestationSha256: values[index]!,
    })),
  });
}

function runtimePortDocument(
  value: ProductionOptimizationCompositionManifest,
  portId: ProductionRuntimePortId,
): ProductionRuntimePortAttestationArtifact {
  const role = PORT_ROLES[portId];
  const descriptor = value.components[role];
  const commitment = value.runtimePortAttestations.find((item) => item.portId === portId);
  if (commitment === undefined) {
    throw new Error("Missing test runtime-port commitment.");
  }
  return withContentHash({
    ...commonArtifact(value),
    domain: "dark-factory.production-runtime-port-attestation.v1" as const,
    runtimePortBindingsHash: productionRuntimePortBindingsHash(value.runtimePortAttestations),
    portId,
    role,
    componentBindingHash: canonicalHash(descriptor),
    sourceArtifactHash: descriptor.sourceArtifactHash,
    configurationHash: descriptor.configurationHash,
    implementationBindingHash: implementationBindingHash(portId),
    attestationSha256: commitment.attestationSha256,
  });
}

function query(
  value: ProductionOptimizationCompositionManifest,
): ProductionCompositionAttestationQuery {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-composition-attestation-query.v1" as const,
    campaignId: value.campaignId,
    manifestId: value.manifestId,
    manifestHash: value.manifestHash,
    componentBindingsHash: canonicalHash(value.components),
    operationalBindingsHash: canonicalHash(value.bindings),
    runtimePortBindingsHash: productionRuntimePortBindingsHash(value.runtimePortAttestations),
  };
  return {
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  };
}

interface Fixture {
  readonly manifest: ProductionOptimizationCompositionManifest;
  readonly artifactSet: ProductionCompositionAttestationArtifactSet;
  readonly rawByUri: Map<string, string>;
  readonly source: TrustedProductionCompositionAttestationArtifactSource;
  readonly reader: TrustedProductionCompositionAttestationArtifactReader;
  readonly keyAuthority: TrustedProductionCompositionPublicKeyAuthority;
  readonly evidenceKeyAuthority: TrustedProductionCompositionEvidencePublicKeyAuthority;
  readonly locate: ReturnType<
    typeof vi.fn<TrustedProductionCompositionAttestationArtifactSource["locate"]>
  >;
  readonly readUtf8: ReturnType<
    typeof vi.fn<TrustedProductionCompositionAttestationArtifactReader["readUtf8"]>
  >;
  readonly resolve: ReturnType<
    typeof vi.fn<TrustedProductionCompositionPublicKeyAuthority["resolve"]>
  >;
  readonly resolveEvidenceKey: ReturnType<
    typeof vi.fn<TrustedProductionCompositionEvidencePublicKeyAuthority["resolve"]>
  >;
  readonly verifier: ArtifactBackedProductionCompositionAttestationVerifier;
}

function fixture(): Fixture {
  const signedManifest = manifest();
  const rawByUri = new Map<string, string>();
  const artifact = (name: string, document: object): TrustedCloudArtifactRef => {
    const raw = `${canonicalJson(document)}\n`;
    const ref: TrustedCloudArtifactRef = {
      uri: `trusted://production-composition-evidence/${name}`,
      sha256: sha256(raw),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(raw, "utf8"),
    };
    rawByUri.set(ref.uri, raw);
    return ref;
  };
  const componentAttestations = ROLES.map((role) => ({
    role,
    componentBindingHash: canonicalHash(signedManifest.components[role]),
    artifact: artifact(`component-${role}`, componentDocument(signedManifest, role)),
  }));
  const operationalBindingsAttestation = {
    operationalBindingsHash: canonicalHash(signedManifest.bindings),
    artifact: artifact("operational-bindings", operationalDocument(signedManifest)),
  };
  const runtimePortAttestations = signedManifest.runtimePortAttestations.map((commitment) => ({
    portId: commitment.portId,
    attestationSha256: commitment.attestationSha256,
    artifact: artifact(
      `runtime-port-${commitment.portId}`,
      runtimePortDocument(signedManifest, commitment.portId),
    ),
  }));
  const expectedQuery = query(signedManifest);
  const artifactSetUnsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-composition-attestation-artifact-set.v1" as const,
    sensitivity: "release-safe-control" as const,
    deployment: "trusted-cloud" as const,
    campaignId: signedManifest.campaignId,
    manifestId: signedManifest.manifestId,
    manifestHash: signedManifest.manifestHash,
    queryHash: expectedQuery.queryHash,
    componentAttestations,
    operationalBindingsAttestation,
    runtimePortAttestations,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  };
  const artifactSet: ProductionCompositionAttestationArtifactSet = withContentHash({
    ...artifactSetUnsigned,
    signature: createEd25519Signature(
      artifactSetUnsigned,
      evidencePrivateKey,
      EVIDENCE_KEY_ID,
      ISSUED_AT,
    ),
  });
  const locate = vi.fn(
    async (
      _input: ProductionCompositionAttestationQuery,
    ): Promise<ProductionCompositionAttestationArtifactSet> => artifactSet,
  );
  const readUtf8 = vi.fn(async (ref: TrustedCloudArtifactRef): Promise<string> => {
    const raw = rawByUri.get(ref.uri);
    if (raw === undefined) throw new Error("Missing test artifact.");
    return raw;
  });
  const resolve = vi.fn(
    async (): Promise<TrustedProductionCompositionPublicKey> => ({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-manifest",
      keyId: KEY_ID,
      keyVersion: "composition-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey,
    }),
  );
  const resolveEvidenceKey = vi.fn(
    async (): Promise<TrustedProductionCompositionEvidencePublicKey> => ({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-evidence-set",
      keyId: EVIDENCE_KEY_ID,
      keyVersion: "composition-evidence-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey: evidencePublicKey,
    }),
  );
  const source = {
    boundary: "trusted-cloud" as const,
    locate,
  };
  const reader = {
    boundary: "trusted-cloud" as const,
    readUtf8,
  };
  const keyAuthority = {
    boundary: "trusted-cloud" as const,
    resolve,
  };
  const evidenceKeyAuthority = {
    boundary: "trusted-cloud" as const,
    resolve: resolveEvidenceKey,
  };
  return {
    manifest: signedManifest,
    artifactSet,
    rawByUri,
    source,
    reader,
    keyAuthority,
    evidenceKeyAuthority,
    locate,
    readUtf8,
    resolve,
    resolveEvidenceKey,
    verifier: new ArtifactBackedProductionCompositionAttestationVerifier({
      source,
      reader,
      keyAuthority,
      evidenceKeyAuthority,
      trustedKeyIds: [KEY_ID],
      trustedEvidenceKeyIds: [EVIDENCE_KEY_ID],
      now: () => NOW,
    }),
  };
}

function replaceRaw(value: Fixture, ref: TrustedCloudArtifactRef, raw: string): void {
  value.rawByUri.set(ref.uri, raw);
  Object.assign(ref, {
    sha256: sha256(raw),
    byteLength: Buffer.byteLength(raw, "utf8"),
  });
}

function replaceDocument(
  value: Fixture,
  ref: TrustedCloudArtifactRef,
  update: (document: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
): void {
  const raw = value.rawByUri.get(ref.uri);
  if (raw === undefined) throw new Error("Missing test artifact.");
  const document = JSON.parse(raw) as Readonly<Record<string, unknown>>;
  replaceRaw(value, ref, `${canonicalJson(update(document))}\n`);
}

function rehashDocument(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const { contentHash: _contentHash, ...body } = value;
  return withContentHash(body);
}

function resignArtifactSet(
  value: Fixture,
  signingKey: typeof evidencePrivateKey = evidencePrivateKey,
): void {
  const { signature: _signature, contentHash: _contentHash, ...unsigned } = value.artifactSet;
  Object.assign(
    value.artifactSet,
    withContentHash({
      ...unsigned,
      signature: createEd25519Signature(unsigned, signingKey, EVIDENCE_KEY_ID, ISSUED_AT),
    }),
  );
}

describe("artifact-backed production composition attestation verifier", () => {
  it("verifies the exact immutable evidence set and returns a deterministic receipt", async () => {
    const value = fixture();

    const first = await value.verifier.verify(
      value.manifest,
      value.manifest.runtimePortAttestations,
    );
    const second = await value.verifier.verify(
      value.manifest,
      value.manifest.runtimePortAttestations,
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      domain: "dark-factory.production-composition-verification.v1",
      manifestHash: value.manifest.manifestHash,
      signingKeyId: KEY_ID,
      componentBindingsHash: canonicalHash(value.manifest.components),
      operationalBindingsHash: canonicalHash(value.manifest.bindings),
      runtimePortBindingsHash: productionRuntimePortBindingsHash(
        value.manifest.runtimePortAttestations,
      ),
      verified: true,
    });
    expect(first.verifierAttestationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.resolve).toHaveBeenCalledWith({
      purpose: "production-composition-manifest",
      keyId: KEY_ID,
      signedAt: value.manifest.signature.signedAt,
    });
    expect(value.resolveEvidenceKey).toHaveBeenCalledWith({
      purpose: "production-composition-evidence-set",
      keyId: EVIDENCE_KEY_ID,
      signedAt: ISSUED_AT,
    });
    expect(value.locate).toHaveBeenCalledWith(query(value.manifest));
    expect(value.readUtf8).toHaveBeenCalledTimes(28);
    expect(Object.isFrozen(value.readUtf8.mock.calls[0]?.[0])).toBe(true);
    const released = JSON.stringify({
      query: value.locate.mock.calls[0]?.[0],
      receipt: first,
    });
    expect(released).not.toContain('"implementation":');
    expect(released).not.toContain("taskId");
  });

  it("rejects forged signatures and detached rotation-aware public keys", async () => {
    const forged = fixture();
    Object.assign(forged.manifest.signature, {
      signature: "A".repeat(86),
    });
    await expect(
      forged.verifier.verify(forged.manifest, forged.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
    expect(forged.locate).not.toHaveBeenCalled();

    const revoked = fixture();
    revoked.resolve.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-manifest",
      keyId: KEY_ID,
      keyVersion: "composition-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: true,
      publicKey,
    });
    await expect(
      revoked.verifier.verify(revoked.manifest, revoked.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const wrongPurpose = fixture();
    wrongPurpose.resolve.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "result-envelope",
      keyId: KEY_ID,
      keyVersion: "composition-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey,
    } as never);
    await expect(
      wrongPurpose.verifier.verify(
        wrongPurpose.manifest,
        wrongPurpose.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const privateMaterial = fixture();
    privateMaterial.resolve.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-manifest",
      keyId: KEY_ID,
      keyVersion: "composition-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey,
      privateKey,
    } as never);
    await expect(
      privateMaterial.verifier.verify(
        privateMaterial.manifest,
        privateMaterial.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const privateKeyDisguisedAsPublic = fixture();
    privateKeyDisguisedAsPublic.resolve.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-manifest",
      keyId: KEY_ID,
      keyVersion: "composition-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey: privateKey,
    } as never);
    await expect(
      privateKeyDisguisedAsPublic.verifier.verify(
        privateKeyDisguisedAsPublic.manifest,
        privateKeyDisguisedAsPublic.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
  });

  it("rejects substituted, wrong-purpose, and revoked evidence-envelope keys", async () => {
    const substituted = fixture();
    resignArtifactSet(substituted, privateKey);
    substituted.resolveEvidenceKey.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-evidence-set",
      keyId: EVIDENCE_KEY_ID,
      keyVersion: "composition-evidence-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey,
    });
    await expect(
      substituted.verifier.verify(
        substituted.manifest,
        substituted.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
    expect(substituted.readUtf8).not.toHaveBeenCalled();

    const wrongPurpose = fixture();
    wrongPurpose.resolveEvidenceKey.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-manifest",
      keyId: EVIDENCE_KEY_ID,
      keyVersion: "composition-evidence-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: false,
      publicKey: evidencePublicKey,
    } as never);
    await expect(
      wrongPurpose.verifier.verify(
        wrongPurpose.manifest,
        wrongPurpose.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const revoked = fixture();
    revoked.resolveEvidenceKey.mockResolvedValue({
      boundary: "trusted-cloud-key-material",
      algorithm: "Ed25519",
      purpose: "production-composition-evidence-set",
      keyId: EVIDENCE_KEY_ID,
      keyVersion: "composition-evidence-key/2026-07",
      validFrom: "2026-07-26T10:00:00.000Z",
      validUntil: "2026-07-26T14:00:00.000Z",
      revoked: true,
      publicKey: evidencePublicKey,
    });
    await expect(
      revoked.verifier.verify(revoked.manifest, revoked.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
  });

  it("requires one exact artifact per role, operation bundle, and ordered port", async () => {
    const extra = fixture();
    Object.assign(extra.artifactSet, {
      hiddenTaskArtifact: {
        uri: "trusted://never/release",
      },
    });
    resignArtifactSet(extra);
    await expect(
      extra.verifier.verify(extra.manifest, extra.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
    expect(extra.readUtf8).not.toHaveBeenCalled();

    const reordered = fixture();
    (
      reordered.artifactSet
        .runtimePortAttestations as ProductionCompositionAttestationArtifactSet["runtimePortAttestations"] &
        unknown[]
    ).reverse();
    resignArtifactSet(reordered);
    await expect(
      reordered.verifier.verify(reordered.manifest, reordered.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const duplicate = fixture();
    const first = duplicate.artifactSet.runtimePortAttestations[0]?.artifact;
    const second = duplicate.artifactSet.runtimePortAttestations[1];
    if (first === undefined || second === undefined) {
      throw new Error("Invalid test artifact set.");
    }
    Object.assign(second, { artifact: first });
    resignArtifactSet(duplicate);
    await expect(
      duplicate.verifier.verify(duplicate.manifest, duplicate.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
  });

  it("rejects detached component, operational, and runtime-port evidence", async () => {
    const detachedComponent = fixture();
    const componentRef = detachedComponent.artifactSet.componentAttestations[0]?.artifact;
    if (componentRef === undefined) throw new Error("Missing test ref.");
    replaceDocument(detachedComponent, componentRef, (document) =>
      rehashDocument({
        ...document,
        sourceArtifactHash: hash("detached-source"),
      }),
    );
    resignArtifactSet(detachedComponent);
    await expect(
      detachedComponent.verifier.verify(
        detachedComponent.manifest,
        detachedComponent.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const reorderedOperations = fixture();
    const operationalRef = reorderedOperations.artifactSet.operationalBindingsAttestation.artifact;
    replaceDocument(reorderedOperations, operationalRef, (document) =>
      rehashDocument({
        ...document,
        bindingAttestations: [...(document["bindingAttestations"] as readonly unknown[])].reverse(),
      }),
    );
    resignArtifactSet(reorderedOperations);
    await expect(
      reorderedOperations.verifier.verify(
        reorderedOperations.manifest,
        reorderedOperations.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const detachedPort = fixture();
    const portRef = detachedPort.artifactSet.runtimePortAttestations[0]?.artifact;
    if (portRef === undefined) throw new Error("Missing test ref.");
    replaceDocument(detachedPort, portRef, (document) =>
      rehashDocument({
        ...document,
        implementationBindingHash: hash("detached-port"),
      }),
    );
    resignArtifactSet(detachedPort);
    await expect(
      detachedPort.verifier.verify(
        detachedPort.manifest,
        detachedPort.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
  });

  it("rejects noncanonical, mismatched, expired, and oversized artifact transport", async () => {
    const noncanonical = fixture();
    const noncanonicalRef = noncanonical.artifactSet.componentAttestations[0]?.artifact;
    if (noncanonicalRef === undefined) throw new Error("Missing test ref.");
    const canonicalRaw = noncanonical.rawByUri.get(noncanonicalRef.uri);
    if (canonicalRaw === undefined) throw new Error("Missing test raw.");
    replaceRaw(
      noncanonical,
      noncanonicalRef,
      `${JSON.stringify(JSON.parse(canonicalRaw), null, 2)}\n`,
    );
    resignArtifactSet(noncanonical);
    await expect(
      noncanonical.verifier.verify(
        noncanonical.manifest,
        noncanonical.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const mismatched = fixture();
    const mismatchedRef = mismatched.artifactSet.componentAttestations[0]?.artifact;
    if (mismatchedRef === undefined) throw new Error("Missing test ref.");
    const mismatchedRaw = mismatched.rawByUri.get(mismatchedRef.uri);
    if (mismatchedRaw === undefined) throw new Error("Missing test raw.");
    mismatched.rawByUri.set(mismatchedRef.uri, `${mismatchedRaw} `);
    await expect(
      mismatched.verifier.verify(mismatched.manifest, mismatched.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const expired = fixture();
    const expiredRef = expired.artifactSet.componentAttestations[0]?.artifact;
    if (expiredRef === undefined) throw new Error("Missing test ref.");
    replaceDocument(expired, expiredRef, (document) =>
      rehashDocument({
        ...document,
        issuedAt: "2026-07-26T11:00:00.000Z",
        expiresAt: "2026-07-26T11:30:00.000Z",
      }),
    );
    resignArtifactSet(expired);
    await expect(
      expired.verifier.verify(expired.manifest, expired.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);

    const oversized = fixture();
    const oversizedRef = oversized.artifactSet.componentAttestations[0]?.artifact;
    if (oversizedRef === undefined) throw new Error("Missing test ref.");
    Object.assign(oversizedRef, { byteLength: 256 * 1024 + 1 });
    resignArtifactSet(oversized);
    await expect(
      oversized.verifier.verify(oversized.manifest, oversized.manifest.runtimePortAttestations),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
    expect(oversized.readUtf8).not.toHaveBeenCalled();
  });

  it("captures trusted methods and rejects caller input mutation during verification", async () => {
    const captured = fixture();
    Object.assign(captured.source, {
      locate: vi.fn(async () => {
        throw new Error("mutated source");
      }),
    });
    Object.assign(captured.reader, {
      readUtf8: vi.fn(async () => {
        throw new Error("mutated reader");
      }),
    });
    Object.assign(captured.keyAuthority, {
      resolve: vi.fn(async () => {
        throw new Error("mutated key authority");
      }),
    });
    Object.assign(captured.evidenceKeyAuthority, {
      resolve: vi.fn(async () => {
        throw new Error("mutated evidence key authority");
      }),
    });
    await expect(
      captured.verifier.verify(captured.manifest, captured.manifest.runtimePortAttestations),
    ).resolves.toMatchObject({ verified: true });

    const mutatedInput = fixture();
    mutatedInput.locate.mockImplementation(
      async (): Promise<ProductionCompositionAttestationArtifactSet> => {
        Object.assign(mutatedInput.manifest, {
          campaignId: "campaign-mutated",
        });
        return mutatedInput.artifactSet;
      },
    );
    await expect(
      mutatedInput.verifier.verify(
        mutatedInput.manifest,
        mutatedInput.manifest.runtimePortAttestations,
      ),
    ).rejects.toBeInstanceOf(ProductionCompositionAttestationVerificationError);
  });

  it("rejects untrusted seams, undeclared options, and invalid rotation sets", () => {
    const value = fixture();
    expect(
      () =>
        new ArtifactBackedProductionCompositionAttestationVerifier({
          source: {
            ...value.source,
            boundary: "local" as "trusted-cloud",
          },
          reader: value.reader,
          keyAuthority: value.keyAuthority,
          evidenceKeyAuthority: value.evidenceKeyAuthority,
          trustedKeyIds: [KEY_ID],
          trustedEvidenceKeyIds: [EVIDENCE_KEY_ID],
        }),
    ).toThrow(ProductionCompositionAttestationVerificationError);
    expect(
      () =>
        new ArtifactBackedProductionCompositionAttestationVerifier({
          source: value.source,
          reader: value.reader,
          keyAuthority: value.keyAuthority,
          evidenceKeyAuthority: value.evidenceKeyAuthority,
          trustedKeyIds: [KEY_ID],
          trustedEvidenceKeyIds: [KEY_ID],
        }),
    ).toThrow(ProductionCompositionAttestationVerificationError);
    expect(
      () =>
        new ArtifactBackedProductionCompositionAttestationVerifier({
          source: value.source,
          reader: value.reader,
          keyAuthority: value.keyAuthority,
          evidenceKeyAuthority: value.evidenceKeyAuthority,
          trustedKeyIds: [KEY_ID, KEY_ID],
          trustedEvidenceKeyIds: [EVIDENCE_KEY_ID],
        }),
    ).toThrow(ProductionCompositionAttestationVerificationError);
    expect(
      () =>
        new ArtifactBackedProductionCompositionAttestationVerifier({
          source: value.source,
          reader: value.reader,
          keyAuthority: value.keyAuthority,
          evidenceKeyAuthority: value.evidenceKeyAuthority,
          trustedKeyIds: [KEY_ID],
          trustedEvidenceKeyIds: [EVIDENCE_KEY_ID],
          environmentRegistry: {},
        } as never),
    ).toThrow(ProductionCompositionAttestationVerificationError);
  });
});
