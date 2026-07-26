import { createHash } from "node:crypto";

import { requireCompatibleProvider } from "../cloud/probe.js";
import type {
  CloudSandboxProvider,
  RemoteCommandSpec,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  SecretReference,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import type { ExperimentIdentity } from "../domain/models.js";
import { trustedGitCandidateBundleRef } from "../harness/git-publication.js";
import { type GitSourceTarget, TRUSTED_GIT_SOURCE_BUNDLE_REF } from "../harness/git-source.js";
import type { RepositoryRegistration } from "../harness/repository.js";
import {
  assertGitObjectId,
  assertRegisteredPrivateGitHubOrigin,
  assertSha256,
  assertSuccessfulCloudExecution,
  assertTrustedGitArtifact,
  type PrivateGitHubOrigin,
  privateGitHubRemoteUrl,
  TRUSTED_GIT_CREDENTIAL_TARGET,
} from "../harness/trusted-git.js";
import type {
  FrozenCandidate,
  FrozenHypothesis,
  OptimizerAdapter,
  OptimizerContext,
  OptimizerProposal,
  RepairAggregate,
  ValidationAggregate,
} from "../orchestrator/contracts.js";
import { canonicalHash, canonicalJson, computeContentHash } from "../schemas/canonical.js";
import {
  type ClaudeCodeLaunchOptions,
  type ClaudeCodeSessionSummary,
  createClaudeCodeLaunchSpec,
} from "./claude-code.js";

const WORKING_DIRECTORY = "/workspace";
const PROJECT_ROOT = "/workspace/pi";
const TRUSTED_ROOT = "/trusted/optimizer";
const WORKER_REMOTE_PATH = `${TRUSTED_ROOT}/optimizer-session-worker.mjs`;
const PLUGIN_ARCHIVE_REMOTE_PATH = `${TRUSTED_ROOT}/plugin.tar`;
const EVIDENCE_ARCHIVE_REMOTE_PATH = `${TRUSTED_ROOT}/evidence.tar`;
const SOURCE_BUNDLE_REMOTE_PATH = `${TRUSTED_ROOT}/source.bundle`;
const INPUT_STATE_REMOTE_PATH = `${TRUSTED_ROOT}/input-state.tar`;
const SETUP_RESULT_REMOTE_PATH = `${TRUSTED_ROOT}/setup-result.json`;
const CLAUDE_RESULT_REMOTE_PATH = `${TRUSTED_ROOT}/claude-result.json`;
const SEALED_RESULT_REMOTE_PATH = `${TRUSTED_ROOT}/sealed-result.json`;
const CANDIDATE_BUNDLE_REMOTE_PATH = `${TRUSTED_ROOT}/candidate.bundle`;
const CANDIDATE_DIFF_REMOTE_PATH = `${TRUSTED_ROOT}/candidate.diff`;
const OUTPUT_STATE_REMOTE_PATH = `${TRUSTED_ROOT}/output-state.tar`;
const RELEASED_EVIDENCE_ROOT = "/workspace/released-evidence";
const SUBMISSION_ROOT = "/workspace/optimizer-submissions";
const AUDIT_ROOT = "/workspace/optimizer-audit";
const PLUGIN_ROOT = "/workspace/claude-plugin";
const PLUGIN_DATA_ROOT = "/workspace/plugin-data";
const MAXIMUM_OPTIMIZER_LIFETIME_MS = 24 * 60 * 60_000;
const MAXIMUM_RESULT_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EXPERIMENT_ID = /^[0-9]{3,8}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALLOWED_OPTIMIZER_SECRET_TARGETS = new Set(["ANTHROPIC_FOUNDRY_API_KEY"]);
const SAFE_FOUNDRY_RESOURCE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_NETWORK_HOST =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;

export class CloudOptimizerSessionError extends Error {
  override readonly name = "CloudOptimizerSessionError";
}

export interface TrustedOptimizerArtifactReader {
  /**
   * Implementations must read through a verifying trusted artifact bridge.
   * The returned bytes are re-hashed here before any JSON is trusted.
   */
  readUtf8(artifact: TrustedCloudArtifactRef, maximumBytes: number): Promise<string>;
}

export interface OptimizerPrivateGitSource {
  readonly mode: "private-github";
  readonly registration: RepositoryRegistration;
  readonly origin: PrivateGitHubOrigin;
  readonly target: GitSourceTarget;
}

export interface OptimizerBundleGitSource {
  readonly mode: "trusted-bundle";
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly bundle: TrustedCloudArtifactRef;
  readonly bundleRef: string;
  readonly target: GitSourceTarget;
}

export type OptimizerGitSource = OptimizerPrivateGitSource | OptimizerBundleGitSource;

export interface CloudOptimizerSandboxProfile {
  readonly imageReference: string;
  readonly imageDigest: string;
  readonly regionClass: string;
  readonly resources: SandboxCreateRequest["resources"];
  readonly networkAllowDomains: readonly string[];
  readonly lifetimeMs: number;
}

export interface CloudOptimizerSessionOptions {
  readonly provider: CloudSandboxProvider;
  readonly sandbox: CloudOptimizerSandboxProfile;
  readonly workerArtifact: TrustedCloudArtifactRef;
  readonly pluginArtifact: TrustedCloudArtifactRef;
  readonly artifactReader: TrustedOptimizerArtifactReader;
  readonly claude: Pick<
    ClaudeCodeLaunchOptions,
    | "claudeExecutable"
    | "model"
    | "modelFamily"
    | "foundryResourceName"
    | "effort"
    | "maximumBudgetUsd"
    | "maximumTurns"
    | "timeoutMs"
  >;
  readonly optimizerSecretReferences: readonly SecretReference[];
}

export interface CloudOptimizerProposalInput {
  readonly context: OptimizerContext;
  readonly source: OptimizerGitSource;
  readonly releasedEvidence: TrustedCloudArtifactRef;
}

export interface CloudOptimizerAnalysisInput {
  readonly experiment: ExperimentIdentity;
  readonly proposal: CloudOptimizerProposalResult;
  readonly releasedEvidence: TrustedCloudArtifactRef;
}

export interface OptimizerSetupManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-setup.v1";
  readonly phase: "proposal" | "analysis";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly sourceMode: "private-github" | "trusted-bundle";
  readonly registrationId: string;
  readonly originRepositoryHash: string;
  readonly sourceCommit: string;
  readonly sourceTree: string;
  readonly lockSha256: string;
  readonly pluginArchiveSha256: string;
  readonly evidenceArchiveSha256: string;
  readonly inputStateSha256: string | null;
  readonly contentHash: string;
}

export interface OptimizerClaudeManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-claude.v1";
  readonly phase: "proposal" | "analysis";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly summary: ClaudeCodeSessionSummary;
  readonly exitCode: number;
  readonly stderrSha256: string;
  readonly contentHash: string;
}

export interface OptimizerSealedArtifactMetadata {
  readonly sha256: string;
  readonly byteLength: number;
}

