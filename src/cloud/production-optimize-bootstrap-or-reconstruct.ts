import { createHash, createPublicKey } from "node:crypto";

import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  gitRegistrationReceiptHash,
  TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION,
  TRUSTED_PI_ADAPTER_EXECUTION_MODE,
  TRUSTED_PI_ADAPTER_ID,
  TRUSTED_PI_CODING_AGENT_PACKAGE_NAME,
  type TrustedGitRegistrationReceipt,
} from "../harness/git-registration.js";
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
  sha256,
} from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import {
  type ProductionOptimizeBootstrapOrReconstructReceipt,
  type ProductionOptimizeBootstrapOrReconstructRequest,
  type ProductionOptimizeLifecycleRegistrar,
  type TrustedProductionOptimizeBootstrapOrReconstructPort,
  type TrustedProductionOptimizeCloseable,
} from "./production-optimize-composition-owner.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_EXTERNAL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const SAFE_KEY_VERSION =
  /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const SAFE_HEAD_REF =
  /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const MAXIMUM_ROTATIONS = 192;

export const PRODUCTION_OPTIMIZE_PREREQUISITE_KEY_PURPOSES = Object.freeze([
  "production-optimize-private-pi-registration",
  "production-optimize-campaign-genesis",
  "production-optimize-hidden-catalog-genesis",
] as const);

export type ProductionOptimizePrerequisiteKeyPurpose =
  (typeof PRODUCTION_OPTIMIZE_PREREQUISITE_KEY_PURPOSES)[number];

export interface SignedProductionOptimizeCampaignGenesis {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-campaign-genesis.v1";
  readonly sensitivity: "release-safe-control";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly sourcePrerequisiteHash: string;
  readonly initialCampaignStateHash: string;
  readonly genesisPolicyHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: Signature;
  readonly contentHash: string;
}

/**
 * This commitment intentionally has no field capable of carrying a package
 * task name, hidden task ID, panel, cell, task order, or grader output.
 */
export interface SignedProductionOptimizeHiddenCatalogGenesis {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-hidden-catalog-genesis.v1";
  readonly sensitivity: "trusted-control-task-free-commitment";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly campaignGenesisPrerequisiteHash: string;
  readonly datasetPinHash: string;
  readonly registryRevision: 6;
  readonly seedSetCommitment: string;
  readonly weightingPolicyHash: string;
  readonly taskIdKeyId: string;
  readonly dispositionKeyId: string;
  readonly initialCatalogStateHash: string;
  readonly informationBoundary: {
    readonly containsTaskNames: false;
    readonly containsTaskIds: false;
    readonly containsPanelIds: false;
    readonly containsGraderEvidence: false;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: Signature;
  readonly contentHash: string;
}

export interface TrustedProductionOptimizePrerequisiteSource {
  readonly boundary:
    "trusted-cloud-production-optimize-prerequisite-source";
  locatePrivatePiRegistration(input: {
    readonly purpose: "production-optimize-private-pi-registration";
    readonly sourcePrerequisiteHash: string;
  }): Promise<TrustedGitRegistrationReceipt | undefined>;
  locateCampaignGenesis(input: {
    readonly purpose: "production-optimize-campaign-genesis";
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
    readonly sourcePrerequisiteHash: string;
    readonly genesisPrerequisiteHash: string;
  }): Promise<SignedProductionOptimizeCampaignGenesis | undefined>;
  locateHiddenCatalogGenesis(input: {
    readonly purpose: "production-optimize-hidden-catalog-genesis";
    readonly campaignId: string;
    readonly lineageId: string;
    readonly protocolHash: string;
    readonly genesisPrerequisiteHash: string;
    readonly catalogPrerequisiteHash: string;
  }): Promise<SignedProductionOptimizeHiddenCatalogGenesis | undefined>;
}

export interface ProductionOptimizePrerequisiteKeyRotation {
  readonly purpose: ProductionOptimizePrerequisiteKeyPurpose;
  readonly keyId: string;
  readonly keyVersion: string;
  /** Half-open interval: validFrom <= signedAt < validUntil. */
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface TrustedProductionOptimizePrerequisitePublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: ProductionOptimizePrerequisiteKeyPurpose;
  readonly keyId: string;
  readonly keyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revoked: boolean;
  /** SubjectPublicKeyInfo DER only; private-key material is not representable. */
  readonly publicKeySpkiDer: Uint8Array;
}

export interface TrustedProductionOptimizePrerequisitePublicKeyAuthority {
  readonly boundary:
    "trusted-cloud-production-optimize-prerequisite-public-key-authority";
  resolve(input: {
    readonly purpose: ProductionOptimizePrerequisiteKeyPurpose;
    readonly keyId: string;
    readonly keyVersion: string;
    readonly signedAt: string;
  }): Promise<TrustedProductionOptimizePrerequisitePublicKey | undefined>;
}

export interface ProductionOptimizeCampaignGenesisAuthorityInput {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-campaign-genesis-authority-input.v1";
  readonly requestHash: string;
  readonly sourcePrerequisiteHash: string;
  readonly sourceRegistrationId: string;
  readonly genesisPrerequisite:
    SignedProductionOptimizeCampaignGenesis;
}

export interface ProductionOptimizeHiddenCatalogGenesisAuthorityInput {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-hidden-catalog-genesis-authority-input.v1";
  readonly requestHash: string;
  readonly campaignStateHash: string;
  readonly catalogPrerequisite:
    SignedProductionOptimizeHiddenCatalogGenesis;
}

export interface ProductionOptimizeGenesisEnsureResult {
  readonly disposition: "created" | "existing";
  readonly stateHash: string;
  readonly resource: TrustedProductionOptimizeCloseable;
}

export interface TrustedProductionOptimizeCampaignGenesisAuthority {
  readonly boundary:
    "trusted-cloud-production-optimize-campaign-genesis-authority";
  ensureExact(
    input: ProductionOptimizeCampaignGenesisAuthorityInput,
  ): Promise<ProductionOptimizeGenesisEnsureResult>;
}

export interface TrustedProductionOptimizeHiddenCatalogGenesisAuthority {
  readonly boundary:
    "trusted-cloud-production-optimize-hidden-catalog-genesis-authority";
  ensureExact(
    input: ProductionOptimizeHiddenCatalogGenesisAuthorityInput,
  ): Promise<ProductionOptimizeGenesisEnsureResult>;
}

type BootstrapPhase =
  | "claimed"
  | "campaign-ensured"
  | "catalog-ensured"
  | "committed";

interface DurableBootstrapBinding {
  readonly request: ProductionOptimizeBootstrapOrReconstructRequest;
  readonly phase: BootstrapPhase;
  readonly replayObserved: boolean;
  readonly campaignStateHash: string | null;
  readonly catalogStateHash: string | null;
  readonly claimedAt: string;
  readonly advancedAt: string;
  readonly receipt:
    ProductionOptimizeBootstrapOrReconstructReceipt | null;
}

interface DurableBootstrapCoordinationState {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.production-optimize-bootstrap-coordination.v1";
  readonly revision: number;
  readonly binding: DurableBootstrapBinding | null;
}

interface BootstrapClaim {
  readonly fresh: boolean;
  readonly phaseAtClaim: BootstrapPhase;
}

export interface DurableProductionOptimizeBootstrapOrReconstructOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly prerequisiteSource:
    TrustedProductionOptimizePrerequisiteSource;
  readonly publicKeyAuthority:
    TrustedProductionOptimizePrerequisitePublicKeyAuthority;
  readonly keyRotations:
    readonly ProductionOptimizePrerequisiteKeyRotation[];
  readonly campaignGenesisAuthority:
    TrustedProductionOptimizeCampaignGenesisAuthority;
  readonly hiddenCatalogGenesisAuthority:
    TrustedProductionOptimizeHiddenCatalogGenesisAuthority;
  readonly now?: () => Date;
}

