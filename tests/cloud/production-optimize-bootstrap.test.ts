import { describe, expect, it, vi } from "vitest";

import {
  type ProductionOptimizeBootstrapDescriptor,
  type ProductionOptimizeBootstrapDescriptorUnsigned,
  type ProductionOptimizeBootstrapDescriptorVerification,
  ProductionOptimizeBootstrapError,
  parseProductionOptimizeBootstrapDescriptorJson,
  productionOptimizeBootstrapDescriptorHash,
  productionOptimizeBootstrapVerificationCommitmentHash,
  VerifiedProductionOptimizeBootstrapArtifactLoader,
} from "../../src/cloud/production-optimize-bootstrap.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import { PRODUCTION_RUNTIME_PORT_IDS } from "../../src/orchestrator/production-runtime.js";
import { canonicalHash, canonicalJson, sha256 } from "../../src/schemas/canonical.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const OCI_DIGEST = `sha256:${"e".repeat(64)}` as const;

function compositionDocument(): Readonly<Record<string, unknown>> {
  const component = (role: string) => ({
    role,
    boundary: "trusted-cloud",
    componentId: `df-${role}`,
    imageReference: `ghcr.io/parallaxai/df-${role}@${OCI_DIGEST}`,
    imageDigest: OCI_DIGEST,
    sourceArtifactHash: HASH_A,
    configurationHash: HASH_B,
  });
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimization-composition.v1" as const,
    manifestId: "production-001",
    campaignId: "campaign-one",
    lineageId: "lineage-one",
    protocolHash: HASH_A,
    deployment: "trusted-cloud" as const,
    components: {
      control: component("control"),
      optimizer: component("optimizer"),
      build: component("build"),
      evaluator: component("evaluator"),
    },
    runtimePortAttestations: PRODUCTION_RUNTIME_PORT_IDS.map((portId) => ({
      portId,
      attestationSha256: canonicalHash({
        domain: "test.task-free-runtime-port-attestation.v1",
        portId,
      }),
    })),
    bindings: {
      harnessRegistrationHash: HASH_A,
      campaignGenesisHash: HASH_A,
      hiddenCatalogGenesisHash: HASH_A,
      providerReadinessHash: HASH_A,
      volumeSemanticsHash: HASH_A,
      optimizerPluginBundleHash: HASH_A,
      correctnessPolicyHash: HASH_A,
      brokerPolicyHash: HASH_A,
      evaluatorPolicyHash: HASH_A,
      journalPolicyHash: HASH_A,
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
    expiresAt: "2026-07-26T13:00:00.000Z",
  };
  return {
    ...unsigned,
    manifestHash: canonicalHash(unsigned),
    signature: {
      algorithm: "ed25519",
      keyId: "composition-key",
      signedAt: "2026-07-26T11:00:01.000Z",
      signature: "A".repeat(86),
    },
  };
}

interface BootstrapFixture {
  readonly descriptor: ProductionOptimizeBootstrapDescriptor;
  readonly document: Readonly<Record<string, unknown>>;
  readonly raw: string;
}

function bootstrapFixture(
  options: {
    readonly document?: Readonly<Record<string, unknown>>;
    readonly raw?: string;
    readonly artifact?: Partial<TrustedCloudArtifactRef>;
  } = {},
): BootstrapFixture {
  const document = options.document ?? compositionDocument();
  const raw = options.raw ?? `${canonicalJson(document)}\n`;
  const compositionArtifact: TrustedCloudArtifactRef = {
    uri: "trusted://production-compositions/campaign-one.json",
    sha256: sha256(raw),
    mediaType: "application/json",
    byteLength: Buffer.byteLength(raw, "utf8"),
    ...options.artifact,
  };
  const commitment = {
    authoritySetHash: HASH_B,
    verificationKeySetHash: HASH_C,
    verifierPolicyHash: HASH_D,
  };
  const unsigned: ProductionOptimizeBootstrapDescriptorUnsigned = {
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-bootstrap.v1",
    descriptorId: "bootstrap-001",
    campaignId: "campaign-one",
    lineageId: "lineage-one",
    protocolHash: HASH_A,
    compositionArtifact,
    compositionManifestHash: document["manifestHash"] as string,
    ...commitment,
    verificationCommitmentHash: productionOptimizeBootstrapVerificationCommitmentHash(commitment),
    issuedAt: "2026-07-26T11:00:00.000Z",
    expiresAt: "2026-07-26T13:00:00.000Z",
  };
  return {
    descriptor: {
      ...unsigned,
      descriptorHash: productionOptimizeBootstrapDescriptorHash(unsigned),
      signature: {
        algorithm: "ed25519",
        keyId: "bootstrap-key",
        signedAt: "2026-07-26T11:00:01.000Z",
        signature: "B".repeat(86),
      },
    },
    document,
    raw,
  };
}

