import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import { canonicalHash } from "../schemas/canonical.js";
import {
  type EvaluationArm,
  type HiddenTaskHandle,
  MVP_REPETITIONS_PER_TASK,
  MVP_SCHEMA_VERSION,
  MVP_TASK_COUNT,
  type PrivateRawDiagnostic,
} from "./contracts.js";
import { isMvpModelDeploymentAlias } from "./model-deployment.js";

export const MVP_HARBOR_VERSION = "0.20.0" as const;
export const MVP_HARBOR_POLICY = "matched-5x3-ab-ba-v1" as const;
export const MVP_HARBOR_ATTEMPTS = 3 as const;
export const MVP_HARBOR_CONCURRENT_TRIALS = 5 as const;
export const MVP_HARBOR_CELLS_PER_ARM = 15 as const;
export const MVP_HARBOR_TRIAL_COUNT = 30 as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const SAFE_EXPERIMENT = /^(?<number>\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const SAFE_AGENT_IMPORT =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const SAFE_ABSOLUTE_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const SAFE_SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TRUSTED_URI = /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const FOUNDRY_HOST =
  /^(?<resource>[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.services\.ai\.azure\.com$/u;
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAXIMUM_DIAGNOSTICS = 128;
const MAXIMUM_REFERENCES = 128;

type MvpHarborOrder = "AB" | "BA";
type PlainRecord = Readonly<Record<string, unknown>>;

export interface TrustedMvpHarborTaskBinding {
  readonly sensitivity: "trusted-hidden-mvp-task";
  readonly hiddenTaskId: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly harborTaskName: string;
  /** Cell IDs are ordered by replicate ordinal 1, 2, and 3. */
  readonly cellIds: readonly [string, string, string];
}

export interface MvpHarborRuntimeArchive {
  readonly arm: EvaluationArm;
  readonly harnessRevision: string;
  readonly artifact: TrustedCloudArtifactRef;
  readonly remotePath: string;
}

export interface MvpHarborAdapterBinding {
  readonly artifact: TrustedCloudArtifactRef;
  readonly remotePath: string;
  readonly importPath: string;
}

export interface MvpHarborModelBinding {
  readonly provider: "microsoft-foundry";
  /** Existing Foundry deployment name; Dark Factory never creates it. */
  readonly deployment: string;
  readonly modelFamily: "claude-opus-4-8";
  readonly endpointHost: string;
  readonly reasoningEffort: "high";
  readonly credentialEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY";
}

export interface MvpHarborBuildInput {
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly environmentDigest: string;
  readonly datasetName: string;
  readonly datasetRef: string;
  readonly jobsDirectory: string;
  readonly environmentType: "daytona";
  readonly evaluatedSecretSourceName: string;
  readonly tasks: readonly TrustedMvpHarborTaskBinding[];
  readonly candidateRuntime: MvpHarborRuntimeArchive;
  readonly championRuntime: MvpHarborRuntimeArchive;
  readonly adapter: MvpHarborAdapterBinding;
  readonly model: MvpHarborModelBinding;
  readonly piEntrypoint: string;
  readonly enabledTools: readonly string[];
  readonly timeoutSeconds: number;
}

export interface MvpHarborAgentConfiguration {
  readonly name: "dark-factory-candidate" | "dark-factory-champion";
  readonly import_path: string;
  readonly model_name: string;
  readonly n_concurrent: 1;
  readonly extra_allowed_hosts: readonly [string];
  readonly include_logs: readonly ["dark-factory-pi.jsonl"];
  readonly skills: readonly [];
  readonly mcp_servers: readonly [];
  readonly override_timeout_sec: number;
  readonly max_timeout_sec: number;
  readonly kwargs: {
    readonly runtime_archive_path: string;
    readonly runtime_sha256: string;
    readonly pi_entrypoint: string;
    readonly thinking: "high";
    readonly enabled_tools: readonly string[];
    readonly credential_environment_names: readonly ["ANTHROPIC_FOUNDRY_API_KEY"];
    readonly foundry_resource_name: string;
    readonly model_family: "claude-opus-4-8";
  };
}

export interface MvpHarborConfiguration {
  readonly job_name: string;
  readonly jobs_dir: string;
  readonly n_attempts: 3;
  readonly n_concurrent_trials: 5;
  readonly quiet: true;
  readonly retry: {
    readonly max_retries: 0;
  };
  readonly environment: {
    readonly type: "daytona";
    readonly delete: true;
    readonly force_build: false;
    readonly kwargs: {
      readonly secrets: {
        readonly ANTHROPIC_FOUNDRY_API_KEY: string;
      };
    };
  };
  readonly verifier: {
    readonly disable: false;
  };
  readonly agents: readonly [
    MvpHarborAgentConfiguration,
    MvpHarborAgentConfiguration,
  ];
  readonly datasets: readonly [
    {
      readonly name: string;
      readonly ref: string;
      readonly overwrite: false;
      readonly task_names: readonly string[];
    },
  ];
}

export interface TrustedMvpHarborConfig {
  readonly sensitivity: "trusted-hidden-mvp-harbor-config";
  readonly order: MvpHarborOrder;
  readonly taskCount: number;
  readonly expectedTrialCount: number;
  readonly configHash: string;
  readonly config: MvpHarborConfiguration;
}

export interface TrustedMvpHarborScheduledTask extends TrustedMvpHarborTaskBinding {
  readonly scheduleOrdinal: number;
  readonly order: MvpHarborOrder;
}

export interface TrustedMvpHarborPlan {
  readonly sensitivity: "trusted-hidden-mvp-harbor-plan";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly experimentId: string;
  readonly experimentNumber: number;
  readonly environmentDigest: string;
  readonly datasetName: string;
  readonly datasetRef: string;
  readonly jobsDirectory: string;
  readonly environmentType: "daytona";
  readonly evaluatedSecretSourceName: string;
  readonly tasks: readonly TrustedMvpHarborScheduledTask[];
  readonly candidateRuntime: MvpHarborRuntimeArchive;
  readonly championRuntime: MvpHarborRuntimeArchive;
  readonly adapter: MvpHarborAdapterBinding;
  readonly model: MvpHarborModelBinding;
  readonly piEntrypoint: string;
  readonly enabledTools: readonly string[];
  readonly timeoutSeconds: number;
  readonly taskCount: 5;
  readonly repetitionsPerTask: 3;
  readonly candidateTrialCount: 15;
  readonly championTrialCount: 15;
  readonly totalTrialCount: 30;
  readonly configs: readonly [TrustedMvpHarborConfig, TrustedMvpHarborConfig];
  readonly planHash: string;
}

export interface TrustedMvpHarborRawTrial {
  readonly trialId: string;
  readonly harborTaskName: string;
  readonly agentName: "dark-factory-candidate" | "dark-factory-champion";
  readonly attemptOrdinal: 1 | 2 | 3;
  readonly runtimeArchiveSha256: string;
  readonly adapterSha256: string;
  readonly modelProvider: "microsoft-foundry";
  readonly modelDeployment: string;
  readonly endpointHost: string;
  readonly passed: boolean;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly evaluatedAt: string;
  readonly traceArtifactRefs: readonly string[];
  readonly rawDiagnostics: readonly PrivateRawDiagnostic[];
}

export interface TrustedMvpHarborRawOutput {
  readonly sensitivity: "trusted-mvp-harbor-output";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly experimentId: string;
  readonly trials: readonly TrustedMvpHarborRawTrial[];
}

export interface TrustedMvpHarborDecodedTrial {
  readonly hiddenTaskId: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly harborTaskName: string;
  readonly cellId: string;
  readonly arm: EvaluationArm;
  readonly replicateOrdinal: 1 | 2 | 3;
  readonly order: MvpHarborOrder;
  readonly harnessRevision: string;
  readonly source: "fresh";
  readonly passed: boolean;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly durationMs: number;
  readonly evaluatedAt: string;
  readonly traceArtifactRefs: readonly string[];
  readonly rawDiagnostics: readonly PrivateRawDiagnostic[];
}

export interface TrustedMvpHarborResultMatrix {
  readonly sensitivity: "trusted-hidden-mvp-result-matrix";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly experimentId: string;
  readonly environmentDigest: string;
  readonly planHash: string;
  readonly candidate: readonly TrustedMvpHarborDecodedTrial[];
  readonly champion: readonly TrustedMvpHarborDecodedTrial[];
}

export interface MvpHarborReleaseReceipt {
  readonly sensitivity: "release-safe-mvp-harbor-receipt";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly experimentId: string;
  readonly complete: true;
  readonly taskCount: 5;
  readonly abTaskCount: 3;
  readonly baTaskCount: 2;
  readonly repetitionsPerTask: 3;
  readonly attemptsPerTaskAndArm: 3;
  readonly candidateTrialCount: 15;
  readonly championTrialCount: 15;
  readonly totalTrialCount: 30;
  readonly infrastructureValidTrialCount: number;
  readonly candidatePassCount: number;
  readonly championPassCount: number;
  readonly candidateMeanReward: number;
  readonly championMeanReward: number;
  readonly candidateRuntimeArchiveSha256: string;
  readonly championRuntimeArchiveSha256: string;
  readonly adapterSha256: string;
  readonly modelProvider: "microsoft-foundry";
  readonly modelDeployment: string;
  readonly endpointHost: string;
  readonly reasoningEffort: "high";
  readonly containsTaskIds: false;
  readonly containsTaskNames: false;
  readonly containsPerTaskResults: false;
}

export interface DecodedMvpHarborEvaluation {
  readonly trustedMatrix: TrustedMvpHarborResultMatrix;
  readonly releaseReceipt: MvpHarborReleaseReceipt;
}

export class MvpHarborError extends Error {
  override readonly name = "MvpHarborError";

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new MvpHarborError(message);
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactRecord(value: unknown, keys: readonly string[], label: string): PlainRecord {
  if (!isPlainRecord(value)) fail(`${label} must be a plain object.`);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key))
  ) {
    fail(`${label} contains missing or unexpected fields.`);
  }
  return value;
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !REVISION.test(value)) {
    fail(`${label} must be an immutable hexadecimal revision.`);
  }
}

function assertSafeAbsolutePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_ABSOLUTE_PATH.test(value) ||
    value.includes("/../")
  ) {
    fail(`${label} must be an absolute traversal-free path.`);
  }
}

function assertArtifact(
  value: unknown,
  label: string,
  allowedMediaTypes: ReadonlySet<string>,
): asserts value is TrustedCloudArtifactRef {
  const artifact = exactRecord(
    value,
    ["uri", "sha256", "mediaType", "byteLength"],
    label,
  );
  if (
    typeof artifact["uri"] !== "string" ||
    !TRUSTED_URI.test(artifact["uri"]) ||
    artifact["uri"].includes("..")
  ) {
    fail(`${label} must have a trusted artifact URI.`);
  }
  assertDigest(artifact["sha256"], `${label} digest`);
  if (
    typeof artifact["mediaType"] !== "string" ||
    !allowedMediaTypes.has(artifact["mediaType"]) ||
    typeof artifact["byteLength"] !== "number" ||
    !Number.isSafeInteger(artifact["byteLength"]) ||
    artifact["byteLength"] <= 0 ||
    artifact["byteLength"] > MAXIMUM_ARTIFACT_BYTES
  ) {
    fail(`${label} has an unsupported media type or byte length.`);
  }
}

function assertRuntime(
  value: unknown,
  expectedArm: EvaluationArm,
): asserts value is MvpHarborRuntimeArchive {
  const runtime = exactRecord(
    value,
    ["arm", "harnessRevision", "artifact", "remotePath"],
    `${expectedArm} runtime`,
  );
  if (runtime["arm"] !== expectedArm) {
    fail("Runtime bindings must identify their exact matched arm.");
  }
  assertRevision(runtime["harnessRevision"], `${expectedArm} harness revision`);
  assertArtifact(
    runtime["artifact"],
    `${expectedArm} runtime artifact`,
    new Set(["application/gzip", "application/x-tar"]),
  );
  assertSafeAbsolutePath(runtime["remotePath"], `${expectedArm} runtime path`);
}

function assertAdapter(value: unknown): asserts value is MvpHarborAdapterBinding {
  const adapter = exactRecord(
    value,
    ["artifact", "remotePath", "importPath"],
    "Harbor adapter",
  );
  assertArtifact(
    adapter["artifact"],
    "Harbor adapter artifact",
    new Set(["text/x-python", "text/plain"]),
  );
  assertSafeAbsolutePath(adapter["remotePath"], "Harbor adapter path");
  if (
    typeof adapter["importPath"] !== "string" ||
    !SAFE_AGENT_IMPORT.test(adapter["importPath"])
  ) {
    fail("Harbor adapter import path is malformed.");
  }
}

function assertModel(value: unknown): asserts value is MvpHarborModelBinding {
  const model = exactRecord(
    value,
    [
      "provider",
      "deployment",
      "modelFamily",
      "endpointHost",
      "reasoningEffort",
      "credentialEnvironmentName",
    ],
    "Evaluated model",
  );
  if (
    model["provider"] !== "microsoft-foundry" ||
    typeof model["deployment"] !== "string" ||
    !isMvpModelDeploymentAlias(model["deployment"]) ||
    model["modelFamily"] !== "claude-opus-4-8" ||
    typeof model["endpointHost"] !== "string" ||
    FOUNDRY_HOST.exec(model["endpointHost"])?.groups?.["resource"] === undefined ||
    model["reasoningEffort"] !== "high" ||
    model["credentialEnvironmentName"] !== "ANTHROPIC_FOUNDRY_API_KEY"
  ) {
    fail("Evaluated model binding must be the existing Opus 4.8 Foundry deployment.");
  }
}

function assertTaskBinding(value: unknown): asserts value is TrustedMvpHarborTaskBinding {
  const task = exactRecord(
    value,
    [
      "sensitivity",
      "hiddenTaskId",
      "taskRevisionDigest",
      "harborTaskName",
      "cellIds",
    ],
    "Hidden task binding",
  );
  if (task["sensitivity"] !== "trusted-hidden-mvp-task") {
    fail("Hidden task binding has the wrong sensitivity.");
  }
  assertDigest(task["hiddenTaskId"], "Hidden task ID");
  assertDigest(task["taskRevisionDigest"], "Hidden task revision");
  if (
    typeof task["harborTaskName"] !== "string" ||
    !SAFE_TASK_NAME.test(task["harborTaskName"])
  ) {
    fail("Trusted Harbor task name is malformed.");
  }
  if (!Array.isArray(task["cellIds"]) || task["cellIds"].length !== 3) {
    fail("A hidden task must bind exactly three replicate cell IDs.");
  }
  for (const cellId of task["cellIds"]) {
    assertDigest(cellId, "Hidden evaluation cell ID");
  }
  if (new Set(task["cellIds"]).size !== 3) {
    fail("Hidden evaluation cell IDs must be unique.");
  }
}

function assertBuildInput(input: MvpHarborBuildInput): void {
  const experiment = SAFE_EXPERIMENT.exec(input.experimentId);
  if (
    experiment?.groups?.["number"] === undefined ||
    input.experimentId.length > 80 ||
    !Number.isSafeInteger(input.experimentNumber) ||
    input.experimentNumber < 1 ||
    Number(experiment.groups["number"]) !== input.experimentNumber
  ) {
    fail("Experiment ID and experiment number must be a matching numbered slug.");
  }
  assertDigest(input.environmentDigest, "Environment digest");
  if (
    !SAFE_IDENTIFIER.test(input.datasetName) ||
    !SAFE_IDENTIFIER.test(input.datasetRef) ||
    input.environmentType !== "daytona" ||
    !SAFE_SECRET_NAME.test(input.evaluatedSecretSourceName)
  ) {
    fail("Harbor dataset or cloud environment binding is malformed.");
  }
  assertSafeAbsolutePath(input.jobsDirectory, "Harbor jobs directory");
  if (!Array.isArray(input.tasks) || input.tasks.length !== MVP_TASK_COUNT) {
    fail("The MVP Harbor schedule requires exactly five hidden tasks.");
  }
  for (const task of input.tasks) assertTaskBinding(task);
  if (
    new Set(input.tasks.map((task) => task.hiddenTaskId)).size !== MVP_TASK_COUNT ||
    new Set(input.tasks.map((task) => task.harborTaskName)).size !== MVP_TASK_COUNT ||
    new Set(input.tasks.flatMap((task) => task.cellIds)).size !==
      MVP_HARBOR_CELLS_PER_ARM
  ) {
    fail("Hidden task, Harbor name, and cell bindings must be unique.");
  }
  assertRuntime(input.candidateRuntime, "candidate");
  assertRuntime(input.championRuntime, "champion");
  if (
    input.candidateRuntime.artifact.sha256 === input.championRuntime.artifact.sha256 ||
    input.candidateRuntime.harnessRevision === input.championRuntime.harnessRevision ||
    input.candidateRuntime.remotePath === input.championRuntime.remotePath
  ) {
    fail("Candidate and champion runtime archives must be distinct.");
  }
  assertAdapter(input.adapter);
  if (
    new Set([
      input.candidateRuntime.remotePath,
      input.championRuntime.remotePath,
      input.adapter.remotePath,
    ]).size !== 3
  ) {
    fail("Runtime and adapter remote paths must be distinct.");
  }
  assertModel(input.model);
  if (!SAFE_RELATIVE_PATH.test(input.piEntrypoint)) {
    fail("Pi entrypoint must be a traversal-free relative path.");
  }
  if (
    input.enabledTools.length === 0 ||
    input.enabledTools.length > 32 ||
    input.enabledTools.some((tool) => !SAFE_TOOL.test(tool)) ||
    new Set(input.enabledTools).size !== input.enabledTools.length
  ) {
    fail("Pi enabled tools must be a small unique allowlist.");
  }
  if (
    !Number.isSafeInteger(input.timeoutSeconds) ||
    input.timeoutSeconds < 60 ||
    input.timeoutSeconds > 24 * 60 * 60
  ) {
    fail("Pi timeout must be an integral value from one minute to one day.");
  }
}

function modelResource(model: MvpHarborModelBinding): string {
  const resource = FOUNDRY_HOST.exec(model.endpointHost)?.groups?.["resource"];
  if (resource === undefined) fail("Foundry endpoint host is malformed.");
  return resource;
}