interface CapturedRotation
  extends ProductionOptimizePrerequisiteKeyRotation {
  readonly validFromMs: number;
  readonly validUntilMs: number;
}

export class ProductionOptimizeBootstrapOrReconstructError extends Error {
  override readonly name =
    "ProductionOptimizeBootstrapOrReconstructError";

  public constructor() {
    super(
      "Production optimize bootstrap or reconstruction failed closed.",
    );
  }
}

function fail(): never {
  throw new ProductionOptimizeBootstrapOrReconstructError();
}

function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
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
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail();
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") fail();
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    fail();
  }
  return parsed;
}

function readNow(now: () => Date): Date {
  const value = now();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime())
  ) {
    fail();
  }
  return new Date(value.getTime());
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function freezeJson<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(
      value as Readonly<Record<string, unknown>>,
    )) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertSignature(
  value: unknown,
): asserts value is Signature {
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"]);
  if (
    value.algorithm !== "ed25519" ||
    typeof value.keyId !== "string" ||
    !SAFE_KEY_ID.test(value.keyId) ||
    timestamp(value.signedAt) < 0 ||
    typeof value.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(value.signature)
  ) {
    fail();
  }
}

function assertRequest(
  value: unknown,
): asserts value is ProductionOptimizeBootstrapOrReconstructRequest {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "manifestId",
    "manifestHash",
    "campaignId",
    "lineageId",
    "protocolHash",
    "sourcePrerequisiteHash",
    "genesisPrerequisiteHash",
    "catalogPrerequisiteHash",
    "requestHash",
  ]);
  const unsigned = {
    schemaVersion: value.schemaVersion,
    domain: value.domain,
    manifestId: value.manifestId,
    manifestHash: value.manifestHash,
    campaignId: value.campaignId,
    lineageId: value.lineageId,
    protocolHash: value.protocolHash,
    sourcePrerequisiteHash: value.sourcePrerequisiteHash,
    genesisPrerequisiteHash: value.genesisPrerequisiteHash,
    catalogPrerequisiteHash: value.catalogPrerequisiteHash,
  };
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-bootstrap-or-reconstruct-request.v1" ||
    typeof value.manifestId !== "string" ||
    !SAFE_ID.test(value.manifestId) ||
    typeof value.campaignId !== "string" ||
    !SAFE_ID.test(value.campaignId) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.manifestHash !== "string" ||
    !SHA256.test(value.manifestHash) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.sourcePrerequisiteHash !== "string" ||
    !SHA256.test(value.sourcePrerequisiteHash) ||
    typeof value.genesisPrerequisiteHash !== "string" ||
    !SHA256.test(value.genesisPrerequisiteHash) ||
    typeof value.catalogPrerequisiteHash !== "string" ||
    !SHA256.test(value.catalogPrerequisiteHash) ||
    typeof value.requestHash !== "string" ||
    value.requestHash !== canonicalHash(unsigned)
  ) {
    fail();
  }
}

function receiptUnsigned(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  input: {
    readonly disposition: "bootstrapped" | "reconstructed";
    readonly campaignStateHash: string;
    readonly catalogStateHash: string;
    readonly verifiedAt: string;
  },
): Omit<
  ProductionOptimizeBootstrapOrReconstructReceipt,
  "receiptHash"
> {
  return {
    schemaVersion: 1,
    domain:
      "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1",
    requestHash: request.requestHash,
    manifestHash: request.manifestHash,
    campaignId: request.campaignId,
    lineageId: request.lineageId,
    protocolHash: request.protocolHash,
    disposition: input.disposition,
    sourcePrerequisiteHash: request.sourcePrerequisiteHash,
    genesisPrerequisiteHash: request.genesisPrerequisiteHash,
    catalogPrerequisiteHash: request.catalogPrerequisiteHash,
    campaignStateHash: input.campaignStateHash,
    catalogStateHash: input.catalogStateHash,
    prerequisitesVerified: true,
    idempotentlyBound: true,
    verifiedAt: input.verifiedAt,
  };
}

function createReceipt(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  input: {
    readonly disposition: "bootstrapped" | "reconstructed";
    readonly campaignStateHash: string;
    readonly catalogStateHash: string;
    readonly verifiedAt: string;
  },
): ProductionOptimizeBootstrapOrReconstructReceipt {
  const unsigned = receiptUnsigned(request, input);
  return {
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  };
}

