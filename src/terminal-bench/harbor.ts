import type {
  RemoteCommandSpec,
  SecretReference,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { canonicalHash } from "../schemas/canonical.js";
import { hashTerminalBench21Pin, type TerminalBench21Pin } from "./pin.js";
import type {
  MatchedArmKind,
  TrustedEvaluationStage,
} from "./trusted.js";

export const HARBOR_AGENT_ISOLATION_POLICY = {
  policyVersion: "harbor-agent-isolation-v2",
  taskInstructionOnly: true,
  graderMountIntoAgent: "forbidden",
  verifierMountIntoAgent: "forbidden",
  graderCredentialAccess: "forbidden",
  rawResultExport: "forbidden",
  candidateChampionCellMatching: "required-for-validation-and-shadow",
  extensions: "disabled",
  skills: "disabled",
  contextFiles: "disabled",
  sessionPersistence: "disabled",
  taskConcurrency: 1,
  harborRetries: 0,
} as const;

export type HarborAgentIsolationPolicy = typeof HARBOR_AGENT_ISOLATION_POLICY;

export function hashHarborAgentIsolationPolicy(): string {
  return canonicalHash(HARBOR_AGENT_ISOLATION_POLICY);
}

export type TrustedHarborUploadRole =
  | "config-repair"
  | "config-ab"
  | "config-ba"
  | "output-packager"
  | "pi-adapter"
  | "candidate-runtime"
  | "champion-runtime";

export interface TrustedHarborUpload {
  readonly role: TrustedHarborUploadRole;
  readonly artifact: TrustedCloudArtifactRef;
  readonly remotePath: string;
}

export interface TrustedHarborInvocation {
  readonly invocationId: string;
  readonly order: "repair" | "AB" | "BA";
  readonly configSha256: string;
  readonly remoteConfigPath: string;
  /** Harbor writes a directory at this path. It never crosses the artifact bridge. */
  readonly remoteHarborJobPath: string;
  /** Deterministic regular-file archive produced from `remoteHarborJobPath`. */
  readonly remoteOutputPath: string;
  readonly cellCount: number;
  readonly armCount: number;
  readonly agentOrder: readonly MatchedArmKind[];
  readonly nAttempts: 1;
  readonly nConcurrentTrials: 1;
  readonly harborRetries: 0;
}

/**
 * A complete, content-addressed cloud execution bundle. Hidden task names live
 * only inside the config artifacts; this release-safe envelope exposes only
 * digests and fixed remote paths.
 */
export interface TrustedHarborJobArtifact {
  readonly sensitivity: "hidden-harbor-job";
  readonly requestId: string;
  readonly stage: TrustedEvaluationStage;
  readonly pinHash: string;
  readonly isolationPolicyHash: string;
  readonly jobSha256: string;
  readonly cellCount: number;
  readonly armCount: number;
  readonly uploads: readonly TrustedHarborUpload[];
  readonly invocations: readonly TrustedHarborInvocation[];
}

export interface HarborInvocationOptions {
  readonly harborExecutable: string;
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly pin: TerminalBench21Pin;
  readonly job: TrustedHarborJobArtifact;
  readonly invocation: TrustedHarborInvocation;
  readonly secretReferences: readonly SecretReference[];
}

export interface HarborOutputPackageOptions {
  readonly nodeExecutable: string;
  readonly workingDirectory: string;
  readonly timeoutMs: number;
  readonly pin: TerminalBench21Pin;
  readonly job: TrustedHarborJobArtifact;
  readonly invocation: TrustedHarborInvocation;
  readonly executionId: string;
}

const ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_PATH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

export class HarborSpecificationError extends Error {
  override readonly name = "HarborSpecificationError";
}

function assertAbsolutePath(value: string, label: string): void {
  if (!ABSOLUTE_PATH.test(value) || value.includes("/../")) {
    throw new HarborSpecificationError(`${label} must be an absolute traversal-free path.`);
  }
}

function assertCloudArtifact(
  upload: TrustedHarborUpload,
  paths: Set<string>,
  uris: Set<string>,
): void {
  assertAbsolutePath(upload.remotePath, `${upload.role} remote path`);
  if (
    !TRUSTED_URI.test(upload.artifact.uri) ||
    upload.artifact.uri.includes("..") ||
    !SHA256.test(upload.artifact.sha256) ||
    !Number.isSafeInteger(upload.artifact.byteLength) ||
    upload.artifact.byteLength <= 0 ||
    upload.artifact.byteLength > MAX_ARTIFACT_BYTES ||
    upload.artifact.mediaType.length === 0 ||
    upload.artifact.mediaType.length > 128 ||
    paths.has(upload.remotePath) ||
    uris.has(upload.artifact.uri)
  ) {
    throw new HarborSpecificationError(
      "Harbor uploads must be unique, bounded, content-addressed trusted artifacts.",
    );
  }
  paths.add(upload.remotePath);
  uris.add(upload.artifact.uri);
}

function expectedRoles(stage: TrustedEvaluationStage): readonly TrustedHarborUploadRole[] {
  return stage === "repair"
    ? [
        "config-repair",
        "output-packager",
        "pi-adapter",
        "candidate-runtime",
      ]
    : [
        "config-ab",
        "config-ba",
        "output-packager",
        "pi-adapter",
        "candidate-runtime",
        "champion-runtime",
      ];
}

function expectedInvocationOrders(
  stage: TrustedEvaluationStage,
): readonly TrustedHarborInvocation["order"][] {
  return stage === "repair" ? ["repair"] : ["AB", "BA"];
}

function expectedAgentOrder(
  order: TrustedHarborInvocation["order"],
): readonly MatchedArmKind[] {
  if (order === "repair") return ["candidate"];
  return order === "AB" ? ["candidate", "champion"] : ["champion", "candidate"];
}

function configRoleForOrder(
  order: TrustedHarborInvocation["order"],
): TrustedHarborUploadRole {
  if (order === "repair") return "config-repair";
  return order === "AB" ? "config-ab" : "config-ba";
}

function jobHashPayload(job: TrustedHarborJobArtifact): Readonly<Record<string, unknown>> {
  return {
    sensitivity: job.sensitivity,
    requestId: job.requestId,
    stage: job.stage,
    pinHash: job.pinHash,
    isolationPolicyHash: job.isolationPolicyHash,
    cellCount: job.cellCount,
    armCount: job.armCount,
    uploads: job.uploads,
    invocations: job.invocations,
  };
}

export function computeTrustedHarborJobHash(job: TrustedHarborJobArtifact): string {
  return canonicalHash(jobHashPayload(job));
}

export function assertTrustedHarborJobArtifact(
  job: TrustedHarborJobArtifact,
  expectedPinHash: string,
): void {
  const requiredRoles = expectedRoles(job.stage);
  const roles = job.uploads.map((upload) => upload.role);
  if (
    job.sensitivity !== "hidden-harbor-job" ||
    !SAFE_ID.test(job.requestId) ||
    job.pinHash !== expectedPinHash ||
    job.isolationPolicyHash !== hashHarborAgentIsolationPolicy() ||
    !SHA256.test(job.jobSha256) ||
    !Number.isSafeInteger(job.cellCount) ||
    job.cellCount !== (job.stage === "repair" ? 5 : 12) ||
    !Number.isSafeInteger(job.armCount) ||
    job.armCount !== (job.stage === "repair" ? 5 : 24) ||
    roles.length !== requiredRoles.length ||
    new Set(roles).size !== roles.length ||
    requiredRoles.some((role) => !roles.includes(role))
  ) {
    throw new HarborSpecificationError(
      "Trusted Harbor job does not match its benchmark pin, stage, or isolation policy.",
    );
  }

  const uploadPaths = new Set<string>();
  const uploadUris = new Set<string>();
  for (const upload of job.uploads) {
    assertCloudArtifact(upload, uploadPaths, uploadUris);
    if (
      upload.role.startsWith("config-") &&
      (upload.artifact.mediaType !== "application/json" ||
        !upload.remotePath.endsWith(".json"))
    ) {
      throw new HarborSpecificationError("Harbor configuration artifacts must be JSON.");
    }
    if (
      upload.role === "output-packager" &&
      (!new Set([
        "application/javascript",
        "text/javascript",
        "text/plain",
      ]).has(upload.artifact.mediaType) ||
        !upload.remotePath.endsWith(".mjs"))
    ) {
      throw new HarborSpecificationError(
        "The Harbor output packager must be an immutable JavaScript module.",
      );
    }
    if (
      upload.role === "pi-adapter" &&
      !new Set(["text/x-python", "text/plain"]).has(upload.artifact.mediaType)
    ) {
      throw new HarborSpecificationError("The Pi adapter must be a Python source artifact.");
    }
    if (
      upload.role.endsWith("-runtime") &&
      !new Set(["application/gzip", "application/x-tar"]).has(
        upload.artifact.mediaType,
      )
    ) {
      throw new HarborSpecificationError("Pi runtimes must be immutable archive artifacts.");
    }
  }

  const expectedOrders = expectedInvocationOrders(job.stage);
  const invocationOrders = job.invocations.map((invocation) => invocation.order);
  const harborJobPaths = new Set<string>();
  const outputPaths = new Set<string>();
  if (
    invocationOrders.length !== expectedOrders.length ||
    new Set(invocationOrders).size !== invocationOrders.length ||
    expectedOrders.some((order) => !invocationOrders.includes(order))
  ) {
    throw new HarborSpecificationError(
      "Harbor invocations do not implement the frozen repair or AB/BA schedule.",
    );
  }

  let totalCells = 0;
  let totalArms = 0;
  for (const invocation of job.invocations) {
    assertAbsolutePath(invocation.remoteConfigPath, "Harbor config path");
    assertAbsolutePath(invocation.remoteHarborJobPath, "Harbor job directory");
    assertAbsolutePath(invocation.remoteOutputPath, "Harbor bundle path");
    const config = job.uploads.find(
      (upload) => upload.role === configRoleForOrder(invocation.order),
    );
    const requiredCells = invocation.order === "repair" ? 5 : 6;
    const requiredArms = invocation.order === "repair" ? 5 : 12;
    if (
      !SAFE_PATH_ID.test(invocation.invocationId) ||
      invocation.invocationId !==
        `${job.requestId}-${invocation.order.toLowerCase()}` ||
      config === undefined ||
      config.remotePath !== invocation.remoteConfigPath ||
      config.artifact.sha256 !== invocation.configSha256 ||
      invocation.cellCount !== requiredCells ||
      invocation.armCount !== requiredArms ||
      invocation.nAttempts !== 1 ||
      invocation.nConcurrentTrials !== 1 ||
      invocation.harborRetries !== 0 ||
      invocation.agentOrder.length !== expectedAgentOrder(invocation.order).length ||
      invocation.agentOrder.some(
        (arm, index) => arm !== expectedAgentOrder(invocation.order)[index],
      ) ||
      invocation.remoteHarborJobPath.endsWith(".tar") ||
      !invocation.remoteHarborJobPath.endsWith(
        `/${invocation.invocationId}`,
      ) ||
      invocation.remoteOutputPath !==
        `${invocation.remoteHarborJobPath}.harbor-output.tar` ||
      uploadPaths.has(invocation.remoteHarborJobPath) ||
      uploadPaths.has(invocation.remoteOutputPath) ||
      harborJobPaths.has(invocation.remoteHarborJobPath) ||
      outputPaths.has(invocation.remoteOutputPath)
    ) {
      throw new HarborSpecificationError(
        "A Harbor invocation violates serial execution, retry, artifact, or arm-order policy.",
      );
    }
    harborJobPaths.add(invocation.remoteHarborJobPath);
    outputPaths.add(invocation.remoteOutputPath);
    totalCells += invocation.cellCount;
    totalArms += invocation.armCount;
  }
  if (
    totalCells !== job.cellCount ||
    totalArms !== job.armCount ||
    computeTrustedHarborJobHash(job) !== job.jobSha256
  ) {
    throw new HarborSpecificationError(
      "Harbor job cardinality or content-addressed bundle hash is inconsistent.",
    );
  }
}

/**
 * Task names are deliberately absent from this command. The trusted config
 * artifact contains hidden selection material and is uploaded directly to the
 * cloud sandbox; only its fixed remote path reaches Harbor's argument vector.
 */
export function createHarborInvocationSpec(
  options: HarborInvocationOptions,
): RemoteCommandSpec {
  assertAbsolutePath(options.harborExecutable, "Harbor executable");
  assertAbsolutePath(options.workingDirectory, "Harbor working directory");
  const pinHash = hashTerminalBench21Pin(options.pin);
  assertTrustedHarborJobArtifact(options.job, pinHash);
  const sealedInvocation = options.job.invocations.find(
    (invocation) => invocation.invocationId === options.invocation.invocationId,
  );
  if (
    sealedInvocation === undefined ||
    canonicalHash(sealedInvocation) !== canonicalHash(options.invocation)
  ) {
    throw new HarborSpecificationError("Harbor invocation is not a member of the sealed job.");
  }
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 24 * 60 * 60_000
  ) {
    throw new HarborSpecificationError("Harbor timeout is outside the allowed range.");
  }
  const adapterUpload = options.job.uploads.find(
    (upload) => upload.role === "pi-adapter",
  );
  if (adapterUpload === undefined) {
    throw new HarborSpecificationError(
      "The sealed Harbor job has no trusted Pi adapter.",
    );
  }
  const importRoot = adapterUpload.remotePath.slice(
    0,
    adapterUpload.remotePath.lastIndexOf("/"),
  );
  if (importRoot.length === 0) {
    throw new HarborSpecificationError(
      "The trusted Pi adapter import root is invalid.",
    );
  }
  return {
    executable: options.harborExecutable,
    arguments: ["run", "-c", options.invocation.remoteConfigPath],
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeoutMs,
    environment: {
      DF_CLOUD_EXECUTION: "1",
      DF_HARBOR_ISOLATION_POLICY_SHA256: hashHarborAgentIsolationPolicy(),
      DF_TERMINAL_BENCH_PIN_SHA256: pinHash,
      NO_COLOR: "1",
      PYTHONPATH: importRoot,
    },
    secretReferences: options.secretReferences,
  };
}