export interface OptimizerProposalSealManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-proposal.v1";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly sourceCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly lockSha256: string;
  readonly bundleRef: string;
  readonly hypothesis: FrozenHypothesis;
  readonly candidate: FrozenCandidate;
  readonly hypothesisReceiptId: string;
  readonly candidateReceiptId: string;
  readonly integrityPolicyHash: string;
  readonly bundle: OptimizerSealedArtifactMetadata;
  readonly diff: OptimizerSealedArtifactMetadata;
  readonly state: OptimizerSealedArtifactMetadata;
  readonly contentHash: string;
}

export interface OptimizerAnalysisSealManifest {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.optimizer-analysis.v1";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly candidateCommit: string;
  readonly analysisHash: string;
  readonly rollbackRequired: boolean;
  readonly analysisReceiptId: string;
  readonly state: OptimizerSealedArtifactMetadata;
  readonly contentHash: string;
}

export interface CloudOptimizerExecutionReceipts {
  readonly setup: RemoteExecutionReceipt;
  readonly claude: RemoteExecutionReceipt;
  readonly seal: RemoteExecutionReceipt;
}

export interface CloudOptimizerProposalResult {
  readonly proposal: OptimizerProposal;
  readonly setup: OptimizerSetupManifest;
  readonly claude: OptimizerClaudeManifest;
  readonly seal: OptimizerProposalSealManifest;
  readonly candidateBundle: TrustedCloudArtifactRef;
  readonly candidateDiff: TrustedCloudArtifactRef;
  readonly sessionState: TrustedCloudArtifactRef;
  readonly setupManifestArtifact: TrustedCloudArtifactRef;
  readonly claudeManifestArtifact: TrustedCloudArtifactRef;
  readonly sealManifestArtifact: TrustedCloudArtifactRef;
  readonly executionReceipts: CloudOptimizerExecutionReceipts;
}

export interface CloudOptimizerAnalysisResult {
  readonly analysisHash: string;
  readonly rollbackRequired: boolean;
  readonly setup: OptimizerSetupManifest;
  readonly claude: OptimizerClaudeManifest;
  readonly seal: OptimizerAnalysisSealManifest;
  readonly sessionState: TrustedCloudArtifactRef;
  readonly setupManifestArtifact: TrustedCloudArtifactRef;
  readonly claudeManifestArtifact: TrustedCloudArtifactRef;
  readonly sealManifestArtifact: TrustedCloudArtifactRef;
  readonly executionReceipts: CloudOptimizerExecutionReceipts;
}

function experimentId(experiment: ExperimentIdentity): string {
  const value = `${experiment.number.toString().padStart(3, "0")}-${experiment.slug}`;
  if (!EXPERIMENT_ID.test(value)) {
    throw new CloudOptimizerSessionError("Optimizer experiment identity is malformed.");
  }
  return value;
}

function assertArtifact(
  artifact: TrustedCloudArtifactRef,
  mediaType: string,
  label: string,
  maximumBytes = 2 * 1024 * 1024 * 1024,
): void {
  assertTrustedGitArtifact(artifact, mediaType, label, maximumBytes);
}

function assertTarget(target: GitSourceTarget): void {
  if (
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(target.remoteRef) ||
    target.remoteRef.includes("..") ||
    target.remoteRef.includes("@{") ||
    target.remoteRef.includes("//") ||
    target.remoteRef.endsWith("/") ||
    target.remoteRef.endsWith(".") ||
    target.remoteRef.endsWith(".lock")
  ) {
    throw new CloudOptimizerSessionError("Optimizer source ref is invalid.");
  }
  assertGitObjectId(target.commitSha, "Optimizer source commit");
  assertGitObjectId(target.treeSha, "Optimizer source tree");
  assertSha256(target.lockSha256, "Optimizer source package lock");
}

function assertOptimizerSecrets(references: readonly SecretReference[]): void {
  const targets = new Set<string>();
  if (
    references.length !== 1 ||
    references.some(
      (reference) =>
        !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(reference.sourceEnvironmentName) ||
        !ALLOWED_OPTIMIZER_SECRET_TARGETS.has(reference.targetEnvironmentName) ||
        reference.targetEnvironmentName === TRUSTED_GIT_CREDENTIAL_TARGET ||
        targets.has(reference.targetEnvironmentName),
    )
  ) {
    throw new CloudOptimizerSessionError(
      "Claude must receive only an explicit supported optimizer credential.",
    );
  }
  for (const reference of references) {
    targets.add(reference.targetEnvironmentName);
  }
}

function assertSandboxProfile(
  profile: CloudOptimizerSandboxProfile,
  foundryResourceName: string,
): void {
  const foundryHost = `${foundryResourceName}.services.ai.azure.com`;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u.test(profile.imageReference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(profile.imageDigest) ||
    !profile.imageReference.endsWith(`@${profile.imageDigest}`) ||
    !SAFE_ID.test(profile.regionClass) ||
    profile.resources.architecture !== "x86_64" ||
    !Number.isSafeInteger(profile.resources.cpuCores) ||
    profile.resources.cpuCores < 1 ||
    profile.resources.cpuCores > 32 ||
    !Number.isSafeInteger(profile.resources.memoryMiB) ||
    profile.resources.memoryMiB < 1024 ||
    profile.resources.memoryMiB > 131_072 ||
    !Number.isSafeInteger(profile.resources.diskMiB) ||
    profile.resources.diskMiB < 4096 ||
    profile.resources.diskMiB > 1_048_576 ||
    profile.resources.gpuClass !== undefined ||
    !Number.isSafeInteger(profile.lifetimeMs) ||
    profile.lifetimeMs < 1 ||
    profile.lifetimeMs > MAXIMUM_OPTIMIZER_LIFETIME_MS ||
    profile.networkAllowDomains.length < 1 ||
    profile.networkAllowDomains.some((host) => !SAFE_NETWORK_HOST.test(host)) ||
    new Set(profile.networkAllowDomains).size !== profile.networkAllowDomains.length ||
    !SAFE_FOUNDRY_RESOURCE.test(foundryResourceName) ||
    !profile.networkAllowDomains.includes(foundryHost) ||
    profile.networkAllowDomains.includes("api.anthropic.com")
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer requires a bounded immutable x86_64 cloud sandbox.",
    );
  }
}

function sourceIdentity(source: OptimizerGitSource): {
  readonly registrationId: string;
  readonly originRepositoryHash: string;
} {
  assertTarget(source.target);
  if (source.mode === "private-github") {
    assertRegisteredPrivateGitHubOrigin(source.registration, source.origin);
    if (
      source.target.commitSha !== source.registration.headCommit &&
      source.target.remoteRef === `refs/heads/${source.registration.branch}`
    ) {
      throw new CloudOptimizerSessionError(
        "The registered baseline ref must resolve to its frozen commit.",
      );
    }
    return {
      registrationId: source.registration.registrationId,
      originRepositoryHash: source.registration.originFingerprint.repositoryHash,
    };
  }
  assertSha256(source.registrationId, "Optimizer source registration");
  assertSha256(source.originRepositoryHash, "Optimizer source origin");
  assertArtifact(source.bundle, "application/vnd.git.bundle", "Optimizer source Git bundle");
  if (
    source.target.remoteRef !== source.bundleRef ||
    (source.bundleRef !== TRUSTED_GIT_SOURCE_BUNDLE_REF &&
      source.bundleRef !==
        trustedGitCandidateBundleRef(source.bundleRef.slice("refs/heads/df/bundle/".length)))
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer bundle source ref is outside the candidate namespace.",
    );
  }
  return {
    registrationId: source.registrationId,
    originRepositoryHash: source.originRepositoryHash,
  };
}

