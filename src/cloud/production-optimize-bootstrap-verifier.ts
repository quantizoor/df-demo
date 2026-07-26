import { createPublicKey } from "node:crypto";

import { verifyEd25519Signature } from "../evidence/signatures.js";
import { canonicalHash, canonicalJson, sha256 } from "../schemas/canonical.js";
import {
  assertProductionOptimizeBootstrapDescriptor,
  type ProductionOptimizeBootstrapDescriptor,
  type ProductionOptimizeBootstrapDescriptorUnsigned,
  type ProductionOptimizeBootstrapDescriptorVerification,
  productionOptimizeBootstrapDescriptorHash,
  productionOptimizeBootstrapVerificationCommitmentHash,
  type TrustedProductionOptimizeBootstrapDescriptorVerifier,
} from "./production-optimize-bootstrap.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const MAXIMUM_ROTATIONS = 64;
const MAXIMUM_CLOCK_SKEW_MS = 60 * 60_000;

export const PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE =
  "production-optimize-bootstrap-descriptor" as const;

export interface ProductionOptimizeBootstrapKeyRotation {
  readonly keyId: string;
  readonly keyVersion: string;
  /**
   * Half-open validity interval: validFrom <= signature.signedAt < validUntil.
   */
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface ProductionOptimizeBootstrapPublicKeyRequest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimize-bootstrap-public-key-request.v1";
  readonly purpose: typeof PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly signedAt: string;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly verifierPolicyHash: string;
  readonly verificationCommitmentHash: string;
}

export interface TrustedProductionOptimizeBootstrapPublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: typeof PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revoked: boolean;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  /**
   * SubjectPublicKeyInfo DER only. PKCS#8/private-key input is not accepted.
   */
  readonly publicKeySpkiDer: Uint8Array;
}

export interface TrustedProductionOptimizeBootstrapPublicKeyAuthority {
  readonly boundary: "trusted-cloud-production-optimize-bootstrap-public-key-authority";
  resolve(
    request: ProductionOptimizeBootstrapPublicKeyRequest,
  ): Promise<TrustedProductionOptimizeBootstrapPublicKey | undefined>;
}

export interface Ed25519ProductionOptimizeBootstrapDescriptorVerifierOptions {
  readonly authority: TrustedProductionOptimizeBootstrapPublicKeyAuthority;
  readonly rotations: readonly ProductionOptimizeBootstrapKeyRotation[];
  /**
   * These values come from independently governed configuration, never from
   * the descriptor being verified.
   */
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly verifierPolicyHash: string;
  readonly verificationCommitmentHash: string;
  readonly maximumClockSkewMs?: number;
  readonly now?: () => Date;
}

interface CapturedRotation extends ProductionOptimizeBootstrapKeyRotation {
  readonly validFromMs: number;
  readonly validUntilMs: number;
}

export class ProductionOptimizeBootstrapDescriptorVerifierError extends Error {
  override readonly name = "ProductionOptimizeBootstrapDescriptorVerifierError";

  constructor() {
    super("Production optimize bootstrap descriptor verification failed.");
  }
}

function fail(): never {
  throw new ProductionOptimizeBootstrapDescriptorVerifierError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail();
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail();
  }
  return parsed;
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail();
  }
  return new Date(value.getTime());
}

function unsignedDescriptor(
  descriptor: ProductionOptimizeBootstrapDescriptor,
): ProductionOptimizeBootstrapDescriptorUnsigned {
  return {
    schemaVersion: descriptor.schemaVersion,
    domain: descriptor.domain,
    descriptorId: descriptor.descriptorId,
    campaignId: descriptor.campaignId,
    lineageId: descriptor.lineageId,
    protocolHash: descriptor.protocolHash,
    compositionArtifact: descriptor.compositionArtifact,
    compositionManifestHash: descriptor.compositionManifestHash,
    authoritySetHash: descriptor.authoritySetHash,
    verificationKeySetHash: descriptor.verificationKeySetHash,
    verifierPolicyHash: descriptor.verifierPolicyHash,
    verificationCommitmentHash: descriptor.verificationCommitmentHash,
    issuedAt: descriptor.issuedAt,
    expiresAt: descriptor.expiresAt,
  };
}

