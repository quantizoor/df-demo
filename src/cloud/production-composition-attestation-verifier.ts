import { createPublicKey, KeyObject } from "node:crypto";

import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  assertProductionOptimizationCompositionManifest,
  PRODUCTION_RUNTIME_PORT_IDS,
  type ProductionCompositionVerification,
  type ProductionOptimizationCompositionManifest,
  type ProductionRuntimeComponentManifest,
  type ProductionRuntimePortAttestationCommitment,
  type ProductionRuntimePortId,
  type ProductionRuntimeRole,
  productionRuntimePortBindingsHash,
  type TrustedProductionCompositionAttestationVerifier,
} from "../orchestrator/production-runtime.js";
import { canonicalHash, canonicalJson, computeContentHash, sha256 } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,127}$/u;
const SAFE_KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const TRUSTED_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 256 * 1024;
const MAXIMUM_ARTIFACT_BYTES_CEILING = 4 * 1024 * 1024;
const DEFAULT_MAXIMUM_TOTAL_BYTES = 4 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES_CEILING = 32 * 1024 * 1024;

const PRODUCTION_RUNTIME_ROLES = ["control", "optimizer", "build", "evaluator"] as const;

const RUNTIME_PORT_ROLES = {
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

type ProductionOperationalBindingField =
  keyof ProductionOptimizationCompositionManifest["bindings"];

const PRODUCTION_OPERATIONAL_BINDING_FIELDS = [
  ["harness.registration", "harnessRegistrationHash"],
  ["campaign.genesis", "campaignGenesisHash"],
  ["hidden-catalog.genesis", "hiddenCatalogGenesisHash"],
  ["provider.readiness", "providerReadinessHash"],
  ["volume.semantics", "volumeSemanticsHash"],
  ["optimizer.plugin-bundle", "optimizerPluginBundleHash"],
  ["build.correctness-policy", "correctnessPolicyHash"],
  ["broker.policy", "brokerPolicyHash"],
  ["evaluator.policy", "evaluatorPolicyHash"],
  ["journal.policy", "journalPolicyHash"],
] as const satisfies readonly (readonly [string, ProductionOperationalBindingField])[];

export const PRODUCTION_OPERATIONAL_BINDING_IDS = Object.freeze(
  PRODUCTION_OPERATIONAL_BINDING_FIELDS.map(([bindingId]) => bindingId),
);

export type ProductionOperationalBindingId = (typeof PRODUCTION_OPERATIONAL_BINDING_IDS)[number];

export interface ProductionCompositionAttestationQuery {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-composition-attestation-query.v1";
  readonly campaignId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly componentBindingsHash: string;
  readonly operationalBindingsHash: string;
  readonly runtimePortBindingsHash: string;
  readonly queryHash: string;
}

export interface ProductionComponentAttestationArtifactBinding {
  readonly role: ProductionRuntimeRole;
  readonly componentBindingHash: string;
  readonly artifact: TrustedCloudArtifactRef;
}

export interface ProductionOperationalAttestationArtifactBinding {
  readonly operationalBindingsHash: string;
  readonly artifact: TrustedCloudArtifactRef;
}

export interface ProductionRuntimePortAttestationArtifactBinding {
  readonly portId: ProductionRuntimePortId;
  readonly attestationSha256: string;
  readonly artifact: TrustedCloudArtifactRef;
}

export interface ProductionCompositionAttestationArtifactSet {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-composition-attestation-artifact-set.v1";
  readonly sensitivity: "release-safe-control";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly queryHash: string;
  readonly componentAttestations: readonly ProductionComponentAttestationArtifactBinding[];
  readonly operationalBindingsAttestation: ProductionOperationalAttestationArtifactBinding;
  readonly runtimePortAttestations: readonly ProductionRuntimePortAttestationArtifactBinding[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: Signature;
  readonly contentHash: string;
}

/**
 * A provider adapter resolves one exact, task-free evidence set. It cannot
 * select a module, constructor, command, model, or executable runtime port.
 */
export interface TrustedProductionCompositionAttestationArtifactSource {
  readonly boundary: "trusted-cloud";
  locate(
    query: ProductionCompositionAttestationQuery,
  ): Promise<ProductionCompositionAttestationArtifactSet | undefined>;
}

export interface TrustedProductionCompositionAttestationArtifactReader {
  readonly boundary: "trusted-cloud";
  readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string>;
}

export interface TrustedProductionCompositionPublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: "production-composition-manifest";
  readonly keyId: string;
  readonly keyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revoked: boolean;
  readonly publicKey: KeyObject;
}

/**
 * The authority exposes public verification material only. `signedAt` lets a
 * rotation-aware implementation resolve the historical key version without
 * making private key material representable in this interface.
 */
export interface TrustedProductionCompositionPublicKeyAuthority {
  readonly boundary: "trusted-cloud";
  resolve(input: {
    readonly purpose: "production-composition-manifest";
    readonly keyId: string;
    readonly signedAt: string;
  }): Promise<TrustedProductionCompositionPublicKey | undefined>;
}

export interface TrustedProductionCompositionEvidencePublicKey {
  readonly boundary: "trusted-cloud-key-material";
  readonly algorithm: "Ed25519";
  readonly purpose: "production-composition-evidence-set";
  readonly keyId: string;
  readonly keyVersion: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revoked: boolean;
  readonly publicKey: KeyObject;
}

/**
 * Evidence authority is deliberately distinct from the manifest authority.
 * It authenticates the exact immutable artifact-reference envelope, never an
 * executable implementation.
 */
export interface TrustedProductionCompositionEvidencePublicKeyAuthority {
  readonly boundary: "trusted-cloud";
  resolve(input: {
    readonly purpose: "production-composition-evidence-set";
    readonly keyId: string;
    readonly signedAt: string;
  }): Promise<TrustedProductionCompositionEvidencePublicKey | undefined>;
}

export interface ProductionRuntimePortAttestationBinding {
  readonly portId: ProductionRuntimePortId;
  readonly role: ProductionRuntimeRole;
  readonly componentBindingHash: string;
  readonly sourceArtifactHash: string;
  readonly configurationHash: string;
  readonly implementationBindingHash: string;
}

export interface ProductionOperationalBindingAttestation {
  readonly bindingId: ProductionOperationalBindingId;
  readonly attestationSha256: string;
}

export interface ProductionComponentAttestationArtifact {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-component-attestation.v1";
  readonly sensitivity: "release-safe-control";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly role: ProductionRuntimeRole;
  readonly componentBindingHash: string;
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly sourceArtifactHash: string;
  readonly configurationHash: string;
  readonly providerAttestationHash: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly contentHash: string;
}

export interface ProductionOperationalBindingsAttestationArtifact {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-operational-bindings-attestation.v1";
  readonly sensitivity: "release-safe-control";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly operationalBindingsHash: string;
  readonly bindingAttestations: readonly ProductionOperationalBindingAttestation[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly contentHash: string;
}

export interface ProductionRuntimePortAttestationArtifact {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-runtime-port-attestation.v1";
  readonly sensitivity: "release-safe-control";
  readonly deployment: "trusted-cloud";
  readonly campaignId: string;
  readonly manifestId: string;
  readonly manifestHash: string;
  readonly runtimePortBindingsHash: string;
  readonly portId: ProductionRuntimePortId;
  readonly role: ProductionRuntimeRole;
  readonly componentBindingHash: string;
  readonly sourceArtifactHash: string;
  readonly configurationHash: string;
  readonly implementationBindingHash: string;
  readonly attestationSha256: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly contentHash: string;
}

export interface ArtifactBackedProductionCompositionVerifierOptions {
  readonly source: TrustedProductionCompositionAttestationArtifactSource;
  readonly reader: TrustedProductionCompositionAttestationArtifactReader;
  readonly keyAuthority: TrustedProductionCompositionPublicKeyAuthority;
  readonly evidenceKeyAuthority: TrustedProductionCompositionEvidencePublicKeyAuthority;
  /**
   * Complete accepted rotation set. Unknown key IDs fail before the authority
   * is queried.
   */
  readonly trustedKeyIds: readonly string[];
  readonly trustedEvidenceKeyIds: readonly string[];
  readonly maximumArtifactBytes?: number;
  readonly maximumTotalBytes?: number;
  readonly now?: () => Date;
}

export class ProductionCompositionAttestationVerificationError extends Error {
  override readonly name = "ProductionCompositionAttestationVerificationError";

  constructor() {
    super("Production composition attestation verification failed closed.");
  }
}

function fail(): never {
  throw new ProductionCompositionAttestationVerificationError();
}

function capturePublicKey(value: KeyObject): KeyObject {
  if (value.type !== "public" || value.asymmetricKeyType !== "ed25519") fail();
  return createPublicKey({
    key: value.export({
      format: "der",
      type: "spki",
    }),
    format: "der",
    type: "spki",
  });
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
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail();
  }
}

function exactDataKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  exactKeys(value, keys);
  if (
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
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

function assertSignature(
  value: unknown,
  trustedKeyIds: ReadonlySet<string>,
  issuedAt: string,
): asserts value is Signature {
  exactKeys(value, ["algorithm", "keyId", "signedAt", "signature"]);
  if (
    value.algorithm !== "ed25519" ||
    typeof value.keyId !== "string" ||
    !trustedKeyIds.has(value.keyId) ||
    value.signedAt !== issuedAt ||
    typeof value.signature !== "string" ||
    !BASE64URL_SIGNATURE.test(value.signature)
  ) {
    fail();
  }
  timestamp(value.signedAt);
}

function readNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  return new Date(value.getTime());
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
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

function assertArtifactReference(
  value: unknown,
  maximumArtifactBytes: number,
): asserts value is TrustedCloudArtifactRef {
  exactKeys(value, ["uri", "sha256", "mediaType", "byteLength"]);
  if (
    typeof value.uri !== "string" ||
    !TRUSTED_URI.test(value.uri) ||
    value.uri.includes("..") ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    value.mediaType !== "application/json" ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0 ||
    (value.byteLength as number) > maximumArtifactBytes
  ) {
    fail();
  }
}

function componentForRole(
  manifest: ProductionOptimizationCompositionManifest,
  role: ProductionRuntimeRole,
): ProductionRuntimeComponentManifest {
  return manifest.components[role];
}

function expectedOperationalBindings(
  manifest: ProductionOptimizationCompositionManifest,
): readonly ProductionOperationalBindingAttestation[] {
  const fields = PRODUCTION_OPERATIONAL_BINDING_FIELDS.map(([, field]) => field);
  if (
    Object.keys(manifest.bindings).length !== PRODUCTION_OPERATIONAL_BINDING_FIELDS.length ||
    new Set(fields).size !== fields.length
  ) {
    fail();
  }
  return PRODUCTION_OPERATIONAL_BINDING_FIELDS.map(
    ([bindingId, field]): ProductionOperationalBindingAttestation => ({
      bindingId,
      attestationSha256: manifest.bindings[field],
    }),
  );
}

function componentBindingForPort(
  manifest: ProductionOptimizationCompositionManifest,
  portId: ProductionRuntimePortId,
): {
  readonly role: ProductionRuntimeRole;
  readonly component: ProductionRuntimeComponentManifest;
  readonly componentBindingHash: string;
} {
  const role = RUNTIME_PORT_ROLES[portId];
  const component = componentForRole(manifest, role);
  return {
    role,
    component,
    componentBindingHash: canonicalHash(component),
  };
}

export function productionRuntimePortAttestationBindingHash(
  value: ProductionRuntimePortAttestationBinding,
): string {
  exactDataKeys(value, [
    "portId",
    "role",
    "componentBindingHash",
    "sourceArtifactHash",
    "configurationHash",
    "implementationBindingHash",
  ]);
  if (
    !PRODUCTION_RUNTIME_PORT_IDS.includes(value.portId as ProductionRuntimePortId) ||
    value.role !== RUNTIME_PORT_ROLES[value.portId as ProductionRuntimePortId] ||
    typeof value.componentBindingHash !== "string" ||
    !SHA256.test(value.componentBindingHash) ||
    typeof value.sourceArtifactHash !== "string" ||
    !SHA256.test(value.sourceArtifactHash) ||
    typeof value.configurationHash !== "string" ||
    !SHA256.test(value.configurationHash) ||
    typeof value.implementationBindingHash !== "string" ||
    !SHA256.test(value.implementationBindingHash)
  ) {
    fail();
  }
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.production-runtime-port-attestation-binding.v1",
    portId: value.portId,
    role: value.role,
    componentBindingHash: value.componentBindingHash,
    sourceArtifactHash: value.sourceArtifactHash,
    configurationHash: value.configurationHash,
    implementationBindingHash: value.implementationBindingHash,
  });
}