function assertReceipt(
  value: unknown,
  request?: ProductionOptimizeBootstrapOrReconstructRequest,
): asserts value is ProductionOptimizeBootstrapOrReconstructReceipt {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "requestHash",
    "manifestHash",
    "campaignId",
    "lineageId",
    "protocolHash",
    "disposition",
    "sourcePrerequisiteHash",
    "genesisPrerequisiteHash",
    "catalogPrerequisiteHash",
    "campaignStateHash",
    "catalogStateHash",
    "prerequisitesVerified",
    "idempotentlyBound",
    "verifiedAt",
    "receiptHash",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-bootstrap-or-reconstruct-receipt.v1" ||
    typeof value.requestHash !== "string" ||
    !SHA256.test(value.requestHash) ||
    typeof value.manifestHash !== "string" ||
    !SHA256.test(value.manifestHash) ||
    typeof value.campaignId !== "string" ||
    !SAFE_ID.test(value.campaignId) ||
    typeof value.lineageId !== "string" ||
    !SAFE_ID.test(value.lineageId) ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    (value.disposition !== "bootstrapped" &&
      value.disposition !== "reconstructed") ||
    typeof value.sourcePrerequisiteHash !== "string" ||
    !SHA256.test(value.sourcePrerequisiteHash) ||
    typeof value.genesisPrerequisiteHash !== "string" ||
    !SHA256.test(value.genesisPrerequisiteHash) ||
    typeof value.catalogPrerequisiteHash !== "string" ||
    !SHA256.test(value.catalogPrerequisiteHash) ||
    typeof value.campaignStateHash !== "string" ||
    !SHA256.test(value.campaignStateHash) ||
    typeof value.catalogStateHash !== "string" ||
    !SHA256.test(value.catalogStateHash) ||
    value.prerequisitesVerified !== true ||
    value.idempotentlyBound !== true ||
    timestamp(value.verifiedAt) < 0 ||
    typeof value.receiptHash !== "string" ||
    !SHA256.test(value.receiptHash)
  ) {
    fail();
  }
  if (
    request !== undefined &&
    (value.requestHash !== request.requestHash ||
      value.manifestHash !== request.manifestHash ||
      value.campaignId !== request.campaignId ||
      value.lineageId !== request.lineageId ||
      value.protocolHash !== request.protocolHash ||
      value.sourcePrerequisiteHash !==
        request.sourcePrerequisiteHash ||
      value.genesisPrerequisiteHash !==
        request.genesisPrerequisiteHash ||
      value.catalogPrerequisiteHash !==
        request.catalogPrerequisiteHash)
  ) {
    fail();
  }
  const { receiptHash: _receiptHash, ...unsigned } = value;
  if (value.receiptHash !== canonicalHash(unsigned)) fail();
}

function reconstructedReceipt(
  value: ProductionOptimizeBootstrapOrReconstructReceipt,
  request: ProductionOptimizeBootstrapOrReconstructRequest,
): ProductionOptimizeBootstrapOrReconstructReceipt {
  if (value.disposition === "reconstructed") return cloneCanonical(value);
  return createReceipt(request, {
    disposition: "reconstructed",
    campaignStateHash: value.campaignStateHash,
    catalogStateHash: value.catalogStateHash,
    verifiedAt: value.verifiedAt,
  });
}

const REGISTRATION_RECEIPT_KEYS = [
  "sensitivity",
  "schemaVersion",
  "registrationRequestId",
  "authorizationHash",
  "registrationId",
  "originRepositoryHash",
  "upstreamRepositoryHash",
  "remoteRef",
  "commitSha",
  "treeSha",
  "lockSha256",
  "packageName",
  "packageVersion",
  "harnessRegistrationSchemaVersion",
  "adapterId",
  "adapterExecutionMode",
  "sessionsDisabled",
  "uncontrolledExtensionsDisabled",
  "uncontrolledContextFilesDisabled",
  "packageJsonSha256",
  "upstreamHeadCommit",
  "upstreamBaseCommit",
  "originPrivate",
  "originFetchable",
  "originWritable",
  "privacyEvidence",
  "fetchEvidence",
  "writeEvidence",
  "lineageEvidence",
  "providerRepositoryAttestationHash",
  "lineageAttestationHash",
  "providerVerifiedAt",
  "provider",
  "sandboxId",
  "imageReference",
  "imageDigest",
  "networkPolicyHash",
  "workerSha256",
  "executionReceiptHash",
  "resultArtifactSha256",
  "attestedAt",
  "passed",
  "signature",
] as const;

function expectedRegistrationId(
  receipt: TrustedGitRegistrationReceipt,
): string {
  return createHash("sha256")
    .update(
      `${receipt.commitSha}:${receipt.originRepositoryHash}:` +
        receipt.upstreamBaseCommit,
      "utf8",
    )
    .digest("hex");
}

function assertPrivatePiRegistration(
  value: unknown,
  expectedHash: string,
): asserts value is TrustedGitRegistrationReceipt {
  exactKeys(value, REGISTRATION_RECEIPT_KEYS);
  assertSignature(value.signature);
  const hashes = [
    value.authorizationHash,
    value.originRepositoryHash,
    value.upstreamRepositoryHash,
    value.lockSha256,
    value.packageJsonSha256,
    value.providerRepositoryAttestationHash,
    value.lineageAttestationHash,
    value.networkPolicyHash,
    value.workerSha256,
    value.executionReceiptHash,
    value.resultArtifactSha256,
  ];
  if (
    value.sensitivity !== "trusted-git-registration" ||
    value.schemaVersion !== 1 ||
    typeof value.registrationRequestId !== "string" ||
    !SAFE_EXTERNAL_ID.test(value.registrationRequestId) ||
    typeof value.registrationId !== "string" ||
    value.registrationId !==
      expectedRegistrationId(
        value as unknown as TrustedGitRegistrationReceipt,
      ) ||
    hashes.some(
      (hash) => typeof hash !== "string" || !SHA256.test(hash),
    ) ||
    typeof value.remoteRef !== "string" ||
    !SAFE_HEAD_REF.test(value.remoteRef) ||
    value.remoteRef.includes("..") ||
    value.remoteRef.includes("@{") ||
    value.remoteRef.includes("//") ||
    typeof value.commitSha !== "string" ||
    !GIT_OBJECT_ID.test(value.commitSha) ||
    typeof value.treeSha !== "string" ||
    !GIT_OBJECT_ID.test(value.treeSha) ||
    typeof value.upstreamHeadCommit !== "string" ||
    !GIT_OBJECT_ID.test(value.upstreamHeadCommit) ||
    typeof value.upstreamBaseCommit !== "string" ||
    !GIT_OBJECT_ID.test(value.upstreamBaseCommit) ||
    value.packageName !== TRUSTED_PI_CODING_AGENT_PACKAGE_NAME ||
    typeof value.packageVersion !== "string" ||
    !EXACT_SEMVER.test(value.packageVersion) ||
    value.harnessRegistrationSchemaVersion !==
      TRUSTED_HARNESS_REGISTRATION_SCHEMA_VERSION ||
    value.adapterId !== TRUSTED_PI_ADAPTER_ID ||
    value.adapterExecutionMode !==
      TRUSTED_PI_ADAPTER_EXECUTION_MODE ||
    value.sessionsDisabled !== true ||
    value.uncontrolledExtensionsDisabled !== true ||
    value.uncontrolledContextFilesDisabled !== true ||
    value.originPrivate !== true ||
    value.originFetchable !== true ||
    value.originWritable !== true ||
    value.privacyEvidence !==
      "github-rest-private-and-visibility" ||
    value.fetchEvidence !==
      "authenticated-ls-remote-and-fetch" ||
    value.writeEvidence !== "github-rest-permissions-push" ||
    value.lineageEvidence !==
      "canonical-upstream-fetched-merge-base" ||
    timestamp(value.providerVerifiedAt) >
      timestamp(value.attestedAt) ||
    (value.provider !== "daytona" &&
      value.provider !== "e2b" &&
      value.provider !== "modal") ||
    typeof value.sandboxId !== "string" ||
    !SAFE_EXTERNAL_ID.test(value.sandboxId) ||
    typeof value.imageReference !== "string" ||
    value.imageReference.length < 1 ||
    value.imageReference.length > 512 ||
    typeof value.imageDigest !== "string" ||
    !IMAGE_DIGEST.test(value.imageDigest) ||
    value.passed !== true ||
    timestamp(value.signature.signedAt) <
      timestamp(value.attestedAt) ||
    gitRegistrationReceiptHash(
      value as unknown as TrustedGitRegistrationReceipt,
    ) !== expectedHash
  ) {
    fail();
  }
}

