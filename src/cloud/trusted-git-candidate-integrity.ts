import type { KeyLike } from "node:crypto";

import { verifyEd25519Signature } from "../evidence/signatures.js";
import {
  assertSuccessfulCloudExecution,
  cloudExecutionReceiptHash,
} from "../harness/trusted-git.js";
import {
  DEFAULT_PI_SCAN_POLICY,
  DEFAULT_PI_SCAN_POLICY_HASH,
  type IntegrityViolationCode,
  scanCandidate,
} from "../integrity/candidate-scanner.js";
import {
  type AccountedCorrectnessGateReceipt,
  type CorrectnessGateOperationAccounting,
  type TrustedCloudIntegrityScanInput,
  type TrustedCloudIntegrityScanPort,
  type TrustedCloudIntegrityScanReceipt,
  type TrustedCloudIntegrityScanReceiptVerifier,
  trustedCloudIntegrityScanAttestationHash,
} from "../orchestrator/correctness-gate.js";
import { canonicalHash, canonicalJson, computeContentHash } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";
import type { TrustedArtifactBridge } from "./artifact-bridge.js";
import { requireCompatibleProvider } from "./probe.js";
import type {
  CloudSandboxProvider,
  RemoteCommandSpec,
  SandboxCreateRequest,
  TrustedCloudArtifactRef,
} from "./types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_BUNDLE_REF = /^refs\/heads\/df\/bundle\/[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\s\S]{1,4096}$/u;
const TREE_MODE = /^[0-7]{6}$/u;
const SAFE_SIGNATURE = /^[A-Za-z0-9_-]{86,128}$/u;
const MAXIMUM_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DIFF_BYTES = 64 * 1024 * 1024;
const MAXIMUM_FRAGMENT_HASHES = 250_000;
const MAXIMUM_SCAN_LIFETIME_MS = 60 * 60_000;
const WORKING_DIRECTORY = "/workspace";
const WORKER_REMOTE_PATH = "/trusted/integrity/candidate-integrity-worker.mjs";
const BUNDLE_REMOTE_PATH = "/trusted/integrity/candidate.bundle";
const DIFF_REMOTE_PATH = "/trusted/integrity/candidate-derived.diff";
const MANIFEST_REMOTE_PATH = "/trusted/integrity/candidate-evidence.json";

export class TrustedCandidateIntegrityError extends Error {
  override readonly name = "TrustedCandidateIntegrityError";

  constructor() {
    super("Trusted candidate integrity scan failed closed.");
  }
}

function fail(): never {
  throw new TrustedCandidateIntegrityError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail();
  }
}

function canonicalClone<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    fail();
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertArtifact(
  value: unknown,
  mediaType: string,
  maximumBytes: number,
): asserts value is TrustedCloudArtifactRef {
  assertExactKeys(value, ["uri", "sha256", "mediaType", "byteLength"]);
  const artifact = value as unknown as TrustedCloudArtifactRef;
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    artifact.mediaType !== mediaType ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > maximumBytes
  ) {
    fail();
  }
}

function assertGitObject(value: unknown): asserts value is string {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    fail();
  }
}

function scanExperimentId(input: TrustedCloudIntegrityScanInput): string {
  assertExactKeys(input.experiment, [
    "number",
    "slug",
    "kind",
    "parentExperiment",
    "lineageId",
    "protocolHash",
  ]);
  const experiment = input.experiment;
  if (
    !Number.isSafeInteger(experiment.number) ||
    experiment.number < 1 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(experiment.slug) ||
    (experiment.kind !== "optimization" && experiment.kind !== "shadow") ||
    (experiment.parentExperiment !== null &&
      (!Number.isSafeInteger(experiment.parentExperiment) ||
        experiment.parentExperiment < 0 ||
        experiment.parentExperiment >= experiment.number)) ||
    !SAFE_ID.test(experiment.lineageId) ||
    !SHA256.test(experiment.protocolHash)
  ) {
    fail();
  }
  const id = `${String(experiment.number).padStart(3, "0")}-${experiment.slug}`;
  if (!EXPERIMENT_ID.test(id)) fail();
  return id;
}