function compositionAttestationQuery(
  manifest: ProductionOptimizationCompositionManifest,
): ProductionCompositionAttestationQuery {
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-composition-attestation-query.v1" as const,
    campaignId: manifest.campaignId,
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    componentBindingsHash: canonicalHash(manifest.components),
    operationalBindingsHash: canonicalHash(manifest.bindings),
    runtimePortBindingsHash: productionRuntimePortBindingsHash(manifest.runtimePortAttestations),
  };
  return Object.freeze({
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  });
}

function assertArtifactSet(
  value: unknown,
  query: ProductionCompositionAttestationQuery,
  manifest: ProductionOptimizationCompositionManifest,
  maximumArtifactBytes: number,
  maximumTotalBytes: number,
  trustedEvidenceKeyIds: ReadonlySet<string>,
  now: Date,
): asserts value is ProductionCompositionAttestationArtifactSet {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "manifestId",
    "manifestHash",
    "queryHash",
    "componentAttestations",
    "operationalBindingsAttestation",
    "runtimePortAttestations",
    "issuedAt",
    "expiresAt",
    "signature",
    "contentHash",
  ]);
  const issuedAt = timestamp(value.issuedAt);
  const expiresAt = timestamp(value.expiresAt);
  assertSignature(value.signature, trustedEvidenceKeyIds, value.issuedAt as string);
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.production-composition-attestation-artifact-set.v1" ||
    value.sensitivity !== "release-safe-control" ||
    value.deployment !== "trusted-cloud" ||
    value.campaignId !== manifest.campaignId ||
    value.manifestId !== manifest.manifestId ||
    value.manifestHash !== manifest.manifestHash ||
    value.queryHash !== query.queryHash ||
    issuedAt < timestamp(manifest.issuedAt) ||
    issuedAt > now.getTime() ||
    expiresAt > timestamp(manifest.expiresAt) ||
    now.getTime() > expiresAt ||
    issuedAt >= expiresAt ||
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    value.contentHash !== computeContentHash(value) ||
    !Array.isArray(value.componentAttestations) ||
    value.componentAttestations.length !== PRODUCTION_RUNTIME_ROLES.length ||
    !Array.isArray(value.runtimePortAttestations) ||
    value.runtimePortAttestations.length !== PRODUCTION_RUNTIME_PORT_IDS.length
  ) {
    fail();
  }

  const artifactUris = new Set<string>();
  const artifactHashes = new Set<string>();
  let totalBytes = 0;
  const addArtifact = (artifactValue: unknown): void => {
    assertArtifactReference(artifactValue, maximumArtifactBytes);
    if (artifactUris.has(artifactValue.uri) || artifactHashes.has(artifactValue.sha256)) {
      fail();
    }
    artifactUris.add(artifactValue.uri);
    artifactHashes.add(artifactValue.sha256);
    totalBytes += artifactValue.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maximumTotalBytes) {
      fail();
    }
  };

  for (const [index, role] of PRODUCTION_RUNTIME_ROLES.entries()) {
    const entry = value.componentAttestations[index];
    exactKeys(entry, ["role", "componentBindingHash", "artifact"]);
    if (
      entry.role !== role ||
      entry.componentBindingHash !== canonicalHash(componentForRole(manifest, role))
    ) {
      fail();
    }
    addArtifact(entry.artifact);
  }

  exactKeys(value.operationalBindingsAttestation, ["operationalBindingsHash", "artifact"]);
  if (
    value.operationalBindingsAttestation.operationalBindingsHash !== query.operationalBindingsHash
  ) {
    fail();
  }
  addArtifact(value.operationalBindingsAttestation.artifact);

  for (const [index, portId] of PRODUCTION_RUNTIME_PORT_IDS.entries()) {
    const entry = value.runtimePortAttestations[index];
    const commitment = manifest.runtimePortAttestations[index];
    exactKeys(entry, ["portId", "attestationSha256", "artifact"]);
    if (
      commitment === undefined ||
      entry.portId !== portId ||
      entry.attestationSha256 !== commitment.attestationSha256
    ) {
      fail();
    }
    addArtifact(entry.artifact);
  }
}