function exactSecretsForSource(
  source: OptimizerGitSource,
  optimizerSecrets: readonly SecretReference[],
): readonly SecretReference[] {
  const all =
    source.mode === "private-github"
      ? [source.origin.credential, ...optimizerSecrets]
      : [...optimizerSecrets];
  const targets = all.map((binding) => binding.targetEnvironmentName);
  if (new Set(targets).size !== targets.length) {
    throw new CloudOptimizerSessionError("Optimizer and Git credential planes overlap.");
  }
  return all;
}

function createSandboxRequest(input: {
  readonly options: CloudOptimizerSessionOptions;
  readonly source: OptimizerGitSource;
  readonly requestId: string;
}): SandboxCreateRequest {
  const secretReferences = exactSecretsForSource(
    input.source,
    input.options.optimizerSecretReferences,
  );
  return {
    requestId: input.requestId,
    imageReference: input.options.sandbox.imageReference,
    imageDigest: input.options.sandbox.imageDigest,
    regionClass: input.options.sandbox.regionClass,
    resources: structuredClone(input.options.sandbox.resources),
    network: {
      defaultAction: "deny",
      allowDomains: [...input.options.sandbox.networkAllowDomains],
    },
    lifetimeMs: input.options.sandbox.lifetimeMs,
    secretReferences,
  };
}

function setupCommand(input: {
  readonly phase: "proposal" | "analysis";
  readonly campaignId: string;
  readonly experimentId: string;
  readonly source: OptimizerGitSource;
  readonly identity: {
    readonly registrationId: string;
    readonly originRepositoryHash: string;
  };
  readonly pluginArtifact: TrustedCloudArtifactRef;
  readonly evidenceArtifact: TrustedCloudArtifactRef;
  readonly inputStateArtifact?: TrustedCloudArtifactRef;
}): RemoteCommandSpec {
  const arguments_ = [
    WORKER_REMOTE_PATH,
    "setup",
    "--phase",
    input.phase,
    "--campaign",
    input.campaignId,
    "--experiment",
    input.experimentId,
    "--source-mode",
    input.source.mode,
    "--registration",
    input.identity.registrationId,
    "--origin-repository-sha256",
    input.identity.originRepositoryHash,
    "--source-commit",
    input.source.target.commitSha,
    "--source-tree",
    input.source.target.treeSha,
    "--lock-sha256",
    input.source.target.lockSha256,
    "--source-ref",
    input.source.target.remoteRef,
    "--project-root",
    PROJECT_ROOT,
    "--plugin-archive",
    PLUGIN_ARCHIVE_REMOTE_PATH,
    "--plugin-archive-sha256",
    input.pluginArtifact.sha256,
    "--plugin-root",
    PLUGIN_ROOT,
    "--evidence-archive",
    EVIDENCE_ARCHIVE_REMOTE_PATH,
    "--evidence-archive-sha256",
    input.evidenceArtifact.sha256,
    "--evidence-root",
    RELEASED_EVIDENCE_ROOT,
    "--submission-root",
    SUBMISSION_ROOT,
    "--audit-root",
    AUDIT_ROOT,
    "--plugin-data-root",
    PLUGIN_DATA_ROOT,
    "--result",
    SETUP_RESULT_REMOTE_PATH,
  ];
  if (input.source.mode === "private-github") {
    arguments_.push("--remote", privateGitHubRemoteUrl(input.source.origin));
  } else {
    arguments_.push(
      "--source-bundle",
      SOURCE_BUNDLE_REMOTE_PATH,
      "--source-bundle-sha256",
      input.source.bundle.sha256,
    );
  }
  if (input.inputStateArtifact !== undefined) {
    arguments_.push(
      "--input-state",
      INPUT_STATE_REMOTE_PATH,
      "--input-state-sha256",
      input.inputStateArtifact.sha256,
    );
  }
  return {
    executable: "/usr/bin/node",
    arguments: arguments_,
    workingDirectory: WORKING_DIRECTORY,
    timeoutMs: 20 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences:
      input.source.mode === "private-github" ? [input.source.origin.credential] : [],
  };
}

function claudeWorkerCommand(
  spec: ReturnType<typeof createClaudeCodeLaunchSpec>,
  phase: "proposal" | "analysis",
  campaignId: string,
  experimentId_: string,
): RemoteCommandSpec {
  const encoded = Buffer.from(canonicalJson(spec.command), "utf8").toString("base64url");
  return {
    executionId: `claude-${canonicalHash({
      phase,
      campaignId,
      experimentId: experimentId_,
      command: spec.command,
    }).slice(0, 48)}`,
    executable: "/usr/bin/node",
    arguments: [
      WORKER_REMOTE_PATH,
      "run-claude",
      "--phase",
      phase,
      "--campaign",
      campaignId,
      "--experiment",
      experimentId_,
      "--command-base64url",
      encoded,
      "--result",
      CLAUDE_RESULT_REMOTE_PATH,
    ],
    workingDirectory: WORKING_DIRECTORY,
    timeoutMs: spec.command.timeoutMs + 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
    },
    secretReferences: spec.command.secretReferences,
  };
}

function proposalSealCommand(input: {
  readonly campaignId: string;
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly sourceCommit: string;
  readonly sourceLockSha256: string;
}): RemoteCommandSpec {
  return {
    executable: "/usr/bin/node",
    arguments: [
      WORKER_REMOTE_PATH,
      "seal-proposal",
      "--campaign",
      input.campaignId,
      "--experiment",
      input.experimentId,
      "--experiment-number",
      input.experimentNumber.toString(),
      "--source-commit",
      input.sourceCommit,
      "--source-lock-sha256",
      input.sourceLockSha256,
      "--project-root",
      PROJECT_ROOT,
      "--submission-root",
      SUBMISSION_ROOT,
      "--audit-root",
      AUDIT_ROOT,
      "--plugin-data-root",
      PLUGIN_DATA_ROOT,
      "--bundle",
      CANDIDATE_BUNDLE_REMOTE_PATH,
      "--diff",
      CANDIDATE_DIFF_REMOTE_PATH,
      "--state",
      OUTPUT_STATE_REMOTE_PATH,
      "--result",
      SEALED_RESULT_REMOTE_PATH,
    ],
    workingDirectory: WORKING_DIRECTORY,
    timeoutMs: 15 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences: [],
  };
}

