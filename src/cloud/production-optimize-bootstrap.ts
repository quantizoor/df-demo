import {
  assertProductionOptimizationCompositionManifest,
  PRODUCTION_RUNTIME_PORT_IDS,
  type ProductionOptimizationCompositionManifest,
} from "../orchestrator/production-runtime.js";
import { canonicalHash, canonicalJson, sha256 } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { VerifyingTrustedJsonArtifactReader } from "./trusted-json-reader.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const TRUSTED_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const MAXIMUM_DESCRIPTOR_BYTES = 64 * 1024;
const DEFAULT_MAXIMUM_COMPOSITION_BYTES = 4 * 1024 * 1024;
const MAXIMUM_COMPOSITION_BYTES = 16 * 1024 * 1024;

export const PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_ENVIRONMENT_NAME =
  "DF_PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_JSON" as const;

export interface ProductionOptimizeBootstrapDescriptorUnsigned {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimize-bootstrap.v1";
  readonly descriptorId: string;
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly compositionArtifact: TrustedCloudArtifactRef;
  readonly compositionManifestHash: string;
  /**
   * These three commitments describe independent authority material. None is
   * derived from this descriptor, its signature, or a verifier receipt.
   */
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly verifierPolicyHash: string;
  readonly verificationCommitmentHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface ProductionOptimizeBootstrapDescriptor
  extends ProductionOptimizeBootstrapDescriptorUnsigned {
  readonly descriptorHash: string;
  readonly signature: Signature;
}

export interface ProductionOptimizeBootstrapDescriptorVerification {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimize-bootstrap-verification.v1";
  readonly descriptorHash: string;
  readonly signingKeyId: string;
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly verifierPolicyHash: string;
  readonly verificationCommitmentHash: string;
  readonly verifierAttestationHash: string;
  readonly verified: true;
}

/**
 * This authority verifies the descriptor signature and the exact independent
 * authority, key-set, and policy commitments. It does not construct runtime
 * ports or verify the referenced composition manifest.
 */
export interface TrustedProductionOptimizeBootstrapDescriptorVerifier {
  readonly boundary: "trusted-cloud-bootstrap-descriptor-verifier";
  verify(
    descriptor: ProductionOptimizeBootstrapDescriptor,
  ): Promise<ProductionOptimizeBootstrapDescriptorVerification>;
}

export type TrustedProductionOptimizeBootstrapArtifactReader = Pick<
  VerifyingTrustedJsonArtifactReader,
  "boundary" | "readUtf8"
>;

export interface LoadedProductionOptimizeCompositionArtifact {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.loaded-production-optimize-composition.v1";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly descriptorHash: string;
  readonly compositionArtifact: TrustedCloudArtifactRef;
  readonly compositionManifestHash: string;
  readonly compositionDocumentHash: string;
  readonly verifierAttestationHash: string;
  readonly descriptorAuthorityVerified: true;
  readonly artifactTransportVerified: true;
  /**
   * Only the separately injected production composition authority may change
   * these facts. JSON never becomes an executable binding.
   */
  readonly compositionAuthorityVerified: false;
  readonly executableBindingsCreated: false;
  readonly receiptHash: string;
  readonly document: Readonly<Record<string, unknown>>;
}

export interface VerifiedProductionOptimizeBootstrapArtifactLoaderOptions {
  readonly reader: TrustedProductionOptimizeBootstrapArtifactReader;
  readonly verifier: TrustedProductionOptimizeBootstrapDescriptorVerifier;
  readonly maximumCompositionBytes?: number;
  readonly now?: () => Date;
}

export class ProductionOptimizeBootstrapError extends Error {
  override readonly name = "ProductionOptimizeBootstrapError";