function assertCommonArtifactEnvelope(
  value: Readonly<Record<string, unknown>>,
  manifest: ProductionOptimizationCompositionManifest,
  now: Date,
): void {
  const issuedAt = timestamp(value["issuedAt"]);
  const expiresAt = timestamp(value["expiresAt"]);
  if (
    value["schemaVersion"] !== 1 ||
    value["sensitivity"] !== "release-safe-control" ||
    value["deployment"] !== "trusted-cloud" ||
    value["campaignId"] !== manifest.campaignId ||
    value["manifestId"] !== manifest.manifestId ||
    value["manifestHash"] !== manifest.manifestHash ||
    issuedAt < timestamp(manifest.issuedAt) ||
    issuedAt > now.getTime() ||
    expiresAt > timestamp(manifest.expiresAt) ||
    now.getTime() > expiresAt ||
    issuedAt >= expiresAt ||
    typeof value["contentHash"] !== "string" ||
    !SHA256.test(value["contentHash"] as string) ||
    value["contentHash"] !== computeContentHash(value)
  ) {
    fail();
  }
}

function assertComponentArtifact(
  value: unknown,
  manifest: ProductionOptimizationCompositionManifest,
  expectedRole: ProductionRuntimeRole,
  now: Date,
): asserts value is ProductionComponentAttestationArtifact {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "manifestId",
    "manifestHash",
    "role",
    "componentBindingHash",
    "imageReference",
    "imageDigest",
    "sourceArtifactHash",
    "configurationHash",
    "providerAttestationHash",
    "issuedAt",
    "expiresAt",
    "contentHash",
  ]);
  assertCommonArtifactEnvelope(value, manifest, now);
  const component = componentForRole(manifest, expectedRole);
  if (
    value.domain !== "dark-factory.production-component-attestation.v1" ||
    value.role !== expectedRole ||
    value.componentBindingHash !== canonicalHash(component) ||
    value.imageReference !== component.imageReference ||
    value.imageDigest !== component.imageDigest ||
    value.sourceArtifactHash !== component.sourceArtifactHash ||
    value.configurationHash !== component.configurationHash ||
    typeof value.providerAttestationHash !== "string" ||
    !SHA256.test(value.providerAttestationHash)
  ) {
    fail();
  }
}

