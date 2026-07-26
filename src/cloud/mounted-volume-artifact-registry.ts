import type {
  EvaluationReleaseArtifactPurpose,
  EvaluationReleaseArtifactQuery,
  TrustedEvaluationReleaseArtifactReader,
  TrustedEvaluationReleaseArtifactSource,
} from "../evaluator/release-bundle-service.js";
import { assertSafeForLocalPersistence } from "../evaluator/retention.js";
import {
  gitRegistrationReceiptHash,
  type TrustedGitRegistrationReceipt,
} from "../harness/git-registration.js";
import type {
  OptimizerReleasedEvidenceMetadata,
  OptimizerReleasedEvidenceQuery,
  TrustedOptimizerReleasedEvidenceMetadataSource,
  TrustedOptimizerResolverArtifactReader,
} from "../optimizer/artifact-backed-resolver.js";
import type {
  BehavioralEvidence,
  CacheAttestation,
  DiagnosticBrief,
  FailureCards,
} from "../schemas/artifacts.js";
import {
  canonicalHash,
  canonicalJson,
  computeContentHash,
  sha256,
} from "../schemas/canonical.js";
import { assertValidDocument } from "../schemas/registry.js";
import type { SignedBehavioralRelease } from "../schemas/trusted.js";
import type { TrustedArtifactBridge } from "./artifact-bridge.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";
import type {
  ProductionCompositionAttestationArtifactSet,
  ProductionCompositionAttestationQuery,
  TrustedProductionCompositionAttestationArtifactReader,
  TrustedProductionCompositionAttestationArtifactSource,
} from "./production-composition-attestation-verifier.js";
import type {
  SignedProductionOptimizeCampaignGenesis,
  SignedProductionOptimizeHiddenCatalogGenesis,
  TrustedProductionOptimizePrerequisiteSource,
} from "./production-optimize-bootstrap-or-reconstruct.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "./production-optimize-composition-owner.js";
import type {
  SignedTrustedCampaignAttestationEvidence,
  TrustedCampaignAttestationArtifactQuery,
  TrustedCampaignAttestationArtifactReader,
  TrustedCampaignAttestationArtifactSource,
} from "./trusted-campaign-attestations.js";
import type { VerifyingTrustedJsonArtifactReader } from "./trusted-json-reader.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_PURPOSE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DEFAULT_MAXIMUM_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_REGISTRY_ENTRIES = 100_000;
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SENSITIVE_DOCUMENT_KEYS = new Set([
  "task",
  "tasks",
  "taskid",
  "taskids",
  "taskname",
  "tasknames",
  "taskinstruction",
  "taskinstructions",
  "taskkey",
  "taskkeys",
  "packagetaskname",
  "panelid",
  "panelids",
  "panelhandle",
  "panelmembership",
  "cellid",
  "cellids",
  "rawartifact",
  "rawartifacts",
  "rawatif",
  "rawgraderoutput",
  "rawharboroutput",
  "graderoutput",
  "graderdata",
  "graderprose",
  "trajectory",
  "trajectories",
  "verifieroutput",
]);

export const TRUSTED_ARTIFACT_REGISTRY_NAMESPACES = Object.freeze([
  "evaluation-release",
  "optimizer-released-evidence-metadata",
  "production-composition-attestation",
  "campaign-attestation",
  "production-optimize-prerequisite",
] as const);

export type TrustedArtifactRegistryNamespace =
  (typeof TRUSTED_ARTIFACT_REGISTRY_NAMESPACES)[number];

export type TrustedArtifactRegistryPurpose =
  | EvaluationReleaseArtifactPurpose
  | "source-only-bootstrap"
  | "proposal-diagnostic"
  | "analysis"
  | "production-composition-attestation-set"
  | "ledger-transition"
  | "decision"
  | "control"
  | "production-optimize-private-pi-registration"
  | "production-optimize-campaign-genesis"
  | "production-optimize-hidden-catalog-genesis";

export interface TrustedArtifactRegistryExactLocator {
  readonly schemaVersion: 1;
  readonly domain:
    "dark-factory.trusted-artifact-registry-exact-locator.v1";
  readonly namespace: TrustedArtifactRegistryNamespace;
  readonly purpose: TrustedArtifactRegistryPurpose;
  readonly lookupHash: string;
}

export interface TrustedArtifactRegistryPublicationReceipt {
  readonly status: "published" | "already-published";
  readonly locatorHash: string;
  readonly documentHash: string;
  readonly artifact: TrustedCloudArtifactRef;
  readonly entryHash: string;
}

export type EvaluationReleaseRegistryDocument =
  | CacheAttestation
  | SignedBehavioralRelease
  | BehavioralEvidence
  | FailureCards
  | DiagnosticBrief;

export interface EvaluationReleaseRegistryPublication {
  readonly query: EvaluationReleaseArtifactQuery;
  readonly document: EvaluationReleaseRegistryDocument;
}

export interface ProductionOptimizePrivatePiRegistrationQuery {
  readonly purpose: "production-optimize-private-pi-registration";
  readonly sourcePrerequisiteHash: string;
}

export interface ProductionOptimizeCampaignGenesisQuery {
  readonly purpose: "production-optimize-campaign-genesis";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly sourcePrerequisiteHash: string;
  readonly genesisPrerequisiteHash: string;
}

export interface ProductionOptimizeHiddenCatalogGenesisQuery {
  readonly purpose: "production-optimize-hidden-catalog-genesis";
  readonly campaignId: string;
  readonly lineageId: string;
  readonly protocolHash: string;
  readonly genesisPrerequisiteHash: string;
  readonly catalogPrerequisiteHash: string;
}

export interface OptimizerSourceOnlyBootstrapMetadataQuery {
  readonly purpose: "source-only-bootstrap";
  readonly metadataHash: string;
}

interface DurableArtifactRegistryEntry {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.trusted-artifact-registry-entry.v1";
  readonly namespace: TrustedArtifactRegistryNamespace;
  readonly purpose: TrustedArtifactRegistryPurpose;
  readonly lookupHash: string;
  readonly locatorHash: string;
  readonly documentHash: string;
  readonly artifact: TrustedCloudArtifactRef;
  readonly publishedAt: string;
  readonly entryHash: string;
}

interface DurableArtifactRegistryState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-task-free-artifact-registry";
  readonly revision: number;
  readonly entries: Readonly<
    Record<string, DurableArtifactRegistryEntry>
  >;
  readonly artifactOwners: Readonly<Record<string, string>>;
}