function assertScanInput(input: TrustedCloudIntegrityScanInput): string {
  const id = scanExperimentId(input);
  assertGitObject(input.sourceCommit);
  assertGitObject(input.sourceTree);
  assertGitObject(input.candidateCommit);
  assertGitObject(input.candidateTree);
  assertArtifact(input.candidateBundle, "application/vnd.git.bundle", 2 * 1024 * 1024 * 1024);
  assertArtifact(input.candidateDiff, "text/x-diff", MAXIMUM_DIFF_BYTES);
  if (
    input.sourceCommit === input.candidateCommit ||
    input.sourceTree === input.candidateTree ||
    !SHA256.test(input.lockSha256) ||
    !SHA256.test(input.hypothesisHash) ||
    !SHA256.test(input.hypothesisDocumentHash) ||
    !SHA256.test(input.candidateDocumentHash) ||
    !SHA256.test(input.integrityPolicyHash) ||
    !Array.isArray(input.changedFiles) ||
    input.changedFiles.length < 1 ||
    input.changedFiles.length > 12 ||
    new Set(input.changedFiles).size !== input.changedFiles.length ||
    input.changedFiles.some(
      (path) =>
        typeof path !== "string" ||
        !SAFE_PATH.test(path) ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: Trusted Git rejects control bytes and backslashes in candidate paths.
        /[\u0000-\u001f\u007f\\]/u.test(path),
    )
  ) {
    fail();
  }
  return id;
}

export interface CandidateGitFileModeEvidence {
  readonly path: string;
  readonly beforeMode: string;
  readonly afterMode: string;
}

export interface TrustedCandidateGitEvidenceManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.candidate-git-evidence.v1";
  readonly experimentId: string;
  readonly bundleRef: string;
  readonly candidateBundleSha256: string;
  readonly candidateBundleByteLength: number;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly diffSha256: string;
  readonly diffByteLength: number;
  readonly changedFiles: readonly string[];
  readonly changedFilesHash: string;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly lineCountsHash: string;
  readonly modes: readonly CandidateGitFileModeEvidence[];
  readonly fileModesHash: string;
  readonly contentHash: string;
}

export interface TrustedCandidateGitEvidenceRequest {
  readonly scanId: string;
  readonly experimentId: string;
  readonly bundleRef: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly candidateBundle: TrustedCloudArtifactRef;
}

export interface TrustedCandidateGitEvidenceResult {
  readonly workerSha256: string;
  readonly executionReceiptHash: string;
  readonly completedAt: string;
  readonly manifestArtifact: TrustedCloudArtifactRef;
  readonly diffArtifact: TrustedCloudArtifactRef;
}

export interface TrustedCandidateGitEvidenceRunner {
  readonly boundary: "trusted-cloud-git-object-evidence";
  derive(request: TrustedCandidateGitEvidenceRequest): Promise<TrustedCandidateGitEvidenceResult>;
}

export interface CloudCandidateGitEvidenceRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: SandboxCreateRequest;
  readonly workerArtifact: TrustedCloudArtifactRef;
}

function assertEvidenceRequest(input: TrustedCandidateGitEvidenceRequest): void {
  assertExactKeys(input, [
    "scanId",
    "experimentId",
    "bundleRef",
    "sourceCommit",
    "sourceTree",
    "candidateCommit",
    "candidateTree",
    "candidateBundle",
  ]);
  assertGitObject(input.sourceCommit);
  assertGitObject(input.sourceTree);
  assertGitObject(input.candidateCommit);
  assertGitObject(input.candidateTree);
  assertArtifact(input.candidateBundle, "application/vnd.git.bundle", 2 * 1024 * 1024 * 1024);
  if (
    !/^scan-[a-f0-9]{48}$/u.test(input.scanId) ||
    !EXPERIMENT_ID.test(input.experimentId) ||
    input.bundleRef !== `refs/heads/df/bundle/${input.experimentId}` ||
    !SAFE_BUNDLE_REF.test(input.bundleRef) ||
    input.sourceCommit === input.candidateCommit ||
    input.sourceTree === input.candidateTree
  ) {
    fail();
  }
}

function evidenceCommand(request: TrustedCandidateGitEvidenceRequest): RemoteCommandSpec {
  return {
    executionId: `derive-${request.scanId.slice("scan-".length)}`,
    executable: "/usr/bin/node",
    arguments: [
      WORKER_REMOTE_PATH,
      "--experiment",
      request.experimentId,
      "--bundle",
      BUNDLE_REMOTE_PATH,
      "--bundle-sha256",
      request.candidateBundle.sha256,
      "--bundle-byte-length",
      String(request.candidateBundle.byteLength),
      "--bundle-ref",
      request.bundleRef,
      "--source-commit",
      request.sourceCommit,
      "--source-tree",
      request.sourceTree,
      "--candidate-commit",
      request.candidateCommit,
      "--candidate-tree",
      request.candidateTree,
      "--diff",
      DIFF_REMOTE_PATH,
      "--manifest",
      MANIFEST_REMOTE_PATH,
    ],
    workingDirectory: WORKING_DIRECTORY,
    timeoutMs: 20 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
    },
    secretReferences: [],
  };
}