function captureRotations(
  rotations: readonly ProductionOptimizeBootstrapKeyRotation[],
): readonly CapturedRotation[] {
  if (!Array.isArray(rotations) || rotations.length < 1 || rotations.length > MAXIMUM_ROTATIONS) {
    fail();
  }
  const captured = rotations.map((value): CapturedRotation => {
    exactKeys(value, ["keyId", "keyVersion", "validFrom", "validUntil"]);
    const rotation = value as unknown as ProductionOptimizeBootstrapKeyRotation;
    const validFromMs = timestamp(rotation.validFrom);
    const validUntilMs = timestamp(rotation.validUntil);
    if (
      !SAFE_KEY_ID.test(rotation.keyId) ||
      !SAFE_KEY_VERSION.test(rotation.keyVersion) ||
      validFromMs >= validUntilMs
    ) {
      fail();
    }
    return Object.freeze({
      keyId: rotation.keyId,
      keyVersion: rotation.keyVersion,
      validFrom: rotation.validFrom,
      validUntil: rotation.validUntil,
      validFromMs,
      validUntilMs,
    });
  });
  const versions = new Set(
    captured.map((rotation) => `${rotation.keyId}\u0000${rotation.keyVersion}`),
  );
  if (versions.size !== captured.length) fail();
  captured.sort((left, right) => {
    if (left.keyId !== right.keyId) {
      return left.keyId < right.keyId ? -1 : 1;
    }
    if (left.validFromMs !== right.validFromMs) {
      return left.validFromMs - right.validFromMs;
    }
    if (left.keyVersion === right.keyVersion) return 0;
    return left.keyVersion < right.keyVersion ? -1 : 1;
  });
  for (const [index, rotation] of captured.entries()) {
    const previous = captured[index - 1];
    if (
      previous !== undefined &&
      previous.keyId === rotation.keyId &&
      previous.validUntilMs > rotation.validFromMs
    ) {
      fail();
    }
  }
  return Object.freeze(captured);
}

function assertPublicKey(
  value: unknown,
  request: ProductionOptimizeBootstrapPublicKeyRequest,
  rotation: CapturedRotation,
): asserts value is TrustedProductionOptimizeBootstrapPublicKey {
  exactKeys(value, [
    "boundary",
    "algorithm",
    "purpose",
    "keyId",
    "keyVersion",
    "validFrom",
    "validUntil",
    "revoked",
    "authoritySetHash",
    "verificationKeySetHash",
    "publicKeySpkiDer",
  ]);
  const key = value as unknown as TrustedProductionOptimizeBootstrapPublicKey;
  if (
    key.boundary !== "trusted-cloud-key-material" ||
    key.algorithm !== "Ed25519" ||
    key.purpose !== PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE ||
    key.keyId !== request.keyId ||
    key.keyVersion !== request.keyVersion ||
    key.validFrom !== rotation.validFrom ||
    key.validUntil !== rotation.validUntil ||
    key.revoked !== false ||
    key.authoritySetHash !== request.authoritySetHash ||
    key.verificationKeySetHash !== request.verificationKeySetHash ||
    !(key.publicKeySpkiDer instanceof Uint8Array) ||
    key.publicKeySpkiDer.byteLength < 32 ||
    key.publicKeySpkiDer.byteLength > 8_192
  ) {
    fail();
  }
}