function verification(
  descriptor: ProductionOptimizeBootstrapDescriptor,
  overrides: Partial<ProductionOptimizeBootstrapDescriptorVerification> = {},
): ProductionOptimizeBootstrapDescriptorVerification {
  return {
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-bootstrap-verification.v1",
    descriptorHash: descriptor.descriptorHash,
    signingKeyId: descriptor.signature.keyId,
    authoritySetHash: descriptor.authoritySetHash,
    verificationKeySetHash: descriptor.verificationKeySetHash,
    verifierPolicyHash: descriptor.verifierPolicyHash,
    verificationCommitmentHash: descriptor.verificationCommitmentHash,
    verifierAttestationHash: HASH_A,
    verified: true,
    ...overrides,
  };
}

function loaderFor(
  fixture: BootstrapFixture,
  verificationOverrides: Partial<ProductionOptimizeBootstrapDescriptorVerification> = {},
) {
  const readUtf8 = vi.fn((_artifact: TrustedCloudArtifactRef, _maximumBytes: number) =>
    Promise.resolve(fixture.raw),
  );
  const verify = vi.fn((descriptor: ProductionOptimizeBootstrapDescriptor) =>
    Promise.resolve(verification(descriptor, verificationOverrides)),
  );
  return {
    readUtf8,
    verify,
    loader: new VerifiedProductionOptimizeBootstrapArtifactLoader({
      reader: {
        boundary: "trusted-cloud",
        readUtf8,
      },
      verifier: {
        boundary: "trusted-cloud-bootstrap-descriptor-verifier",
        verify,
      },
      now: () => NOW,
    }),
  };
}