/**
 * Runs the frozen evidence worker only inside an injected deny-all cloud
 * sandbox. It uploads an immutable candidate bundle and downloads only a
 * derived diff plus its canonical Git-object manifest.
 */
export class CloudCandidateGitEvidenceRunner implements TrustedCandidateGitEvidenceRunner {
  readonly boundary = "trusted-cloud-git-object-evidence" as const;
  readonly #options: CloudCandidateGitEvidenceRunnerOptions;

  constructor(options: CloudCandidateGitEvidenceRunnerOptions) {
    assertArtifact(options.workerArtifact, "text/javascript", 4 * 1024 * 1024);
    if (
      !SAFE_ID.test(options.sandbox.requestId) ||
      options.sandbox.resources.architecture !== "x86_64" ||
      options.sandbox.network.defaultAction !== "deny" ||
      options.sandbox.network.allowDomains.length !== 0 ||
      options.sandbox.secretReferences.length !== 0 ||
      !Number.isSafeInteger(options.sandbox.lifetimeMs) ||
      options.sandbox.lifetimeMs <= 0 ||
      options.sandbox.lifetimeMs > MAXIMUM_SCAN_LIFETIME_MS
    ) {
      fail();
    }
    this.#options = options;
  }

  async derive(
    rawRequest: TrustedCandidateGitEvidenceRequest,
  ): Promise<TrustedCandidateGitEvidenceResult> {
    try {
      const request = canonicalClone(rawRequest);
      assertEvidenceRequest(request);
      await requireCompatibleProvider(this.#options.provider, {
        requestId: `probe-${canonicalHash(request).slice(0, 32)}`,
        imageDigest: this.#options.sandbox.imageDigest,
        regionClass: this.#options.sandbox.regionClass,
        resources: this.#options.sandbox.resources,
        requireDockerInDocker: false,
        requireGpu: false,
      });
      let lease: Awaited<ReturnType<CloudSandboxProvider["create"]>> | undefined;
      let result: TrustedCandidateGitEvidenceResult | undefined;
      let failure: unknown;
      try {
        lease = await this.#options.provider.create({
          ...this.#options.sandbox,
          requestId: request.scanId,
        });
        await this.#options.provider.upload(
          lease,
          this.#options.workerArtifact,
          WORKER_REMOTE_PATH,
        );
        await this.#options.provider.upload(lease, request.candidateBundle, BUNDLE_REMOTE_PATH);
        const execution = await this.#options.provider.execute(lease, evidenceCommand(request));
        assertSuccessfulCloudExecution(execution, "Candidate Git evidence derivation");
        if (execution.provider !== lease.provider || execution.sandboxId !== lease.sandboxId) {
          fail();
        }
        const [manifestArtifact, diffArtifact] = await Promise.all([
          this.#options.provider.download(lease, MANIFEST_REMOTE_PATH, {
            mediaType: "application/json",
            maximumByteLength: MAXIMUM_MANIFEST_BYTES,
          }),
          this.#options.provider.download(lease, DIFF_REMOTE_PATH, {
            mediaType: "text/x-diff",
            maximumByteLength: MAXIMUM_DIFF_BYTES,
          }),
        ]);
        assertArtifact(manifestArtifact, "application/json", MAXIMUM_MANIFEST_BYTES);
        assertArtifact(diffArtifact, "text/x-diff", MAXIMUM_DIFF_BYTES);
        result = {
          workerSha256: this.#options.workerArtifact.sha256,
          executionReceiptHash: cloudExecutionReceiptHash(execution),
          completedAt: execution.finishedAt,
          manifestArtifact: canonicalClone(manifestArtifact),
          diffArtifact: canonicalClone(diffArtifact),
        };
      } catch (error) {
        failure = error;
      } finally {
        if (lease !== undefined) {
          try {
            await this.#options.provider.destroy(lease);
          } catch (error) {
            failure = error;
          }
        }
      }
      if (failure !== undefined || result === undefined) fail();
      return result;
    } catch {
      fail();
    }
  }
}

export interface TrustedCandidateIntegrityArtifactReader {
  readonly boundary: "trusted-cloud-artifact-reader";
  readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string>;
}