function assertCampaignGenesis(
  value: unknown,
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  now: Date,
): asserts value is SignedProductionOptimizeCampaignGenesis {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "lineageId",
    "protocolHash",
    "sourcePrerequisiteHash",
    "initialCampaignStateHash",
    "genesisPolicyHash",
    "issuedAt",
    "expiresAt",
    "signature",
    "contentHash",
  ]);
  assertSignature(value.signature);
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  const signedAt = timestamp(value.signature.signedAt);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-campaign-genesis.v1" ||
    value.sensitivity !== "release-safe-control" ||
    value.deployment !== "trusted-cloud" ||
    value.campaignId !== request.campaignId ||
    value.lineageId !== request.lineageId ||
    value.protocolHash !== request.protocolHash ||
    value.sourcePrerequisiteHash !==
      request.sourcePrerequisiteHash ||
    typeof value.initialCampaignStateHash !== "string" ||
    !SHA256.test(value.initialCampaignStateHash) ||
    typeof value.genesisPolicyHash !== "string" ||
    !SHA256.test(value.genesisPolicyHash) ||
    expiresAt <= issuedAt ||
    signedAt < issuedAt ||
    signedAt >= expiresAt ||
    now.getTime() < issuedAt ||
    now.getTime() >= expiresAt ||
    typeof value.contentHash !== "string" ||
    value.contentHash !== request.genesisPrerequisiteHash ||
    value.contentHash !== computeContentHash(value)
  ) {
    fail();
  }
}

function assertCatalogGenesis(
  value: unknown,
  request: ProductionOptimizeBootstrapOrReconstructRequest,
  now: Date,
): asserts value is SignedProductionOptimizeHiddenCatalogGenesis {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "lineageId",
    "protocolHash",
    "campaignGenesisPrerequisiteHash",
    "datasetPinHash",
    "registryRevision",
    "seedSetCommitment",
    "weightingPolicyHash",
    "taskIdKeyId",
    "dispositionKeyId",
    "initialCatalogStateHash",
    "informationBoundary",
    "issuedAt",
    "expiresAt",
    "signature",
    "contentHash",
  ]);
  exactKeys(value.informationBoundary, [
    "containsTaskNames",
    "containsTaskIds",
    "containsPanelIds",
    "containsGraderEvidence",
  ]);
  assertSignature(value.signature);
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  const signedAt = timestamp(value.signature.signedAt);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-hidden-catalog-genesis.v1" ||
    value.sensitivity !==
      "trusted-control-task-free-commitment" ||
    value.deployment !== "trusted-cloud" ||
    value.campaignId !== request.campaignId ||
    value.lineageId !== request.lineageId ||
    value.protocolHash !== request.protocolHash ||
    value.campaignGenesisPrerequisiteHash !==
      request.genesisPrerequisiteHash ||
    typeof value.datasetPinHash !== "string" ||
    !SHA256.test(value.datasetPinHash) ||
    value.registryRevision !== 6 ||
    typeof value.seedSetCommitment !== "string" ||
    !SHA256.test(value.seedSetCommitment) ||
    typeof value.weightingPolicyHash !== "string" ||
    !SHA256.test(value.weightingPolicyHash) ||
    typeof value.taskIdKeyId !== "string" ||
    !SAFE_EXTERNAL_ID.test(value.taskIdKeyId) ||
    typeof value.dispositionKeyId !== "string" ||
    !SAFE_EXTERNAL_ID.test(value.dispositionKeyId) ||
    value.taskIdKeyId === value.dispositionKeyId ||
    typeof value.initialCatalogStateHash !== "string" ||
    !SHA256.test(value.initialCatalogStateHash) ||
    value.informationBoundary.containsTaskNames !== false ||
    value.informationBoundary.containsTaskIds !== false ||
    value.informationBoundary.containsPanelIds !== false ||
    value.informationBoundary.containsGraderEvidence !== false ||
    expiresAt <= issuedAt ||
    signedAt < issuedAt ||
    signedAt >= expiresAt ||
    now.getTime() < issuedAt ||
    now.getTime() >= expiresAt ||
    typeof value.contentHash !== "string" ||
    value.contentHash !== request.catalogPrerequisiteHash ||
    value.contentHash !== computeContentHash(value)
  ) {
    fail();
  }
}

function assertPhase(value: unknown): asserts value is BootstrapPhase {
  if (
    value !== "claimed" &&
    value !== "campaign-ensured" &&
    value !== "catalog-ensured" &&
    value !== "committed"
  ) {
    fail();
  }
}

function assertBinding(
  value: unknown,
): asserts value is DurableBootstrapBinding {
  exactKeys(value, [
    "request",
    "phase",
    "replayObserved",
    "campaignStateHash",
    "catalogStateHash",
    "claimedAt",
    "advancedAt",
    "receipt",
  ]);
  assertRequest(value.request);
  assertPhase(value.phase);
  const claimedAt = timestamp(value.claimedAt);
  const advancedAt = timestamp(value.advancedAt);
  if (
    typeof value.replayObserved !== "boolean" ||
    (value.campaignStateHash !== null &&
      (typeof value.campaignStateHash !== "string" ||
        !SHA256.test(value.campaignStateHash))) ||
    (value.catalogStateHash !== null &&
      (typeof value.catalogStateHash !== "string" ||
        !SHA256.test(value.catalogStateHash))) ||
    advancedAt < claimedAt
  ) {
    fail();
  }
  if (value.receipt !== null) {
    assertReceipt(value.receipt, value.request);
  }
  if (
    (value.phase === "claimed" &&
      (value.campaignStateHash !== null ||
        value.catalogStateHash !== null ||
        value.receipt !== null)) ||
    (value.phase === "campaign-ensured" &&
      (value.campaignStateHash === null ||
        value.catalogStateHash !== null ||
        value.receipt !== null)) ||
    (value.phase === "catalog-ensured" &&
      (value.campaignStateHash === null ||
        value.catalogStateHash === null ||
        value.receipt !== null)) ||
    (value.phase === "committed" &&
      (value.campaignStateHash === null ||
        value.catalogStateHash === null ||
        value.receipt === null ||
        value.receipt.campaignStateHash !==
          value.campaignStateHash ||
        value.receipt.catalogStateHash !==
          value.catalogStateHash))
  ) {
    fail();
  }
}

