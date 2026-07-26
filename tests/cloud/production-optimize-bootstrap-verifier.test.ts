import { generateKeyPairSync, type KeyObject } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  type ProductionOptimizeBootstrapDescriptor,
  type ProductionOptimizeBootstrapDescriptorUnsigned,
  productionOptimizeBootstrapDescriptorHash,
  productionOptimizeBootstrapVerificationCommitmentHash,
} from "../../src/cloud/production-optimize-bootstrap.js";
import {
  Ed25519ProductionOptimizeBootstrapDescriptorVerifier,
  type Ed25519ProductionOptimizeBootstrapDescriptorVerifierOptions,
  PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE,
  ProductionOptimizeBootstrapDescriptorVerifierError,
  type ProductionOptimizeBootstrapPublicKeyRequest,
  type TrustedProductionOptimizeBootstrapPublicKey,
  type TrustedProductionOptimizeBootstrapPublicKeyAuthority,
} from "../../src/cloud/production-optimize-bootstrap-verifier.js";
import { createEd25519Signature } from "../../src/evidence/signatures.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const ISSUED_AT = "2026-07-26T11:00:00.000Z";
const SIGNED_AT = "2026-07-26T11:00:01.000Z";
const EXPIRES_AT = "2026-07-26T13:00:00.000Z";
const VALID_FROM = "2026-07-01T00:00:00.000Z";
const VALID_UNTIL = "2026-08-01T00:00:00.000Z";
const KEY_ID = "bootstrap-key-001";
const KEY_VERSION = "kms/bootstrap/versions/3";
const AUTHORITY_SET_HASH = "a".repeat(64);
const VERIFICATION_KEY_SET_HASH = "b".repeat(64);
const VERIFIER_POLICY_HASH = "c".repeat(64);
const PROTOCOL_HASH = "d".repeat(64);
const COMPOSITION_HASH = "e".repeat(64);
const ARTIFACT_HASH = "f".repeat(64);
const keyPair = generateKeyPairSync("ed25519");
const spki = keyPair.publicKey.export({
  format: "der",
  type: "spki",
});

function commitments(
  overrides: {
    readonly authoritySetHash?: string;
    readonly verificationKeySetHash?: string;
    readonly verifierPolicyHash?: string;
  } = {},
) {
  const values = {
    authoritySetHash: overrides.authoritySetHash ?? AUTHORITY_SET_HASH,
    verificationKeySetHash: overrides.verificationKeySetHash ?? VERIFICATION_KEY_SET_HASH,
    verifierPolicyHash: overrides.verifierPolicyHash ?? VERIFIER_POLICY_HASH,
  };
  return {
    ...values,
    verificationCommitmentHash: productionOptimizeBootstrapVerificationCommitmentHash(values),
  };
}

function descriptor(
  options: {
    readonly authoritySetHash?: string;
    readonly verificationKeySetHash?: string;
    readonly verifierPolicyHash?: string;
    readonly issuedAt?: string;
    readonly signedAt?: string;
    readonly expiresAt?: string;
    readonly keyId?: string;
    readonly privateKey?: KeyObject;
  } = {},
): ProductionOptimizeBootstrapDescriptor {
  const trust = commitments(options);
  const unsigned: ProductionOptimizeBootstrapDescriptorUnsigned = {
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-bootstrap.v1",
    descriptorId: "bootstrap-001",
    campaignId: "campaign-one",
    lineageId: "lineage-one",
    protocolHash: PROTOCOL_HASH,
    compositionArtifact: {
      uri: "trusted://production-compositions/campaign-one.json",
      sha256: ARTIFACT_HASH,
      mediaType: "application/json",
      byteLength: 4_096,
    },
    compositionManifestHash: COMPOSITION_HASH,
    ...trust,
    issuedAt: options.issuedAt ?? ISSUED_AT,
    expiresAt: options.expiresAt ?? EXPIRES_AT,
  };
  const signedDocument = {
    ...unsigned,
    descriptorHash: productionOptimizeBootstrapDescriptorHash(unsigned),
  };
  return {
    ...signedDocument,
    signature: createEd25519Signature(
      signedDocument,
      options.privateKey ?? keyPair.privateKey,
      options.keyId ?? KEY_ID,
      options.signedAt ?? SIGNED_AT,
    ),
  };
}

function keyMaterial(
  overrides: Partial<TrustedProductionOptimizeBootstrapPublicKey> = {},
): TrustedProductionOptimizeBootstrapPublicKey {
  return {
    boundary: "trusted-cloud-key-material",
    algorithm: "Ed25519",
    purpose: PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE,
    keyId: KEY_ID,
    keyVersion: KEY_VERSION,
    validFrom: VALID_FROM,
    validUntil: VALID_UNTIL,
    revoked: false,
    authoritySetHash: AUTHORITY_SET_HASH,
    verificationKeySetHash: VERIFICATION_KEY_SET_HASH,
    publicKeySpkiDer: spki,
    ...overrides,
  };
}