/**
 * Bounded fatal-UTF-8 reader over the verifying artifact bridge. The bridge
 * authenticates the exact digest and EOF before any parsed evidence is used.
 */
export class VerifyingCandidateIntegrityArtifactReader
  implements TrustedCandidateIntegrityArtifactReader
{
  readonly boundary = "trusted-cloud-artifact-reader" as const;
  readonly #bridge: TrustedArtifactBridge;

  constructor(bridge: TrustedArtifactBridge) {
    this.#bridge = bridge;
  }

  async readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string> {
    try {
      if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes <= 0 ||
        maximumBytes > MAXIMUM_DIFF_BYTES ||
        artifact.byteLength <= 0 ||
        artifact.byteLength > maximumBytes ||
        (artifact.mediaType !== "application/json" && artifact.mediaType !== "text/x-diff")
      ) {
        fail();
      }
      const decoder = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      });
      const chunks = await this.#bridge.openVerified(artifact);
      let output = "";
      let byteLength = 0;
      for await (const chunk of chunks) {
        if (!(chunk instanceof Uint8Array)) fail();
        byteLength += chunk.byteLength;
        if (
          !Number.isSafeInteger(byteLength) ||
          byteLength > artifact.byteLength ||
          byteLength > maximumBytes
        ) {
          fail();
        }
        output += decoder.decode(chunk, { stream: true });
      }
      output += decoder.decode();
      if (
        byteLength !== artifact.byteLength ||
        output.length < 1 ||
        output.charCodeAt(0) === 0xfeff ||
        output.includes("\0")
      ) {
        fail();
      }
      return output;
    } catch {
      fail();
    }
  }
}

function parseEvidenceManifest(
  raw: string,
  request: TrustedCandidateGitEvidenceRequest,
  result: TrustedCandidateGitEvidenceResult,
): TrustedCandidateGitEvidenceManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  assertExactKeys(parsed, [
    "schemaVersion",
    "domain",
    "experimentId",
    "bundleRef",
    "candidateBundleSha256",
    "candidateBundleByteLength",
    "sourceCommit",
    "sourceTree",
    "candidateCommit",
    "candidateTree",
    "diffSha256",
    "diffByteLength",
    "changedFiles",
    "changedFilesHash",
    "addedLines",
    "deletedLines",
    "lineCountsHash",
    "modes",
    "fileModesHash",
    "contentHash",
  ]);
  const manifest = parsed as unknown as TrustedCandidateGitEvidenceManifest;
  if (
    raw !== `${canonicalJson(manifest)}\n` ||
    manifest.contentHash !== computeContentHash(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.domain !== "dark-factory.candidate-git-evidence.v1" ||
    manifest.experimentId !== request.experimentId ||
    manifest.bundleRef !== request.bundleRef ||
    manifest.candidateBundleSha256 !== request.candidateBundle.sha256 ||
    manifest.candidateBundleByteLength !== request.candidateBundle.byteLength ||
    manifest.sourceCommit !== request.sourceCommit ||
    manifest.sourceTree !== request.sourceTree ||
    manifest.candidateCommit !== request.candidateCommit ||
    manifest.candidateTree !== request.candidateTree ||
    manifest.diffSha256 !== result.diffArtifact.sha256 ||
    manifest.diffByteLength !== result.diffArtifact.byteLength ||
    !Array.isArray(manifest.changedFiles) ||
    manifest.changedFiles.length < 1 ||
    manifest.changedFiles.length > 4096 ||
    new Set(manifest.changedFiles).size !== manifest.changedFiles.length ||
    manifest.changedFiles.some(
      (path) => typeof path !== "string" || !SAFE_PATH.test(path) || path.includes("\0"),
    ) ||
    manifest.changedFilesHash !== canonicalHash(manifest.changedFiles) ||
    !Number.isSafeInteger(manifest.addedLines) ||
    manifest.addedLines < 0 ||
    !Number.isSafeInteger(manifest.deletedLines) ||
    manifest.deletedLines < 0 ||
    manifest.lineCountsHash !==
      canonicalHash({
        addedLines: manifest.addedLines,
        deletedLines: manifest.deletedLines,
      }) ||
    !Array.isArray(manifest.modes) ||
    manifest.modes.length !== manifest.changedFiles.length ||
    manifest.fileModesHash !== canonicalHash(manifest.modes)
  ) {
    fail();
  }
  for (const [index, mode] of manifest.modes.entries()) {
    assertExactKeys(mode, ["path", "beforeMode", "afterMode"]);
    const beforeMode = mode.beforeMode;
    const afterMode = mode.afterMode;
    if (
      mode.path !== manifest.changedFiles[index] ||
      typeof beforeMode !== "string" ||
      typeof afterMode !== "string" ||
      !TREE_MODE.test(beforeMode) ||
      !TREE_MODE.test(afterMode)
    ) {
      fail();
    }
  }
  return canonicalClone(manifest);
}