function assertOperationalArtifact(
  value: unknown,
  manifest: ProductionOptimizationCompositionManifest,
  now: Date,
): asserts value is ProductionOperationalBindingsAttestationArtifact {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "manifestId",
    "manifestHash",
    "operationalBindingsHash",
    "bindingAttestations",
    "issuedAt",
    "expiresAt",
    "contentHash",
  ]);
  assertCommonArtifactEnvelope(value, manifest, now);
  const expected = expectedOperationalBindings(manifest);
  if (
    value.domain !== "dark-factory.production-operational-bindings-attestation.v1" ||
    value.operationalBindingsHash !== canonicalHash(manifest.bindings) ||
    !Array.isArray(value.bindingAttestations) ||
    value.bindingAttestations.length !== expected.length
  ) {
    fail();
  }
  for (const [index, expectedBinding] of expected.entries()) {
    const binding = value.bindingAttestations[index];
    exactKeys(binding, ["bindingId", "attestationSha256"]);
    if (
      binding.bindingId !== expectedBinding.bindingId ||
      binding.attestationSha256 !== expectedBinding.attestationSha256
    ) {
      fail();
    }
  }
}

function assertRuntimePortArtifact(
  value: unknown,
  manifest: ProductionOptimizationCompositionManifest,
  expectedCommitment: ProductionRuntimePortAttestationCommitment,
  now: Date,
): asserts value is ProductionRuntimePortAttestationArtifact {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "sensitivity",
    "deployment",
    "campaignId",
    "manifestId",
    "manifestHash",
    "runtimePortBindingsHash",
    "portId",
    "role",
    "componentBindingHash",
    "sourceArtifactHash",
    "configurationHash",
    "implementationBindingHash",
    "attestationSha256",
    "issuedAt",
    "expiresAt",
    "contentHash",
  ]);
  assertCommonArtifactEnvelope(value, manifest, now);
  const binding = componentBindingForPort(manifest, expectedCommitment.portId);
  if (
    value.domain !== "dark-factory.production-runtime-port-attestation.v1" ||
    value.runtimePortBindingsHash !==
      productionRuntimePortBindingsHash(manifest.runtimePortAttestations) ||
    value.portId !== expectedCommitment.portId ||
    value.role !== binding.role ||
    value.componentBindingHash !== binding.componentBindingHash ||
    value.sourceArtifactHash !== binding.component.sourceArtifactHash ||
    value.configurationHash !== binding.component.configurationHash ||
    typeof value.implementationBindingHash !== "string" ||
    !SHA256.test(value.implementationBindingHash) ||
    value.attestationSha256 !== expectedCommitment.attestationSha256 ||
    value.attestationSha256 !==
      productionRuntimePortAttestationBindingHash({
        portId: expectedCommitment.portId,
        role: binding.role,
        componentBindingHash: binding.componentBindingHash,
        sourceArtifactHash: binding.component.sourceArtifactHash,
        configurationHash: binding.component.configurationHash,
        implementationBindingHash: value.implementationBindingHash,
      })
  ) {
    fail();
  }
}