interface CapturedPublication {
  readonly locator: TrustedArtifactRegistryExactLocator;
  readonly locatorHash: string;
  readonly documentHash: string;
  readonly canonicalDocument: string;
  readonly originalQuery: object;
  readonly originalQueryJson: string;
  readonly originalDocument: object;
  readonly originalDocumentJson: string;
}

interface PersistedPublication extends CapturedPublication {
  readonly artifact: TrustedCloudArtifactRef;
}

export interface MountedVolumeTrustedArtifactRegistryOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly bridge: TrustedArtifactBridge;
  readonly reader: VerifyingTrustedJsonArtifactReader;
  readonly lifecycle?: ProductionOptimizeLifecycleRegistrar;
  readonly maximumArtifactBytes?: number;
}

export class MountedVolumeTrustedArtifactRegistryError extends Error {
  override readonly name =
    "MountedVolumeTrustedArtifactRegistryError";

  constructor() {
    super("Trusted content-addressed artifact registry failed closed.");
  }
}

function fail(): never {
  throw new MountedVolumeTrustedArtifactRegistryError();
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
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
    )
  ) {
    fail();
  }
}

function cloneCanonical<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    fail();
  }
}

function unchanged(value: object, expected: string): boolean {
  try {
    return canonicalJson(value) === expected;
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail();
  }
}

function assertTaskFreeDocument(value: unknown): void {
  const pending = [value];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > 1_000_000) fail();
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail();
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isPlainRecord(current)) fail();
    for (const [key, item] of Object.entries(current)) {
      const normalized = key.replace(/[-_]/gu, "").toLowerCase();
      if (
        DANGEROUS_KEYS.has(key) ||
        key.includes("\u0000") ||
        SENSITIVE_DOCUMENT_KEYS.has(normalized)
      ) {
        fail();
      }
      pending.push(item);
    }
  }
}

function allowedPurpose(
  namespace: TrustedArtifactRegistryNamespace,
  purpose: TrustedArtifactRegistryPurpose,
): boolean {
  switch (namespace) {
    case "evaluation-release":
      return new Set<string>([
        "cache-attestation",
        "behavioral-release",
        "behavioral-evidence",
        "failure-cards",
        "diagnostic-brief",
      ]).has(purpose);
    case "optimizer-released-evidence-metadata":
      return new Set<string>([
        "source-only-bootstrap",
        "proposal-diagnostic",
        "analysis",
      ]).has(purpose);
    case "production-composition-attestation":
      return purpose === "production-composition-attestation-set";
    case "campaign-attestation":
      return new Set<string>([
        "ledger-transition",
        "decision",
        "control",
      ]).has(purpose);
    case "production-optimize-prerequisite":
      return new Set<string>([
        "production-optimize-private-pi-registration",
        "production-optimize-campaign-genesis",
        "production-optimize-hidden-catalog-genesis",
      ]).has(purpose);
  }
}

function assertLocator(
  value: unknown,
): asserts value is TrustedArtifactRegistryExactLocator {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "namespace",
    "purpose",
    "lookupHash",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.trusted-artifact-registry-exact-locator.v1" ||
    !TRUSTED_ARTIFACT_REGISTRY_NAMESPACES.includes(
      value.namespace as TrustedArtifactRegistryNamespace,
    ) ||
    typeof value.purpose !== "string" ||
    !SAFE_PURPOSE.test(value.purpose) ||
    !allowedPurpose(
      value.namespace as TrustedArtifactRegistryNamespace,
      value.purpose as TrustedArtifactRegistryPurpose,
    ) ||
    typeof value.lookupHash !== "string" ||
    !SHA256.test(value.lookupHash)
  ) {
    fail();
  }
}

export function trustedArtifactRegistryLocatorHash(
  locator: TrustedArtifactRegistryExactLocator,
): string {
  assertLocator(locator);
  return canonicalHash({
    domain: "dark-factory.trusted-artifact-registry-binding.v1",
    namespace: locator.namespace,
    purpose: locator.purpose,
    lookupHash: locator.lookupHash,
  });
}

function locator(
  namespace: TrustedArtifactRegistryNamespace,
  purpose: TrustedArtifactRegistryPurpose,
  lookupHash: string,
): TrustedArtifactRegistryExactLocator {
  const value: TrustedArtifactRegistryExactLocator = {
    schemaVersion: 1,
    domain:
      "dark-factory.trusted-artifact-registry-exact-locator.v1",
    namespace,
    purpose,
    lookupHash,
  };
  assertLocator(value);
  return value;
}

function assertArtifact(
  value: unknown,
  maximumBytes: number,
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
    (value.byteLength as number) > maximumBytes
  ) {
    fail();
  }
}

function artifactUri(
  value: TrustedArtifactRegistryExactLocator,
  byteHash: string,
): `trusted://${string}` {
  if (!SHA256.test(byteHash)) fail();
  return `trusted://artifact-registry/v1/${value.namespace}/${value.purpose}/${byteHash}`;
}

function artifactOwnerKey(artifact: TrustedCloudArtifactRef): string {
  return canonicalHash({
    domain: "dark-factory.trusted-artifact-registry-object.v1",
    artifact,
  });
}

function entryHash(
  entry: Omit<DurableArtifactRegistryEntry, "entryHash">,
): string {
  return canonicalHash(entry);
}

function assertEntry(
  value: unknown,
  key: string,
  maximumBytes: number,
): asserts value is DurableArtifactRegistryEntry {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "namespace",
    "purpose",
    "lookupHash",
    "locatorHash",
    "documentHash",
    "artifact",
    "publishedAt",
    "entryHash",
  ]);
  const entry = value as unknown as DurableArtifactRegistryEntry;
  const expectedLocator = locator(
    entry.namespace,
    entry.purpose,
    entry.lookupHash,
  );
  assertArtifact(entry.artifact, maximumBytes);
  canonicalTimestamp(entry.publishedAt);
  const unsigned = {
    schemaVersion: entry.schemaVersion,
    domain: entry.domain,
    namespace: entry.namespace,
    purpose: entry.purpose,
    lookupHash: entry.lookupHash,
    locatorHash: entry.locatorHash,
    documentHash: entry.documentHash,
    artifact: entry.artifact,
    publishedAt: entry.publishedAt,
  } as const;
  if (
    entry.schemaVersion !== 1 ||
    entry.domain !==
      "dark-factory.trusted-artifact-registry-entry.v1" ||
    key !== entry.locatorHash ||
    entry.locatorHash !==
      trustedArtifactRegistryLocatorHash(expectedLocator) ||
    !SHA256.test(entry.documentHash) ||
    entry.artifact.uri !==
      artifactUri(expectedLocator, entry.artifact.sha256) ||
    !SHA256.test(entry.entryHash) ||
    entry.entryHash !== entryHash(unsigned)
  ) {
    fail();
  }
}