function analysisSealCommand(input: {
  readonly campaignId: string;
  readonly experimentId: string;
  readonly candidateCommit: string;
}): RemoteCommandSpec {
  return {
    executable: "/usr/bin/node",
    arguments: [
      WORKER_REMOTE_PATH,
      "seal-analysis",
      "--campaign",
      input.campaignId,
      "--experiment",
      input.experimentId,
      "--candidate-commit",
      input.candidateCommit,
      "--project-root",
      PROJECT_ROOT,
      "--submission-root",
      SUBMISSION_ROOT,
      "--audit-root",
      AUDIT_ROOT,
      "--plugin-data-root",
      PLUGIN_DATA_ROOT,
      "--state",
      OUTPUT_STATE_REMOTE_PATH,
      "--result",
      SEALED_RESULT_REMOTE_PATH,
    ],
    workingDirectory: WORKING_DIRECTORY,
    timeoutMs: 10 * 60_000,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    secretReferences: [],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new CloudOptimizerSessionError(`${label} contains non-canonical fields.`);
  }
}

function assertContentHash(value: Readonly<Record<string, unknown>>): void {
  if (
    typeof value.contentHash !== "string" ||
    !SHA256.test(value.contentHash) ||
    value.contentHash !== computeContentHash(value)
  ) {
    throw new CloudOptimizerSessionError("Optimizer worker result content hash is invalid.");
  }
}

async function readCanonicalResult(
  reader: TrustedOptimizerArtifactReader,
  artifact: TrustedCloudArtifactRef,
): Promise<Readonly<Record<string, unknown>>> {
  if (
    artifact.mediaType !== "application/json" ||
    artifact.byteLength <= 0 ||
    artifact.byteLength > MAXIMUM_RESULT_BYTES
  ) {
    throw new CloudOptimizerSessionError("Optimizer result artifact metadata is invalid.");
  }
  const raw = await reader.readUtf8(artifact, MAXIMUM_RESULT_BYTES);
  if (
    Buffer.byteLength(raw, "utf8") !== artifact.byteLength ||
    createHash("sha256").update(raw).digest("hex") !== artifact.sha256
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer result bytes do not match their artifact reference.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudOptimizerSessionError("Optimizer result artifact is not JSON.");
  }
  if (!isRecord(parsed) || raw !== `${canonicalJson(parsed)}\n`) {
    throw new CloudOptimizerSessionError("Optimizer result artifact is not canonical JSON.");
  }
  assertContentHash(parsed);
  return parsed;
}

function parseSetupManifest(
  value: Readonly<Record<string, unknown>>,
  expected: {
    readonly phase: "proposal" | "analysis";
    readonly campaignId: string;
    readonly experimentId: string;
    readonly identity: {
      readonly registrationId: string;
      readonly originRepositoryHash: string;
    };
    readonly source: OptimizerGitSource;
    readonly pluginSha256: string;
    readonly evidenceSha256: string;
    readonly inputStateSha256: string | null;
  },
): OptimizerSetupManifest {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "domain",
      "phase",
      "campaignId",
      "experimentId",
      "sourceMode",
      "registrationId",
      "originRepositoryHash",
      "sourceCommit",
      "sourceTree",
      "lockSha256",
      "pluginArchiveSha256",
      "evidenceArchiveSha256",
      "inputStateSha256",
      "contentHash",
    ],
    "Optimizer setup manifest",
  );
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.optimizer-setup.v1" ||
    value.phase !== expected.phase ||
    value.campaignId !== expected.campaignId ||
    value.experimentId !== expected.experimentId ||
    value.sourceMode !== expected.source.mode ||
    value.registrationId !== expected.identity.registrationId ||
    value.originRepositoryHash !== expected.identity.originRepositoryHash ||
    value.sourceCommit !== expected.source.target.commitSha ||
    value.sourceTree !== expected.source.target.treeSha ||
    value.lockSha256 !== expected.source.target.lockSha256 ||
    value.pluginArchiveSha256 !== expected.pluginSha256 ||
    value.evidenceArchiveSha256 !== expected.evidenceSha256 ||
    value.inputStateSha256 !== expected.inputStateSha256
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer setup did not bind the requested source and inputs.",
    );
  }
  return value as unknown as OptimizerSetupManifest;
}

function parseClaudeSummary(value: unknown): ClaudeCodeSessionSummary {
  if (!isRecord(value)) {
    throw new CloudOptimizerSessionError("Claude summary is malformed.");
  }
  assertExactKeys(
    value,
    [
      "initialized",
      "pluginLoaded",
      "pluginErrors",
      "sessionId",
      "model",
      "result",
      "totalCostUsd",
      "turns",
    ],
    "Claude summary",
  );
  if (
    value.initialized !== true ||
    value.pluginLoaded !== true ||
    !Array.isArray(value.pluginErrors) ||
    value.pluginErrors.length !== 0 ||
    (value.sessionId !== null && typeof value.sessionId !== "string") ||
    typeof value.model !== "string" ||
    value.result !== "completed" ||
    typeof value.totalCostUsd !== "number" ||
    !Number.isFinite(value.totalCostUsd) ||
    value.totalCostUsd < 0 ||
    !Number.isSafeInteger(value.turns) ||
    (value.turns as number) < 1
  ) {
    throw new CloudOptimizerSessionError(
      "Claude did not complete one valid plugin-backed session.",
    );
  }
  return value as unknown as ClaudeCodeSessionSummary;
}

function parseClaudeManifest(
  value: Readonly<Record<string, unknown>>,
  expected: {
    readonly phase: "proposal" | "analysis";
    readonly campaignId: string;
    readonly experimentId: string;
    readonly model: string;
    readonly maximumBudgetUsd: number;
    readonly maximumTurns: number;
  },
): OptimizerClaudeManifest {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "domain",
      "phase",
      "campaignId",
      "experimentId",
      "summary",
      "exitCode",
      "stderrSha256",
      "contentHash",
    ],
    "Optimizer Claude manifest",
  );
  const summary = parseClaudeSummary(value.summary);
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.optimizer-claude.v1" ||
    value.phase !== expected.phase ||
    value.campaignId !== expected.campaignId ||
    value.experimentId !== expected.experimentId ||
    value.exitCode !== 0 ||
    typeof value.stderrSha256 !== "string" ||
    !SHA256.test(value.stderrSha256) ||
    summary.model !== expected.model ||
    summary.totalCostUsd > expected.maximumBudgetUsd ||
    summary.turns > expected.maximumTurns
  ) {
    throw new CloudOptimizerSessionError(
      "Claude execution result does not match the frozen optimizer identity.",
    );
  }
  return {
    ...(value as unknown as OptimizerClaudeManifest),
    summary,
  };
}

function artifactMetadata(value: unknown, label: string): OptimizerSealedArtifactMetadata {
  if (!isRecord(value)) {
    throw new CloudOptimizerSessionError(`${label} metadata is malformed.`);
  }
  assertExactKeys(value, ["sha256", "byteLength"], label);
  if (
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) <= 0
  ) {
    throw new CloudOptimizerSessionError(`${label} metadata is invalid.`);
  }
  return value as unknown as OptimizerSealedArtifactMetadata;
}