function assertCoordinationState(
  value: unknown,
): asserts value is DurableBootstrapCoordinationState {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "revision",
    "binding",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-optimize-bootstrap-coordination.v1" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    fail();
  }
  if (value.binding !== null) assertBinding(value.binding);
  if ((value.revision === 0) !== (value.binding === null)) fail();
}

function captureRotations(
  value: readonly ProductionOptimizePrerequisiteKeyRotation[],
): readonly CapturedRotation[] {
  if (
    !Array.isArray(value) ||
    value.length < PRODUCTION_OPTIMIZE_PREREQUISITE_KEY_PURPOSES.length ||
    value.length > MAXIMUM_ROTATIONS
  ) {
    fail();
  }
  const rotations = value.map((candidate): CapturedRotation => {
    exactKeys(candidate, [
      "purpose",
      "keyId",
      "keyVersion",
      "validFrom",
      "validUntil",
    ]);
    if (
      !PRODUCTION_OPTIMIZE_PREREQUISITE_KEY_PURPOSES.includes(
        candidate.purpose as ProductionOptimizePrerequisiteKeyPurpose,
      ) ||
      typeof candidate.keyId !== "string" ||
      !SAFE_KEY_ID.test(candidate.keyId) ||
      typeof candidate.keyVersion !== "string" ||
      !SAFE_KEY_VERSION.test(candidate.keyVersion)
    ) {
      fail();
    }
    const validFromMs = timestamp(candidate.validFrom);
    const validUntilMs = timestamp(candidate.validUntil);
    if (validUntilMs <= validFromMs) fail();
    return {
      purpose:
        candidate.purpose as ProductionOptimizePrerequisiteKeyPurpose,
      keyId: candidate.keyId,
      keyVersion: candidate.keyVersion,
      validFrom: candidate.validFrom as string,
      validUntil: candidate.validUntil as string,
      validFromMs,
      validUntilMs,
    };
  });
  const identities = rotations.map(
    (rotation) =>
      `${rotation.purpose}\u0000${rotation.keyId}\u0000` +
      rotation.keyVersion,
  );
  if (new Set(identities).size !== identities.length) fail();
  for (const purpose of PRODUCTION_OPTIMIZE_PREREQUISITE_KEY_PURPOSES) {
    if (!rotations.some((rotation) => rotation.purpose === purpose)) {
      fail();
    }
  }
  const keyPurposes = new Map<string, ProductionOptimizePrerequisiteKeyPurpose>();
  for (const rotation of rotations) {
    const prior = keyPurposes.get(rotation.keyId);
    if (prior !== undefined && prior !== rotation.purpose) fail();
    keyPurposes.set(rotation.keyId, rotation.purpose);
    for (const other of rotations) {
      if (
        other !== rotation &&
        other.purpose === rotation.purpose &&
        other.keyId === rotation.keyId &&
        rotation.validFromMs < other.validUntilMs &&
        other.validFromMs < rotation.validUntilMs
      ) {
        fail();
      }
    }
  }
  return Object.freeze(
    rotations.map((rotation) => Object.freeze(rotation)),
  );
}

function matchingRotation(
  rotations: readonly CapturedRotation[],
  purpose: ProductionOptimizePrerequisiteKeyPurpose,
  signature: Signature,
): CapturedRotation {
  const signedAt = timestamp(signature.signedAt);
  const matches = rotations.filter(
    (rotation) =>
      rotation.purpose === purpose &&
      rotation.keyId === signature.keyId &&
      rotation.validFromMs <= signedAt &&
      signedAt < rotation.validUntilMs,
  );
  if (matches.length !== 1) fail();
  const match = matches[0];
  if (match === undefined) fail();
  return match;
}

function assertPublicKey(
  value: unknown,
  input: {
    readonly purpose: ProductionOptimizePrerequisiteKeyPurpose;
    readonly signature: Signature;
    readonly rotation: CapturedRotation;
  },
): asserts value is TrustedProductionOptimizePrerequisitePublicKey {
  exactKeys(value, [
    "boundary",
    "algorithm",
    "purpose",
    "keyId",
    "keyVersion",
    "validFrom",
    "validUntil",
    "revoked",
    "publicKeySpkiDer",
  ]);
  if (
    value.boundary !== "trusted-cloud-key-material" ||
    value.algorithm !== "Ed25519" ||
    value.purpose !== input.purpose ||
    value.keyId !== input.signature.keyId ||
    value.keyVersion !== input.rotation.keyVersion ||
    value.validFrom !== input.rotation.validFrom ||
    value.validUntil !== input.rotation.validUntil ||
    value.revoked !== false ||
    !(value.publicKeySpkiDer instanceof Uint8Array) ||
    value.publicKeySpkiDer.byteLength < 32 ||
    value.publicKeySpkiDer.byteLength > 1024
  ) {
    fail();
  }
}

async function verifySignedDocument(
  input: {
    readonly document: Readonly<Record<string, unknown>>;
    readonly signature: Signature;
    readonly purpose: ProductionOptimizePrerequisiteKeyPurpose;
  },
  rotations: readonly CapturedRotation[],
  resolve: TrustedProductionOptimizePrerequisitePublicKeyAuthority["resolve"],
  now: Date,
): Promise<string> {
  const rotation = matchingRotation(
    rotations,
    input.purpose,
    input.signature,
  );
  if (timestamp(input.signature.signedAt) > now.getTime()) fail();
  const request = freezeJson({
    purpose: input.purpose,
    keyId: input.signature.keyId,
    keyVersion: rotation.keyVersion,
    signedAt: input.signature.signedAt,
  } as const);
  const requestJson = canonicalJson(request);
  const resolved = await resolve(request);
  if (canonicalJson(request) !== requestJson) fail();
  assertPublicKey(resolved, {
    purpose: input.purpose,
    signature: input.signature,
    rotation,
  });
  const spki = Uint8Array.from(resolved.publicKeySpkiDer);
  const publicKey = createPublicKey({
    key: Buffer.from(spki),
    format: "der",
    type: "spki",
  });
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verifyEd25519Signature(input.document, publicKey)
  ) {
    fail();
  }
  const canonicalSpki = publicKey.export({
    format: "der",
    type: "spki",
  });
  if (!Buffer.from(canonicalSpki).equals(Buffer.from(spki))) fail();
  return sha256(canonicalSpki);
}