  constructor() {
    super("Production optimize bootstrap material failed closed.");
  }
}

function fail(): never {
  throw new ProductionOptimizeBootstrapError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function deepFreezeJson<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
    return Object.freeze(value) as Readonly<T>;
  }
  if (isPlainRecord(value)) {
    for (const item of Object.values(value)) deepFreezeJson(item);
    return Object.freeze(value) as Readonly<T>;
  }
  return value as Readonly<T>;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
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

function assertArtifact(value: unknown): asserts value is TrustedCloudArtifactRef {
  exactKeys(value, ["uri", "sha256", "mediaType", "byteLength"]);
  const artifact = value as unknown as TrustedCloudArtifactRef;
  if (
    typeof artifact.uri !== "string" ||
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== "application/json" ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > MAXIMUM_COMPOSITION_BYTES
  ) {
    fail();
  }
}

function assertSignature(value: unknown): asserts value is Signature {
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"]);
  const signature = value as unknown as Signature;
  if (
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    !SAFE_KEY_ID.test(signature.keyId) ||
    typeof signature.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(signature.signature)
  ) {
    fail();
  }
  timestamp(signature.signedAt);
}

export function productionOptimizeBootstrapVerificationCommitmentHash(input: {
  readonly authoritySetHash: string;
  readonly verificationKeySetHash: string;
  readonly verifierPolicyHash: string;
}): string {
  if (
    !SHA256.test(input.authoritySetHash) ||
    !SHA256.test(input.verificationKeySetHash) ||
    !SHA256.test(input.verifierPolicyHash)
  ) {
    fail();
  }
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-bootstrap-trust-commitment.v1",
    authoritySetHash: input.authoritySetHash,
    verificationKeySetHash: input.verificationKeySetHash,
    verifierPolicyHash: input.verifierPolicyHash,
  });
}

export function productionOptimizeBootstrapDescriptorHash(
  unsigned: ProductionOptimizeBootstrapDescriptorUnsigned,
): string {
  return canonicalHash(unsigned);
}

export function assertProductionOptimizeBootstrapDescriptor(
  value: unknown,
  now?: Date,
): asserts value is ProductionOptimizeBootstrapDescriptor {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "descriptorId",
    "campaignId",
    "lineageId",
    "protocolHash",
    "compositionArtifact",
    "compositionManifestHash",
    "authoritySetHash",
    "verificationKeySetHash",
    "verifierPolicyHash",
    "verificationCommitmentHash",
    "issuedAt",
    "expiresAt",
    "descriptorHash",
    "signature",
  ]);
  const descriptor = value as unknown as ProductionOptimizeBootstrapDescriptor;
  assertArtifact(descriptor.compositionArtifact);
  assertSignature(descriptor.signature);
  const issuedAt = timestamp(descriptor.issuedAt);
  const expiresAt = timestamp(descriptor.expiresAt);
  const signedAt = timestamp(descriptor.signature.signedAt);
  const expectedVerificationCommitment =
    productionOptimizeBootstrapVerificationCommitmentHash(descriptor);
  const unsigned: ProductionOptimizeBootstrapDescriptorUnsigned = {
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
  if (
    descriptor.schemaVersion !== 1 ||
    descriptor.domain !== "dark-factory.production-optimize-bootstrap.v1" ||
    !SAFE_ID.test(descriptor.descriptorId) ||
    !SAFE_ID.test(descriptor.campaignId) ||
    !SAFE_ID.test(descriptor.lineageId) ||
    !SHA256.test(descriptor.protocolHash) ||
    !SHA256.test(descriptor.compositionManifestHash) ||
    !SHA256.test(descriptor.authoritySetHash) ||
    !SHA256.test(descriptor.verificationKeySetHash) ||
    !SHA256.test(descriptor.verifierPolicyHash) ||
    !SHA256.test(descriptor.verificationCommitmentHash) ||
    descriptor.verificationCommitmentHash !== expectedVerificationCommitment ||
    issuedAt >= expiresAt ||
    signedAt < issuedAt ||
    signedAt > expiresAt ||
    !SHA256.test(descriptor.descriptorHash) ||
    descriptor.descriptorHash !== productionOptimizeBootstrapDescriptorHash(unsigned)
  ) {
    fail();
  }
  if (now !== undefined) {
    const current = now.getTime();
    if (!Number.isFinite(current) || current < issuedAt || current > expiresAt) {
      fail();
    }
  }
}