function parseFrozenHypothesis(value: unknown): FrozenHypothesis {
  if (!isRecord(value)) {
    throw new CloudOptimizerSessionError("Frozen hypothesis is malformed.");
  }
  assertExactKeys(
    value,
    [
      "hash",
      "sourceBriefHash",
      "causalClaim",
      "intervention",
      "predictedRepairBehavior",
      "predictedFreshEffect",
      "falsificationCriteria",
      "rollbackCondition",
    ],
    "Frozen hypothesis",
  );
  if (
    typeof value.hash !== "string" ||
    !SHA256.test(value.hash) ||
    (value.sourceBriefHash !== null &&
      (typeof value.sourceBriefHash !== "string" || !SHA256.test(value.sourceBriefHash))) ||
    typeof value.causalClaim !== "string" ||
    typeof value.intervention !== "string" ||
    typeof value.predictedRepairBehavior !== "string" ||
    typeof value.predictedFreshEffect !== "string" ||
    !Array.isArray(value.falsificationCriteria) ||
    value.falsificationCriteria.length < 1 ||
    value.falsificationCriteria.some((item) => typeof item !== "string") ||
    typeof value.rollbackCondition !== "string"
  ) {
    throw new CloudOptimizerSessionError("Frozen hypothesis is invalid.");
  }
  return value as unknown as FrozenHypothesis;
}

function parseFrozenCandidate(value: unknown): FrozenCandidate {
  if (!isRecord(value)) {
    throw new CloudOptimizerSessionError("Frozen candidate is malformed.");
  }
  assertExactKeys(
    value,
    ["commit", "patchHash", "changedFiles", "mutationCategory"],
    "Frozen candidate",
  );
  if (
    typeof value.commit !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.commit) ||
    typeof value.patchHash !== "string" ||
    !SHA256.test(value.patchHash) ||
    !Array.isArray(value.changedFiles) ||
    value.changedFiles.length < 1 ||
    value.changedFiles.some((item) => typeof item !== "string") ||
    typeof value.mutationCategory !== "string"
  ) {
    throw new CloudOptimizerSessionError("Frozen candidate is invalid.");
  }
  return value as unknown as FrozenCandidate;
}

function assertDownloadedArtifact(
  artifact: TrustedCloudArtifactRef,
  metadata: OptimizerSealedArtifactMetadata,
  mediaType: string,
  label: string,
): void {
  if (
    artifact.mediaType !== mediaType ||
    artifact.sha256 !== metadata.sha256 ||
    artifact.byteLength !== metadata.byteLength
  ) {
    throw new CloudOptimizerSessionError(`${label} does not match the sealed worker manifest.`);
  }
}

function parseProposalSeal(
  value: Readonly<Record<string, unknown>>,
  expected: {
    readonly campaignId: string;
    readonly experimentId: string;
    readonly sourceCommit: string;
    readonly sourceLockSha256: string;
  },
): OptimizerProposalSealManifest {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "domain",
      "campaignId",
      "experimentId",
      "sourceCommit",
      "candidateCommit",
      "candidateTree",
      "lockSha256",
      "bundleRef",
      "hypothesis",
      "candidate",
      "hypothesisReceiptId",
      "candidateReceiptId",
      "integrityPolicyHash",
      "bundle",
      "diff",
      "state",
      "contentHash",
    ],
    "Optimizer proposal seal",
  );
  const hypothesis = parseFrozenHypothesis(value.hypothesis);
  const candidate = parseFrozenCandidate(value.candidate);
  const bundle = artifactMetadata(value.bundle, "Candidate bundle");
  const diff = artifactMetadata(value.diff, "Candidate diff");
  const state = artifactMetadata(value.state, "Optimizer state");
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.optimizer-proposal.v1" ||
    value.campaignId !== expected.campaignId ||
    value.experimentId !== expected.experimentId ||
    value.sourceCommit !== expected.sourceCommit ||
    value.candidateCommit !== candidate.commit ||
    candidate.patchHash !== diff.sha256 ||
    typeof value.candidateTree !== "string" ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value.candidateTree) ||
    value.lockSha256 !== expected.sourceLockSha256 ||
    value.bundleRef !== trustedGitCandidateBundleRef(expected.experimentId) ||
    typeof value.hypothesisReceiptId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.hypothesisReceiptId) ||
    typeof value.candidateReceiptId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.candidateReceiptId) ||
    typeof value.integrityPolicyHash !== "string" ||
    !SHA256.test(value.integrityPolicyHash)
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer proposal seal is invalid or detached from its source.",
    );
  }
  return {
    ...(value as unknown as OptimizerProposalSealManifest),
    hypothesis,
    candidate,
    bundle,
    diff,
    state,
  };
}

function parseAnalysisSeal(
  value: Readonly<Record<string, unknown>>,
  expected: {
    readonly campaignId: string;
    readonly experimentId: string;
    readonly candidateCommit: string;
  },
): OptimizerAnalysisSealManifest {
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "domain",
      "campaignId",
      "experimentId",
      "candidateCommit",
      "analysisHash",
      "rollbackRequired",
      "analysisReceiptId",
      "state",
      "contentHash",
    ],
    "Optimizer analysis seal",
  );
  const state = artifactMetadata(value.state, "Optimizer state");
  if (
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.optimizer-analysis.v1" ||
    value.campaignId !== expected.campaignId ||
    value.experimentId !== expected.experimentId ||
    value.candidateCommit !== expected.candidateCommit ||
    typeof value.analysisHash !== "string" ||
    !SHA256.test(value.analysisHash) ||
    typeof value.rollbackRequired !== "boolean" ||
    typeof value.analysisReceiptId !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/u.test(value.analysisReceiptId)
  ) {
    throw new CloudOptimizerSessionError(
      "Optimizer analysis seal is invalid or detached from its candidate.",
    );
  }
  return {
    ...(value as unknown as OptimizerAnalysisSealManifest),
    state,
  };
}

function campaignIdFor(experiment: ExperimentIdentity): string {
  if (!SAFE_ID.test(experiment.lineageId)) {
    throw new CloudOptimizerSessionError("Optimizer campaign identifier is malformed.");
  }
  return experiment.lineageId;
}

export class CloudOnlyClaudeOptimizerSession {
  readonly #options: CloudOptimizerSessionOptions;