class MountedVolumeBootstrapCoordinationStore {
  readonly boundary =
    "trusted-cloud-production-optimize-lifecycle" as const;
  readonly lifecycleId =
    "production-bootstrap-coordination" as const;
  readonly #store: MountedVolumeTransactionalJsonStore<
    DurableBootstrapCoordinationState
  >;

  public constructor(options: MountedVolumeDurableStateOptions) {
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableBootstrapCoordinationState>(
        options,
        `production-optimize-bootstrap-${options.storeId}`,
        {
          domain:
            "dark-factory.production-optimize-bootstrap-coordination.v1",
          initialState: () => ({
            schemaVersion: 1,
            domain:
              "dark-factory.production-optimize-bootstrap-coordination.v1",
            revision: 0,
            binding: null,
          }),
          assertState: assertCoordinationState,
          revision: (state) => state.revision,
        },
      );
  }

  public claim(
    request: ProductionOptimizeBootstrapOrReconstructRequest,
    claimedAt: string,
  ): Promise<BootstrapClaim> {
    const requestSnapshot = cloneCanonical(request);
    assertRequest(requestSnapshot);
    timestamp(claimedAt);
    return this.#store.transact((state) => {
      if (state.binding === null) {
        return {
          next: {
            ...state,
            revision: 1,
            binding: {
              request: requestSnapshot,
              phase: "claimed",
              replayObserved: false,
              campaignStateHash: null,
              catalogStateHash: null,
              claimedAt,
              advancedAt: claimedAt,
              receipt: null,
            },
          },
          result: {
            fresh: true,
            phaseAtClaim: "claimed" as const,
          },
        };
      }
      if (
        canonicalJson(state.binding.request) !==
        canonicalJson(requestSnapshot)
      ) {
        fail();
      }
      const result = {
        fresh: false,
        phaseAtClaim: state.binding.phase,
      } as const;
      if (state.binding.replayObserved) {
        return { next: state, result };
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          binding: {
            ...state.binding,
            replayObserved: true,
            advancedAt: claimedAt,
          },
        },
        result,
      };
    });
  }

  public recordCampaign(
    requestHash: string,
    campaignStateHash: string,
    advancedAt: string,
  ): Promise<void> {
    if (
      !SHA256.test(requestHash) ||
      !SHA256.test(campaignStateHash)
    ) {
      fail();
    }
    timestamp(advancedAt);
    return this.#store.transact((state) => {
      const binding = state.binding;
      if (
        binding === null ||
        binding.request.requestHash !== requestHash
      ) {
        fail();
      }
      if (binding.phase !== "claimed") {
        if (binding.campaignStateHash !== campaignStateHash) fail();
        return { next: state, result: undefined };
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          binding: {
            ...binding,
            phase: "campaign-ensured" as const,
            campaignStateHash,
            advancedAt,
          },
        },
        result: undefined,
      };
    });
  }

  public recordCatalog(
    requestHash: string,
    catalogStateHash: string,
    advancedAt: string,
  ): Promise<void> {
    if (
      !SHA256.test(requestHash) ||
      !SHA256.test(catalogStateHash)
    ) {
      fail();
    }
    timestamp(advancedAt);
    return this.#store.transact((state) => {
      const binding = state.binding;
      if (
        binding === null ||
        binding.request.requestHash !== requestHash
      ) {
        fail();
      }
      if (
        binding.phase === "claimed" ||
        binding.campaignStateHash === null
      ) {
        fail();
      }
      if (binding.phase !== "campaign-ensured") {
        if (binding.catalogStateHash !== catalogStateHash) fail();
        return { next: state, result: undefined };
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          binding: {
            ...binding,
            phase: "catalog-ensured" as const,
            catalogStateHash,
            advancedAt,
          },
        },
        result: undefined,
      };
    });
  }

  public commit(input: {
    readonly request: ProductionOptimizeBootstrapOrReconstructRequest;
    readonly claim: BootstrapClaim;
    readonly campaignDisposition: "created" | "existing";
    readonly catalogDisposition: "created" | "existing";
    readonly campaignStateHash: string;
    readonly catalogStateHash: string;
    readonly verifiedAt: string;
  }): Promise<ProductionOptimizeBootstrapOrReconstructReceipt> {
    timestamp(input.verifiedAt);
    return this.#store.transact((state) => {
      const binding = state.binding;
      if (
        binding === null ||
        canonicalJson(binding.request) !==
          canonicalJson(input.request) ||
        binding.campaignStateHash !== input.campaignStateHash ||
        binding.catalogStateHash !== input.catalogStateHash ||
        (input.claim.phaseAtClaim !== "claimed" &&
          input.campaignDisposition !== "existing") ||
        ((input.claim.phaseAtClaim === "catalog-ensured" ||
          input.claim.phaseAtClaim === "committed") &&
          input.catalogDisposition !== "existing") ||
        (input.campaignDisposition === "created" &&
          input.catalogDisposition === "existing")
      ) {
        fail();
      }
      if (binding.phase === "committed") {
        if (binding.receipt === null) fail();
        return {
          next: state,
          result: cloneCanonical(binding.receipt),
        };
      }
      if (binding.phase !== "catalog-ensured") fail();
      const disposition =
        input.claim.fresh &&
        !binding.replayObserved &&
        input.campaignDisposition === "created" &&
        input.catalogDisposition === "created"
          ? "bootstrapped"
          : "reconstructed";
      const receipt = createReceipt(input.request, {
        disposition,
        campaignStateHash: input.campaignStateHash,
        catalogStateHash: input.catalogStateHash,
        verifiedAt: input.verifiedAt,
      });
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          binding: {
            ...binding,
            phase: "committed" as const,
            advancedAt: input.verifiedAt,
            receipt,
          },
        },
        result: receipt,
      };
    });
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}

interface CapturedDependencies {
  readonly locatePrivatePiRegistration:
    TrustedProductionOptimizePrerequisiteSource["locatePrivatePiRegistration"];
  readonly locateCampaignGenesis:
    TrustedProductionOptimizePrerequisiteSource["locateCampaignGenesis"];
  readonly locateHiddenCatalogGenesis:
    TrustedProductionOptimizePrerequisiteSource["locateHiddenCatalogGenesis"];
  readonly resolvePublicKey:
    TrustedProductionOptimizePrerequisitePublicKeyAuthority["resolve"];
  readonly ensureCampaign:
    TrustedProductionOptimizeCampaignGenesisAuthority["ensureExact"];
  readonly ensureCatalog:
    TrustedProductionOptimizeHiddenCatalogGenesisAuthority["ensureExact"];
  readonly rotations: readonly CapturedRotation[];
  readonly now: () => Date;
}