function assertPublicKey(
  value: unknown,
  purpose: "production-composition-manifest" | "production-composition-evidence-set",
  keyId: string,
  signedAt: string,
): asserts value is
  | TrustedProductionCompositionPublicKey
  | TrustedProductionCompositionEvidencePublicKey {
  exactDataKeys(value, [
    "boundary",
    "algorithm",
    "purpose",
    "keyId",
    "keyVersion",
    "validFrom",
    "validUntil",
    "revoked",
    "publicKey",
  ]);
  const signedAtTime = timestamp(signedAt);
  const validFrom = timestamp(value.validFrom);
  const validUntil = timestamp(value.validUntil);
  if (
    value.boundary !== "trusted-cloud-key-material" ||
    value.algorithm !== "Ed25519" ||
    value.purpose !== purpose ||
    value.keyId !== keyId ||
    typeof value.keyVersion !== "string" ||
    !SAFE_KEY_VERSION.test(value.keyVersion) ||
    value.revoked !== false ||
    validFrom >= validUntil ||
    signedAtTime < validFrom ||
    signedAtTime >= validUntil ||
    !(value.publicKey instanceof KeyObject) ||
    value.publicKey.type !== "public" ||
    value.publicKey.asymmetricKeyType !== "ed25519"
  ) {
    fail();
  }
}