  constructor(options: CloudOptimizerSessionOptions) {
    assertSandboxProfile(options.sandbox, options.claude.foundryResourceName);
    assertOptimizerSecrets(options.optimizerSecretReferences);
    assertArtifact(
      options.workerArtifact,
      "text/javascript",
      "Optimizer session worker",
      4 * 1024 * 1024,
    );
    assertArtifact(
      options.pluginArtifact,
      "application/x-tar",
      "Claude optimizer plugin",
      512 * 1024 * 1024,
    );
    if (options.sandbox.lifetimeMs < options.claude.timeoutMs + 42 * 60_000) {
      throw new CloudOptimizerSessionError(
        "Optimizer lease leaves insufficient time for setup, Claude, sealing, and confirmed teardown.",
      );
    }
    this.#options = {
      ...options,
      sandbox: structuredClone(options.sandbox),
      workerArtifact: structuredClone(options.workerArtifact),
      pluginArtifact: structuredClone(options.pluginArtifact),
      claude: structuredClone(options.claude),
      optimizerSecretReferences: structuredClone(options.optimizerSecretReferences),
    };
  }

  async propose(input: CloudOptimizerProposalInput): Promise<CloudOptimizerProposalResult> {
    const phase = "proposal" as const;
    const id = experimentId(input.context.experiment);
    const campaignId = campaignIdFor(input.context.experiment);
    if (input.source.target.commitSha !== input.context.activeChampion.activeCommit) {
      throw new CloudOptimizerSessionError("Optimizer source is not the active champion.");
    }
    if (input.context.sourceOnlyBootstrap !== (input.context.experiment.number === 1)) {
      throw new CloudOptimizerSessionError("Optimizer bootstrap evidence policy is inconsistent.");
    }
    assertArtifact(
      input.releasedEvidence,
      "application/x-tar",
      "Released optimizer evidence",
      512 * 1024 * 1024,
    );
    const identity = sourceIdentity(input.source);
    const requestId = `optimizer-${canonicalHash({
      phase,
      campaignId,
      id,
      source: input.source.target,
      evidence: input.releasedEvidence.sha256,
      plugin: this.#options.pluginArtifact.sha256,
    }).slice(0, 48)}`;
    return this.#runProposal({
      input,
      identity,
      requestId,
      phase,
      campaignId,
      id,
    });
  }

  async analyze(input: CloudOptimizerAnalysisInput): Promise<CloudOptimizerAnalysisResult> {
    const phase = "analysis" as const;
    const id = experimentId(input.experiment);
    const campaignId = campaignIdFor(input.experiment);
    if (input.proposal.seal.experimentId !== id || input.proposal.seal.campaignId !== campaignId) {
      throw new CloudOptimizerSessionError("Analysis proposal belongs to another experiment.");
    }
    assertArtifact(
      input.releasedEvidence,
      "application/x-tar",
      "Released analysis evidence",
      512 * 1024 * 1024,
    );
    assertArtifact(
      input.proposal.sessionState,
      "application/x-tar",
      "Optimizer proposal state",
      512 * 1024 * 1024,
    );
    const source: OptimizerBundleGitSource = {
      mode: "trusted-bundle",
      registrationId: input.proposal.setup.registrationId,
      originRepositoryHash: input.proposal.setup.originRepositoryHash,
      bundle: input.proposal.candidateBundle,
      bundleRef: input.proposal.seal.bundleRef,
      target: {
        remoteRef: input.proposal.seal.bundleRef,
        commitSha: input.proposal.seal.candidateCommit,
        treeSha: input.proposal.seal.candidateTree,
        lockSha256: input.proposal.seal.lockSha256,
      },
    };
    const identity = sourceIdentity(source);
    const requestId = `optimizer-${canonicalHash({
      phase,
      campaignId,
      id,
      candidate: input.proposal.seal.candidateCommit,
      evidence: input.releasedEvidence.sha256,
      state: input.proposal.sessionState.sha256,
    }).slice(0, 48)}`;
    return this.#runAnalysis({
      input,
      source,
      identity,
      requestId,
      phase,
      campaignId,
      id,
    });
  }

  async #prepareLease(input: {
    readonly source: OptimizerGitSource;
    readonly requestId: string;
  }): Promise<{ readonly request: SandboxCreateRequest; readonly lease: SandboxLease }> {
    const request = createSandboxRequest({
      options: this.#options,
      source: input.source,
      requestId: input.requestId,
    });
    await requireCompatibleProvider(this.#options.provider, {
      requestId: `probe-${canonicalHash(input.requestId).slice(0, 32)}`,
      imageDigest: request.imageDigest,
      regionClass: request.regionClass,
      resources: request.resources,
      requireDockerInDocker: false,
      requireGpu: false,
    });
    const lease = await this.#options.provider.create(request);
    return { request, lease };
  }

  async #uploadCommon(
    lease: SandboxLease,
    source: OptimizerGitSource,
    evidence: TrustedCloudArtifactRef,
    state?: TrustedCloudArtifactRef,
  ): Promise<void> {
    await this.#options.provider.upload(lease, this.#options.workerArtifact, WORKER_REMOTE_PATH);
    await this.#options.provider.upload(
      lease,
      this.#options.pluginArtifact,
      PLUGIN_ARCHIVE_REMOTE_PATH,
    );
    await this.#options.provider.upload(lease, evidence, EVIDENCE_ARCHIVE_REMOTE_PATH);
    if (source.mode === "trusted-bundle") {
      await this.#options.provider.upload(lease, source.bundle, SOURCE_BUNDLE_REMOTE_PATH);
    }
    if (state !== undefined) {
      await this.#options.provider.upload(lease, state, INPUT_STATE_REMOTE_PATH);
    }
  }

  async #execute(
    lease: SandboxLease,
    command: RemoteCommandSpec,
    label: string,
  ): Promise<RemoteExecutionReceipt> {
    const receipt = await this.#options.provider.execute(lease, command);
    assertSuccessfulCloudExecution(receipt, label);
    return receipt;
  }

  async #runProposal(input: {
    readonly input: CloudOptimizerProposalInput;
    readonly identity: {
      readonly registrationId: string;
      readonly originRepositoryHash: string;
    };
    readonly requestId: string;
    readonly phase: "proposal";
    readonly campaignId: string;
    readonly id: string;
  }): Promise<CloudOptimizerProposalResult> {
    let lease: SandboxLease | undefined;
    let result: CloudOptimizerProposalResult | undefined;
    let failure: { readonly error: unknown } | undefined;
    let teardownFailure: { readonly error: unknown } | undefined;
    try {
      ({ lease } = await this.#prepareLease({
        source: input.input.source,
        requestId: input.requestId,
      }));
      await this.#uploadCommon(lease, input.input.source, input.input.releasedEvidence);
      const setupReceipt = await this.#execute(
        lease,
        setupCommand({
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          source: input.input.source,
          identity: input.identity,
          pluginArtifact: this.#options.pluginArtifact,
          evidenceArtifact: input.input.releasedEvidence,
        }),
        "Optimizer setup",
      );
      const setupManifestArtifact = await this.#options.provider.download(
        lease,
        SETUP_RESULT_REMOTE_PATH,
        {
          mediaType: "application/json",
          maximumByteLength: MAXIMUM_RESULT_BYTES,
        },
      );
      const setup = parseSetupManifest(
        await readCanonicalResult(this.#options.artifactReader, setupManifestArtifact),
        {
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          identity: input.identity,
          source: input.input.source,
          pluginSha256: this.#options.pluginArtifact.sha256,
          evidenceSha256: input.input.releasedEvidence.sha256,
          inputStateSha256: null,
        },
      );
      const launch = createClaudeCodeLaunchSpec({
        ...this.#options.claude,
        projectRoot: PROJECT_ROOT,
        pluginRoot: PLUGIN_ROOT,
        releasedEvidenceRoot: RELEASED_EVIDENCE_ROOT,
        submissionRoot: SUBMISSION_ROOT,
        auditRoot: AUDIT_ROOT,
        pluginDataRoot: PLUGIN_DATA_ROOT,
        campaignId: input.campaignId,
        experimentNumber: input.input.context.experiment.number,
        phase: input.phase,
        secretReferences: this.#options.optimizerSecretReferences,
      });
      const claudeReceipt = await this.#execute(
        lease,
        claudeWorkerCommand(launch, input.phase, input.campaignId, input.id),
        "Claude proposal",
      );
      const claudeManifestArtifact = await this.#options.provider.download(
        lease,
        CLAUDE_RESULT_REMOTE_PATH,
        {
          mediaType: "application/json",
          maximumByteLength: MAXIMUM_RESULT_BYTES,
        },
      );
      const claude = parseClaudeManifest(
        await readCanonicalResult(this.#options.artifactReader, claudeManifestArtifact),
        {
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          model: this.#options.claude.model,
          maximumBudgetUsd: this.#options.claude.maximumBudgetUsd,
          maximumTurns: this.#options.claude.maximumTurns,
        },
      );
      const sealReceipt = await this.#execute(
        lease,
        proposalSealCommand({
          campaignId: input.campaignId,
          experimentId: input.id,
          experimentNumber: input.input.context.experiment.number,
          sourceCommit: input.input.source.target.commitSha,
          sourceLockSha256: input.input.source.target.lockSha256,
        }),
        "Optimizer proposal sealing",
      );
      const [sealManifestArtifact, candidateBundle, candidateDiff, sessionState] =
        await Promise.all([
          this.#options.provider.download(lease, SEALED_RESULT_REMOTE_PATH, {
            mediaType: "application/json",
            maximumByteLength: MAXIMUM_RESULT_BYTES,
          }),
          this.#options.provider.download(lease, CANDIDATE_BUNDLE_REMOTE_PATH, {
            mediaType: "application/vnd.git.bundle",
            maximumByteLength: 2 * 1024 * 1024 * 1024,
          }),
          this.#options.provider.download(lease, CANDIDATE_DIFF_REMOTE_PATH, {
            mediaType: "text/x-diff",
            maximumByteLength: 2 * 1024 * 1024 * 1024,
          }),
          this.#options.provider.download(lease, OUTPUT_STATE_REMOTE_PATH, {
            mediaType: "application/x-tar",
            maximumByteLength: 2 * 1024 * 1024 * 1024,
          }),
        ]);
      const seal = parseProposalSeal(
        await readCanonicalResult(this.#options.artifactReader, sealManifestArtifact),
        {
          campaignId: input.campaignId,
          experimentId: input.id,
          sourceCommit: input.input.source.target.commitSha,
          sourceLockSha256: input.input.source.target.lockSha256,
        },
      );
      assertDownloadedArtifact(
        candidateBundle,
        seal.bundle,
        "application/vnd.git.bundle",
        "Candidate bundle",
      );
      assertDownloadedArtifact(candidateDiff, seal.diff, "text/x-diff", "Candidate diff");
      assertDownloadedArtifact(sessionState, seal.state, "application/x-tar", "Optimizer state");
      result = {
        proposal: {
          hypothesis: seal.hypothesis,
          candidate: seal.candidate,
        },
        setup,
        claude,
        seal,
        candidateBundle,
        candidateDiff,
        sessionState,
        setupManifestArtifact,
        claudeManifestArtifact,
        sealManifestArtifact,
        executionReceipts: {
          setup: setupReceipt,
          claude: claudeReceipt,
          seal: sealReceipt,
        },
      };
    } catch (error) {
      failure = { error };
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch (error) {
          teardownFailure = { error };
        }
      }
    }
    if (teardownFailure !== undefined) {
      throw new CloudOptimizerSessionError(
        "Optimizer sandbox teardown failed; no result is usable.",
        {
          cause:
            failure === undefined
              ? teardownFailure.error
              : new AggregateError(
                  [failure.error, teardownFailure.error],
                  "Optimizer proposal and sandbox teardown both failed.",
                ),
        },
      );
    }
    if (failure !== undefined || result === undefined) {
      throw new CloudOptimizerSessionError("Cloud-only optimizer proposal failed closed.", {
        cause: failure?.error,
      });
    }
    return result;
  }

  async #runAnalysis(input: {
    readonly input: CloudOptimizerAnalysisInput;
    readonly source: OptimizerBundleGitSource;
    readonly identity: {
      readonly registrationId: string;
      readonly originRepositoryHash: string;
    };
    readonly requestId: string;
    readonly phase: "analysis";
    readonly campaignId: string;
    readonly id: string;
  }): Promise<CloudOptimizerAnalysisResult> {
    let lease: SandboxLease | undefined;
    let result: CloudOptimizerAnalysisResult | undefined;
    let failure: { readonly error: unknown } | undefined;
    let teardownFailure: { readonly error: unknown } | undefined;
    try {
      ({ lease } = await this.#prepareLease({
        source: input.source,
        requestId: input.requestId,
      }));
      await this.#uploadCommon(
        lease,
        input.source,
        input.input.releasedEvidence,
        input.input.proposal.sessionState,
      );
      const setupReceipt = await this.#execute(
        lease,
        setupCommand({
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          source: input.source,
          identity: input.identity,
          pluginArtifact: this.#options.pluginArtifact,
          evidenceArtifact: input.input.releasedEvidence,
          inputStateArtifact: input.input.proposal.sessionState,
        }),
        "Optimizer analysis setup",
      );
      const setupManifestArtifact = await this.#options.provider.download(
        lease,
        SETUP_RESULT_REMOTE_PATH,
        {
          mediaType: "application/json",
          maximumByteLength: MAXIMUM_RESULT_BYTES,
        },
      );
      const setup = parseSetupManifest(
        await readCanonicalResult(this.#options.artifactReader, setupManifestArtifact),
        {
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          identity: input.identity,
          source: input.source,
          pluginSha256: this.#options.pluginArtifact.sha256,
          evidenceSha256: input.input.releasedEvidence.sha256,
          inputStateSha256: input.input.proposal.sessionState.sha256,
        },
      );
      const launch = createClaudeCodeLaunchSpec({
        ...this.#options.claude,
        projectRoot: PROJECT_ROOT,
        pluginRoot: PLUGIN_ROOT,
        releasedEvidenceRoot: RELEASED_EVIDENCE_ROOT,
        submissionRoot: SUBMISSION_ROOT,
        auditRoot: AUDIT_ROOT,
        pluginDataRoot: PLUGIN_DATA_ROOT,
        campaignId: input.campaignId,
        experimentNumber: input.input.experiment.number,
        phase: input.phase,
        secretReferences: this.#options.optimizerSecretReferences,
      });
      const claudeReceipt = await this.#execute(
        lease,
        claudeWorkerCommand(launch, input.phase, input.campaignId, input.id),
        "Claude analysis",
      );
      const claudeManifestArtifact = await this.#options.provider.download(
        lease,
        CLAUDE_RESULT_REMOTE_PATH,
        {
          mediaType: "application/json",
          maximumByteLength: MAXIMUM_RESULT_BYTES,
        },
      );
      const claude = parseClaudeManifest(
        await readCanonicalResult(this.#options.artifactReader, claudeManifestArtifact),
        {
          phase: input.phase,
          campaignId: input.campaignId,
          experimentId: input.id,
          model: this.#options.claude.model,
          maximumBudgetUsd: this.#options.claude.maximumBudgetUsd,
          maximumTurns: this.#options.claude.maximumTurns,
        },
      );
      const sealReceipt = await this.#execute(
        lease,
        analysisSealCommand({
          campaignId: input.campaignId,
          experimentId: input.id,
          candidateCommit: input.source.target.commitSha,
        }),
        "Optimizer analysis sealing",
      );
      const [sealManifestArtifact, sessionState] = await Promise.all([
        this.#options.provider.download(lease, SEALED_RESULT_REMOTE_PATH, {
          mediaType: "application/json",
          maximumByteLength: MAXIMUM_RESULT_BYTES,
        }),
        this.#options.provider.download(lease, OUTPUT_STATE_REMOTE_PATH, {
          mediaType: "application/x-tar",
          maximumByteLength: 2 * 1024 * 1024 * 1024,
        }),
      ]);
      const seal = parseAnalysisSeal(
        await readCanonicalResult(this.#options.artifactReader, sealManifestArtifact),
        {
          campaignId: input.campaignId,
          experimentId: input.id,
          candidateCommit: input.source.target.commitSha,
        },
      );
      assertDownloadedArtifact(sessionState, seal.state, "application/x-tar", "Optimizer state");
      result = {
        analysisHash: seal.analysisHash,
        rollbackRequired: seal.rollbackRequired,
        setup,
        claude,
        seal,
        sessionState,
        setupManifestArtifact,
        claudeManifestArtifact,
        sealManifestArtifact,
        executionReceipts: {
          setup: setupReceipt,
          claude: claudeReceipt,
          seal: sealReceipt,
        },
      };
    } catch (error) {
      failure = { error };
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch (error) {
          teardownFailure = { error };
        }
      }
    }
    if (teardownFailure !== undefined) {
      throw new CloudOptimizerSessionError(
        "Optimizer analysis sandbox teardown failed; no result is usable.",
        {
          cause:
            failure === undefined
              ? teardownFailure.error
              : new AggregateError(
                  [failure.error, teardownFailure.error],
                  "Optimizer analysis and sandbox teardown both failed.",
                ),
        },
      );
    }
    if (failure !== undefined || result === undefined) {
      throw new CloudOptimizerSessionError("Cloud-only optimizer analysis failed closed.", {
        cause: failure?.error,
      });
    }
    return result;
  }
}