function captureDependencies(
  options: DurableProductionOptimizeBootstrapOrReconstructOptions,
): CapturedDependencies {
  exactKeys(options, [
    "durableState",
    "prerequisiteSource",
    "publicKeyAuthority",
    "keyRotations",
    "campaignGenesisAuthority",
    "hiddenCatalogGenesisAuthority",
    "now",
  ].filter((key) => key !== "now" || options.now !== undefined));
  if (
    options.prerequisiteSource.boundary !==
      "trusted-cloud-production-optimize-prerequisite-source" ||
    typeof options.prerequisiteSource
      .locatePrivatePiRegistration !== "function" ||
    typeof options.prerequisiteSource.locateCampaignGenesis !==
      "function" ||
    typeof options.prerequisiteSource
      .locateHiddenCatalogGenesis !== "function" ||
    options.publicKeyAuthority.boundary !==
      "trusted-cloud-production-optimize-prerequisite-public-key-authority" ||
    typeof options.publicKeyAuthority.resolve !== "function" ||
    options.campaignGenesisAuthority.boundary !==
      "trusted-cloud-production-optimize-campaign-genesis-authority" ||
    typeof options.campaignGenesisAuthority.ensureExact !==
      "function" ||
    options.hiddenCatalogGenesisAuthority.boundary !==
      "trusted-cloud-production-optimize-hidden-catalog-genesis-authority" ||
    typeof options.hiddenCatalogGenesisAuthority.ensureExact !==
      "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    fail();
  }
  const sourceNow = options.now ?? (() => new Date());
  return {
    locatePrivatePiRegistration:
      options.prerequisiteSource.locatePrivatePiRegistration.bind(
        options.prerequisiteSource,
      ),
    locateCampaignGenesis:
      options.prerequisiteSource.locateCampaignGenesis.bind(
        options.prerequisiteSource,
      ),
    locateHiddenCatalogGenesis:
      options.prerequisiteSource.locateHiddenCatalogGenesis.bind(
        options.prerequisiteSource,
      ),
    resolvePublicKey: options.publicKeyAuthority.resolve.bind(
      options.publicKeyAuthority,
    ),
    ensureCampaign:
      options.campaignGenesisAuthority.ensureExact.bind(
        options.campaignGenesisAuthority,
      ),
    ensureCatalog:
      options.hiddenCatalogGenesisAuthority.ensureExact.bind(
        options.hiddenCatalogGenesisAuthority,
      ),
    rotations: captureRotations(options.keyRotations),
    now: () => readNow(sourceNow),
  };
}

async function registerEnsureResult(
  value: unknown,
  input: {
    readonly lifecycle: ProductionOptimizeLifecycleRegistrar;
    readonly expectedStateHash: string;
  },
): Promise<{
  readonly disposition: "created" | "existing";
  readonly stateHash: string;
}> {
  exactKeys(value, ["disposition", "stateHash", "resource"]);
  const resource = value.resource;
  exactKeys(resource, ["boundary", "lifecycleId", "close"]);
  if (
    resource.boundary !==
      "trusted-cloud-production-optimize-lifecycle" ||
    typeof resource.lifecycleId !== "string" ||
    !SAFE_ID.test(resource.lifecycleId) ||
    typeof resource.close !== "function"
  ) {
    fail();
  }
  const close = resource.close.bind(resource);
  try {
    input.lifecycle.register(
      resource as unknown as TrustedProductionOptimizeCloseable,
    );
  } catch {
    try {
      await close();
    } catch {
      // The generic failure below intentionally hides cleanup internals.
    }
    fail();
  }
  if (
    (value.disposition !== "created" &&
      value.disposition !== "existing") ||
    typeof value.stateHash !== "string" ||
    value.stateHash !== input.expectedStateHash
  ) {
    fail();
  }
  return {
    disposition: value.disposition,
    stateHash: value.stateHash,
  };
}

function assertLifecycle(
  value: unknown,
): asserts value is ProductionOptimizeLifecycleRegistrar {
  exactKeys(value, ["boundary", "register"]);
  if (
    value.boundary !== "production-optimize-composition-owner" ||
    typeof value.register !== "function"
  ) {
    fail();
  }
}

function sourceQuery(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
) {
  return freezeJson({
    purpose:
      "production-optimize-private-pi-registration" as const,
    sourcePrerequisiteHash: request.sourcePrerequisiteHash,
  });
}

function campaignQuery(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
) {
  return freezeJson({
    purpose: "production-optimize-campaign-genesis" as const,
    campaignId: request.campaignId,
    lineageId: request.lineageId,
    protocolHash: request.protocolHash,
    sourcePrerequisiteHash: request.sourcePrerequisiteHash,
    genesisPrerequisiteHash: request.genesisPrerequisiteHash,
  });
}

function catalogQuery(
  request: ProductionOptimizeBootstrapOrReconstructRequest,
) {
  return freezeJson({
    purpose:
      "production-optimize-hidden-catalog-genesis" as const,
    campaignId: request.campaignId,
    lineageId: request.lineageId,
    protocolHash: request.protocolHash,
    genesisPrerequisiteHash: request.genesisPrerequisiteHash,
    catalogPrerequisiteHash: request.catalogPrerequisiteHash,
  });
}

/**
 * Concrete production bootstrap/reconstruction authority.
 *
 * The mounted coordination record is a recoverable write-ahead protocol, not
 * a cross-store transaction. It records only strict prefixes:
 *
 * claimed -> campaign ensured -> catalog ensured -> committed.
 *
 * Each replay re-verifies all signed prerequisites and asks both domain
 * authorities to create or exactly reconstruct their own state. Journal/state
 * disagreement, catalog-without-campaign, or a later phase whose domain store
 * had to be recreated is treated as corruption and fails closed.
 */