export function parseProductionOptimizeBootstrapDescriptorJson(
  raw: string,
  expectedCampaignId: string,
): ProductionOptimizeBootstrapDescriptor {
  try {
    if (
      !SAFE_ID.test(expectedCampaignId) ||
      raw.length === 0 ||
      raw.includes("\u0000") ||
      raw.charCodeAt(0) === 0xfeff ||
      Buffer.byteLength(raw, "utf8") > MAXIMUM_DESCRIPTOR_BYTES
    ) {
      fail();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail();
    }
    if (raw !== canonicalJson(parsed)) fail();
    assertProductionOptimizeBootstrapDescriptor(parsed);
    if (parsed.campaignId !== expectedCampaignId) fail();
    return JSON.parse(canonicalJson(parsed)) as ProductionOptimizeBootstrapDescriptor;
  } catch (error) {
    if (error instanceof ProductionOptimizeBootstrapError) throw error;
    fail();
  }
}

export function parseProductionOptimizeBootstrapDescriptorEnvironment(
  environment: NodeJS.ProcessEnv,
  expectedCampaignId: string,
): ProductionOptimizeBootstrapDescriptor {
  const raw = environment[PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_ENVIRONMENT_NAME];
  if (raw === undefined) fail();
  return parseProductionOptimizeBootstrapDescriptorJson(raw, expectedCampaignId);
}

function assertVerification(
  value: unknown,
  descriptor: ProductionOptimizeBootstrapDescriptor,
): asserts value is ProductionOptimizeBootstrapDescriptorVerification {
  exactKeys(value, [
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
  ]);
  const verification = value as unknown as ProductionOptimizeBootstrapDescriptorVerification;
  if (
    verification.schemaVersion !== 1 ||
    verification.domain !== "dark-factory.production-optimize-bootstrap-verification.v1" ||
    verification.descriptorHash !== descriptor.descriptorHash ||
    verification.signingKeyId !== descriptor.signature.keyId ||
    verification.authoritySetHash !== descriptor.authoritySetHash ||
    verification.verificationKeySetHash !== descriptor.verificationKeySetHash ||
    verification.verifierPolicyHash !== descriptor.verifierPolicyHash ||
    verification.verificationCommitmentHash !== descriptor.verificationCommitmentHash ||
    !SHA256.test(verification.verifierAttestationHash) ||
    verification.verified !== true
  ) {
    fail();
  }
}

function assertCompositionDocument(
  value: unknown,
  descriptor: ProductionOptimizeBootstrapDescriptor,
  now: Date,
): asserts value is ProductionOptimizationCompositionManifest {
  try {
    assertProductionOptimizationCompositionManifest(value, now);
  } catch {
    fail();
  }
  const document = value as ProductionOptimizationCompositionManifest;
  if (
    document.campaignId !== descriptor.campaignId ||
    document.lineageId !== descriptor.lineageId ||
    document.protocolHash !== descriptor.protocolHash ||
    document.manifestHash !== descriptor.compositionManifestHash ||
    document.runtimePortAttestations.length !== PRODUCTION_RUNTIME_PORT_IDS.length
  ) {
    fail();
  }
}

/**
 * Verifies the signed task-free bootstrap descriptor and the exact artifact
 * transport. It deliberately returns a non-authorizing JSON document:
 * production-runtime composition must still validate the manifest and bind
 * independently supplied executable ports.
 */
export class VerifiedProductionOptimizeBootstrapArtifactLoader {
  readonly boundary = "trusted-cloud-bootstrap-artifact-loader" as const;
  readonly #readUtf8: TrustedProductionOptimizeBootstrapArtifactReader["readUtf8"];
  readonly #verifyDescriptor: TrustedProductionOptimizeBootstrapDescriptorVerifier["verify"];
  readonly #maximumCompositionBytes: number;
  readonly #now: () => Date;