function assertState(
  value: unknown,
  maximumBytes: number,
): asserts value is DurableArtifactRegistryState {
  exactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "revision",
    "entries",
    "artifactOwners",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !== "trusted-task-free-artifact-registry" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.entries) ||
    !isPlainRecord(value.artifactOwners)
  ) {
    fail();
  }
  const entries = value.entries as Readonly<
    Record<string, DurableArtifactRegistryEntry>
  >;
  const owners = value.artifactOwners as Readonly<Record<string, unknown>>;
  const entryKeys = Object.keys(entries);
  if (
    entryKeys.length > MAXIMUM_REGISTRY_ENTRIES ||
    Object.keys(owners).length !== entryKeys.length
  ) {
    fail();
  }
  const observedOwners = new Set<string>();
  for (const key of entryKeys) {
    if (DANGEROUS_KEYS.has(key) || !SHA256.test(key)) fail();
    const entry = entries[key];
    assertEntry(entry, key, maximumBytes);
    const ownerKey = artifactOwnerKey(entry.artifact);
    if (
      observedOwners.has(ownerKey) ||
      owners[ownerKey] !== entry.locatorHash
    ) {
      fail();
    }
    observedOwners.add(ownerKey);
  }
  for (const [ownerKey, locatorHash] of Object.entries(owners)) {
    if (
      DANGEROUS_KEYS.has(ownerKey) ||
      !SHA256.test(ownerKey) ||
      typeof locatorHash !== "string" ||
      !Object.hasOwn(entries, locatorHash) ||
      artifactOwnerKey(entries[locatorHash]!.artifact) !== ownerKey
    ) {
      fail();
    }
  }
}

function nowTimestamp(now: (() => Date) | undefined): string {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail();
  return value.toISOString();
}

function exactQueryHash(
  query: Readonly<Record<string, unknown>>,
): string {
  if (typeof query.queryHash !== "string" || !SHA256.test(query.queryHash)) {
    fail();
  }
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key !== "queryHash") unsigned[key] = value;
  }
  if (query.queryHash !== canonicalHash(unsigned)) fail();
  return query.queryHash;
}

function assertEvaluationQuery(
  value: unknown,
): asserts value is EvaluationReleaseArtifactQuery {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "purpose",
    "contentHash",
    "queryHash",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.evaluation-release-artifact-query.v1" ||
    !allowedPurpose(
      "evaluation-release",
      value.purpose as TrustedArtifactRegistryPurpose,
    ) ||
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash)
  ) {
    fail();
  }
  exactQueryHash(value);
}

function evaluationSchema(
  purpose: EvaluationReleaseArtifactPurpose,
):
  | "cacheAttestation"
  | "signedBehavioralRelease"
  | "behavioralEvidence"
  | "failureCards"
  | "diagnosticBrief" {
  switch (purpose) {
    case "cache-attestation":
      return "cacheAttestation";
    case "behavioral-release":
      return "signedBehavioralRelease";
    case "behavioral-evidence":
      return "behavioralEvidence";
    case "failure-cards":
      return "failureCards";
    case "diagnostic-brief":
      return "diagnosticBrief";
  }
}

function captureEvaluationPublication(
  publication: EvaluationReleaseRegistryPublication,
): CapturedPublication {
  exactKeys(publication, ["query", "document"]);
  const originalQuery = publication.query;
  const originalDocument = publication.document;
  const originalQueryJson = canonicalJson(originalQuery);
  const originalDocumentJson = canonicalJson(originalDocument);
  const query = cloneCanonical(originalQuery);
  const document = cloneCanonical(originalDocument);
  assertEvaluationQuery(query);
  assertValidDocument(evaluationSchema(query.purpose), document);
  assertSafeForLocalPersistence(document);
  if (document.contentHash !== query.contentHash) fail();
  const exactLocator = locator(
    "evaluation-release",
    query.purpose,
    query.queryHash,
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: query.contentHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery,
    originalQueryJson,
    originalDocument,
    originalDocumentJson,
  };
}

function assertBehavioralReleaseBatch(
  captured: readonly CapturedPublication[],
): void {
  const purposes = new Set(captured.map((item) => item.locator.purpose));
  if (purposes.size !== captured.length) fail();
  const cacheOnly =
    purposes.size === 1 && purposes.has("cache-attestation");
  const behavioral = [
    "behavioral-release",
    "behavioral-evidence",
    "failure-cards",
    "diagnostic-brief",
  ] as const;
  const completeBehavioral = behavioral.every((purpose) =>
    purposes.has(purpose),
  );
  if (
    !cacheOnly &&
    !(purposes.size === 4 && completeBehavioral) &&
    !(
      purposes.size === 5 &&
      completeBehavioral &&
      purposes.has("cache-attestation")
    )
  ) {
    fail();
  }
  if (!completeBehavioral) return;
  const byPurpose = new Map(
    captured.map((item) => [item.locator.purpose, item] as const),
  );
  const rawRelease = byPurpose.get("behavioral-release");
  if (rawRelease === undefined) fail();
  const release = JSON.parse(
    rawRelease.canonicalDocument,
  ) as SignedBehavioralRelease;
  if (
    release.aggregateArtifactHashes.behavioralEvidence !==
      byPurpose.get("behavioral-evidence")?.documentHash ||
    release.aggregateArtifactHashes.failureCards !==
      byPurpose.get("failure-cards")?.documentHash ||
    release.aggregateArtifactHashes.diagnosticBrief !==
      byPurpose.get("diagnostic-brief")?.documentHash
  ) {
    fail();
  }
}