export interface TrustedTaskFragmentHashCatalog {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-task-fragment-hashes";
  readonly protocolHash: string;
  readonly integrityPolicyHash: string;
  readonly fragmentHashes: readonly string[];
  readonly containsTaskPlaintext: false;
  readonly sourceAttestationHash: string;
  readonly fragmentCatalogHash: string;
}

export function taskFragmentCatalogHash(
  catalog: Omit<TrustedTaskFragmentHashCatalog, "fragmentCatalogHash">,
): string {
  return canonicalHash(catalog);
}

function assertFragmentCatalog(
  value: unknown,
  expected: {
    readonly protocolHash: string;
    readonly integrityPolicyHash: string;
    readonly fragmentCatalogHash: string;
  },
): asserts value is TrustedTaskFragmentHashCatalog {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "protocolHash",
    "integrityPolicyHash",
    "fragmentHashes",
    "containsTaskPlaintext",
    "sourceAttestationHash",
    "fragmentCatalogHash",
  ]);
  const catalog = value as unknown as TrustedTaskFragmentHashCatalog;
  const { fragmentCatalogHash: _fragmentCatalogHash, ...body } = catalog;
  if (
    catalog.schemaVersion !== 1 ||
    catalog.sensitivity !== "trusted-task-fragment-hashes" ||
    catalog.protocolHash !== expected.protocolHash ||
    catalog.integrityPolicyHash !== expected.integrityPolicyHash ||
    !Array.isArray(catalog.fragmentHashes) ||
    catalog.fragmentHashes.length < 1 ||
    catalog.fragmentHashes.length > MAXIMUM_FRAGMENT_HASHES ||
    new Set(catalog.fragmentHashes).size !== catalog.fragmentHashes.length ||
    catalog.fragmentHashes.some((hash) => !SHA256.test(hash)) ||
    catalog.fragmentHashes.some((hash, index) => {
      const previous = catalog.fragmentHashes[index - 1];
      return previous !== undefined && previous.localeCompare(hash) >= 0;
    }) ||
    catalog.containsTaskPlaintext !== false ||
    !SHA256.test(catalog.sourceAttestationHash) ||
    catalog.fragmentCatalogHash !== taskFragmentCatalogHash(body) ||
    catalog.fragmentCatalogHash !== expected.fragmentCatalogHash
  ) {
    fail();
  }
}

export interface TrustedTaskFragmentHashSource {
  readonly boundary: "trusted-evaluator-fragment-hashes";
  load(input: {
    readonly protocolHash: string;
    readonly integrityPolicyHash: string;
    readonly expectedFragmentCatalogHash: string;
  }): Promise<TrustedTaskFragmentHashCatalog>;
}

/**
 * Non-enumerable outside the trusted evaluator/control process. This adapter
 * deliberately exposes no lookup API: the entire sealed catalog can only be
 * consumed by the one-shot integrity port.
 */
export class PinnedTrustedTaskFragmentHashSource implements TrustedTaskFragmentHashSource {
  readonly boundary = "trusted-evaluator-fragment-hashes" as const;
  readonly #catalog: TrustedTaskFragmentHashCatalog;

  constructor(catalog: TrustedTaskFragmentHashCatalog) {
    assertFragmentCatalog(catalog, {
      protocolHash: catalog.protocolHash,
      integrityPolicyHash: catalog.integrityPolicyHash,
      fragmentCatalogHash: catalog.fragmentCatalogHash,
    });
    this.#catalog = canonicalClone(catalog);
  }