export class DurableProductionOptimizeBootstrapOrReconstructPort
  implements TrustedProductionOptimizeBootstrapOrReconstructPort
{
  readonly boundary =
    "trusted-cloud-production-optimize-bootstrap-or-reconstruct" as const;
  readonly #coordination: MountedVolumeBootstrapCoordinationStore;
  readonly #dependencies: CapturedDependencies;
  #inFlightRequestHash: string | null = null;

  public constructor(
    options: DurableProductionOptimizeBootstrapOrReconstructOptions,
  ) {
    try {
      this.#dependencies = captureDependencies(options);
      this.#coordination =
        new MountedVolumeBootstrapCoordinationStore(
          options.durableState,
        );
    } catch {
      fail();
    }
  }

  public async verifyBootstrapOrReconstruct(
    request: ProductionOptimizeBootstrapOrReconstructRequest,
    lifecycle: ProductionOptimizeLifecycleRegistrar,
  ): Promise<ProductionOptimizeBootstrapOrReconstructReceipt> {
    let requestHash: string | null = null;
    let ownsInFlight = false;
    try {
      assertLifecycle(lifecycle);
      const snapshot = cloneCanonical<unknown>(request);
      assertRequest(snapshot);
      const requestSnapshot = freezeJson(snapshot);
      requestHash = requestSnapshot.requestHash;
      if (this.#inFlightRequestHash !== null) fail();
      this.#inFlightRequestHash = requestHash;
      ownsInFlight = true;
      const requestJson = canonicalJson(request);

      const sourceLookup = sourceQuery(requestSnapshot);
      const campaignLookup = campaignQuery(requestSnapshot);
      const catalogLookup = catalogQuery(requestSnapshot);
      const sourceLookupJson = canonicalJson(sourceLookup);
      const campaignLookupJson = canonicalJson(campaignLookup);
      const catalogLookupJson = canonicalJson(catalogLookup);
      const [sourceCandidate, campaignCandidate, catalogCandidate] =
        await Promise.all([
          this.#dependencies.locatePrivatePiRegistration(
            sourceLookup,
          ),
          this.#dependencies.locateCampaignGenesis(
            campaignLookup,
          ),
          this.#dependencies.locateHiddenCatalogGenesis(
            catalogLookup,
          ),
        ]);
      if (
        canonicalJson(request) !== requestJson ||
        canonicalJson(sourceLookup) !== sourceLookupJson ||
        canonicalJson(campaignLookup) !== campaignLookupJson ||
        canonicalJson(catalogLookup) !== catalogLookupJson ||
        sourceCandidate === undefined ||
        campaignCandidate === undefined ||
        catalogCandidate === undefined
      ) {
        fail();
      }

      const source = cloneCanonical<unknown>(sourceCandidate);
      const campaign = cloneCanonical<unknown>(campaignCandidate);
      const catalog = cloneCanonical<unknown>(catalogCandidate);
      const now = this.#dependencies.now();
      assertPrivatePiRegistration(
        source,
        requestSnapshot.sourcePrerequisiteHash,
      );
      assertCampaignGenesis(campaign, requestSnapshot, now);
      assertCatalogGenesis(catalog, requestSnapshot, now);
      const keyFingerprints = await Promise.all([
        verifySignedDocument(
          {
            document: source as unknown as Readonly<
              Record<string, unknown>
            >,
            signature: source.signature,
            purpose:
              "production-optimize-private-pi-registration",
          },
          this.#dependencies.rotations,
          this.#dependencies.resolvePublicKey,
          now,
        ),
        verifySignedDocument(
          {
            document: campaign as unknown as Readonly<
              Record<string, unknown>
            >,
            signature: campaign.signature,
            purpose: "production-optimize-campaign-genesis",
          },
          this.#dependencies.rotations,
          this.#dependencies.resolvePublicKey,
          now,
        ),
        verifySignedDocument(
          {
            document: catalog as unknown as Readonly<
              Record<string, unknown>
            >,
            signature: catalog.signature,
            purpose:
              "production-optimize-hidden-catalog-genesis",
          },
          this.#dependencies.rotations,
          this.#dependencies.resolvePublicKey,
          now,
        ),
      ]);
      if (
        new Set(keyFingerprints).size !== keyFingerprints.length
      ) {
        fail();
      }

      try {
        lifecycle.register(this.#coordination);
      } catch {
        try {
          await this.#coordination.close();
        } catch {
          // The generic failure below intentionally hides cleanup internals.
        }
        fail();
      }
      const claim = await this.#coordination.claim(
        requestSnapshot,
        this.#dependencies.now().toISOString(),
      );

      const campaignInput = freezeJson({
        schemaVersion: 1 as const,
        domain:
          "dark-factory.production-optimize-campaign-genesis-authority-input.v1" as const,
        requestHash: requestSnapshot.requestHash,
        sourcePrerequisiteHash:
          requestSnapshot.sourcePrerequisiteHash,
        sourceRegistrationId: source.registrationId,
        genesisPrerequisite: cloneCanonical(campaign),
      });
      const campaignInputJson = canonicalJson(campaignInput);
      const campaignResultCandidate =
        await this.#dependencies.ensureCampaign(campaignInput);
      if (canonicalJson(campaignInput) !== campaignInputJson) fail();
      const campaignResult = await registerEnsureResult(
        campaignResultCandidate,
        {
          lifecycle,
          expectedStateHash: campaign.initialCampaignStateHash,
        },
      );
      if (
        claim.phaseAtClaim !== "claimed" &&
        campaignResult.disposition !== "existing"
      ) {
        fail();
      }
      await this.#coordination.recordCampaign(
        requestSnapshot.requestHash,
        campaignResult.stateHash,
        this.#dependencies.now().toISOString(),
      );

      const catalogInput = freezeJson({
        schemaVersion: 1 as const,
        domain:
          "dark-factory.production-optimize-hidden-catalog-genesis-authority-input.v1" as const,
        requestHash: requestSnapshot.requestHash,
        campaignStateHash: campaignResult.stateHash,
        catalogPrerequisite: cloneCanonical(catalog),
      });
      const catalogInputJson = canonicalJson(catalogInput);
      const catalogResultCandidate =
        await this.#dependencies.ensureCatalog(catalogInput);
      if (canonicalJson(catalogInput) !== catalogInputJson) fail();
      const catalogResult = await registerEnsureResult(
        catalogResultCandidate,
        {
          lifecycle,
          expectedStateHash: catalog.initialCatalogStateHash,
        },
      );
      if (
        ((claim.phaseAtClaim === "catalog-ensured" ||
          claim.phaseAtClaim === "committed") &&
          catalogResult.disposition !== "existing") ||
        (campaignResult.disposition === "created" &&
          catalogResult.disposition === "existing")
      ) {
        fail();
      }
      await this.#coordination.recordCatalog(
        requestSnapshot.requestHash,
        catalogResult.stateHash,
        this.#dependencies.now().toISOString(),
      );
      const committed = await this.#coordination.commit({
        request: requestSnapshot,
        claim,
        campaignDisposition: campaignResult.disposition,
        catalogDisposition: catalogResult.disposition,
        campaignStateHash: campaignResult.stateHash,
        catalogStateHash: catalogResult.stateHash,
        verifiedAt: this.#dependencies.now().toISOString(),
      });
      const receipt = claim.fresh
        ? committed
        : reconstructedReceipt(committed, requestSnapshot);
      assertReceipt(receipt, requestSnapshot);
      return receipt;
    } catch {
      fail();
    } finally {
      if (ownsInFlight) this.#inFlightRequestHash = null;
    }
  }
}