function authority(
  resolve: (
    request: ProductionOptimizeBootstrapPublicKeyRequest,
  ) => Promise<TrustedProductionOptimizeBootstrapPublicKey | undefined> = async () => keyMaterial(),
) {
  return {
    boundary: "trusted-cloud-production-optimize-bootstrap-public-key-authority" as const,
    resolve: vi.fn(resolve),
  };
}

function verifierOptions(
  keyAuthority: TrustedProductionOptimizeBootstrapPublicKeyAuthority,
  overrides: Partial<Ed25519ProductionOptimizeBootstrapDescriptorVerifierOptions> = {},
): Ed25519ProductionOptimizeBootstrapDescriptorVerifierOptions {
  const trust = commitments();
  return {
    authority: keyAuthority,
    rotations: [
      {
        keyId: KEY_ID,
        keyVersion: KEY_VERSION,
        validFrom: VALID_FROM,
        validUntil: VALID_UNTIL,
      },
    ],
    ...trust,
    maximumClockSkewMs: 0,
    now: () => NOW,
    ...overrides,
  };
}

describe("Ed25519 production optimize bootstrap descriptor verifier", () => {
  it("returns one deterministic strict receipt for the exact signed descriptor", async () => {
    const keys = authority();
    const verifier = new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
      verifierOptions(keys),
    );
    const input = descriptor();

    const first = await verifier.verify(input);
    const second = await verifier.verify(input);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(
      [
        "schemaVersion",
        "domain",
        "descriptorHash",
        "signingKeyId",
        "authoritySetHash",
        "verificationKeySetHash",
        "verifierPolicyHash",
        "verificationCommitmentHash",
        "verifierAttestationHash",
        "verified",
      ].sort(),
    );
    expect(first).toMatchObject({
      descriptorHash: input.descriptorHash,
      signingKeyId: KEY_ID,
      authoritySetHash: AUTHORITY_SET_HASH,
      verificationKeySetHash: VERIFICATION_KEY_SET_HASH,
      verifierPolicyHash: VERIFIER_POLICY_HASH,
      verificationCommitmentHash: input.verificationCommitmentHash,
      verified: true,
    });
    expect(first.verifierAttestationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(keys.resolve).toHaveBeenCalledWith({
      schemaVersion: 1,
      domain: "dark-factory.production-optimize-bootstrap-public-key-request.v1",
      purpose: PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE,
      keyId: KEY_ID,
      keyVersion: KEY_VERSION,
      signedAt: SIGNED_AT,
      authoritySetHash: AUTHORITY_SET_HASH,
      verificationKeySetHash: VERIFICATION_KEY_SET_HASH,
      verifierPolicyHash: VERIFIER_POLICY_HASH,
      verificationCommitmentHash: input.verificationCommitmentHash,
    });
    expect(Object.isFrozen(keys.resolve.mock.calls[0]?.[0])).toBe(true);
  });

  it("rejects the wrong key purpose, version, rotation window, or public key", async () => {
    const wrongPurpose = authority(
      async () =>
        ({
          ...keyMaterial(),
          purpose: "result-envelope",
        }) as unknown as TrustedProductionOptimizeBootstrapPublicKey,
    );
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
        verifierOptions(wrongPurpose),
      ).verify(descriptor()),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const wrongId = authority(async () => keyMaterial({ keyId: "bootstrap-key-002" }));
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(verifierOptions(wrongId)).verify(
        descriptor(),
      ),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const wrongVersion = authority(async () =>
      keyMaterial({ keyVersion: "kms/bootstrap/versions/4" }),
    );
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
        verifierOptions(wrongVersion),
      ).verify(descriptor()),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const wrongWindow = authority(async () =>
      keyMaterial({ validFrom: "2026-07-02T00:00:00.000Z" }),
    );
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(verifierOptions(wrongWindow)).verify(
        descriptor(),
      ),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const revoked = authority(async () => keyMaterial({ revoked: true }));
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(verifierOptions(revoked)).verify(
        descriptor(),
      ),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const otherKeys = generateKeyPairSync("ed25519");
    const wrongKey = authority(async () =>
      keyMaterial({
        publicKeySpkiDer: otherKeys.publicKey.export({
          format: "der",
          type: "spki",
        }),
      }),
    );
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(verifierOptions(wrongKey)).verify(
        descriptor(),
      ),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
  });

  it("rejects detached commitments before resolving a key", async () => {
    const keys = authority();
    const verifier = new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
      verifierOptions(keys),
    );

    for (const detached of [
      descriptor({ authoritySetHash: "9".repeat(64) }),
      descriptor({ verificationKeySetHash: "8".repeat(64) }),
      descriptor({ verifierPolicyHash: "7".repeat(64) }),
    ]) {
      await expect(verifier.verify(detached)).rejects.toBeInstanceOf(
        ProductionOptimizeBootstrapDescriptorVerifierError,
      );
    }
    expect(keys.resolve).not.toHaveBeenCalled();

    expect(
      () =>
        new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
          verifierOptions(authority(), {
            verificationCommitmentHash: "8".repeat(64),
          }),
        ),
    ).toThrow(ProductionOptimizeBootstrapDescriptorVerifierError);
  });

  it("rejects unsigned-payload, schema, hash, and signature mutation", async () => {
    const keys = authority();
    const verifier = new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
      verifierOptions(keys),
    );
    const signed = descriptor();
    await expect(
      verifier.verify({
        ...signed,
        compositionManifestHash: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
    await expect(
      verifier.verify({
        ...signed,
        executableModule: "untrusted-constructor",
      } as unknown as ProductionOptimizeBootstrapDescriptor),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
    expect(keys.resolve).not.toHaveBeenCalled();

    const signature = signed.signature.signature;
    const replacement = signature.startsWith("A") ? "B" : "A";
    await expect(
      verifier.verify({
        ...signed,
        signature: {
          ...signed.signature,
          signature: `${replacement}${signature.slice(1)}`,
        },
      }),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
    expect(keys.resolve).toHaveBeenCalledOnce();
  });

  it("rejects expired, future-signed, unknown, and overlapping rotations", async () => {
    const keys = authority();
    const verifier = new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
      verifierOptions(keys),
    );
    await expect(
      verifier.verify(
        descriptor({
          issuedAt: "2026-07-26T10:00:00.000Z",
          signedAt: "2026-07-26T10:00:01.000Z",
          expiresAt: "2026-07-26T11:00:00.000Z",
        }),
      ),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
    await expect(
      verifier.verify(descriptor({ signedAt: "2026-07-26T12:01:00.000Z" })),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
    await expect(verifier.verify(descriptor({ keyId: "unknown-key" }))).rejects.toBeInstanceOf(
      ProductionOptimizeBootstrapDescriptorVerifierError,
    );
    expect(keys.resolve).not.toHaveBeenCalled();

    expect(
      () =>
        new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
          verifierOptions(authority(), {
            rotations: [
              {
                keyId: KEY_ID,
                keyVersion: KEY_VERSION,
                validFrom: VALID_FROM,
                validUntil: VALID_UNTIL,
              },
              {
                keyId: KEY_ID,
                keyVersion: "kms/bootstrap/versions/4",
                validFrom: "2026-07-15T00:00:00.000Z",
                validUntil: "2026-08-15T00:00:00.000Z",
              },
            ],
          }),
        ),
    ).toThrow(ProductionOptimizeBootstrapDescriptorVerifierError);
  });

  it("rejects key responses that can carry private material", async () => {
    const leaked = {
      ...keyMaterial(),
      privateKey: keyPair.privateKey,
    } as unknown as TrustedProductionOptimizeBootstrapPublicKey;
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
        verifierOptions(authority(async () => leaked)),
      ).verify(descriptor()),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);

    const pkcs8 = keyPair.privateKey.export({
      format: "der",
      type: "pkcs8",
    });
    await expect(
      new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
        verifierOptions(authority(async () => keyMaterial({ publicKeySpkiDer: pkcs8 }))),
      ).verify(descriptor()),
    ).rejects.toBeInstanceOf(ProductionOptimizeBootstrapDescriptorVerifierError);
  });

  it("captures the authority method and snapshots the descriptor before awaiting it", async () => {
    let release: ((value: TrustedProductionOptimizeBootstrapPublicKey) => void) | undefined;
    const originalResolve = vi.fn(
      () =>
        new Promise<TrustedProductionOptimizeBootstrapPublicKey>((resolve) => {
          release = resolve;
        }),
    );
    const keys = {
      boundary: "trusted-cloud-production-optimize-bootstrap-public-key-authority" as const,
      resolve: originalResolve,
    };
    const verifier = new Ed25519ProductionOptimizeBootstrapDescriptorVerifier(
      verifierOptions(keys),
    );
    const mutatedResolve = vi.fn(
      (
        _request: ProductionOptimizeBootstrapPublicKeyRequest,
      ): Promise<TrustedProductionOptimizeBootstrapPublicKey | undefined> =>
        Promise.reject(new Error("mutated authority method")),
    );
    (
      keys as {
        resolve: TrustedProductionOptimizeBootstrapPublicKeyAuthority["resolve"];
      }
    ).resolve = mutatedResolve;
    const input = descriptor();
    const expectedHash = input.descriptorHash;
    const pending = verifier.verify(input);
    (input as unknown as { campaignId: string }).campaignId = "mutated-campaign";
    release?.(keyMaterial());

    await expect(pending).resolves.toMatchObject({
      descriptorHash: expectedHash,
      verified: true,
    });
    expect(originalResolve).toHaveBeenCalledOnce();
    expect(mutatedResolve).not.toHaveBeenCalled();
  });
});