export class Ed25519ProductionOptimizeBootstrapDescriptorVerifier
  implements TrustedProductionOptimizeBootstrapDescriptorVerifier
{
  readonly boundary = "trusted-cloud-bootstrap-descriptor-verifier" as const;
  readonly #resolveKey: TrustedProductionOptimizeBootstrapPublicKeyAuthority["resolve"];
  readonly #rotations: readonly CapturedRotation[];
  readonly #authoritySetHash: string;
  readonly #verificationKeySetHash: string;
  readonly #verifierPolicyHash: string;
  readonly #verificationCommitmentHash: string;
  readonly #maximumClockSkewMs: number;
  readonly #now: () => Date;

  constructor(options: Ed25519ProductionOptimizeBootstrapDescriptorVerifierOptions) {
    try {
      const maximumClockSkewMs = options.maximumClockSkewMs ?? 0;
      if (
        options.authority.boundary !==
          "trusted-cloud-production-optimize-bootstrap-public-key-authority" ||
        typeof options.authority.resolve !== "function" ||
        !SHA256.test(options.authoritySetHash) ||
        !SHA256.test(options.verificationKeySetHash) ||
        !SHA256.test(options.verifierPolicyHash) ||
        !SHA256.test(options.verificationCommitmentHash) ||
        options.verificationCommitmentHash !==
          productionOptimizeBootstrapVerificationCommitmentHash(options) ||
        !Number.isSafeInteger(maximumClockSkewMs) ||
        maximumClockSkewMs < 0 ||
        maximumClockSkewMs > MAXIMUM_CLOCK_SKEW_MS ||
        (options.now !== undefined && typeof options.now !== "function")
      ) {
        fail();
      }
      this.#resolveKey = options.authority.resolve.bind(options.authority);
      this.#rotations = captureRotations(options.rotations);
      this.#authoritySetHash = options.authoritySetHash;
      this.#verificationKeySetHash = options.verificationKeySetHash;
      this.#verifierPolicyHash = options.verifierPolicyHash;
      this.#verificationCommitmentHash = options.verificationCommitmentHash;
      this.#maximumClockSkewMs = maximumClockSkewMs;
      this.#now = options.now ?? (() => new Date());
    } catch {
      fail();
    }
  }

  async verify(
    descriptor: ProductionOptimizeBootstrapDescriptor,
  ): Promise<ProductionOptimizeBootstrapDescriptorVerification> {
    try {
      const snapshot = JSON.parse(
        canonicalJson(descriptor),
      ) as ProductionOptimizeBootstrapDescriptor;
      const startedAt = readNow(this.#now);
      assertProductionOptimizeBootstrapDescriptor(snapshot, startedAt);
      const unsigned = unsignedDescriptor(snapshot);
      if (
        productionOptimizeBootstrapDescriptorHash(unsigned) !== snapshot.descriptorHash ||
        snapshot.authoritySetHash !== this.#authoritySetHash ||
        snapshot.verificationKeySetHash !== this.#verificationKeySetHash ||
        snapshot.verifierPolicyHash !== this.#verifierPolicyHash ||
        snapshot.verificationCommitmentHash !== this.#verificationCommitmentHash
      ) {
        fail();
      }
      const signedAtMs = timestamp(snapshot.signature.signedAt);
      if (signedAtMs > startedAt.getTime() + this.#maximumClockSkewMs) {
        fail();
      }
      const matchingRotations = this.#rotations.filter(
        (rotation) =>
          rotation.keyId === snapshot.signature.keyId &&
          rotation.validFromMs <= signedAtMs &&
          signedAtMs < rotation.validUntilMs,
      );
      if (matchingRotations.length !== 1) fail();
      const rotation = matchingRotations[0];
      if (rotation === undefined) fail();
      const request: ProductionOptimizeBootstrapPublicKeyRequest = Object.freeze({
        schemaVersion: 1,
        domain: "dark-factory.production-optimize-bootstrap-public-key-request.v1",
        purpose: PRODUCTION_OPTIMIZE_BOOTSTRAP_KEY_PURPOSE,
        keyId: rotation.keyId,
        keyVersion: rotation.keyVersion,
        signedAt: snapshot.signature.signedAt,
        authoritySetHash: this.#authoritySetHash,
        verificationKeySetHash: this.#verificationKeySetHash,
        verifierPolicyHash: this.#verifierPolicyHash,
        verificationCommitmentHash: this.#verificationCommitmentHash,
      });
      const resolved = await this.#resolveKey(request);
      const completedAt = readNow(this.#now);
      if (
        completedAt.getTime() + this.#maximumClockSkewMs < startedAt.getTime() ||
        signedAtMs > completedAt.getTime() + this.#maximumClockSkewMs
      ) {
        fail();
      }
      assertProductionOptimizeBootstrapDescriptor(snapshot, completedAt);
      assertPublicKey(resolved, request, rotation);
      const spki = Uint8Array.from(resolved.publicKeySpkiDer);
      const publicKey = createPublicKey({
        key: Buffer.from(spki),
        format: "der",
        type: "spki",
      });
      if (
        publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        !verifyEd25519Signature(snapshot as unknown as Readonly<Record<string, unknown>>, publicKey)
      ) {
        fail();
      }
      const canonicalSpki = publicKey.export({
        format: "der",
        type: "spki",
      });
      const verifierAttestationHash = canonicalHash({
        schemaVersion: 1,
        domain: "dark-factory.production-optimize-bootstrap-verifier-attestation.v1",
        descriptorHash: snapshot.descriptorHash,
        signatureHash: canonicalHash(snapshot.signature),
        signingKeyId: rotation.keyId,
        signingKeyVersion: rotation.keyVersion,
        keyValidFrom: rotation.validFrom,
        keyValidUntil: rotation.validUntil,
        keyRevoked: false,
        publicKeySpkiSha256: sha256(canonicalSpki),
        keyResolutionRequestHash: canonicalHash(request),
        authoritySetHash: this.#authoritySetHash,
        verificationKeySetHash: this.#verificationKeySetHash,
        verifierPolicyHash: this.#verifierPolicyHash,
        maximumClockSkewMs: this.#maximumClockSkewMs,
        verificationCommitmentHash: this.#verificationCommitmentHash,
      });
      return Object.freeze({
        schemaVersion: 1,
        domain: "dark-factory.production-optimize-bootstrap-verification.v1",
        descriptorHash: snapshot.descriptorHash,
        signingKeyId: rotation.keyId,
        authoritySetHash: this.#authoritySetHash,
        verificationKeySetHash: this.#verificationKeySetHash,
        verifierPolicyHash: this.#verifierPolicyHash,
        verificationCommitmentHash: this.#verificationCommitmentHash,
        verifierAttestationHash,
        verified: true,
      });
    } catch (error) {
      if (error instanceof ProductionOptimizeBootstrapDescriptorVerifierError) {
        throw error;
      }
      fail();
    }
  }
}