function agentConfiguration(
  arm: EvaluationArm,
  input: Pick<
    TrustedMvpHarborPlan,
    | "candidateRuntime"
    | "championRuntime"
    | "adapter"
    | "model"
    | "piEntrypoint"
    | "enabledTools"
    | "timeoutSeconds"
  >,
): MvpHarborAgentConfiguration {
  const runtime =
    arm === "candidate" ? input.candidateRuntime : input.championRuntime;
  return {
    name: arm === "candidate" ? "dark-factory-candidate" : "dark-factory-champion",
    import_path: input.adapter.importPath,
    model_name: `${input.model.provider}/${input.model.deployment}`,
    n_concurrent: 1,
    extra_allowed_hosts: [input.model.endpointHost],
    include_logs: ["dark-factory-pi.jsonl"],
    skills: [],
    mcp_servers: [],
    override_timeout_sec: input.timeoutSeconds,
    max_timeout_sec: input.timeoutSeconds,
    kwargs: {
      runtime_archive_path: runtime.remotePath,
      runtime_sha256: runtime.artifact.sha256,
      pi_entrypoint: input.piEntrypoint,
      thinking: "high",
      enabled_tools: [...input.enabledTools],
      credential_environment_names: ["ANTHROPIC_FOUNDRY_API_KEY"],
      foundry_resource_name: modelResource(input.model),
      model_family: "claude-opus-4-8",
    },
  };
}

function configuration(
  order: MvpHarborOrder,
  input: Pick<
    TrustedMvpHarborPlan,
    | "experimentId"
    | "datasetName"
    | "datasetRef"
    | "jobsDirectory"
    | "environmentType"
    | "evaluatedSecretSourceName"
    | "tasks"
    | "candidateRuntime"
    | "championRuntime"
    | "adapter"
    | "model"
    | "piEntrypoint"
    | "enabledTools"
    | "timeoutSeconds"
  >,
): MvpHarborConfiguration {
  const agentOrder: readonly [EvaluationArm, EvaluationArm] =
    order === "AB" ? ["candidate", "champion"] : ["champion", "candidate"];
  return {
    job_name: `${input.experimentId}-${order.toLowerCase()}`,
    jobs_dir: input.jobsDirectory,
    n_attempts: MVP_HARBOR_ATTEMPTS,
    n_concurrent_trials: MVP_HARBOR_CONCURRENT_TRIALS,
    quiet: true,
    retry: {
      max_retries: 0,
    },
    environment: {
      type: input.environmentType,
      delete: true,
      force_build: false,
      kwargs: {
        secrets: {
          ANTHROPIC_FOUNDRY_API_KEY:
            input.evaluatedSecretSourceName,
        },
      },
    },
    verifier: {
      disable: false,
    },
    agents: [
      agentConfiguration(agentOrder[0], input),
      agentConfiguration(agentOrder[1], input),
    ],
    datasets: [
      {
        name: input.datasetName,
        ref: input.datasetRef,
        overwrite: false,
        task_names: input.tasks
          .filter((task) => task.order === order)
          .map((task) => task.harborTaskName),
      },
    ],
  };
}

function planHashMaterial(
  plan: Omit<TrustedMvpHarborPlan, "planHash">,
): Readonly<Record<string, unknown>> {
  return {
    ...plan,
    sensitivity: plan.sensitivity,
  };
}

export function hashTrustedMvpHarborPlan(
  plan: Omit<TrustedMvpHarborPlan, "planHash">,
): string {
  return canonicalHash(planHashMaterial(plan));
}

/**
 * Builds the entire MVP execution schedule without randomness. The selected
 * tasks are sorted by opaque ID, rotated by experiment number to avoid pinning
 * the same task to the same arm order forever, then split into three AB tasks
 * and two BA tasks. Harbor's three attempts are the three replicate ordinals.
 */
export function buildTrustedMvpHarborPlan(
  input: MvpHarborBuildInput,
): TrustedMvpHarborPlan {
  assertBuildInput(input);
  const sorted = [...input.tasks].sort((left, right) =>
    left.hiddenTaskId.localeCompare(right.hiddenTaskId),
  );
  const offset = (input.experimentNumber - 1) % MVP_TASK_COUNT;
  const rotated = [...sorted.slice(offset), ...sorted.slice(0, offset)];
  const tasks: readonly TrustedMvpHarborScheduledTask[] = rotated.map(
    (task, scheduleOrdinal) => ({
      ...task,
      scheduleOrdinal,
      order: scheduleOrdinal < 3 ? "AB" : "BA",
    }),
  );

  const planWithoutConfigs = {
    sensitivity: "trusted-hidden-mvp-harbor-plan" as const,
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: MVP_HARBOR_POLICY,
    harborVersion: MVP_HARBOR_VERSION,
    experimentId: input.experimentId,
    experimentNumber: input.experimentNumber,
    environmentDigest: input.environmentDigest,
    datasetName: input.datasetName,
    datasetRef: input.datasetRef,
    jobsDirectory: input.jobsDirectory,
    environmentType: input.environmentType,
    evaluatedSecretSourceName: input.evaluatedSecretSourceName,
    tasks,
    candidateRuntime: input.candidateRuntime,
    championRuntime: input.championRuntime,
    adapter: input.adapter,
    model: input.model,
    piEntrypoint: input.piEntrypoint,
    enabledTools: [...input.enabledTools],
    timeoutSeconds: input.timeoutSeconds,
    taskCount: MVP_TASK_COUNT,
    repetitionsPerTask: MVP_REPETITIONS_PER_TASK,
    candidateTrialCount: MVP_HARBOR_CELLS_PER_ARM,
    championTrialCount: MVP_HARBOR_CELLS_PER_ARM,
    totalTrialCount: MVP_HARBOR_TRIAL_COUNT,
  };
  const abConfiguration = configuration("AB", planWithoutConfigs);
  const baConfiguration = configuration("BA", planWithoutConfigs);
  const configs: TrustedMvpHarborPlan["configs"] = [
    {
      sensitivity: "trusted-hidden-mvp-harbor-config",
      order: "AB",
      taskCount: 3,
      expectedTrialCount: 18,
      configHash: canonicalHash(abConfiguration),
      config: abConfiguration,
    },
    {
      sensitivity: "trusted-hidden-mvp-harbor-config",
      order: "BA",
      taskCount: 2,
      expectedTrialCount: 12,
      configHash: canonicalHash(baConfiguration),
      config: baConfiguration,
    },
  ];
  const unsigned: Omit<TrustedMvpHarborPlan, "planHash"> = {
    ...planWithoutConfigs,
    configs,
  };
  const plan: TrustedMvpHarborPlan = {
    ...unsigned,
    planHash: hashTrustedMvpHarborPlan(unsigned),
  };
  assertTrustedMvpHarborPlan(plan);
  return plan;
}

function assertScheduledTask(
  value: unknown,
): asserts value is TrustedMvpHarborScheduledTask {
  const task = exactRecord(
    value,
    [
      "sensitivity",
      "hiddenTaskId",
      "taskRevisionDigest",
      "harborTaskName",
      "cellIds",
      "scheduleOrdinal",
      "order",
    ],
    "Scheduled hidden task",
  );
  assertTaskBinding({
    sensitivity: task["sensitivity"],
    hiddenTaskId: task["hiddenTaskId"],
    taskRevisionDigest: task["taskRevisionDigest"],
    harborTaskName: task["harborTaskName"],
    cellIds: task["cellIds"],
  });
  if (
    typeof task["scheduleOrdinal"] !== "number" ||
    !Number.isSafeInteger(task["scheduleOrdinal"]) ||
    task["scheduleOrdinal"] < 0 ||
    task["scheduleOrdinal"] >= MVP_TASK_COUNT ||
    (task["order"] !== "AB" && task["order"] !== "BA")
  ) {
    fail("Scheduled hidden task has an invalid ordinal or arm order.");
  }
}

function assertConfigEnvelope(
  value: unknown,
  expectedOrder: MvpHarborOrder,
  plan: TrustedMvpHarborPlan,
): asserts value is TrustedMvpHarborConfig {
  const envelope = exactRecord(
    value,
    [
      "sensitivity",
      "order",
      "taskCount",
      "expectedTrialCount",
      "configHash",
      "config",
    ],
    "Trusted Harbor config",
  );
  const expectedTaskCount = expectedOrder === "AB" ? 3 : 2;
  const expectedTrialCount = expectedTaskCount * 2 * MVP_HARBOR_ATTEMPTS;
  const expectedConfiguration = configuration(expectedOrder, plan);
  if (
    envelope["sensitivity"] !== "trusted-hidden-mvp-harbor-config" ||
    envelope["order"] !== expectedOrder ||
    envelope["taskCount"] !== expectedTaskCount ||
    envelope["expectedTrialCount"] !== expectedTrialCount
  ) {
    fail("Trusted Harbor config has the wrong schedule cardinality.");
  }
  assertDigest(envelope["configHash"], "Harbor config hash");
  try {
    if (
      envelope["configHash"] !== canonicalHash(expectedConfiguration) ||
      canonicalHash(envelope["config"]) !== canonicalHash(expectedConfiguration)
    ) {
      fail("Trusted Harbor config does not match its sealed schedule.");
    }
  } catch (error) {
    if (error instanceof MvpHarborError) throw error;
    fail("Trusted Harbor config is not canonical JSON.");
  }
}