function assertOptimizerQuery(
  value: unknown,
): asserts value is OptimizerReleasedEvidenceQuery {
  if (!isPlainRecord(value) || typeof value.purpose !== "string") fail();
  if (value.purpose === "proposal-diagnostic") {
    exactKeys(value, [
      "schemaVersion",
      "domain",
      "purpose",
      "campaignId",
      "experimentId",
      "diagnosticHash",
      "releaseId",
      "actionable",
      "queryHash",
    ]);
    if (
      value.domain !==
        "dark-factory.optimizer-proposal-evidence-query.v1"
    ) {
      fail();
    }
  } else if (value.purpose === "analysis") {
    exactKeys(value, [
      "schemaVersion",
      "domain",
      "purpose",
      "campaignId",
      "experimentId",
      "hypothesisHash",
      "hypothesisDocumentHash",
      "candidateCommit",
      "candidatePatchHash",
      "candidateDocumentHash",
      "repairAttestationHash",
      "validationAttestationHash",
      "releasedEvidenceHash",
      "queryHash",
    ]);
    if (
      value.domain !==
        "dark-factory.optimizer-analysis-evidence-query.v1"
    ) {
      fail();
    }
  } else {
    fail();
  }
  if (
    value.schemaVersion !== 1 ||
    !allowedPurpose(
      "optimizer-released-evidence-metadata",
      value.purpose as TrustedArtifactRegistryPurpose,
    )
  ) {
    fail();
  }
  exactQueryHash(value);
}

function optimizerMetadataHash(
  document: OptimizerReleasedEvidenceMetadata,
): string {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "metadataHash" && key !== "signature") {
      unsigned[key] = value;
    }
  }
  return canonicalHash(unsigned);
}