/**
 * Packages one completed Harbor job directory into a deterministic regular
 * file. The packager receives only sealed identifiers and paths; it receives
 * neither model credentials nor an optimizer-visible artifact destination.
 */
export function createHarborOutputPackageSpec(
  options: HarborOutputPackageOptions,
): RemoteCommandSpec {
  assertAbsolutePath(options.nodeExecutable, "Node executable");
  assertAbsolutePath(options.workingDirectory, "Harbor packager working directory");
  const pinHash = hashTerminalBench21Pin(options.pin);
  assertTrustedHarborJobArtifact(options.job, pinHash);
  const sealedInvocation = options.job.invocations.find(
    (invocation) => invocation.invocationId === options.invocation.invocationId,
  );
  const packager = options.job.uploads.find(
    (upload) => upload.role === "output-packager",
  );
  if (
    sealedInvocation === undefined ||
    canonicalHash(sealedInvocation) !== canonicalHash(options.invocation) ||
    packager === undefined ||
    !SAFE_EXECUTION_ID.test(options.executionId) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 60 * 60_000
  ) {
    throw new HarborSpecificationError(
      "Harbor output packaging is not bound to a sealed invocation.",
    );
  }
  return {
    executable: options.nodeExecutable,
    arguments: [
      packager.remotePath,
      "--source-directory",
      options.invocation.remoteHarborJobPath,
      "--output",
      options.invocation.remoteOutputPath,
      "--request-id",
      options.job.requestId,
      "--job-sha256",
      options.job.jobSha256,
      "--pin-sha256",
      options.job.pinHash,
      "--invocation-id",
      options.invocation.invocationId,
      "--order",
      options.invocation.order,
      "--config-sha256",
      options.invocation.configSha256,
      "--execution-id",
      options.executionId,
      "--expected-trials",
      String(options.invocation.armCount),
    ],
    workingDirectory: options.workingDirectory,
    timeoutMs: options.timeoutMs,
    environment: {
      DF_CLOUD_EXECUTION: "1",
      DF_HARBOR_JOB_SHA256: options.job.jobSha256,
      DF_TERMINAL_BENCH_PIN_SHA256: pinHash,
      NO_COLOR: "1",
    },
    secretReferences: [],
  };
}