export function assertTrustedMvpHarborPlan(
  value: unknown,
): asserts value is TrustedMvpHarborPlan {
  const plan = exactRecord(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "policyVersion",
      "harborVersion",
      "experimentId",
      "experimentNumber",
      "environmentDigest",
      "datasetName",
      "datasetRef",
      "jobsDirectory",
      "environmentType",
      "evaluatedSecretSourceName",
      "tasks",
      "candidateRuntime",
      "championRuntime",
      "adapter",
      "model",
      "piEntrypoint",
      "enabledTools",
      "timeoutSeconds",
      "taskCount",
      "repetitionsPerTask",
      "candidateTrialCount",
      "championTrialCount",
      "totalTrialCount",
      "configs",
      "planHash",
    ],
    "Trusted MVP Harbor plan",
  );
  if (
    plan["sensitivity"] !== "trusted-hidden-mvp-harbor-plan" ||
    plan["schemaVersion"] !== MVP_SCHEMA_VERSION ||
    plan["policyVersion"] !== MVP_HARBOR_POLICY ||
    plan["harborVersion"] !== MVP_HARBOR_VERSION
  ) {
    fail("Trusted MVP Harbor plan has the wrong protocol identity.");
  }
  const scheduledInputTasks = Array.isArray(plan["tasks"])
    ? plan["tasks"].map((value) => {
        const task = isPlainRecord(value) ? value : {};
        return {
          sensitivity: task["sensitivity"],
          hiddenTaskId: task["hiddenTaskId"],
          taskRevisionDigest: task["taskRevisionDigest"],
          harborTaskName: task["harborTaskName"],
          cellIds: task["cellIds"],
        } as TrustedMvpHarborTaskBinding;
      })
    : [];
  const buildInput: MvpHarborBuildInput = {
    experimentId: plan["experimentId"] as string,
    experimentNumber: plan["experimentNumber"] as number,
    environmentDigest: plan["environmentDigest"] as string,
    datasetName: plan["datasetName"] as string,
    datasetRef: plan["datasetRef"] as string,
    jobsDirectory: plan["jobsDirectory"] as string,
    environmentType: plan["environmentType"] as "daytona",
    evaluatedSecretSourceName:
      plan["evaluatedSecretSourceName"] as string,
    tasks: scheduledInputTasks,
    candidateRuntime: plan["candidateRuntime"] as MvpHarborRuntimeArchive,
    championRuntime: plan["championRuntime"] as MvpHarborRuntimeArchive,
    adapter: plan["adapter"] as MvpHarborAdapterBinding,
    model: plan["model"] as MvpHarborModelBinding,
    piEntrypoint: plan["piEntrypoint"] as string,
    enabledTools: Array.isArray(plan["enabledTools"])
      ? (plan["enabledTools"] as readonly string[])
      : [],
    timeoutSeconds: plan["timeoutSeconds"] as number,
  };
  assertBuildInput(buildInput);
  if (!Array.isArray(plan["tasks"]) || plan["tasks"].length !== MVP_TASK_COUNT) {
    fail("Trusted MVP Harbor plan must contain five scheduled tasks.");
  }
  for (const task of plan["tasks"]) assertScheduledTask(task);
  const scheduledTasks = plan["tasks"] as readonly TrustedMvpHarborScheduledTask[];
  const deterministicallySorted = [...scheduledInputTasks].sort((left, right) =>
    left.hiddenTaskId.localeCompare(right.hiddenTaskId),
  );
  const deterministicOffset =
    (buildInput.experimentNumber - 1) % MVP_TASK_COUNT;
  const deterministicOrder = [
    ...deterministicallySorted.slice(deterministicOffset),
    ...deterministicallySorted.slice(0, deterministicOffset),
  ];
  if (
    scheduledTasks.some((task, index) => task.scheduleOrdinal !== index) ||
    scheduledTasks.some(
      (task, index) =>
        task.hiddenTaskId !== deterministicOrder[index]?.hiddenTaskId ||
        task.order !== (index < 3 ? "AB" : "BA"),
    ) ||
    scheduledTasks.filter((task) => task.order === "AB").length !== 3 ||
    scheduledTasks.filter((task) => task.order === "BA").length !== 2 ||
    plan["taskCount"] !== MVP_TASK_COUNT ||
    plan["repetitionsPerTask"] !== MVP_REPETITIONS_PER_TASK ||
    plan["candidateTrialCount"] !== MVP_HARBOR_CELLS_PER_ARM ||
    plan["championTrialCount"] !== MVP_HARBOR_CELLS_PER_ARM ||
    plan["totalTrialCount"] !== MVP_HARBOR_TRIAL_COUNT
  ) {
    fail("Trusted MVP Harbor plan does not implement the 5x3 matched matrix.");
  }
  if (!Array.isArray(plan["configs"]) || plan["configs"].length !== 2) {
    fail("Trusted MVP Harbor plan requires exactly two arm-order configs.");
  }
  const typedPlan = plan as unknown as TrustedMvpHarborPlan;
  assertConfigEnvelope(plan["configs"][0], "AB", typedPlan);
  assertConfigEnvelope(plan["configs"][1], "BA", typedPlan);
  assertDigest(plan["planHash"], "Trusted MVP Harbor plan hash");
  const unsigned = { ...typedPlan } as Partial<TrustedMvpHarborPlan>;
  delete unsigned.planHash;
  if (
    plan["planHash"] !==
    hashTrustedMvpHarborPlan(
      unsigned as Omit<TrustedMvpHarborPlan, "planHash">,
    )
  ) {
    fail("Trusted MVP Harbor plan hash is inconsistent.");
  }
}

function parseDiagnostics(value: unknown): readonly PrivateRawDiagnostic[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_DIAGNOSTICS) {
    fail("Trusted trial diagnostics exceed the MVP bound.");
  }
  return value.map((entry) => {
    const diagnostic = exactRecord(
      entry,
      ["kind", "code", "toolName", "message", "evidenceRefs"],
      "Trusted raw diagnostic",
    );
    if (
      !new Set(["agent", "tool", "grader", "infrastructure"]).has(
        diagnostic["kind"] as string,
      ) ||
      typeof diagnostic["code"] !== "string" ||
      !SAFE_CODE.test(diagnostic["code"]) ||
      (diagnostic["toolName"] !== null &&
        (typeof diagnostic["toolName"] !== "string" ||
          diagnostic["toolName"].length < 1 ||
          diagnostic["toolName"].length > 256)) ||
      typeof diagnostic["message"] !== "string" ||
      diagnostic["message"].length > 16_384 ||
      !Array.isArray(diagnostic["evidenceRefs"]) ||
      diagnostic["evidenceRefs"].length > MAXIMUM_REFERENCES ||
      diagnostic["evidenceRefs"].some(
        (reference) =>
          typeof reference !== "string" ||
          reference.length < 1 ||
          reference.length > 2_048,
      )
    ) {
      fail("Trusted raw diagnostic is malformed.");
    }
    return diagnostic as unknown as PrivateRawDiagnostic;
  });
}

function parseRawTrial(value: unknown): TrustedMvpHarborRawTrial {
  const trial = exactRecord(
    value,
    [
      "trialId",
      "harborTaskName",
      "agentName",
      "attemptOrdinal",
      "runtimeArchiveSha256",
      "adapterSha256",
      "modelProvider",
      "modelDeployment",
      "endpointHost",
      "passed",
      "reward",
      "infrastructureValid",
      "durationMs",
      "evaluatedAt",
      "traceArtifactRefs",
      "rawDiagnostics",
    ],
    "Trusted Harbor trial",
  );
  if (
    typeof trial["trialId"] !== "string" ||
    !SAFE_CODE.test(trial["trialId"]) ||
    typeof trial["harborTaskName"] !== "string" ||
    !SAFE_TASK_NAME.test(trial["harborTaskName"]) ||
    (trial["agentName"] !== "dark-factory-candidate" &&
      trial["agentName"] !== "dark-factory-champion") ||
    (trial["attemptOrdinal"] !== 1 &&
      trial["attemptOrdinal"] !== 2 &&
      trial["attemptOrdinal"] !== 3)
  ) {
    fail("Trusted Harbor trial identity is malformed.");
  }
  assertDigest(trial["runtimeArchiveSha256"], "Trial runtime archive digest");
  assertDigest(trial["adapterSha256"], "Trial adapter digest");
  if (
    trial["modelProvider"] !== "microsoft-foundry" ||
    typeof trial["modelDeployment"] !== "string" ||
    !isMvpModelDeploymentAlias(trial["modelDeployment"]) ||
    typeof trial["endpointHost"] !== "string" ||
    FOUNDRY_HOST.exec(trial["endpointHost"])?.groups?.["resource"] === undefined ||
    typeof trial["passed"] !== "boolean" ||
    typeof trial["reward"] !== "number" ||
    !Number.isFinite(trial["reward"]) ||
    trial["reward"] < 0 ||
    trial["reward"] > 1 ||
    typeof trial["infrastructureValid"] !== "boolean" ||
    typeof trial["durationMs"] !== "number" ||
    !Number.isSafeInteger(trial["durationMs"]) ||
    trial["durationMs"] < 0 ||
    typeof trial["evaluatedAt"] !== "string" ||
    !isCanonicalTimestamp(trial["evaluatedAt"]) ||
    !Array.isArray(trial["traceArtifactRefs"]) ||
    trial["traceArtifactRefs"].length > MAXIMUM_REFERENCES ||
    trial["traceArtifactRefs"].some(
      (reference) =>
        typeof reference !== "string" ||
        !TRUSTED_URI.test(reference) ||
        reference.includes(".."),
    )
  ) {
    fail("Trusted Harbor trial evidence is malformed.");
  }
  return {
    trialId: trial["trialId"],
    harborTaskName: trial["harborTaskName"],
    agentName: trial["agentName"],
    attemptOrdinal: trial["attemptOrdinal"],
    runtimeArchiveSha256: trial["runtimeArchiveSha256"],
    adapterSha256: trial["adapterSha256"],
    modelProvider: trial["modelProvider"],
    modelDeployment: trial["modelDeployment"],
    endpointHost: trial["endpointHost"],
    passed: trial["passed"],
    reward: trial["reward"],
    infrastructureValid: trial["infrastructureValid"],
    durationMs: trial["durationMs"],
    evaluatedAt: trial["evaluatedAt"],
    traceArtifactRefs: [...trial["traceArtifactRefs"]] as readonly string[],
    rawDiagnostics: parseDiagnostics(trial["rawDiagnostics"]),
  };
}

function isCanonicalTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseRawOutput(value: unknown): TrustedMvpHarborRawOutput {
  const output = exactRecord(
    value,
    ["sensitivity", "schemaVersion", "harborVersion", "experimentId", "trials"],
    "Trusted MVP Harbor output",
  );
  if (
    output["sensitivity"] !== "trusted-mvp-harbor-output" ||
    output["schemaVersion"] !== MVP_SCHEMA_VERSION ||
    output["harborVersion"] !== MVP_HARBOR_VERSION ||
    typeof output["experimentId"] !== "string" ||
    !SAFE_EXPERIMENT.test(output["experimentId"]) ||
    !Array.isArray(output["trials"]) ||
    output["trials"].length !== MVP_HARBOR_TRIAL_COUNT
  ) {
    fail("Trusted MVP Harbor output does not contain exactly thirty trials.");
  }
  return {
    sensitivity: "trusted-mvp-harbor-output",
    schemaVersion: MVP_SCHEMA_VERSION,
    harborVersion: MVP_HARBOR_VERSION,
    experimentId: output["experimentId"],
    trials: output["trials"].map((trial) => parseRawTrial(trial)),
  };
}

function identity(
  hiddenTaskId: HiddenTaskHandle,
  arm: EvaluationArm,
  replicateOrdinal: number,
): string {
  return `${hiddenTaskId}|${arm}|${replicateOrdinal}`;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) fail("Cannot aggregate an empty Harbor arm.");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Decodes only against a sealed trusted plan. The sole result identity is the
 * tuple hiddenTaskId + arm + replicateOrdinal. Trial IDs and output order are
 * evidence, never identity. Missing, duplicate, unknown, or misbound trials
 * make the complete result set unusable.
 */