describe("production optimize bootstrap descriptor", () => {
  it("accepts only exact canonical task-free campaign-bound JSON", () => {
    const fixture = bootstrapFixture();
    const canonical = canonicalJson(fixture.descriptor);

    expect(parseProductionOptimizeBootstrapDescriptorJson(canonical, "campaign-one")).toEqual(
      fixture.descriptor,
    );
    expect(() =>
      parseProductionOptimizeBootstrapDescriptorJson(`${canonical}\n`, "campaign-one"),
    ).toThrow(ProductionOptimizeBootstrapError);
    expect(() =>
      parseProductionOptimizeBootstrapDescriptorJson(canonical, "another-campaign"),
    ).toThrow(ProductionOptimizeBootstrapError);
    expect(() =>
      parseProductionOptimizeBootstrapDescriptorJson(
        canonicalJson({
          ...fixture.descriptor,
          descriptorHash: HASH_A,
        }),
        "campaign-one",
      ),
    ).toThrow(ProductionOptimizeBootstrapError);
  });

  it("verifies authority and transport without constructing ports", async () => {
    const fixture = bootstrapFixture();
    const { loader, readUtf8, verify } = loaderFor(fixture);

    const loaded = await loader.load(fixture.descriptor);

    expect(verify).toHaveBeenCalledOnce();
    expect(Object.isFrozen(verify.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(verify.mock.calls[0]?.[0].compositionArtifact)).toBe(true);
    expect(readUtf8).toHaveBeenCalledWith(fixture.descriptor.compositionArtifact, 4 * 1024 * 1024);
    expect(Object.isFrozen(readUtf8.mock.calls[0]?.[0])).toBe(true);
    expect(loaded).toMatchObject({
      campaignId: "campaign-one",
      lineageId: "lineage-one",
      protocolHash: HASH_A,
      descriptorHash: fixture.descriptor.descriptorHash,
      compositionManifestHash: fixture.descriptor.compositionManifestHash,
      compositionDocumentHash: canonicalHash(fixture.document),
      descriptorAuthorityVerified: true,
      artifactTransportVerified: true,
      compositionAuthorityVerified: false,
      executableBindingsCreated: false,
      document: fixture.document,
    });
    expect(Object.isFrozen(loaded.document)).toBe(true);
    expect(Object.isFrozen(loaded.document["informationBoundary"])).toBe(true);
  });

  it("rejects untrusted seams and a detached authority receipt", async () => {
    const fixture = bootstrapFixture();
    expect(
      () =>
        new VerifiedProductionOptimizeBootstrapArtifactLoader({
          reader: {
            boundary: "local" as "trusted-cloud",
            readUtf8: () => Promise.resolve(fixture.raw),
          },
          verifier: {
            boundary: "trusted-cloud-bootstrap-descriptor-verifier",
            verify: () => Promise.resolve(verification(fixture.descriptor)),
          },
        }),
    ).toThrow(ProductionOptimizeBootstrapError);

    const detached = loaderFor(fixture, {
      verifierPolicyHash: HASH_A,
    });
    await expect(detached.loader.load(fixture.descriptor)).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapError,
    );
  });

  it("rejects mismatched bytes and non-canonical composition JSON", async () => {
    const fixture = bootstrapFixture();
    const mismatched = bootstrapFixture({
      artifact: { sha256: HASH_A },
    });
    await expect(loaderFor(mismatched).loader.load(mismatched.descriptor)).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapError,
    );

    const noncanonicalRaw = `${JSON.stringify(fixture.document)}\n`;
    expect(noncanonicalRaw).not.toBe(`${canonicalJson(fixture.document)}\n`);
    const noncanonical = bootstrapFixture({
      document: fixture.document,
      raw: noncanonicalRaw,
    });
    await expect(
      loaderFor(noncanonical).loader.load(noncanonical.descriptor),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapError);
  });

  it("rejects an expired descriptor before authority or artifact access", async () => {
    const fixture = bootstrapFixture();
    const { descriptorHash: _descriptorHash, signature, ...unsigned } = fixture.descriptor;
    const expiredUnsigned: ProductionOptimizeBootstrapDescriptorUnsigned = {
      ...unsigned,
      issuedAt: "2026-07-26T10:00:00.000Z",
      expiresAt: "2026-07-26T11:00:00.000Z",
    };
    const expired: BootstrapFixture = {
      ...fixture,
      descriptor: {
        ...expiredUnsigned,
        descriptorHash: productionOptimizeBootstrapDescriptorHash(expiredUnsigned),
        signature: {
          ...signature,
          signedAt: "2026-07-26T10:00:01.000Z",
        },
      },
    };
    const { loader, readUtf8, verify } = loaderFor(expired);

    await expect(loader.load(expired.descriptor)).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapError,
    );
    expect(verify).not.toHaveBeenCalled();
    expect(readUtf8).not.toHaveBeenCalled();
  });

  it("rejects task-bearing boundaries and malformed runtime-port commitments", async () => {
    const taskBearingBase = compositionDocument();
    const taskBearing = bootstrapFixture({
      document: {
        ...taskBearingBase,
        informationBoundary: {
          ...(taskBearingBase["informationBoundary"] as Record<string, boolean>),
          containsTaskIdentities: true,
        },
      },
    });
    await expect(loaderFor(taskBearing).loader.load(taskBearing.descriptor)).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapError,
    );

    const malformedBase = compositionDocument();
    const attestations = [
      ...(malformedBase["runtimePortAttestations"] as readonly Record<string, unknown>[]),
    ];
    attestations[0] = {
      ...(attestations[0] ?? {}),
      portId: "control.task-specific-secret-port",
    };
    const malformed = bootstrapFixture({
      document: {
        ...malformedBase,
        runtimePortAttestations: attestations,
      },
    });
    await expect(loaderFor(malformed).loader.load(malformed.descriptor)).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapError,
    );
  });
});