  constructor(options: VerifiedProductionOptimizeBootstrapArtifactLoaderOptions) {
    const maximum = options.maximumCompositionBytes ?? DEFAULT_MAXIMUM_COMPOSITION_BYTES;
    if (
      options.reader.boundary !== "trusted-cloud" ||
      options.verifier.boundary !== "trusted-cloud-bootstrap-descriptor-verifier" ||
      typeof options.reader.readUtf8 !== "function" ||
      typeof options.verifier.verify !== "function" ||
      !Number.isSafeInteger(maximum) ||
      maximum < 4_096 ||
      maximum > MAXIMUM_COMPOSITION_BYTES
    ) {
      fail();
    }
    this.#readUtf8 = options.reader.readUtf8.bind(options.reader);
    this.#verifyDescriptor = options.verifier.verify.bind(options.verifier);
    this.#maximumCompositionBytes = maximum;
    this.#now = options.now ?? (() => new Date());
  }

  async load(
    descriptor: ProductionOptimizeBootstrapDescriptor,
  ): Promise<LoadedProductionOptimizeCompositionArtifact> {
    try {
      const now = this.#now();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        fail();
      }
      const currentTime = new Date(now.getTime());
      const parsedSnapshot = JSON.parse(
        canonicalJson(descriptor),
      ) as ProductionOptimizeBootstrapDescriptor;
      assertProductionOptimizeBootstrapDescriptor(parsedSnapshot, currentTime);
      const snapshot = deepFreezeJson(parsedSnapshot) as ProductionOptimizeBootstrapDescriptor;
      if (snapshot.compositionArtifact.byteLength > this.#maximumCompositionBytes) {
        fail();
      }
      const verificationCandidate = await this.#verifyDescriptor(snapshot);
      assertVerification(verificationCandidate, snapshot);
      const verification = deepFreezeJson(
        JSON.parse(canonicalJson(verificationCandidate)),
      ) as ProductionOptimizeBootstrapDescriptorVerification;
      const artifact: TrustedCloudArtifactRef = Object.freeze({
        uri: snapshot.compositionArtifact.uri,
        sha256: snapshot.compositionArtifact.sha256,
        mediaType: snapshot.compositionArtifact.mediaType,
        byteLength: snapshot.compositionArtifact.byteLength,
      });
      const raw = await this.#readUtf8(artifact, this.#maximumCompositionBytes);
      const byteLength = Buffer.byteLength(raw, "utf8");
      if (
        !Number.isSafeInteger(byteLength) ||
        byteLength <= 0 ||
        byteLength > this.#maximumCompositionBytes ||
        byteLength !== artifact.byteLength ||
        sha256(raw) !== artifact.sha256
      ) {
        fail();
      }
      let document: unknown;
      try {
        document = JSON.parse(raw);
      } catch {
        fail();
      }
      if (raw !== `${canonicalJson(document)}\n`) fail();
      assertCompositionDocument(document, snapshot, currentTime);
      const frozenDocument = deepFreezeJson(JSON.parse(canonicalJson(document))) as Readonly<
        Record<string, unknown>
      >;
      const unsignedReceipt = {
        schemaVersion: 1 as const,
        domain: "dark-factory.loaded-production-optimize-composition.v1" as const,
        campaignId: snapshot.campaignId,
        lineageId: snapshot.lineageId,
        protocolHash: snapshot.protocolHash,
        descriptorHash: snapshot.descriptorHash,
        compositionArtifact: artifact,
        compositionManifestHash: snapshot.compositionManifestHash,
        compositionDocumentHash: canonicalHash(frozenDocument),
        verifierAttestationHash: verification.verifierAttestationHash,
        descriptorAuthorityVerified: true as const,
        artifactTransportVerified: true as const,
        compositionAuthorityVerified: false as const,
        executableBindingsCreated: false as const,
      };
      return {
        ...unsignedReceipt,
        receiptHash: canonicalHash(unsignedReceipt),
        document: frozenDocument,
      };
    } catch (error) {
      if (error instanceof ProductionOptimizeBootstrapError) throw error;
      fail();
    }
  }
}