  async load(input: {
    readonly protocolHash: string;
    readonly integrityPolicyHash: string;
    readonly expectedFragmentCatalogHash: string;
  }): Promise<TrustedTaskFragmentHashCatalog> {
    const result = canonicalClone(this.#catalog);
    assertFragmentCatalog(result, {
      protocolHash: input.protocolHash,
      integrityPolicyHash: input.integrityPolicyHash,
      fragmentCatalogHash: input.expectedFragmentCatalogHash,
    });
    return result;
  }
}

export interface TrustedCandidateIntegritySigningAuthority {
  readonly boundary: "trusted-cloud-key-material";
  readonly keyId: string;
  sign(receipt: Omit<TrustedCloudIntegrityScanReceipt, "signature">): Promise<Signature>;
}

export interface TrustedCandidateIntegrityAccountingAttestation {
  readonly aggregateCostUsd: number;
  readonly tokens: number;
  readonly wallTimeMs: number;
  readonly accountingAttestationHash: string;
  readonly containsTaskIdentifiers: false;
}

export interface TrustedCandidateIntegrityAccountingAuthority {
  readonly boundary: "trusted-cloud-accounting";
  attest(input: {
    readonly scanId: string;
    readonly receiptHash: string;
    readonly executionReceiptHash: string;
  }): Promise<TrustedCandidateIntegrityAccountingAttestation>;
}

export interface ArtifactDerivedCandidateIntegrityScanPortOptions {
  readonly evidenceRunner: TrustedCandidateGitEvidenceRunner;
  readonly artifactReader: TrustedCandidateIntegrityArtifactReader;
  readonly fragmentSource: TrustedTaskFragmentHashSource;
  readonly signer: TrustedCandidateIntegritySigningAuthority;
  readonly accounting: TrustedCandidateIntegrityAccountingAuthority;
  readonly receiptVerifier: TrustedCloudIntegrityScanReceiptVerifier;
  readonly integrityPolicyHash: string;
  readonly workerSha256: string;
  readonly fragmentCatalogHash: string;
  readonly now?: () => Date;
}

function expectedScanId(
  input: TrustedCloudIntegrityScanInput,
  experimentId: string,
  options: {
    readonly workerSha256: string;
    readonly fragmentCatalogHash: string;
  },
): string {
  return `scan-${canonicalHash({
    experimentId,
    protocolHash: input.experiment.protocolHash,
    sourceCommit: input.sourceCommit,
    sourceTree: input.sourceTree,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    lockSha256: input.lockSha256,
    hypothesisDocumentHash: input.hypothesisDocumentHash,
    candidateDocumentHash: input.candidateDocumentHash,
    diffSha256: input.candidateDiff.sha256,
    changedFilesHash: canonicalHash(input.changedFiles),
    candidateBundleSha256: input.candidateBundle.sha256,
    integrityWorkerSha256: options.workerSha256,
    fragmentCatalogHash: options.fragmentCatalogHash,
    integrityPolicyHash: input.integrityPolicyHash,
  }).slice(0, 48)}`;
}

function assertEvidenceResult(
  result: unknown,
  expectedWorkerSha256: string,
): asserts result is TrustedCandidateGitEvidenceResult {
  assertExactKeys(result, [
    "workerSha256",
    "executionReceiptHash",
    "completedAt",
    "manifestArtifact",
    "diffArtifact",
  ]);
  const evidence = result as unknown as TrustedCandidateGitEvidenceResult;
  assertArtifact(evidence.manifestArtifact, "application/json", MAXIMUM_MANIFEST_BYTES);
  assertArtifact(evidence.diffArtifact, "text/x-diff", MAXIMUM_DIFF_BYTES);
  if (
    evidence.workerSha256 !== expectedWorkerSha256 ||
    !SHA256.test(evidence.executionReceiptHash) ||
    !isCanonicalTimestamp(evidence.completedAt)
  ) {
    fail();
  }
}

function assertSignature(
  signature: unknown,
  input: {
    readonly keyId: string;
    readonly scannedAt: string;
    readonly receipt: Omit<TrustedCloudIntegrityScanReceipt, "signature">;
    readonly publicKey: KeyLike;
  },
): asserts signature is Signature {
  assertExactKeys(signature, ["algorithm", "keyId", "signedAt", "signature"]);
  const value = signature as unknown as Signature;
  const signed = {
    ...input.receipt,
    signature: value,
  };
  if (
    value.algorithm !== "ed25519" ||
    value.keyId !== input.keyId ||
    !isCanonicalTimestamp(value.signedAt) ||
    Date.parse(value.signedAt) < Date.parse(input.scannedAt) ||
    !SAFE_SIGNATURE.test(value.signature) ||
    !verifyEd25519Signature(signed as unknown as Readonly<Record<string, unknown>>, input.publicKey)
  ) {
    fail();
  }
}

function assertAccountingAttestation(
  value: unknown,
): asserts value is TrustedCandidateIntegrityAccountingAttestation {
  assertExactKeys(value, [
    "aggregateCostUsd",
    "tokens",
    "wallTimeMs",
    "accountingAttestationHash",
    "containsTaskIdentifiers",
  ]);
  const accounting = value as unknown as TrustedCandidateIntegrityAccountingAttestation;
  if (
    !Number.isFinite(accounting.aggregateCostUsd) ||
    accounting.aggregateCostUsd < 0 ||
    accounting.aggregateCostUsd > 1_000_000 ||
    !Number.isSafeInteger(accounting.tokens) ||
    accounting.tokens < 0 ||
    accounting.tokens > 10_000_000_000 ||
    !Number.isSafeInteger(accounting.wallTimeMs) ||
    accounting.wallTimeMs < 0 ||
    accounting.wallTimeMs > 30 * 24 * 60 * 60_000 ||
    !SHA256.test(accounting.accountingAttestationHash) ||
    accounting.containsTaskIdentifiers !== false
  ) {
    fail();
  }
}

/**
 * Production integrity port. Raw source paths, diff lines, mode records, and
 * the hidden task-fragment hash set remain inside this trusted object and its
 * evidence sandbox. Only sorted violation codes and content commitments leave
 * the boundary.
 */
export class ArtifactDerivedCandidateIntegrityScanPort implements TrustedCloudIntegrityScanPort {
  readonly boundary = "trusted-cloud" as const;
  readonly #options: ArtifactDerivedCandidateIntegrityScanPortOptions;
  readonly #now: () => Date;