export interface CloudOptimizerSessionRecordStore {
  /**
   * Implementations are immutable/idempotent by experiment identity and must
   * reject a second record with different canonical content.
   */
  put(experiment: ExperimentIdentity, result: CloudOptimizerProposalResult): Promise<void>;
  get(experiment: ExperimentIdentity): Promise<CloudOptimizerProposalResult | null>;
  putAnalysis(experiment: ExperimentIdentity, result: CloudOptimizerAnalysisResult): Promise<void>;
  getAnalysis(experiment: ExperimentIdentity): Promise<CloudOptimizerAnalysisResult | null>;
}

export interface CloudOptimizerAdapterResolver {
  proposal(input: OptimizerContext): Promise<{
    readonly source: OptimizerGitSource;
    readonly releasedEvidence: TrustedCloudArtifactRef;
  }>;
  analysis(input: {
    readonly experiment: ExperimentIdentity;
    readonly hypothesis: FrozenHypothesis;
    readonly candidate: FrozenCandidate;
    readonly repair: RepairAggregate | null;
    readonly validation: ValidationAggregate | null;
  }): Promise<{ readonly releasedEvidence: TrustedCloudArtifactRef }>;
}

/**
 * Composes the cloud session into the orchestrator without adding a local
 * execution escape hatch. Durable stores must retain only trusted artifact
 * references/receipts; they never need the candidate diff bytes.
 */