export function decodeTrustedMvpHarborOutput(
  planValue: unknown,
  rawOutputValue: unknown,
): DecodedMvpHarborEvaluation {
  assertTrustedMvpHarborPlan(planValue);
  const plan = planValue;
  const output = parseRawOutput(rawOutputValue);
  if (output.experimentId !== plan.experimentId) {
    fail("Trusted Harbor output belongs to a different experiment.");
  }

  const tasksByName = new Map(
    plan.tasks.map((task) => [task.harborTaskName, task]),
  );
  const expectedIdentities = new Set<string>();
  for (const task of plan.tasks) {
    for (const replicateOrdinal of [1, 2, 3] as const) {
      expectedIdentities.add(
        identity(task.hiddenTaskId, "candidate", replicateOrdinal),
      );
      expectedIdentities.add(
        identity(task.hiddenTaskId, "champion", replicateOrdinal),
      );
    }
  }

  const seenIdentities = new Set<string>();
  const seenTrialIds = new Set<string>();
  const decoded: TrustedMvpHarborDecodedTrial[] = [];
  for (const trial of output.trials) {
    const task = tasksByName.get(trial.harborTaskName);
    if (task === undefined) {
      fail("Harbor output references a task outside the sealed hidden panel.");
    }
    const arm: EvaluationArm =
      trial.agentName === "dark-factory-candidate" ? "candidate" : "champion";
    const runtime =
      arm === "candidate" ? plan.candidateRuntime : plan.championRuntime;
    if (
      trial.runtimeArchiveSha256 !== runtime.artifact.sha256 ||
      trial.adapterSha256 !== plan.adapter.artifact.sha256 ||
      trial.modelProvider !== plan.model.provider ||
      trial.modelDeployment !== plan.model.deployment ||
      trial.endpointHost !== plan.model.endpointHost
    ) {
      fail("Harbor trial execution bindings do not match the sealed plan.");
    }
    const trialIdentity = identity(
      task.hiddenTaskId,
      arm,
      trial.attemptOrdinal,
    );
    if (
      !expectedIdentities.has(trialIdentity) ||
      seenIdentities.has(trialIdentity) ||
      seenTrialIds.has(trial.trialId)
    ) {
      fail("Harbor output contains a duplicate or unexpected matched trial.");
    }
    seenIdentities.add(trialIdentity);
    seenTrialIds.add(trial.trialId);
    decoded.push({
      hiddenTaskId: task.hiddenTaskId,
      taskRevisionDigest: task.taskRevisionDigest,
      harborTaskName: task.harborTaskName,
      cellId: task.cellIds[trial.attemptOrdinal - 1],
      arm,
      replicateOrdinal: trial.attemptOrdinal,
      order: task.order,
      harnessRevision: runtime.harnessRevision,
      source: "fresh",
      passed: trial.passed,
      reward: trial.reward,
      infrastructureValid: trial.infrastructureValid,
      durationMs: trial.durationMs,
      evaluatedAt: trial.evaluatedAt,
      traceArtifactRefs: [...trial.traceArtifactRefs],
      rawDiagnostics: [...trial.rawDiagnostics],
    });
  }
  if (
    seenIdentities.size !== MVP_HARBOR_TRIAL_COUNT ||
    [...expectedIdentities].some((expected) => !seenIdentities.has(expected))
  ) {
    fail("Harbor output is not a complete 15/15 matched result matrix.");
  }

  const taskOrdinal = new Map(
    plan.tasks.map((task) => [task.hiddenTaskId, task.scheduleOrdinal]),
  );
  const compareDecoded = (
    left: TrustedMvpHarborDecodedTrial,
    right: TrustedMvpHarborDecodedTrial,
  ): number =>
    (taskOrdinal.get(left.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) -
      (taskOrdinal.get(right.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) ||
    left.replicateOrdinal - right.replicateOrdinal;
  const candidate = decoded
    .filter((trial) => trial.arm === "candidate")
    .sort(compareDecoded);
  const champion = decoded
    .filter((trial) => trial.arm === "champion")
    .sort(compareDecoded);
  if (
    candidate.length !== MVP_HARBOR_CELLS_PER_ARM ||
    champion.length !== MVP_HARBOR_CELLS_PER_ARM
  ) {
    fail("Harbor output is not a complete 15/15 matched result matrix.");
  }

  return {
    trustedMatrix: {
      sensitivity: "trusted-hidden-mvp-result-matrix",
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_HARBOR_POLICY,
      experimentId: plan.experimentId,
      environmentDigest: plan.environmentDigest,
      planHash: plan.planHash,
      candidate,
      champion,
    },
    releaseReceipt: {
      sensitivity: "release-safe-mvp-harbor-receipt",
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_HARBOR_POLICY,
      harborVersion: MVP_HARBOR_VERSION,
      experimentId: plan.experimentId,
      complete: true,
      taskCount: MVP_TASK_COUNT,
      abTaskCount: 3,
      baTaskCount: 2,
      repetitionsPerTask: MVP_REPETITIONS_PER_TASK,
      attemptsPerTaskAndArm: MVP_HARBOR_ATTEMPTS,
      candidateTrialCount: MVP_HARBOR_CELLS_PER_ARM,
      championTrialCount: MVP_HARBOR_CELLS_PER_ARM,
      totalTrialCount: MVP_HARBOR_TRIAL_COUNT,
      infrastructureValidTrialCount: decoded.filter(
        (trial) => trial.infrastructureValid,
      ).length,
      candidatePassCount: candidate.filter((trial) => trial.passed).length,
      championPassCount: champion.filter((trial) => trial.passed).length,
      candidateMeanReward: rounded(mean(candidate.map((trial) => trial.reward))),
      championMeanReward: rounded(mean(champion.map((trial) => trial.reward))),
      candidateRuntimeArchiveSha256: plan.candidateRuntime.artifact.sha256,
      championRuntimeArchiveSha256: plan.championRuntime.artifact.sha256,
      adapterSha256: plan.adapter.artifact.sha256,
      modelProvider: plan.model.provider,
      modelDeployment: plan.model.deployment,
      endpointHost: plan.model.endpointHost,
      reasoningEffort: plan.model.reasoningEffort,
      containsTaskIds: false,
      containsTaskNames: false,
      containsPerTaskResults: false,
    },
  };
}

export type MvpHarborExecutionPurpose = "screen" | "promotion-refresh";

export interface MvpHarborRequestedCell {
  readonly hiddenTaskId: HiddenTaskHandle;
  readonly arm: EvaluationArm;
  readonly replicateOrdinal: 1 | 2 | 3;
}

export interface MvpHarborExecutionRequest {
  readonly purpose: MvpHarborExecutionPurpose;
  readonly cells: readonly MvpHarborRequestedCell[];
}

export interface TrustedMvpHarborExpectedTrial extends MvpHarborRequestedCell {
  readonly invocationId: string;
  readonly harborTaskName: string;
  readonly harborAttemptOrdinal: 1 | 2 | 3;
}

export type MvpHarborRequestedArmMode =
  | "paired"
  | "candidate-only"
  | "champion-only";

export interface MvpHarborRequestedConfiguration {
  readonly job_name: string;
  readonly jobs_dir: string;
  readonly n_attempts: 1 | 3;
  readonly n_concurrent_trials: 5;
  readonly quiet: true;
  readonly retry: {
    readonly max_retries: 0;
  };
  readonly environment: {
    readonly type: "daytona";
    readonly delete: true;
    readonly force_build: false;
    readonly kwargs: {
      readonly secrets: {
        readonly ANTHROPIC_FOUNDRY_API_KEY: string;
      };
    };
  };
  readonly verifier: {
    readonly disable: false;
  };
  readonly agents: readonly MvpHarborAgentConfiguration[];
  readonly datasets: readonly [
    {
      readonly name: string;
      readonly ref: string;
      readonly overwrite: false;
      readonly task_names: readonly string[];
    },
  ];
}

export interface TrustedMvpHarborRequestedInvocation {
  readonly sensitivity: "trusted-hidden-mvp-harbor-invocation";
  readonly invocationId: string;
  readonly order: MvpHarborOrder;
  readonly armMode: MvpHarborRequestedArmMode;
  /**
   * Non-null only for a one-attempt partial-replicate invocation. Harbor's
   * attempt 1 is mapped to this sealed logical replicate ordinal.
   */
  readonly targetReplicateOrdinal: 1 | 2 | 3 | null;
  readonly configHash: string;
  readonly expectedTrialCount: number;
  readonly expectedTrials: readonly TrustedMvpHarborExpectedTrial[];
  readonly config: MvpHarborRequestedConfiguration;
}

export interface TrustedMvpHarborExecutionPlan {
  readonly sensitivity: "trusted-hidden-mvp-harbor-execution-plan";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly basePlan: TrustedMvpHarborPlan;
  readonly purpose: MvpHarborExecutionPurpose;
  readonly requestedCells: readonly MvpHarborRequestedCell[];
  readonly candidateTrialCount: number;
  readonly championTrialCount: number;
  readonly totalTrialCount: number;
  readonly fullFreshMatchedMatrix: boolean;
  readonly invocations: readonly TrustedMvpHarborRequestedInvocation[];
  readonly executionPlanHash: string;
}

export interface TrustedMvpHarborRequestedRawTrial extends TrustedMvpHarborRawTrial {
  readonly invocationId: string;
}

export interface TrustedMvpHarborRequestedRawOutput {
  readonly sensitivity: "trusted-mvp-harbor-requested-output";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly experimentId: string;
  readonly executionPlanHash: string;
  readonly trials: readonly TrustedMvpHarborRequestedRawTrial[];
}

export interface TrustedMvpHarborRequestedResultMatrix {
  readonly sensitivity: "trusted-hidden-mvp-requested-result-matrix";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly experimentId: string;
  readonly environmentDigest: string;
  readonly executionPlanHash: string;
  readonly purpose: MvpHarborExecutionPurpose;
  readonly fullFreshMatchedMatrix: boolean;
  readonly candidate: readonly TrustedMvpHarborDecodedTrial[];
  readonly champion: readonly TrustedMvpHarborDecodedTrial[];
}

export interface MvpHarborRequestedReleaseReceipt {
  readonly sensitivity: "release-safe-mvp-harbor-requested-receipt";
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof MVP_HARBOR_POLICY;
  readonly harborVersion: typeof MVP_HARBOR_VERSION;
  readonly experimentId: string;
  readonly purpose: MvpHarborExecutionPurpose;
  readonly completeRequestedSet: true;
  readonly fullFreshMatchedMatrix: boolean;
  readonly candidateTrialCount: number;
  readonly championTrialCount: number;
  readonly totalTrialCount: number;
  readonly infrastructureValidTrialCount: number;
  readonly candidatePassCount: number;
  readonly championPassCount: number;
  readonly candidateMeanReward: number | null;
  readonly championMeanReward: number | null;
  readonly candidateRuntimeArchiveSha256: string;
  readonly championRuntimeArchiveSha256: string;
  readonly adapterSha256: string;
  readonly modelProvider: "microsoft-foundry";
  readonly modelDeployment: string;
  readonly endpointHost: string;
  readonly reasoningEffort: "high";
  readonly containsTaskIds: false;
  readonly containsTaskNames: false;
  readonly containsPerTaskResults: false;
}

export interface DecodedMvpHarborRequestedEvaluation {
  readonly trustedMatrix: TrustedMvpHarborRequestedResultMatrix;
  readonly releaseReceipt: MvpHarborRequestedReleaseReceipt;
}

interface RequestedInvocationGroup {
  readonly order: MvpHarborOrder;
  readonly armMode: MvpHarborRequestedArmMode;
  readonly targetReplicateOrdinal: 1 | 2 | 3 | null;
  readonly tasks: readonly TrustedMvpHarborScheduledTask[];
}

function requestedCellIdentity(cell: MvpHarborRequestedCell): string {
  return identity(cell.hiddenTaskId, cell.arm, cell.replicateOrdinal);
}

function normalizeExecutionRequest(
  basePlan: TrustedMvpHarborPlan,
  requestValue: unknown,
): MvpHarborExecutionRequest {
  const request = exactRecord(
    requestValue,
    ["purpose", "cells"],
    "MVP Harbor execution request",
  );
  if (
    (request["purpose"] !== "screen" &&
      request["purpose"] !== "promotion-refresh") ||
    !Array.isArray(request["cells"]) ||
    request["cells"].length < 1 ||
    request["cells"].length > MVP_HARBOR_TRIAL_COUNT
  ) {
    fail("MVP Harbor execution request has an invalid purpose or size.");
  }
  const knownTaskIds = new Set(basePlan.tasks.map((task) => task.hiddenTaskId));
  const cells = request["cells"].map((value) => {
    const cell = exactRecord(
      value,
      ["hiddenTaskId", "arm", "replicateOrdinal"],
      "Requested Harbor cell",
    );
    assertDigest(cell["hiddenTaskId"], "Requested hidden task ID");
    if (
      !knownTaskIds.has(cell["hiddenTaskId"] as HiddenTaskHandle) ||
      (cell["arm"] !== "candidate" && cell["arm"] !== "champion") ||
      (cell["replicateOrdinal"] !== 1 &&
        cell["replicateOrdinal"] !== 2 &&
        cell["replicateOrdinal"] !== 3)
    ) {
      fail("Requested Harbor cell is outside the sealed matched panel.");
    }
    return {
      hiddenTaskId: cell["hiddenTaskId"] as HiddenTaskHandle,
      arm: cell["arm"],
      replicateOrdinal: cell["replicateOrdinal"],
    };
  });
  if (
    new Set(cells.map((cell) => requestedCellIdentity(cell))).size !==
    cells.length
  ) {
    fail("Requested Harbor cells must have unique task-arm-replicate identities.");
  }

  const allCandidateCells = basePlan.tasks.flatMap((task) =>
    ([1, 2, 3] as const).map((replicateOrdinal) =>
      identity(task.hiddenTaskId, "candidate", replicateOrdinal),
    ),
  );
  const requested = new Set(cells.map((cell) => requestedCellIdentity(cell)));
  if (
    request["purpose"] === "screen" &&
    (cells.filter((cell) => cell.arm === "candidate").length !==
      MVP_HARBOR_CELLS_PER_ARM ||
      allCandidateCells.some((cell) => !requested.has(cell)))
  ) {
    fail("A cache-aware screen must execute all fifteen candidate cells.");
  }
  if (
    request["purpose"] === "promotion-refresh" &&
    cells.some((cell) => cell.arm !== "champion")
  ) {
    fail("A promotion refresh may execute only champion cache cells.");
  }

  const taskOrdinal = new Map(
    basePlan.tasks.map((task) => [task.hiddenTaskId, task.scheduleOrdinal]),
  );
  const armOrdinal = (arm: EvaluationArm): number => (arm === "candidate" ? 0 : 1);
  cells.sort(
    (left, right) =>
      (taskOrdinal.get(left.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) -
        (taskOrdinal.get(right.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) ||
      armOrdinal(left.arm) - armOrdinal(right.arm) ||
      left.replicateOrdinal - right.replicateOrdinal,
  );
  return {
    purpose: request["purpose"],
    cells,
  };
}

function hasAllRequestedReplicates(
  requested: ReadonlySet<string>,
  task: TrustedMvpHarborScheduledTask,
  arm: EvaluationArm,
): boolean {
  return ([1, 2, 3] as const).every((replicateOrdinal) =>
    requested.has(identity(task.hiddenTaskId, arm, replicateOrdinal)),
  );
}

function requestedInvocationGroups(
  basePlan: TrustedMvpHarborPlan,
  request: MvpHarborExecutionRequest,
): readonly RequestedInvocationGroup[] {
  const requested = new Set(
    request.cells.map((cell) => requestedCellIdentity(cell)),
  );
  const groups: RequestedInvocationGroup[] = [];
  for (const order of ["AB", "BA"] as const) {
    const orderedTasks = basePlan.tasks.filter((task) => task.order === order);
    const paired =
      request.purpose === "screen"
        ? orderedTasks.filter((task) =>
            hasAllRequestedReplicates(requested, task, "champion"),
          )
        : [];
    if (paired.length > 0) {
      groups.push({
        order,
        armMode: "paired",
        targetReplicateOrdinal: null,
        tasks: paired,
      });
    }

    if (request.purpose === "screen") {
      const candidateOnly = orderedTasks.filter(
        (task) => !paired.includes(task),
      );
      if (candidateOnly.length > 0) {
        groups.push({
          order,
          armMode: "candidate-only",
          targetReplicateOrdinal: null,
          tasks: candidateOnly,
        });
      }
    }

    const championAll =
      request.purpose === "promotion-refresh"
        ? orderedTasks.filter((task) =>
            hasAllRequestedReplicates(requested, task, "champion"),
          )
        : [];
    if (championAll.length > 0) {
      groups.push({
        order,
        armMode: "champion-only",
        targetReplicateOrdinal: null,
        tasks: championAll,
      });
    }

    const fullyCoveredChampion = new Set(
      [...paired, ...championAll].map((task) => task.hiddenTaskId),
    );
    for (const replicateOrdinal of [1, 2, 3] as const) {
      const partialChampion = orderedTasks.filter(
        (task) =>
          !fullyCoveredChampion.has(task.hiddenTaskId) &&
          requested.has(
            identity(task.hiddenTaskId, "champion", replicateOrdinal),
          ),
      );
      if (partialChampion.length > 0) {
        groups.push({
          order,
          armMode: "champion-only",
          targetReplicateOrdinal: replicateOrdinal,
          tasks: partialChampion,
        });
      }
    }
  }
  return groups;
}

function groupArms(group: RequestedInvocationGroup): readonly EvaluationArm[] {
  if (group.armMode === "candidate-only") return ["candidate"];
  if (group.armMode === "champion-only") return ["champion"];
  return group.order === "AB"
    ? ["candidate", "champion"]
    : ["champion", "candidate"];
}

function requestedConfiguration(
  invocationId: string,
  group: RequestedInvocationGroup,
  basePlan: TrustedMvpHarborPlan,
): MvpHarborRequestedConfiguration {
  const arms = groupArms(group);
  return {
    job_name: invocationId,
    jobs_dir: basePlan.jobsDirectory,
    n_attempts: group.targetReplicateOrdinal === null ? 3 : 1,
    n_concurrent_trials: MVP_HARBOR_CONCURRENT_TRIALS,
    quiet: true,
    retry: {
      max_retries: 0,
    },
    environment: {
      type: basePlan.environmentType,
      delete: true,
      force_build: false,
      kwargs: {
        secrets: {
          ANTHROPIC_FOUNDRY_API_KEY:
            basePlan.evaluatedSecretSourceName,
        },
      },
    },
    verifier: {
      disable: false,
    },
    agents: arms.map((arm) => agentConfiguration(arm, basePlan)),
    datasets: [
      {
        name: basePlan.datasetName,
        ref: basePlan.datasetRef,
        overwrite: false,
        task_names: group.tasks.map((task) => task.harborTaskName),
      },
    ],
  };
}

function expectedTrialsForGroup(
  invocationId: string,
  group: RequestedInvocationGroup,
): readonly TrustedMvpHarborExpectedTrial[] {
  const arms = groupArms(group);
  const logicalReplicates =
    group.targetReplicateOrdinal === null
      ? ([1, 2, 3] as const)
      : ([group.targetReplicateOrdinal] as const);
  return group.tasks.flatMap((task) =>
    logicalReplicates.flatMap((replicateOrdinal, attemptIndex) =>
      arms.map((arm) => ({
        invocationId,
        hiddenTaskId: task.hiddenTaskId,
        harborTaskName: task.harborTaskName,
        arm,
        replicateOrdinal,
        harborAttemptOrdinal: (
          group.targetReplicateOrdinal === null ? attemptIndex + 1 : 1
        ) as 1 | 2 | 3,
      })),
    ),
  );
}

function createRequestedExecutionPlan(
  basePlan: TrustedMvpHarborPlan,
  request: MvpHarborExecutionRequest,
): TrustedMvpHarborExecutionPlan {
  const groups = requestedInvocationGroups(basePlan, request);
  const invocations = groups.map((group, index) => {
    const suffix =
      group.targetReplicateOrdinal === null
        ? group.armMode
        : `${group.armMode}-rep-${group.targetReplicateOrdinal}`;
    const invocationId =
      `${basePlan.experimentId}-${String(index + 1).padStart(2, "0")}-` +
      `${request.purpose}-${group.order.toLowerCase()}-${suffix}`;
    const config = requestedConfiguration(invocationId, group, basePlan);
    const expectedTrials = expectedTrialsForGroup(invocationId, group);
    return {
      sensitivity: "trusted-hidden-mvp-harbor-invocation" as const,
      invocationId,
      order: group.order,
      armMode: group.armMode,
      targetReplicateOrdinal: group.targetReplicateOrdinal,
      configHash: canonicalHash(config),
      expectedTrialCount: expectedTrials.length,
      expectedTrials,
      config,
    };
  });
  const candidateTrialCount = request.cells.filter(
    (cell) => cell.arm === "candidate",
  ).length;
  const championTrialCount = request.cells.length - candidateTrialCount;
  const unsigned = {
    sensitivity: "trusted-hidden-mvp-harbor-execution-plan" as const,
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: MVP_HARBOR_POLICY,
    harborVersion: MVP_HARBOR_VERSION,
    basePlan,
    purpose: request.purpose,
    requestedCells: request.cells,
    candidateTrialCount,
    championTrialCount,
    totalTrialCount: request.cells.length,
    fullFreshMatchedMatrix:
      candidateTrialCount === MVP_HARBOR_CELLS_PER_ARM &&
      championTrialCount === MVP_HARBOR_CELLS_PER_ARM,
    invocations,
  };
  return {
    ...unsigned,
    executionPlanHash: canonicalHash(unsigned),
  };
}

/**
 * Builds the smallest safe Harbor execution for a cache-aware screen or a
 * promotion refresh. Complete task/arm triples use Harbor n_attempts=3.
 * Partial champion misses use one-attempt configs whose sealed invocation maps
 * Harbor attempt 1 to the requested logical replicate.
 */
export function buildTrustedMvpHarborExecutionPlan(
  input: MvpHarborBuildInput,
  requestValue: unknown,
): TrustedMvpHarborExecutionPlan {
  const basePlan = buildTrustedMvpHarborPlan(input);
  const request = normalizeExecutionRequest(basePlan, requestValue);
  const plan = createRequestedExecutionPlan(basePlan, request);
  assertTrustedMvpHarborExecutionPlan(plan);
  return plan;
}

export function buildCanonicalFreshMvpHarborExecutionPlan(
  input: MvpHarborBuildInput,
): TrustedMvpHarborExecutionPlan {
  const basePlan = buildTrustedMvpHarborPlan(input);
  return buildTrustedMvpHarborExecutionPlan(input, {
    purpose: "screen",
    cells: basePlan.tasks.flatMap((task) =>
      ([1, 2, 3] as const).flatMap((replicateOrdinal) =>
        (["candidate", "champion"] as const).map((arm) => ({
          hiddenTaskId: task.hiddenTaskId,
          arm,
          replicateOrdinal,
        })),
      ),
    ),
  });
}

export function assertTrustedMvpHarborExecutionPlan(
  value: unknown,
): asserts value is TrustedMvpHarborExecutionPlan {
  const plan = exactRecord(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "policyVersion",
      "harborVersion",
      "basePlan",
      "purpose",
      "requestedCells",
      "candidateTrialCount",
      "championTrialCount",
      "totalTrialCount",
      "fullFreshMatchedMatrix",
      "invocations",
      "executionPlanHash",
    ],
    "Trusted MVP Harbor execution plan",
  );
  if (
    plan["sensitivity"] !== "trusted-hidden-mvp-harbor-execution-plan" ||
    plan["schemaVersion"] !== MVP_SCHEMA_VERSION ||
    plan["policyVersion"] !== MVP_HARBOR_POLICY ||
    plan["harborVersion"] !== MVP_HARBOR_VERSION
  ) {
    fail("Trusted MVP Harbor execution plan has the wrong protocol identity.");
  }
  assertTrustedMvpHarborPlan(plan["basePlan"]);
  const basePlan = plan["basePlan"];
  const request = normalizeExecutionRequest(basePlan, {
    purpose: plan["purpose"],
    cells: plan["requestedCells"],
  });
  const expected = createRequestedExecutionPlan(basePlan, request);
  try {
    if (canonicalHash(value) !== canonicalHash(expected)) {
      fail("Trusted MVP Harbor execution plan does not match its exact requested set.");
    }
  } catch (error) {
    if (error instanceof MvpHarborError) throw error;
    fail("Trusted MVP Harbor execution plan is not canonical JSON.");
  }
}

function parseRequestedRawTrial(
  value: unknown,
): TrustedMvpHarborRequestedRawTrial {
  const trial = exactRecord(
    value,
    [
      "invocationId",
      "trialId",
      "harborTaskName",
      "agentName",
      "attemptOrdinal",
      "runtimeArchiveSha256",
      "adapterSha256",
      "modelProvider",
      "modelDeployment",
      "endpointHost",
      "passed",
      "reward",
      "infrastructureValid",
      "durationMs",
      "evaluatedAt",
      "traceArtifactRefs",
      "rawDiagnostics",
    ],
    "Trusted requested Harbor trial",
  );
  if (
    typeof trial["invocationId"] !== "string" ||
    !SAFE_CODE.test(trial["invocationId"])
  ) {
    fail("Trusted requested Harbor trial invocation is malformed.");
  }
  const baseTrial: Record<string, unknown> = { ...trial };
  delete baseTrial["invocationId"];
  return {
    invocationId: trial["invocationId"],
    ...parseRawTrial(baseTrial),
  };
}

function parseRequestedRawOutput(
  value: unknown,
  expectedTrialCount: number,
): TrustedMvpHarborRequestedRawOutput {
  const output = exactRecord(
    value,
    [
      "sensitivity",
      "schemaVersion",
      "harborVersion",
      "experimentId",
      "executionPlanHash",
      "trials",
    ],
    "Trusted requested MVP Harbor output",
  );
  if (
    output["sensitivity"] !== "trusted-mvp-harbor-requested-output" ||
    output["schemaVersion"] !== MVP_SCHEMA_VERSION ||
    output["harborVersion"] !== MVP_HARBOR_VERSION ||
    typeof output["experimentId"] !== "string" ||
    !SAFE_EXPERIMENT.test(output["experimentId"]) ||
    typeof output["executionPlanHash"] !== "string" ||
    !SHA256.test(output["executionPlanHash"]) ||
    !Array.isArray(output["trials"]) ||
    output["trials"].length !== expectedTrialCount
  ) {
    fail("Trusted requested Harbor output has the wrong exact trial count.");
  }
  return {
    sensitivity: "trusted-mvp-harbor-requested-output",
    schemaVersion: MVP_SCHEMA_VERSION,
    harborVersion: MVP_HARBOR_VERSION,
    experimentId: output["experimentId"],
    executionPlanHash: output["executionPlanHash"],
    trials: output["trials"].map((trial) => parseRequestedRawTrial(trial)),
  };
}

function nullableMean(trials: readonly TrustedMvpHarborDecodedTrial[]): number | null {
  return trials.length === 0
    ? null
    : rounded(mean(trials.map((trial) => trial.reward)));
}

/**
 * Decodes an exact requested set, including cache-aware partial batches. The
 * invocation binding maps Harbor attempt ordinals to logical replicate
 * ordinals before the final hiddenTaskId + arm + replicateOrdinal identity is
 * checked. No unrequested result may be silently accepted.
 */
export function decodeTrustedMvpHarborRequestedOutput(
  executionPlanValue: unknown,
  rawOutputValue: unknown,
): DecodedMvpHarborRequestedEvaluation {
  assertTrustedMvpHarborExecutionPlan(executionPlanValue);
  const plan = executionPlanValue;
  const output = parseRequestedRawOutput(
    rawOutputValue,
    plan.totalTrialCount,
  );
  if (
    output.experimentId !== plan.basePlan.experimentId ||
    output.executionPlanHash !== plan.executionPlanHash
  ) {
    fail("Trusted requested Harbor output does not match its sealed execution plan.");
  }

  const expectedByRawIdentity = new Map<string, TrustedMvpHarborExpectedTrial>();
  for (const expected of plan.invocations.flatMap(
    (invocation) => invocation.expectedTrials,
  )) {
    const agentName =
      expected.arm === "candidate"
        ? "dark-factory-candidate"
        : "dark-factory-champion";
    const rawIdentity =
      `${expected.invocationId}|${expected.harborTaskName}|` +
      `${agentName}|${expected.harborAttemptOrdinal}`;
    if (expectedByRawIdentity.has(rawIdentity)) {
      fail("Requested Harbor plan contains an ambiguous raw result identity.");
    }
    expectedByRawIdentity.set(rawIdentity, expected);
  }
  if (expectedByRawIdentity.size !== plan.totalTrialCount) {
    fail("Requested Harbor plan does not cover its exact declared trial set.");
  }

  const taskById = new Map(
    plan.basePlan.tasks.map((task) => [task.hiddenTaskId, task]),
  );
  const seenRawIdentities = new Set<string>();
  const seenLogicalIdentities = new Set<string>();
  const seenTrialIds = new Set<string>();
  const decoded: TrustedMvpHarborDecodedTrial[] = [];
  for (const trial of output.trials) {
    const rawIdentity =
      `${trial.invocationId}|${trial.harborTaskName}|` +
      `${trial.agentName}|${trial.attemptOrdinal}`;
    const expected = expectedByRawIdentity.get(rawIdentity);
    if (
      expected === undefined ||
      seenRawIdentities.has(rawIdentity) ||
      seenTrialIds.has(trial.trialId)
    ) {
      fail("Requested Harbor output contains an unrequested or duplicate trial.");
    }
    const logicalIdentity = requestedCellIdentity(expected);
    if (seenLogicalIdentities.has(logicalIdentity)) {
      fail("Requested Harbor output duplicates a logical matched cell.");
    }
    const task = taskById.get(expected.hiddenTaskId);
    if (task === undefined) {
      fail("Requested Harbor output escaped the sealed hidden panel.");
    }
    const runtime =
      expected.arm === "candidate"
        ? plan.basePlan.candidateRuntime
        : plan.basePlan.championRuntime;
    if (
      trial.runtimeArchiveSha256 !== runtime.artifact.sha256 ||
      trial.adapterSha256 !== plan.basePlan.adapter.artifact.sha256 ||
      trial.modelProvider !== plan.basePlan.model.provider ||
      trial.modelDeployment !== plan.basePlan.model.deployment ||
      trial.endpointHost !== plan.basePlan.model.endpointHost
    ) {
      fail("Requested Harbor trial execution bindings do not match the sealed plan.");
    }
    seenRawIdentities.add(rawIdentity);
    seenLogicalIdentities.add(logicalIdentity);
    seenTrialIds.add(trial.trialId);
    decoded.push({
      hiddenTaskId: task.hiddenTaskId,
      taskRevisionDigest: task.taskRevisionDigest,
      harborTaskName: task.harborTaskName,
      cellId: task.cellIds[expected.replicateOrdinal - 1],
      arm: expected.arm,
      replicateOrdinal: expected.replicateOrdinal,
      order: task.order,
      harnessRevision: runtime.harnessRevision,
      source: "fresh",
      passed: trial.passed,
      reward: trial.reward,
      infrastructureValid: trial.infrastructureValid,
      durationMs: trial.durationMs,
      evaluatedAt: trial.evaluatedAt,
      traceArtifactRefs: [...trial.traceArtifactRefs],
      rawDiagnostics: [...trial.rawDiagnostics],
    });
  }
  if (
    seenLogicalIdentities.size !== plan.totalTrialCount ||
    [...expectedByRawIdentity.keys()].some(
      (rawIdentity) => !seenRawIdentities.has(rawIdentity),
    )
  ) {
    fail("Requested Harbor output is incomplete.");
  }

  const taskOrdinal = new Map(
    plan.basePlan.tasks.map((task) => [task.hiddenTaskId, task.scheduleOrdinal]),
  );
  const sortTrials = (
    left: TrustedMvpHarborDecodedTrial,
    right: TrustedMvpHarborDecodedTrial,
  ): number =>
    (taskOrdinal.get(left.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) -
      (taskOrdinal.get(right.hiddenTaskId) ?? Number.MAX_SAFE_INTEGER) ||
    left.replicateOrdinal - right.replicateOrdinal;
  const candidate = decoded
    .filter((trial) => trial.arm === "candidate")
    .sort(sortTrials);
  const champion = decoded
    .filter((trial) => trial.arm === "champion")
    .sort(sortTrials);
  if (
    candidate.length !== plan.candidateTrialCount ||
    champion.length !== plan.championTrialCount
  ) {
    fail("Requested Harbor output has the wrong arm cardinality.");
  }

  return {
    trustedMatrix: {
      sensitivity: "trusted-hidden-mvp-requested-result-matrix",
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_HARBOR_POLICY,
      experimentId: plan.basePlan.experimentId,
      environmentDigest: plan.basePlan.environmentDigest,
      executionPlanHash: plan.executionPlanHash,
      purpose: plan.purpose,
      fullFreshMatchedMatrix: plan.fullFreshMatchedMatrix,
      candidate,
      champion,
    },
    releaseReceipt: {
      sensitivity: "release-safe-mvp-harbor-requested-receipt",
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_HARBOR_POLICY,
      harborVersion: MVP_HARBOR_VERSION,
      experimentId: plan.basePlan.experimentId,
      purpose: plan.purpose,
      completeRequestedSet: true,
      fullFreshMatchedMatrix: plan.fullFreshMatchedMatrix,
      candidateTrialCount: candidate.length,
      championTrialCount: champion.length,
      totalTrialCount: decoded.length,
      infrastructureValidTrialCount: decoded.filter(
        (trial) => trial.infrastructureValid,
      ).length,
      candidatePassCount: candidate.filter((trial) => trial.passed).length,
      championPassCount: champion.filter((trial) => trial.passed).length,
      candidateMeanReward: nullableMean(candidate),
      championMeanReward: nullableMean(champion),
      candidateRuntimeArchiveSha256:
        plan.basePlan.candidateRuntime.artifact.sha256,
      championRuntimeArchiveSha256:
        plan.basePlan.championRuntime.artifact.sha256,
      adapterSha256: plan.basePlan.adapter.artifact.sha256,
      modelProvider: plan.basePlan.model.provider,
      modelDeployment: plan.basePlan.model.deployment,
      endpointHost: plan.basePlan.model.endpointHost,
      reasoningEffort: plan.basePlan.model.reasoningEffort,
      containsTaskIds: false,
      containsTaskNames: false,
      containsPerTaskResults: false,
    },
  };
}

export function assertCanonicalFreshMvpHarborEvaluation(
  value: DecodedMvpHarborRequestedEvaluation,
): void {
  if (
    value.trustedMatrix.purpose !== "screen" ||
    !value.trustedMatrix.fullFreshMatchedMatrix ||
    value.trustedMatrix.candidate.length !== MVP_HARBOR_CELLS_PER_ARM ||
    value.trustedMatrix.champion.length !== MVP_HARBOR_CELLS_PER_ARM ||
    !value.releaseReceipt.completeRequestedSet ||
    !value.releaseReceipt.fullFreshMatchedMatrix ||
    value.releaseReceipt.totalTrialCount !== MVP_HARBOR_TRIAL_COUNT
  ) {
    fail("A canonical fresh matched evaluation requires a complete 15/15 matrix.");
  }
}