function assertOptionKeys(value: unknown): void {
  if (!isPlainRecord(value)) fail();
  const allowed = [
    "source",
    "reader",
    "keyAuthority",
    "evidenceKeyAuthority",
    "trustedKeyIds",
    "trustedEvidenceKeyIds",
    "maximumArtifactBytes",
    "maximumTotalBytes",
    "now",
  ];
  const required = [
    "source",
    "reader",
    "keyAuthority",
    "evidenceKeyAuthority",
    "trustedKeyIds",
    "trustedEvidenceKeyIds",
  ];
  const keys = Object.keys(value);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.includes(key))) {
    fail();
  }
}

/**
 * Provider-neutral production verifier for the signed composition and its
 * immutable, task-free cloud evidence. It never accepts an implementation,
 * private key, environment value, module name, command, or dynamic loader.
 */
export class ArtifactBackedProductionCompositionAttestationVerifier
  implements TrustedProductionCompositionAttestationVerifier
{
  readonly boundary = "trusted-cloud-attestation-verifier" as const;
  readonly #locate: TrustedProductionCompositionAttestationArtifactSource["locate"];
  readonly #readUtf8: TrustedProductionCompositionAttestationArtifactReader["readUtf8"];
  readonly #resolveKey: TrustedProductionCompositionPublicKeyAuthority["resolve"];
  readonly #resolveEvidenceKey: TrustedProductionCompositionEvidencePublicKeyAuthority["resolve"];
  readonly #trustedKeyIds: ReadonlySet<string>;
  readonly #trustedEvidenceKeyIds: ReadonlySet<string>;
  readonly #maximumArtifactBytes: number;
  readonly #maximumTotalBytes: number;
  readonly #now: () => Date;

  constructor(options: ArtifactBackedProductionCompositionVerifierOptions) {
    try {
      assertOptionKeys(options);
      const trustedKeyIds = new Set(options.trustedKeyIds);
      const trustedEvidenceKeyIds = new Set(options.trustedEvidenceKeyIds);
      const maximumArtifactBytes = options.maximumArtifactBytes ?? DEFAULT_MAXIMUM_ARTIFACT_BYTES;
      const maximumTotalBytes = options.maximumTotalBytes ?? DEFAULT_MAXIMUM_TOTAL_BYTES;
      if (
        options.source.boundary !== "trusted-cloud" ||
        options.reader.boundary !== "trusted-cloud" ||
        options.keyAuthority.boundary !== "trusted-cloud" ||
        options.evidenceKeyAuthority.boundary !== "trusted-cloud" ||
        typeof options.source.locate !== "function" ||
        typeof options.reader.readUtf8 !== "function" ||
        typeof options.keyAuthority.resolve !== "function" ||
        typeof options.evidenceKeyAuthority.resolve !== "function" ||
        !Array.isArray(options.trustedKeyIds) ||
        !Array.isArray(options.trustedEvidenceKeyIds) ||
        trustedKeyIds.size < 1 ||
        trustedKeyIds.size !== options.trustedKeyIds.length ||
        [...trustedKeyIds].some((keyId) => !SAFE_KEY_ID.test(keyId)) ||
        trustedEvidenceKeyIds.size < 1 ||
        trustedEvidenceKeyIds.size !== options.trustedEvidenceKeyIds.length ||
        [...trustedEvidenceKeyIds].some(
          (keyId) => !SAFE_KEY_ID.test(keyId) || trustedKeyIds.has(keyId),
        ) ||
        !Number.isSafeInteger(maximumArtifactBytes) ||
        maximumArtifactBytes < 1_024 ||
        maximumArtifactBytes > MAXIMUM_ARTIFACT_BYTES_CEILING ||
        !Number.isSafeInteger(maximumTotalBytes) ||
        maximumTotalBytes < maximumArtifactBytes ||
        maximumTotalBytes > MAXIMUM_TOTAL_BYTES_CEILING ||
        (options.now !== undefined && typeof options.now !== "function")
      ) {
        fail();
      }
      const sourceNow = options.now ?? (() => new Date());
      this.#locate = options.source.locate.bind(options.source);
      this.#readUtf8 = options.reader.readUtf8.bind(options.reader);
      this.#resolveKey = options.keyAuthority.resolve.bind(options.keyAuthority);
      this.#resolveEvidenceKey = options.evidenceKeyAuthority.resolve.bind(
        options.evidenceKeyAuthority,
      );
      this.#trustedKeyIds = trustedKeyIds;
      this.#trustedEvidenceKeyIds = trustedEvidenceKeyIds;
      this.#maximumArtifactBytes = maximumArtifactBytes;
      this.#maximumTotalBytes = maximumTotalBytes;
      this.#now = (): Date => readNow(sourceNow);
    } catch {
      fail();
    }
  }

  async #readArtifact(
    artifact: TrustedCloudArtifactRef,
  ): Promise<Readonly<Record<string, unknown>>> {
    const raw = await this.#readUtf8(artifact, this.#maximumArtifactBytes);
    const byteLength = Buffer.byteLength(raw, "utf8");
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength !== artifact.byteLength ||
      byteLength > this.#maximumArtifactBytes ||
      sha256(raw) !== artifact.sha256
    ) {
      fail();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      fail();
    }
    if (!isPlainRecord(parsed) || raw !== `${canonicalJson(parsed)}\n`) {
      fail();
    }
    return parsed;
  }

  async verify(
    manifestInput: ProductionOptimizationCompositionManifest,
    runtimePortAttestationsInput: readonly ProductionRuntimePortAttestationCommitment[],
  ): Promise<ProductionCompositionVerification> {
    try {
      const manifestInputJson = canonicalJson(manifestInput);
      const runtimePortAttestationsInputJson = canonicalJson(runtimePortAttestationsInput);
      const manifest = cloneCanonical(manifestInput);
      const runtimePortAttestations = cloneCanonical(runtimePortAttestationsInput);
      const now = this.#now();
      assertProductionOptimizationCompositionManifest(manifest, now);
      productionRuntimePortBindingsHash(runtimePortAttestations);
      if (
        canonicalJson(runtimePortAttestations) !==
          canonicalJson(manifest.runtimePortAttestations) ||
        timestamp(manifest.signature.signedAt) > now.getTime() ||
        !this.#trustedKeyIds.has(manifest.signature.keyId)
      ) {
        fail();
      }

      const keyRequest = Object.freeze({
        purpose: "production-composition-manifest" as const,
        keyId: manifest.signature.keyId,
        signedAt: manifest.signature.signedAt,
      });
      const key = await this.#resolveKey(keyRequest);
      assertPublicKey(
        key,
        "production-composition-manifest",
        manifest.signature.keyId,
        manifest.signature.signedAt,
      );
      const publicKey = capturePublicKey(key.publicKey);
      if (
        publicKey.type !== "public" ||
        publicKey.asymmetricKeyType !== "ed25519" ||
        !verifyEd25519Signature(manifest as unknown as Readonly<Record<string, unknown>>, publicKey)
      ) {
        fail();
      }
      const publicKeySha256 = sha256(publicKey.export({ format: "der", type: "spki" }));

      const query = compositionAttestationQuery(manifest);
      const queryJson = canonicalJson(query);
      const located = await this.#locate(query);
      if (canonicalJson(query) !== queryJson) fail();
      const artifactSetCandidate = cloneCanonical<unknown>(located);
      assertArtifactSet(
        artifactSetCandidate,
        query,
        manifest,
        this.#maximumArtifactBytes,
        this.#maximumTotalBytes,
        this.#trustedEvidenceKeyIds,
        now,
      );
      const artifactSet = deepFreezeJson(
        artifactSetCandidate,
      ) as ProductionCompositionAttestationArtifactSet;
      const evidenceKeyRequest = Object.freeze({
        purpose: "production-composition-evidence-set" as const,
        keyId: artifactSet.signature.keyId,
        signedAt: artifactSet.signature.signedAt,
      });
      const evidenceKey = await this.#resolveEvidenceKey(evidenceKeyRequest);
      assertPublicKey(
        evidenceKey,
        "production-composition-evidence-set",
        artifactSet.signature.keyId,
        artifactSet.signature.signedAt,
      );
      const evidencePublicKey = capturePublicKey(evidenceKey.publicKey);
      if (
        evidencePublicKey.type !== "public" ||
        evidencePublicKey.asymmetricKeyType !== "ed25519" ||
        !verifyEd25519Signature(
          artifactSet as unknown as Readonly<Record<string, unknown>>,
          evidencePublicKey,
        )
      ) {
        fail();
      }
      const evidencePublicKeySha256 = sha256(
        evidencePublicKey.export({ format: "der", type: "spki" }),
      );
      if (evidencePublicKeySha256 === publicKeySha256) fail();

      const componentDocuments = await Promise.all(
        artifactSet.componentAttestations.map((entry) => this.#readArtifact(entry.artifact)),
      );
      const operationalDocument = await this.#readArtifact(
        artifactSet.operationalBindingsAttestation.artifact,
      );
      const runtimePortDocuments = await Promise.all(
        artifactSet.runtimePortAttestations.map((entry) => this.#readArtifact(entry.artifact)),
      );

      for (const [index, role] of PRODUCTION_RUNTIME_ROLES.entries()) {
        assertComponentArtifact(componentDocuments[index], manifest, role, now);
      }
      assertOperationalArtifact(operationalDocument, manifest, now);
      for (const [index, commitment] of runtimePortAttestations.entries()) {
        assertRuntimePortArtifact(runtimePortDocuments[index], manifest, commitment, now);
      }

      if (
        canonicalJson(manifestInput) !== manifestInputJson ||
        canonicalJson(runtimePortAttestationsInput) !== runtimePortAttestationsInputJson
      ) {
        fail();
      }
      const componentBindingsHash = canonicalHash(manifest.components);
      const operationalBindingsHash = canonicalHash(manifest.bindings);
      const runtimePortBindingsHash = productionRuntimePortBindingsHash(runtimePortAttestations);
      const verifierAttestationHash = canonicalHash({
        schemaVersion: 1,
        domain: "dark-factory.production-composition-verified-evidence.v1",
        manifestHash: manifest.manifestHash,
        queryHash: query.queryHash,
        signingKey: {
          keyId: key.keyId,
          keyVersion: key.keyVersion,
          publicKeySha256,
        },
        evidenceSigningKey: {
          keyId: evidenceKey.keyId,
          keyVersion: evidenceKey.keyVersion,
          publicKeySha256: evidencePublicKeySha256,
        },
        artifactSet,
      });
      return {
        schemaVersion: 1,
        domain: "dark-factory.production-composition-verification.v1",
        manifestHash: manifest.manifestHash,
        signingKeyId: manifest.signature.keyId,
        componentBindingsHash,
        operationalBindingsHash,
        runtimePortBindingsHash,
        verifierAttestationHash,
        verified: true,
      };
    } catch (error) {
      if (error instanceof ProductionCompositionAttestationVerificationError) {
        throw error;
      }
      fail();
    }
  }
}