export function createCloudOnlyClaudeOptimizerAdapter(input: {
  readonly session: CloudOnlyClaudeOptimizerSession;
  readonly resolver: CloudOptimizerAdapterResolver;
  readonly records: CloudOptimizerSessionRecordStore;
}): OptimizerAdapter {
  return {
    propose: async (context) => {
      const existing = await input.records.get(context.experiment);
      if (existing !== null) {
        if (
          existing.seal.campaignId !== context.experiment.lineageId ||
          existing.seal.experimentId !== experimentId(context.experiment) ||
          existing.seal.sourceCommit !== context.activeChampion.activeCommit ||
          existing.proposal.hypothesis.sourceBriefHash !==
            (context.diagnosticBrief?.hash ?? null) ||
          context.sourceOnlyBootstrap !== (context.experiment.number === 1)
        ) {
          throw new CloudOptimizerSessionError(
            "Stored optimizer proposal is detached from the requested context.",
          );
        }
        return existing.proposal;
      }
      const resolved = await input.resolver.proposal(context);
      const result = await input.session.propose({
        context,
        source: resolved.source,
        releasedEvidence: resolved.releasedEvidence,
      });
      await input.records.put(context.experiment, result);
      return result.proposal;
    },
    analyze: async (analysisInput) => {
      const proposal = await input.records.get(analysisInput.experiment);
      if (
        proposal === null ||
        canonicalHash(proposal.proposal.hypothesis) !== canonicalHash(analysisInput.hypothesis) ||
        canonicalHash(proposal.proposal.candidate) !== canonicalHash(analysisInput.candidate)
      ) {
        throw new CloudOptimizerSessionError(
          "Optimizer analysis cannot resolve the exact sealed proposal.",
        );
      }
      const existingAnalysis = await input.records.getAnalysis(analysisInput.experiment);
      if (existingAnalysis !== null) {
        if (
          existingAnalysis.seal.candidateCommit !== analysisInput.candidate.commit ||
          existingAnalysis.seal.experimentId !== experimentId(analysisInput.experiment)
        ) {
          throw new CloudOptimizerSessionError(
            "Stored optimizer analysis is detached from the requested candidate.",
          );
        }
        return {
          hash: existingAnalysis.analysisHash,
          rollbackRequired: existingAnalysis.rollbackRequired,
        };
      }
      const resolved = await input.resolver.analysis(analysisInput);
      const result = await input.session.analyze({
        experiment: analysisInput.experiment,
        proposal,
        releasedEvidence: resolved.releasedEvidence,
      });
      await input.records.putAnalysis(analysisInput.experiment, result);
      return {
        hash: result.analysisHash,
        rollbackRequired: result.rollbackRequired,
      };
    },
  };
}