  constructor(options: ArtifactDerivedCandidateIntegrityScanPortOptions) {
    if (
      options.evidenceRunner.boundary !== "trusted-cloud-git-object-evidence" ||
      options.artifactReader.boundary !== "trusted-cloud-artifact-reader" ||
      options.fragmentSource.boundary !== "trusted-evaluator-fragment-hashes" ||
      options.signer.boundary !== "trusted-cloud-key-material" ||
      options.accounting.boundary !== "trusted-cloud-accounting" ||
      !SAFE_ID.test(options.signer.keyId) ||
      options.signer.keyId !== options.receiptVerifier.trustedKeyId ||
      options.integrityPolicyHash !== DEFAULT_PI_SCAN_POLICY_HASH ||
      !SHA256.test(options.workerSha256) ||
      !SHA256.test(options.fragmentCatalogHash)
    ) {
      fail();
    }
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async scan(
    rawInput: TrustedCloudIntegrityScanInput,
  ): Promise<AccountedCorrectnessGateReceipt<TrustedCloudIntegrityScanReceipt>> {
    try {
      const input = canonicalClone(rawInput);
      const experimentId = assertScanInput(input);
      if (input.integrityPolicyHash !== this.#options.integrityPolicyHash) {
        fail();
      }
      const scanId = expectedScanId(input, experimentId, {
        workerSha256: this.#options.workerSha256,
        fragmentCatalogHash: this.#options.fragmentCatalogHash,
      });
      const evidenceRequest: TrustedCandidateGitEvidenceRequest = {
        scanId,
        experimentId,
        bundleRef: `refs/heads/df/bundle/${experimentId}`,
        sourceCommit: input.sourceCommit,
        sourceTree: input.sourceTree,
        candidateCommit: input.candidateCommit,
        candidateTree: input.candidateTree,
        candidateBundle: canonicalClone(input.candidateBundle),
      };
      const evidence = canonicalClone(
        await this.#options.evidenceRunner.derive(canonicalClone(evidenceRequest)),
      );
      assertEvidenceResult(evidence, this.#options.workerSha256);
      const [manifestRaw, derivedDiff, catalog] = await Promise.all([
        this.#options.artifactReader.readUtf8(evidence.manifestArtifact, MAXIMUM_MANIFEST_BYTES),
        this.#options.artifactReader.readUtf8(evidence.diffArtifact, MAXIMUM_DIFF_BYTES),
        this.#options.fragmentSource.load({
          protocolHash: input.experiment.protocolHash,
          integrityPolicyHash: input.integrityPolicyHash,
          expectedFragmentCatalogHash: this.#options.fragmentCatalogHash,
        }),
      ]);
      const manifest = parseEvidenceManifest(manifestRaw, evidenceRequest, evidence);
      assertFragmentCatalog(catalog, {
        protocolHash: input.experiment.protocolHash,
        integrityPolicyHash: input.integrityPolicyHash,
        fragmentCatalogHash: this.#options.fragmentCatalogHash,
      });
      const scan = scanCandidate(
        {
          changedFiles: manifest.changedFiles,
          unifiedDiff: derivedDiff,
          addedLines: manifest.addedLines,
          deletedLines: manifest.deletedLines,
          taskFragmentHashes: new Set(catalog.fragmentHashes),
        },
        DEFAULT_PI_SCAN_POLICY,
      );
      const violationCodes = new Set<IntegrityViolationCode>(
        scan.violations.map((violation) => violation.code),
      );
      const claimedChangedFilesHash = canonicalHash(input.changedFiles);
      if (
        manifest.changedFilesHash !== claimedChangedFilesHash ||
        evidence.diffArtifact.sha256 !== input.candidateDiff.sha256 ||
        evidence.diffArtifact.byteLength !== input.candidateDiff.byteLength
      ) {
        violationCodes.add("DIFF_METADATA_MISMATCH");
      }
      if (
        manifest.modes.some(
          (mode) =>
            !new Set(["000000", "100644", "100755"]).has(mode.beforeMode) ||
            !new Set(["000000", "100644", "100755"]).has(mode.afterMode),
        )
      ) {
        violationCodes.add("OPAQUE_BINARY_CHANGE");
      }
      const orderedViolationCodes = [...violationCodes].sort();
      const scannedAt = this.#now().toISOString();
      if (
        !isCanonicalTimestamp(scannedAt) ||
        Date.parse(scannedAt) < Date.parse(evidence.completedAt)
      ) {
        fail();
      }
      const attested = {
        schemaVersion: 2 as const,
        sensitivity: "release-safe-candidate-integrity-scan" as const,
        scanId,
        experimentId,
        protocolHash: input.experiment.protocolHash,
        sourceCommit: input.sourceCommit,
        sourceTree: input.sourceTree,
        candidateCommit: input.candidateCommit,
        candidateTree: input.candidateTree,
        lockSha256: input.lockSha256,
        hypothesisHash: input.hypothesisHash,
        hypothesisDocumentHash: input.hypothesisDocumentHash,
        candidateDocumentHash: input.candidateDocumentHash,
        diffSha256: input.candidateDiff.sha256,
        changedFilesHash: claimedChangedFilesHash,
        candidateBundleSha256: input.candidateBundle.sha256,
        evidenceManifestSha256: evidence.manifestArtifact.sha256,
        evidenceDiffSha256: evidence.diffArtifact.sha256,
        observedChangedFilesHash: manifest.changedFilesHash,
        lineCountsHash: manifest.lineCountsHash,
        fileModesHash: manifest.fileModesHash,
        fragmentCatalogHash: this.#options.fragmentCatalogHash,
        workerSha256: evidence.workerSha256,
        executionReceiptHash: evidence.executionReceiptHash,
        integrityPolicyHash: input.integrityPolicyHash,
        passed: orderedViolationCodes.length === 0,
        violationCodes: orderedViolationCodes,
        containsTaskIdentifiers: false as const,
        scannedAt,
      };
      const unsigned: Omit<TrustedCloudIntegrityScanReceipt, "signature"> = {
        ...attested,
        scanAttestationHash: trustedCloudIntegrityScanAttestationHash(attested),
      };
      const signature = canonicalClone(await this.#options.signer.sign(canonicalClone(unsigned)));
      assertSignature(signature, {
        keyId: this.#options.signer.keyId,
        scannedAt,
        receipt: unsigned,
        publicKey: this.#options.receiptVerifier.publicKey,
      });
      const receipt: TrustedCloudIntegrityScanReceipt = {
        ...unsigned,
        signature: canonicalClone(signature),
      };
      const receiptHash = canonicalHash(receipt);
      const attestation = canonicalClone(
        await this.#options.accounting.attest({
          scanId,
          receiptHash,
          executionReceiptHash: evidence.executionReceiptHash,
        }),
      );
      assertAccountingAttestation(attestation);
      const accounting: CorrectnessGateOperationAccounting = {
        schemaVersion: 1,
        sensitivity: "release-safe-correctness-gate-accounting",
        operation: "integrity-scan",
        receiptHash,
        aggregateCostUsd: attestation.aggregateCostUsd,
        tokens: attestation.tokens,
        wallTimeMs: attestation.wallTimeMs,
        containsTaskIdentifiers: false,
        accountingAttestationHash: attestation.accountingAttestationHash,
      };
      return canonicalClone({ receipt, accounting });
    } catch {
      fail();
    }
  }
}