function captureOptimizerPublication(
  queryInput: OptimizerReleasedEvidenceQuery,
  documentInput: OptimizerReleasedEvidenceMetadata,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertOptimizerQuery(query);
  if (
    !isPlainRecord(document) ||
    document.purpose !== query.purpose ||
    document.containsTaskIdentifiers !== false ||
    document.containsPanelIdentifiers !== false ||
    document.containsCellIdentifiers !== false ||
    document.containsRawEvidence !== false ||
    document.containsGraderIdentifiers !== false ||
    typeof document.metadataHash !== "string" ||
    !SHA256.test(document.metadataHash) ||
    document.metadataHash !==
      optimizerMetadataHash(
        document as unknown as OptimizerReleasedEvidenceMetadata,
      )
  ) {
    fail();
  }
  for (const [key, value] of Object.entries(query)) {
    if (
      !["schemaVersion", "domain", "purpose", "queryHash"].includes(key) &&
      document[key] !== value
    ) {
      fail();
    }
  }
  assertTaskFreeDocument(document);
  const exactLocator = locator(
    "optimizer-released-evidence-metadata",
    query.purpose,
    query.queryHash,
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: document.metadataHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function captureOptimizerSourceOnlyPublication(
  queryInput: OptimizerSourceOnlyBootstrapMetadataQuery,
  documentInput: OptimizerReleasedEvidenceMetadata,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  exactKeys(query, ["purpose", "metadataHash"]);
  if (
    query.purpose !== "source-only-bootstrap" ||
    typeof query.metadataHash !== "string" ||
    !SHA256.test(query.metadataHash) ||
    !isPlainRecord(document) ||
    document.purpose !== "source-only-bootstrap" ||
    document.containsTaskIdentifiers !== false ||
    document.containsPanelIdentifiers !== false ||
    document.containsCellIdentifiers !== false ||
    document.containsRawEvidence !== false ||
    document.containsGraderIdentifiers !== false ||
    document.metadataHash !== query.metadataHash ||
    document.metadataHash !==
      optimizerMetadataHash(
        document as unknown as OptimizerReleasedEvidenceMetadata,
      )
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  const exactLocator = locator(
    "optimizer-released-evidence-metadata",
    "source-only-bootstrap",
    canonicalHash({
      domain:
        "dark-factory.optimizer-source-only-bootstrap-registry-query.v1",
      query,
    }),
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: query.metadataHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function assertCompositionQuery(
  value: unknown,
): asserts value is ProductionCompositionAttestationQuery {
  exactKeys(value, [
    "schemaVersion",
    "domain",
    "campaignId",
    "manifestId",
    "manifestHash",
    "componentBindingsHash",
    "operationalBindingsHash",
    "runtimePortBindingsHash",
    "queryHash",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.domain !==
      "dark-factory.production-composition-attestation-query.v1"
  ) {
    fail();
  }
  exactQueryHash(value);
}

function captureCompositionPublication(
  queryInput: ProductionCompositionAttestationQuery,
  documentInput: ProductionCompositionAttestationArtifactSet,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertCompositionQuery(query);
  if (
    !isPlainRecord(document) ||
    document.schemaVersion !== 1 ||
    document.domain !==
      "dark-factory.production-composition-attestation-artifact-set.v1" ||
    document.sensitivity !== "release-safe-control" ||
    document.deployment !== "trusted-cloud" ||
    document.campaignId !== query.campaignId ||
    document.manifestId !== query.manifestId ||
    document.manifestHash !== query.manifestHash ||
    document.queryHash !== query.queryHash ||
    typeof document.contentHash !== "string" ||
    !SHA256.test(document.contentHash) ||
    document.contentHash !== computeContentHash(document)
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  const exactLocator = locator(
    "production-composition-attestation",
    "production-composition-attestation-set",
    query.queryHash,
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: document.contentHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function assertCampaignQuery(
  value: unknown,
): asserts value is TrustedCampaignAttestationArtifactQuery {
  exactKeys(value, [
    "evidenceKind",
    "campaignId",
    "protocolHash",
    "lookupHash",
    "payloadHash",
  ]);
  if (
    !allowedPurpose(
      "campaign-attestation",
      value.evidenceKind as TrustedArtifactRegistryPurpose,
    ) ||
    typeof value.lookupHash !== "string" ||
    !SHA256.test(value.lookupHash) ||
    typeof value.payloadHash !== "string" ||
    !SHA256.test(value.payloadHash)
  ) {
    fail();
  }
}

function campaignQueryHash(
  query: TrustedCampaignAttestationArtifactQuery,
): string {
  assertCampaignQuery(query);
  return canonicalHash({
    domain: "dark-factory.campaign-attestation-registry-query.v1",
    query,
  });
}

function captureCampaignPublication(
  queryInput: TrustedCampaignAttestationArtifactQuery,
  documentInput: SignedTrustedCampaignAttestationEvidence,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertCampaignQuery(query);
  if (
    !isPlainRecord(document) ||
    document.schemaVersion !== 1 ||
    document.domain !==
      "dark-factory.campaign-attestation-evidence.v1" ||
    document.sensitivity !== "release-safe-control" ||
    document.evidenceKind !== query.evidenceKind ||
    document.campaignId !== query.campaignId ||
    document.protocolHash !== query.protocolHash ||
    document.lookupHash !== query.lookupHash ||
    document.payloadHash !== query.payloadHash ||
    canonicalHash(document.payload) !== query.payloadHash ||
    typeof document.contentHash !== "string" ||
    !SHA256.test(document.contentHash) ||
    document.contentHash !== computeContentHash(document)
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  assertSafeForLocalPersistence(document);
  const exactLocator = locator(
    "campaign-attestation",
    query.evidenceKind,
    campaignQueryHash(query),
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: document.contentHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function assertPrivatePiQuery(
  value: unknown,
): asserts value is ProductionOptimizePrivatePiRegistrationQuery {
  exactKeys(value, ["purpose", "sourcePrerequisiteHash"]);
  if (
    value.purpose !== "production-optimize-private-pi-registration" ||
    typeof value.sourcePrerequisiteHash !== "string" ||
    !SHA256.test(value.sourcePrerequisiteHash)
  ) {
    fail();
  }
}

function assertCampaignGenesisQuery(
  value: unknown,
): asserts value is ProductionOptimizeCampaignGenesisQuery {
  exactKeys(value, [
    "purpose",
    "campaignId",
    "lineageId",
    "protocolHash",
    "sourcePrerequisiteHash",
    "genesisPrerequisiteHash",
  ]);
  if (
    value.purpose !== "production-optimize-campaign-genesis" ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.sourcePrerequisiteHash !== "string" ||
    !SHA256.test(value.sourcePrerequisiteHash) ||
    typeof value.genesisPrerequisiteHash !== "string" ||
    !SHA256.test(value.genesisPrerequisiteHash)
  ) {
    fail();
  }
}

function assertCatalogGenesisQuery(
  value: unknown,
): asserts value is ProductionOptimizeHiddenCatalogGenesisQuery {
  exactKeys(value, [
    "purpose",
    "campaignId",
    "lineageId",
    "protocolHash",
    "genesisPrerequisiteHash",
    "catalogPrerequisiteHash",
  ]);
  if (
    value.purpose !==
      "production-optimize-hidden-catalog-genesis" ||
    typeof value.protocolHash !== "string" ||
    !SHA256.test(value.protocolHash) ||
    typeof value.genesisPrerequisiteHash !== "string" ||
    !SHA256.test(value.genesisPrerequisiteHash) ||
    typeof value.catalogPrerequisiteHash !== "string" ||
    !SHA256.test(value.catalogPrerequisiteHash)
  ) {
    fail();
  }
}

function prerequisiteQueryHash(
  query:
    | ProductionOptimizePrivatePiRegistrationQuery
    | ProductionOptimizeCampaignGenesisQuery
    | ProductionOptimizeHiddenCatalogGenesisQuery,
): string {
  return canonicalHash({
    domain: "dark-factory.production-optimize-prerequisite-registry-query.v1",
    query,
  });
}

function capturePrivatePiPublication(
  queryInput: ProductionOptimizePrivatePiRegistrationQuery,
  documentInput: TrustedGitRegistrationReceipt,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertPrivatePiQuery(query);
  if (
    !isPlainRecord(document) ||
    document.sensitivity !== "trusted-git-registration" ||
    document.schemaVersion !== 1 ||
    gitRegistrationReceiptHash(
      document as unknown as TrustedGitRegistrationReceipt,
    ) !== query.sourcePrerequisiteHash
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  assertSafeForLocalPersistence(document);
  const exactLocator = locator(
    "production-optimize-prerequisite",
    query.purpose,
    prerequisiteQueryHash(query),
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: query.sourcePrerequisiteHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function captureCampaignGenesisPublication(
  queryInput: ProductionOptimizeCampaignGenesisQuery,
  documentInput: SignedProductionOptimizeCampaignGenesis,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertCampaignGenesisQuery(query);
  if (
    !isPlainRecord(document) ||
    document.schemaVersion !== 1 ||
    document.domain !==
      "dark-factory.production-optimize-campaign-genesis.v1" ||
    document.sensitivity !== "release-safe-control" ||
    document.deployment !== "trusted-cloud" ||
    document.campaignId !== query.campaignId ||
    document.lineageId !== query.lineageId ||
    document.protocolHash !== query.protocolHash ||
    document.sourcePrerequisiteHash !==
      query.sourcePrerequisiteHash ||
    document.contentHash !== query.genesisPrerequisiteHash ||
    document.contentHash !== computeContentHash(document)
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  assertSafeForLocalPersistence(document);
  const exactLocator = locator(
    "production-optimize-prerequisite",
    query.purpose,
    prerequisiteQueryHash(query),
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: query.genesisPrerequisiteHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

function captureCatalogGenesisPublication(
  queryInput: ProductionOptimizeHiddenCatalogGenesisQuery,
  documentInput: SignedProductionOptimizeHiddenCatalogGenesis,
): CapturedPublication {
  const originalQueryJson = canonicalJson(queryInput);
  const originalDocumentJson = canonicalJson(documentInput);
  const query = cloneCanonical(queryInput);
  const document = cloneCanonical(documentInput);
  assertCatalogGenesisQuery(query);
  if (
    !isPlainRecord(document) ||
    document.schemaVersion !== 1 ||
    document.domain !==
      "dark-factory.production-optimize-hidden-catalog-genesis.v1" ||
    document.sensitivity !==
      "trusted-control-task-free-commitment" ||
    document.deployment !== "trusted-cloud" ||
    document.campaignId !== query.campaignId ||
    document.lineageId !== query.lineageId ||
    document.protocolHash !== query.protocolHash ||
    document.campaignGenesisPrerequisiteHash !==
      query.genesisPrerequisiteHash ||
    document.contentHash !== query.catalogPrerequisiteHash ||
    document.contentHash !== computeContentHash(document) ||
    !isPlainRecord(document.informationBoundary) ||
    document.informationBoundary.containsTaskNames !== false ||
    document.informationBoundary.containsTaskIds !== false ||
    document.informationBoundary.containsPanelIds !== false ||
    document.informationBoundary.containsGraderEvidence !== false
  ) {
    fail();
  }
  assertTaskFreeDocument(document);
  assertSafeForLocalPersistence(document);
  const exactLocator = locator(
    "production-optimize-prerequisite",
    query.purpose,
    prerequisiteQueryHash(query),
  );
  return {
    locator: exactLocator,
    locatorHash: trustedArtifactRegistryLocatorHash(exactLocator),
    documentHash: query.catalogPrerequisiteHash,
    canonicalDocument: `${canonicalJson(document)}\n`,
    originalQuery: queryInput,
    originalQueryJson,
    originalDocument: documentInput,
    originalDocumentJson,
  };
}

/**
 * Durable exact-match index over immutable JSON objects on a provider-mounted
 * trusted volume. Object bytes become visible only when their complete index
 * batch commits; abandoned object writes are unreachable orphans.
 */
export class MountedVolumeTrustedArtifactRegistry {
  readonly boundary =
    "trusted-cloud-content-addressed-artifact-registry" as const;
  readonly lifecycleId: string;
  readonly lifecycleResource: TrustedProductionOptimizeCloseable;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableArtifactRegistryState>;
  readonly #persistVerified: TrustedArtifactBridge["persistVerified"];
  readonly #readUtf8: VerifyingTrustedJsonArtifactReader["readUtf8"];
  readonly #maximumArtifactBytes: number;
  readonly #now: () => Date;

  constructor(options: MountedVolumeTrustedArtifactRegistryOptions) {
    exactKeys(options, [
      "durableState",
      "bridge",
      "reader",
      ...(options.lifecycle === undefined ? [] : ["lifecycle"]),
      ...(options.maximumArtifactBytes === undefined
        ? []
        : ["maximumArtifactBytes"]),
    ]);
    const maximumArtifactBytes =
      options.maximumArtifactBytes ??
      DEFAULT_MAXIMUM_ARTIFACT_BYTES;
    if (
      typeof options.bridge?.assertTrustedRuntime !== "function" ||
      typeof options.bridge?.persistVerified !== "function" ||
      options.reader?.boundary !== "trusted-cloud" ||
      typeof options.reader?.readUtf8 !== "function" ||
      (options.lifecycle !== undefined &&
        typeof options.lifecycle.register !== "function") ||
      !Number.isSafeInteger(maximumArtifactBytes) ||
      maximumArtifactBytes < 4_096 ||
      maximumArtifactBytes > MAXIMUM_ARTIFACT_BYTES
    ) {
      fail();
    }
    options.bridge.assertTrustedRuntime();
    this.#persistVerified =
      options.bridge.persistVerified.bind(options.bridge);
    this.#readUtf8 = options.reader.readUtf8.bind(options.reader);
    this.#maximumArtifactBytes = maximumArtifactBytes;
    this.#now = options.durableState.now ?? (() => new Date());
    this.lifecycleId = `artifact-registry-${canonicalHash({
      domain: "dark-factory.artifact-registry-lifecycle.v1",
      storeId: options.durableState.storeId,
    }).slice(0, 24)}`;
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableArtifactRegistryState>(
        options.durableState,
        "trusted-artifact-registry-v1",
        {
          domain: "dark-factory.trusted-artifact-registry-state.v1",
          initialState: () => ({
            schemaVersion: 1,
            sensitivity: "trusted-task-free-artifact-registry",
            revision: 0,
            entries: {},
            artifactOwners: {},
          }),
          assertState: (
            value: unknown,
          ): asserts value is DurableArtifactRegistryState => {
            assertState(value, maximumArtifactBytes);
          },
          revision: (state) => state.revision,
        },
      );
    this.lifecycleResource = Object.freeze({
      boundary:
        "trusted-cloud-production-optimize-lifecycle" as const,
      lifecycleId: this.lifecycleId,
      close: (): Promise<void> => this.close(),
    });
    options.lifecycle?.register(this.lifecycleResource);
  }

  async #publishCaptured(
    captured: readonly CapturedPublication[],
  ): Promise<readonly TrustedArtifactRegistryPublicationReceipt[]> {
    if (captured.length < 1 || captured.length > 16) fail();
    const locatorHashes = new Set<string>();
    const plannedArtifactOwners = new Set<string>();
    const persisted: PersistedPublication[] = [];
    for (const item of captured) {
      if (locatorHashes.has(item.locatorHash)) fail();
      locatorHashes.add(item.locatorHash);
      const bytes = Buffer.from(item.canonicalDocument, "utf8");
      if (
        bytes.byteLength <= 0 ||
        bytes.byteLength > this.#maximumArtifactBytes
      ) {
        fail();
      }
      const byteHash = sha256(bytes);
      const expectedArtifact: TrustedCloudArtifactRef = {
        uri: artifactUri(item.locator, byteHash),
        sha256: byteHash,
        mediaType: "application/json",
        byteLength: bytes.byteLength,
      };
      const artifact = await this.#persistVerified({
        uri: expectedArtifact.uri,
        mediaType: expectedArtifact.mediaType,
        chunks: (async function* () {
          yield bytes;
        })(),
      });
      assertArtifact(artifact, this.#maximumArtifactBytes);
      if (canonicalJson(artifact) !== canonicalJson(expectedArtifact)) fail();
      const owner = artifactOwnerKey(artifact);
      if (plannedArtifactOwners.has(owner)) fail();
      plannedArtifactOwners.add(owner);
      persisted.push({ ...item, artifact: cloneCanonical(artifact) });
    }
    if (
      persisted.some(
        (item) =>
          !unchanged(item.originalQuery, item.originalQueryJson) ||
          !unchanged(item.originalDocument, item.originalDocumentJson),
      )
    ) {
      fail();
    }
    const publishedAt = nowTimestamp(this.#now);
    return this.#store.transact((state) => {
      const existing = persisted.map(
        (item) => state.entries[item.locatorHash],
      );
      if (existing.every((entry) => entry !== undefined)) {
        const receipts = persisted.map((item, index) => {
          const entry = existing[index];
          if (
            entry === undefined ||
            entry.documentHash !== item.documentHash ||
            canonicalJson(entry.artifact) !== canonicalJson(item.artifact)
          ) {
            fail();
          }
          return {
            status: "already-published" as const,
            locatorHash: entry.locatorHash,
            documentHash: entry.documentHash,
            artifact: cloneCanonical(entry.artifact),
            entryHash: entry.entryHash,
          };
        });
        return { next: state, result: receipts };
      }
      if (existing.some((entry) => entry !== undefined)) fail();
      if (
        Object.keys(state.entries).length + persisted.length >
        MAXIMUM_REGISTRY_ENTRIES
      ) {
        fail();
      }
      const entries: Record<string, DurableArtifactRegistryEntry> = {
        ...state.entries,
      };
      const artifactOwners: Record<string, string> = {
        ...state.artifactOwners,
      };
      const receipts: TrustedArtifactRegistryPublicationReceipt[] = [];
      for (const item of persisted) {
        const owner = artifactOwnerKey(item.artifact);
        if (Object.hasOwn(artifactOwners, owner)) fail();
        const unsigned = {
          schemaVersion: 1 as const,
          domain:
            "dark-factory.trusted-artifact-registry-entry.v1" as const,
          namespace: item.locator.namespace,
          purpose: item.locator.purpose,
          lookupHash: item.locator.lookupHash,
          locatorHash: item.locatorHash,
          documentHash: item.documentHash,
          artifact: cloneCanonical(item.artifact),
          publishedAt,
        };
        const entry: DurableArtifactRegistryEntry = {
          ...unsigned,
          entryHash: entryHash(unsigned),
        };
        assertEntry(
          entry,
          item.locatorHash,
          this.#maximumArtifactBytes,
        );
        entries[item.locatorHash] = entry;
        artifactOwners[owner] = item.locatorHash;
        receipts.push({
          status: "published",
          locatorHash: item.locatorHash,
          documentHash: item.documentHash,
          artifact: cloneCanonical(item.artifact),
          entryHash: entry.entryHash,
        });
      }
      return {
        next: {
          ...state,
          revision: state.revision + 1,
          entries,
          artifactOwners,
        },
        result: receipts,
      };
    });
  }

  async publishEvaluationReleaseArtifacts(
    publications: readonly EvaluationReleaseRegistryPublication[],
  ): Promise<readonly TrustedArtifactRegistryPublicationReceipt[]> {
    try {
      if (!Array.isArray(publications)) fail();
      const captured = publications.map(captureEvaluationPublication);
      assertBehavioralReleaseBatch(captured);
      return await this.#publishCaptured(captured);
    } catch {
      fail();
    }
  }

  async publishOptimizerReleasedEvidenceMetadata(
    query: OptimizerReleasedEvidenceQuery,
    document: OptimizerReleasedEvidenceMetadata,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureOptimizerPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishOptimizerSourceOnlyBootstrapMetadata(
    query: OptimizerSourceOnlyBootstrapMetadataQuery,
    document: OptimizerReleasedEvidenceMetadata,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureOptimizerSourceOnlyPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishProductionCompositionAttestationSet(
    query: ProductionCompositionAttestationQuery,
    document: ProductionCompositionAttestationArtifactSet,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureCompositionPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishCampaignAttestation(
    query: TrustedCampaignAttestationArtifactQuery,
    document: SignedTrustedCampaignAttestationEvidence,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureCampaignPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishPrivatePiRegistration(
    query: ProductionOptimizePrivatePiRegistrationQuery,
    document: TrustedGitRegistrationReceipt,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        capturePrivatePiPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishCampaignGenesis(
    query: ProductionOptimizeCampaignGenesisQuery,
    document: SignedProductionOptimizeCampaignGenesis,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureCampaignGenesisPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async publishHiddenCatalogGenesis(
    query: ProductionOptimizeHiddenCatalogGenesisQuery,
    document: SignedProductionOptimizeHiddenCatalogGenesis,
  ): Promise<TrustedArtifactRegistryPublicationReceipt> {
    try {
      const [receipt] = await this.#publishCaptured([
        captureCatalogGenesisPublication(query, document),
      ]);
      return receipt ?? fail();
    } catch {
      fail();
    }
  }

  async locateExact(
    input: TrustedArtifactRegistryExactLocator,
  ): Promise<TrustedCloudArtifactRef | undefined> {
    try {
      const inputJson = canonicalJson(input);
      const exactLocator = cloneCanonical(input);
      assertLocator(exactLocator);
      const hash = trustedArtifactRegistryLocatorHash(exactLocator);
      const result = await this.#store.transact((state) => ({
        next: state,
        result: state.entries[hash]?.artifact,
      }));
      if (!unchanged(input, inputJson)) fail();
      return result === undefined
        ? undefined
        : cloneCanonical(result);
    } catch {
      fail();
    }
  }

  async readExact(
    input: TrustedArtifactRegistryExactLocator,
    maximumBytes: number,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    try {
      if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes <= 0 ||
        maximumBytes > this.#maximumArtifactBytes
      ) {
        fail();
      }
      const artifact = await this.locateExact(input);
      if (artifact === undefined) return undefined;
      const artifactSnapshot = cloneCanonical(artifact);
      const artifactJson = canonicalJson(artifactSnapshot);
      const raw = await this.#readUtf8(artifactSnapshot, maximumBytes);
      if (
        canonicalJson(artifactSnapshot) !== artifactJson ||
        typeof raw !== "string" ||
        Buffer.byteLength(raw, "utf8") !== artifact.byteLength ||
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
      if (
        !isPlainRecord(parsed) ||
        raw !== `${canonicalJson(parsed)}\n`
      ) {
        fail();
      }
      return cloneCanonical(parsed);
    } catch {
      fail();
    }
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

abstract class RegistrySource {
  protected readonly locateRegistryExact:
    MountedVolumeTrustedArtifactRegistry["locateExact"];
  protected readonly readRegistryExact:
    MountedVolumeTrustedArtifactRegistry["readExact"];

  constructor(registry: MountedVolumeTrustedArtifactRegistry) {
    if (
      registry.boundary !==
      "trusted-cloud-content-addressed-artifact-registry"
    ) {
      fail();
    }
    this.locateRegistryExact = registry.locateExact.bind(registry);
    this.readRegistryExact = registry.readExact.bind(registry);
  }
}

export class MountedVolumeEvaluationReleaseArtifactSource
  extends RegistrySource
  implements TrustedEvaluationReleaseArtifactSource
{
  readonly boundary = "trusted-cloud" as const;

  async locate(
    queryInput: EvaluationReleaseArtifactQuery,
  ): Promise<TrustedCloudArtifactRef | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertEvaluationQuery(query);
      const result = await this.locateRegistryExact(
        locator("evaluation-release", query.purpose, query.queryHash),
      );
      if (!unchanged(queryInput, before)) fail();
      return result;
    } catch {
      fail();
    }
  }
}

export class MountedVolumeOptimizerReleasedEvidenceMetadataSource
  extends RegistrySource
  implements TrustedOptimizerReleasedEvidenceMetadataSource
{
  readonly boundary = "trusted-cloud" as const;

  async locate(
    queryInput: OptimizerReleasedEvidenceQuery,
  ): Promise<readonly TrustedCloudArtifactRef[]> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertOptimizerQuery(query);
      const result = await this.locateRegistryExact(
        locator(
          "optimizer-released-evidence-metadata",
          query.purpose,
          query.queryHash,
        ),
      );
      if (!unchanged(queryInput, before)) fail();
      return result === undefined ? [] : [result];
    } catch {
      fail();
    }
  }
}

export class MountedVolumeOptimizerSourceOnlyBootstrapMetadataSource
  extends RegistrySource
{
  readonly boundary = "trusted-cloud" as const;

  async locate(
    queryInput: OptimizerSourceOnlyBootstrapMetadataQuery,
  ): Promise<TrustedCloudArtifactRef | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      exactKeys(query, ["purpose", "metadataHash"]);
      if (
        query.purpose !== "source-only-bootstrap" ||
        typeof query.metadataHash !== "string" ||
        !SHA256.test(query.metadataHash)
      ) {
        fail();
      }
      const result = await this.locateRegistryExact(
        locator(
          "optimizer-released-evidence-metadata",
          "source-only-bootstrap",
          canonicalHash({
            domain:
              "dark-factory.optimizer-source-only-bootstrap-registry-query.v1",
            query,
          }),
        ),
      );
      if (!unchanged(queryInput, before)) fail();
      return result;
    } catch {
      fail();
    }
  }
}

export class MountedVolumeProductionCompositionAttestationArtifactSource
  extends RegistrySource
  implements TrustedProductionCompositionAttestationArtifactSource
{
  readonly boundary = "trusted-cloud" as const;

  async locate(
    queryInput: ProductionCompositionAttestationQuery,
  ): Promise<ProductionCompositionAttestationArtifactSet | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertCompositionQuery(query);
      const document = await this.readRegistryExact(
        locator(
          "production-composition-attestation",
          "production-composition-attestation-set",
          query.queryHash,
        ),
        4 * 1024 * 1024,
      );
      if (!unchanged(queryInput, before)) fail();
      if (document === undefined) return undefined;
      captureCompositionPublication(
        query,
        document as unknown as ProductionCompositionAttestationArtifactSet,
      );
      return cloneCanonical(
        document,
      ) as unknown as ProductionCompositionAttestationArtifactSet;
    } catch {
      fail();
    }
  }
}

export class MountedVolumeCampaignAttestationArtifactSource
  extends RegistrySource
  implements TrustedCampaignAttestationArtifactSource
{
  readonly boundary = "trusted-cloud" as const;

  async locate(
    queryInput: TrustedCampaignAttestationArtifactQuery,
  ): Promise<TrustedCloudArtifactRef | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertCampaignQuery(query);
      const result = await this.locateRegistryExact(
        locator(
          "campaign-attestation",
          query.evidenceKind,
          campaignQueryHash(query),
        ),
      );
      if (!unchanged(queryInput, before)) fail();
      return result;
    } catch {
      fail();
    }
  }
}

export class MountedVolumeProductionOptimizePrerequisiteSource
  extends RegistrySource
  implements TrustedProductionOptimizePrerequisiteSource
{
  readonly boundary =
    "trusted-cloud-production-optimize-prerequisite-source" as const;

  async locatePrivatePiRegistration(
    queryInput: ProductionOptimizePrivatePiRegistrationQuery,
  ): Promise<TrustedGitRegistrationReceipt | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertPrivatePiQuery(query);
      const document = await this.readRegistryExact(
        locator(
          "production-optimize-prerequisite",
          query.purpose,
          prerequisiteQueryHash(query),
        ),
        4 * 1024 * 1024,
      );
      if (!unchanged(queryInput, before)) fail();
      if (document === undefined) return undefined;
      capturePrivatePiPublication(
        query,
        document as unknown as TrustedGitRegistrationReceipt,
      );
      return cloneCanonical(
        document,
      ) as unknown as TrustedGitRegistrationReceipt;
    } catch {
      fail();
    }
  }

  async locateCampaignGenesis(
    queryInput: ProductionOptimizeCampaignGenesisQuery,
  ): Promise<SignedProductionOptimizeCampaignGenesis | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertCampaignGenesisQuery(query);
      const document = await this.readRegistryExact(
        locator(
          "production-optimize-prerequisite",
          query.purpose,
          prerequisiteQueryHash(query),
        ),
        4 * 1024 * 1024,
      );
      if (!unchanged(queryInput, before)) fail();
      if (document === undefined) return undefined;
      captureCampaignGenesisPublication(
        query,
        document as unknown as SignedProductionOptimizeCampaignGenesis,
      );
      return cloneCanonical(
        document,
      ) as unknown as SignedProductionOptimizeCampaignGenesis;
    } catch {
      fail();
    }
  }

  async locateHiddenCatalogGenesis(
    queryInput: ProductionOptimizeHiddenCatalogGenesisQuery,
  ): Promise<SignedProductionOptimizeHiddenCatalogGenesis | undefined> {
    try {
      const before = canonicalJson(queryInput);
      const query = cloneCanonical(queryInput);
      assertCatalogGenesisQuery(query);
      const document = await this.readRegistryExact(
        locator(
          "production-optimize-prerequisite",
          query.purpose,
          prerequisiteQueryHash(query),
        ),
        4 * 1024 * 1024,
      );
      if (!unchanged(queryInput, before)) fail();
      if (document === undefined) return undefined;
      captureCatalogGenesisPublication(
        query,
        document as unknown as SignedProductionOptimizeHiddenCatalogGenesis,
      );
      return cloneCanonical(
        document,
      ) as unknown as SignedProductionOptimizeHiddenCatalogGenesis;
    } catch {
      fail();
    }
  }
}

/**
 * One JSON reader capability can be supplied to all typed consumers without
 * exposing the registry, backend, URI mapping, or filesystem.
 */
export class MountedVolumeTrustedArtifactJsonReader
  implements
    TrustedEvaluationReleaseArtifactReader,
    TrustedOptimizerResolverArtifactReader,
    TrustedProductionCompositionAttestationArtifactReader,
    TrustedCampaignAttestationArtifactReader
{
  readonly boundary = "trusted-cloud" as const;
  readonly #readUtf8: VerifyingTrustedJsonArtifactReader["readUtf8"];

  constructor(reader: VerifyingTrustedJsonArtifactReader) {
    if (
      reader.boundary !== "trusted-cloud" ||
      typeof reader.readUtf8 !== "function"
    ) {
      fail();
    }
    this.#readUtf8 = reader.readUtf8.bind(reader);
  }

  readUtf8(
    artifact: TrustedCloudArtifactRef,
    maximumBytes: number,
  ): Promise<string> {
    const snapshot = cloneCanonical(artifact);
    assertArtifact(snapshot, maximumBytes);
    return this.#readUtf8(snapshot, maximumBytes);
  }
}
