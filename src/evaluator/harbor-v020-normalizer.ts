import { createHash } from "node:crypto";

import type {
  RemoteExecutionReceipt,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type {
  TrustedHarborInvocation,
  TrustedHarborJobArtifact,
  TrustedHarborUpload,
} from "../terminal-bench/harbor.js";
import type {
  TrustedMatchedArm,
  TrustedMatchedArmSchedule,
  TrustedMatchedPanel,
} from "../terminal-bench/trusted.js";
import type { TrustedRuntimeVerificationReceipt } from "../terminal-bench/runner.js";
import {
  HARBOR_0_20_0_VERSION,
  HARBOR_0_20_0_WHEEL_SHA256,
  assertTrustedHarbor020DecodingPlan,
  hashTrustedHarbor020DecodingPlan,
  type TrustedHarbor020DecodingPlan,
  type TrustedHarbor020ExpectedArm,
  type TrustedHarbor020ExpectedInvocation,
} from "./harbor-v020-decoder.js";
import {
  parseHarbor020Json,
  parseHarbor020OutputBundle,
  type Harbor020ParsedOutputBundle,
} from "./harbor-v020-bundle.js";
import type {
  TrustedDecodedPlaintextSet,
  TrustedEvaluatorPortBoundary,
} from "./raw-reader.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAXIMUM_WRAPPER_BYTES = 256 * 1024 * 1024;

type PlainRecord = Readonly<Record<string, unknown>>;

export interface TrustedHarbor020NormalizationContext {
  readonly sensitivity: "trusted-harbor-0.20.0-normalization-context";
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly jobSha256: string;
  readonly protocolHash: string;
  readonly environmentFingerprintHash: string;
  readonly evaluatedModel: {
    readonly provider: string;
    readonly modelId: string;
  };
  readonly contextHash: string;
}

export interface TrustedHarbor020NormalizationContextProvider {
  readonly boundary: TrustedEvaluatorPortBoundary;
  load(input: {
    readonly requestId: string;
    readonly jobSha256: string;
  }): Promise<TrustedHarbor020NormalizationContext>;
}

export interface TrustedHarbor020TrialResourceRequest {
  readonly scheduleArmId: string;
  readonly trialId: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface TrustedHarbor020TrialResourceAllocation {
  readonly scheduleArmId: string;
  readonly trialId: string;
  readonly sandboxUsd: number;
  readonly cpuUtilizationPercent: number | null;
  readonly maxRssMb: number | null;
}

/**
 * Billing is provider-specific and must come from a trusted cloud billing or
 * metering source. The normalizer refuses a missing arm or a synthetic zero
 * fallback. CPU/RSS may honestly be null when per-trial telemetry is absent.
 */
export interface TrustedHarbor020TrialResourceAllocator {
  readonly boundary: TrustedEvaluatorPortBoundary;
  allocate(input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
    readonly invocation: TrustedHarborInvocation;
    readonly execution: RemoteExecutionReceipt;
    readonly trials: readonly TrustedHarbor020TrialResourceRequest[];
  }): Promise<readonly TrustedHarbor020TrialResourceAllocation[]>;
}

export interface TrustedHarbor020BundleInput {
  readonly artifact: TrustedCloudArtifactRef;
  readonly bytes: Uint8Array;
  readonly invocation: TrustedHarborInvocation;
  readonly execution: RemoteExecutionReceipt;
}

export interface TrustedHarbor020ConfigInput {
  readonly upload: TrustedHarborUpload;
  readonly bytes: Uint8Array;
  readonly invocation: TrustedHarborInvocation;
}

export interface TrustedHarbor020NormalizedEvidence {
  readonly sensitivity: "trusted-harbor-0.20.0-normalized-evidence";
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly jobSha256: string;
  readonly sourceEvidenceHash: string;
  readonly plan: TrustedHarbor020DecodingPlan;
  /**
   * Ownership transfers to ingress. The normalizer must not retain these
   * buffers; ingress encrypts them immediately and zeroes them in `finally`.
   */
  readonly plaintexts: TrustedDecodedPlaintextSet;
  readonly plaintextHashes: Readonly<
    Record<"atif" | "grader-output" | "harbor-output", string>
  >;
  readonly normalizationAttestationHash: string;
}

export interface TrustedHarbor020BundleNormalizer {
  readonly boundary: TrustedEvaluatorPortBoundary;
  normalize(input: {
    readonly requestId: string;
    readonly job: TrustedHarborJobArtifact;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly executions: readonly RemoteExecutionReceipt[];
    readonly runtimeVerification: TrustedRuntimeVerificationReceipt;
    readonly sourceEvidenceHash: string;
    readonly bundles: readonly TrustedHarbor020BundleInput[];
    readonly configs: readonly TrustedHarbor020ConfigInput[];
    readonly maximumArchiveBytes: number;
  }): Promise<TrustedHarbor020NormalizedEvidence>;
}

export interface StrictHarbor020BundleNormalizerOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly contexts: TrustedHarbor020NormalizationContextProvider;
  readonly resources: TrustedHarbor020TrialResourceAllocator;
}

export class Harbor020NormalizationError extends Error {
  override readonly name = "Harbor020NormalizationError";

  constructor() {
    super("Harbor v0.20.0 evidence failed strict trusted normalization.");
  }
}

function fail(): never {
  throw new Harbor020NormalizationError();
}

function record(value: unknown): PlainRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail();
  }
  return value as PlainRecord;
}

function exactKeys(value: unknown, keys: readonly string[]): PlainRecord {
  const result = record(value);
  const actual = Object.keys(result);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
  return result;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value.toLowerCase();
}

function finiteNonNegative(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    fail();
  }
  return value;
}

function nullableFiniteNonNegative(value: unknown): number | null {
  return value === null ? null : finiteNonNegative(value);
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) fail();
  const match =
    /^(?<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<zone>Z|\+00:00)?$/u.exec(
      value,
    );
  if (match?.groups === undefined) fail();
  const normalized = `${match.groups["date"]}.${(match.groups["fraction"] ?? "")
    .padEnd(3, "0")
    .slice(0, 3)}Z`;
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(Date.parse(normalized)).toISOString() !== normalized
  ) {
    fail();
  }
  return normalized;
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashTrustedHarbor020NormalizationContext(
  context: Omit<TrustedHarbor020NormalizationContext, "contextHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.harbor-0.20.0-normalization-context.v1",
    ...context,
  });
}

function assertContext(
  value: TrustedHarbor020NormalizationContext,
  requestId: string,
  jobSha256: string,
): void {
  exactKeys(value, [
    "sensitivity",
    "schemaVersion",
    "requestId",
    "jobSha256",
    "protocolHash",
    "environmentFingerprintHash",
    "evaluatedModel",
    "contextHash",
  ]);
  const model = exactKeys(value.evaluatedModel, ["provider", "modelId"]);
  if (
    value.sensitivity !==
      "trusted-harbor-0.20.0-normalization-context" ||
    value.schemaVersion !== 1 ||
    value.requestId !== requestId ||
    value.jobSha256 !== jobSha256 ||
    typeof model["provider"] !== "string" ||
    !SAFE_MODEL_ID.test(model["provider"]) ||
    typeof model["modelId"] !== "string" ||
    !SAFE_MODEL_ID.test(model["modelId"]) ||
    value.contextHash !==
      hashTrustedHarbor020NormalizationContext({
        sensitivity: value.sensitivity,
        schemaVersion: value.schemaVersion,
        requestId: value.requestId,
        jobSha256: value.jobSha256,
        protocolHash: value.protocolHash,
        environmentFingerprintHash: value.environmentFingerprintHash,
        evaluatedModel: value.evaluatedModel,
      })
  ) {
    fail();
  }
  digest(value.jobSha256);
  digest(value.protocolHash);
  digest(value.environmentFingerprintHash);
  digest(value.contextHash);
}

interface ParsedInputConfig {
  readonly taskNames: readonly string[];
  readonly agentOrder: readonly ("candidate" | "champion")[];
}

function parseInputConfig(
  input: TrustedHarbor020ConfigInput,
  context: TrustedHarbor020NormalizationContext,
): ParsedInputConfig {
  if (
    input.upload.artifact.sha256 !== input.invocation.configSha256 ||
    input.upload.artifact.byteLength !== input.bytes.byteLength ||
    hashBytes(input.bytes) !== input.invocation.configSha256
  ) {
    fail();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
  } catch {
    fail();
  }
  const config = exactKeys(parseHarbor020Json(input.bytes), [
    "job_name",
    "jobs_dir",
    "n_attempts",
    "n_concurrent_trials",
    "quiet",
    "retry",
    "environment",
    "verifier",
    "agents",
    "datasets",
  ]);
  if (
    canonicalJson(config) !== text ||
    config["job_name"] !== input.invocation.invocationId ||
    config["n_attempts"] !== 1 ||
    config["n_concurrent_trials"] !== 1 ||
    config["quiet"] !== true
  ) {
    fail();
  }
  const retry = exactKeys(config["retry"], ["max_retries"]);
  const environment = exactKeys(config["environment"], [
    "type",
    "delete",
    "force_build",
  ]);
  const verifier = exactKeys(config["verifier"], ["disable"]);
  if (
    retry["max_retries"] !== 0 ||
    environment["delete"] !== true ||
    environment["force_build"] !== false ||
    verifier["disable"] !== false ||
    !Array.isArray(config["agents"]) ||
    config["agents"].length !== input.invocation.agentOrder.length ||
    !Array.isArray(config["datasets"]) ||
    config["datasets"].length !== 1
  ) {
    fail();
  }
  const agentOrder: ("candidate" | "champion")[] = [];
  for (const [index, rawAgent] of config["agents"].entries()) {
    const agent = record(rawAgent);
    const expectedArm = input.invocation.agentOrder[index];
    if (
      expectedArm === undefined ||
      agent["name"] !== `dark-factory-${expectedArm}` ||
      agent["model_name"] !==
        `${context.evaluatedModel.provider}/${context.evaluatedModel.modelId}`
    ) {
      fail();
    }
    agentOrder.push(expectedArm);
  }
  const dataset = exactKeys(config["datasets"][0], [
    "name",
    "ref",
    "overwrite",
    "task_names",
  ]);
  if (
    dataset["overwrite"] !== false ||
    !Array.isArray(dataset["task_names"]) ||
    dataset["task_names"].length !== input.invocation.cellCount
  ) {
    fail();
  }
  const taskNames = dataset["task_names"].map((name) => {
    if (typeof name !== "string" || !SAFE_TASK_NAME.test(name)) fail();
    return name;
  });
  if (new Set(taskNames).size !== taskNames.length) fail();
  return { taskNames, agentOrder };
}

function assertOutputConfig(
  outputConfig: PlainRecord,
  input: TrustedHarbor020ConfigInput,
  parsed: ParsedInputConfig,
  context: TrustedHarbor020NormalizationContext,
): void {
  if (
    outputConfig["job_name"] !== input.invocation.invocationId ||
    outputConfig["n_concurrent_trials"] !== 1 ||
    outputConfig["quiet"] !== true ||
    !Array.isArray(outputConfig["agents"]) ||
    outputConfig["agents"].length !== parsed.agentOrder.length ||
    !Array.isArray(outputConfig["datasets"]) ||
    outputConfig["datasets"].length !== 1 ||
    (outputConfig["source_jobs"] !== undefined &&
      (!Array.isArray(outputConfig["source_jobs"]) ||
        outputConfig["source_jobs"].length !== 0))
  ) {
    fail();
  }
  for (const [index, rawAgent] of outputConfig["agents"].entries()) {
    const agent = record(rawAgent);
    const arm = parsed.agentOrder[index];
    if (
      arm === undefined ||
      agent["name"] !== `dark-factory-${arm}` ||
      agent["model_name"] !==
        `${context.evaluatedModel.provider}/${context.evaluatedModel.modelId}`
    ) {
      fail();
    }
  }
  const dataset = record(outputConfig["datasets"][0]);
  if (
    !Array.isArray(dataset["task_names"]) ||
    canonicalJson(dataset["task_names"]) !== canonicalJson(parsed.taskNames)
  ) {
    fail();
  }
}

function armsForInvocation(
  panel: TrustedMatchedPanel,
  schedule: TrustedMatchedArmSchedule,
  invocation: TrustedHarborInvocation,
  config: ParsedInputConfig,
): readonly {
  readonly taskName: string;
  readonly arms: readonly TrustedMatchedArm[];
}[] {
  const cells =
    invocation.order === "repair"
      ? panel.cells.map((cell, cellOrdinal) => ({ cell, cellOrdinal }))
      : panel.cells
          .map((cell, cellOrdinal) => ({ cell, cellOrdinal }))
          .filter(({ cell }) => cell.order === invocation.order);
  if (cells.length !== invocation.cellCount || cells.length !== config.taskNames.length) {
    fail();
  }
  return cells.map(({ cell, cellOrdinal }, index) => {
    const arms = schedule.arms.filter(
      (arm) => arm.cellOrdinal === cellOrdinal,
    );
    if (
      arms.length !== config.agentOrder.length ||
      config.agentOrder.some(
        (kind) => !arms.some((arm) => arm.arm === kind),
      ) ||
      arms.some(
        (arm) =>
          arm.taskId !== cell.taskId ||
          arm.taskRevisionDigest !== cell.taskRevisionDigest ||
          arm.capabilityStratum !== cell.capabilityStratum ||
          arm.order !== cell.order,
      )
    ) {
      fail();
    }
    const taskName = config.taskNames[index];
    if (taskName === undefined) fail();
    return {
      taskName,
      arms: config.agentOrder.map((kind) => {
        const arm = arms.find((candidate) => candidate.arm === kind);
        if (arm === undefined) fail();
        return arm;
      }),
    };
  });
}

interface JoinedTrial {
  readonly scheduleArm: TrustedMatchedArm;
  readonly taskName: string;
  readonly taskChecksum: string;
  readonly trialId: string;
  readonly result: PlainRecord;
  readonly trajectory: PlainRecord;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reward: number;
}

function joinTrials(
  bundle: Harbor020ParsedOutputBundle,
  expectedTasks: ReturnType<typeof armsForInvocation>,
): readonly JoinedTrial[] {
  const expected = new Map<string, TrustedMatchedArm>();
  for (const task of expectedTasks) {
    for (const arm of task.arms) {
      expected.set(`${task.taskName}\u0000dark-factory-${arm.arm}`, arm);
    }
  }
  const joinedByArmId = new Map<string, JoinedTrial>();
  for (const trialFiles of bundle.trials) {
    const result = trialFiles.result;
    const taskName = result["task_name"];
    const config = record(result["config"]);
    const agent = record(config["agent"]);
    if (
      typeof taskName !== "string" ||
      !SAFE_TASK_NAME.test(taskName) ||
      result["trial_name"] !== trialFiles.directory ||
      typeof agent["name"] !== "string"
    ) {
      fail();
    }
    const key = `${taskName}\u0000${agent["name"]}`;
    const scheduleArm = expected.get(key);
    if (
      scheduleArm === undefined ||
      joinedByArmId.has(scheduleArm.armId)
    ) {
      fail();
    }
    const execution = record(result["agent_execution"]);
    const startedAt = canonicalTimestamp(execution["started_at"]);
    const completedAt = canonicalTimestamp(execution["finished_at"]);
    if (Date.parse(completedAt) < Date.parse(startedAt)) fail();
    const verifier = record(result["verifier_result"]);
    const rewards = exactKeys(verifier["rewards"], ["reward"]);
    const reward = finiteNonNegative(rewards["reward"]);
    if (reward > 1) fail();
    joinedByArmId.set(scheduleArm.armId, {
      scheduleArm,
      taskName,
      taskChecksum: digest(result["task_checksum"]),
      trialId: uuid(result["id"]),
      result,
      trajectory: trialFiles.trajectory,
      startedAt,
      completedAt,
      reward,
    });
  }
  if (
    joinedByArmId.size !== expected.size
  ) {
    fail();
  }
  const joined = expectedTasks.flatMap((task) =>
    task.arms.map((arm) => {
      const trial = joinedByArmId.get(arm.armId);
      if (trial === undefined) fail();
      return trial;
    }),
  );
  for (const task of expectedTasks) {
    const checksums = new Set(
      joined
        .filter((entry) => entry.taskName === task.taskName)
        .map((entry) => entry.taskChecksum),
    );
    if (checksums.size !== 1) fail();
  }
  return joined;
}

function assertAllocations(
  values: readonly TrustedHarbor020TrialResourceAllocation[],
  trials: readonly JoinedTrial[],
): ReadonlyMap<string, TrustedHarbor020TrialResourceAllocation> {
  if (!Array.isArray(values) || values.length !== trials.length) fail();
  const result = new Map<string, TrustedHarbor020TrialResourceAllocation>();
  const expected = new Map(
    trials.map((trial) => [trial.scheduleArm.armId, trial] as const),
  );
  for (const value of values) {
    exactKeys(value, [
      "scheduleArmId",
      "trialId",
      "sandboxUsd",
      "cpuUtilizationPercent",
      "maxRssMb",
    ]);
    const scheduleArmId = safeId(value.scheduleArmId);
    const trial = expected.get(scheduleArmId);
    const cpu = nullableFiniteNonNegative(value.cpuUtilizationPercent);
    if (
      trial === undefined ||
      result.has(scheduleArmId) ||
      uuid(value.trialId) !== trial.trialId ||
      value.sandboxUsd <= 0 ||
      (cpu !== null && cpu > 100)
    ) {
      fail();
    }
    finiteNonNegative(value.sandboxUsd);
    nullableFiniteNonNegative(value.maxRssMb);
    result.set(scheduleArmId, value);
  }
  return result;
}

function encodeWrapper(value: PlainRecord): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength < 2 || bytes.byteLength > MAXIMUM_WRAPPER_BYTES) {
    fail();
  }
  return bytes;
}

function header(
  schemaVersion: string,
  input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  },
): PlainRecord {
  return {
    schemaVersion,
    harborVersion: HARBOR_0_20_0_VERSION,
    harborWheelSha256: HARBOR_0_20_0_WHEEL_SHA256,
    requestId: input.requestId,
    jobSha256: input.jobSha256,
    sourceEvidenceHash: input.sourceEvidenceHash,
  };
}

export class StrictHarbor020BundleNormalizer
  implements TrustedHarbor020BundleNormalizer
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #contexts: TrustedHarbor020NormalizationContextProvider;
  readonly #resources: TrustedHarbor020TrialResourceAllocator;

  constructor(options: StrictHarbor020BundleNormalizerOptions) {
    const expected =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    if (
      options.contexts.boundary !== expected ||
      options.resources.boundary !== expected
    ) {
      fail();
    }
    this.boundary = expected;
    this.#contexts = options.contexts;
    this.#resources = options.resources;
  }

  async normalize(input: {
    readonly requestId: string;
    readonly job: TrustedHarborJobArtifact;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly executions: readonly RemoteExecutionReceipt[];
    readonly runtimeVerification: TrustedRuntimeVerificationReceipt;
    readonly sourceEvidenceHash: string;
    readonly bundles: readonly TrustedHarbor020BundleInput[];
    readonly configs: readonly TrustedHarbor020ConfigInput[];
    readonly maximumArchiveBytes: number;
  }): Promise<TrustedHarbor020NormalizedEvidence> {
    const ownedPlaintexts: Uint8Array[] = [];
    let transferred = false;
    try {
      if (
        input.requestId !== input.job.requestId ||
        input.requestId !== input.panel.requestId ||
        input.requestId !== input.schedule.requestId ||
        input.job.stage !== input.panel.stage ||
        input.job.stage !== input.schedule.stage ||
        input.bundles.length !== input.job.invocations.length ||
        input.configs.length !== input.job.invocations.length ||
        input.executions.length !== input.job.invocations.length ||
        input.runtimeVerification.harborPackageSha256 !==
          HARBOR_0_20_0_WHEEL_SHA256 ||
        !SHA256.test(input.sourceEvidenceHash) ||
        !Number.isSafeInteger(input.maximumArchiveBytes) ||
        input.maximumArchiveBytes < 1
      ) {
        fail();
      }
      const context = await this.#contexts.load({
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
      });
      assertContext(context, input.requestId, input.job.jobSha256);

      const planInvocations: TrustedHarbor020ExpectedInvocation[] = [];
      const harborInvocations: PlainRecord[] = [];
      const graderRecords: PlainRecord[] = [];
      const atifRecords: PlainRecord[] = [];
      const bundleBindings: PlainRecord[] = [];
      for (const [index, invocation] of input.job.invocations.entries()) {
        const bundleInput = input.bundles[index];
        const configInput = input.configs[index];
        const execution = input.executions[index];
        if (
          bundleInput === undefined ||
          configInput === undefined ||
          execution === undefined ||
          bundleInput.invocation.invocationId !== invocation.invocationId ||
          configInput.invocation.invocationId !== invocation.invocationId ||
          bundleInput.execution.executionId !== execution.executionId ||
          execution.exitCode !== 0 ||
          execution.timedOut ||
          execution.cancelled
        ) {
          fail();
        }
        const parsedConfig = parseInputConfig(configInput, context);
        const parsedBundle = parseHarbor020OutputBundle({
          artifact: bundleInput.artifact,
          bytes: bundleInput.bytes,
          job: input.job,
          invocation,
          executionId: execution.executionId,
          maximumArchiveBytes: input.maximumArchiveBytes,
        });
        assertOutputConfig(
          parsedBundle.outputConfig,
          configInput,
          parsedConfig,
          context,
        );
        const expectedTasks = armsForInvocation(
          input.panel,
          input.schedule,
          invocation,
          parsedConfig,
        );
        const joined = joinTrials(parsedBundle, expectedTasks);
        const allocations = assertAllocations(
          await this.#resources.allocate({
            requestId: input.requestId,
            jobSha256: input.job.jobSha256,
            sourceEvidenceHash: input.sourceEvidenceHash,
            invocation,
            execution,
            trials: joined.map((trial) => ({
              scheduleArmId: trial.scheduleArm.armId,
              trialId: trial.trialId,
              startedAt: trial.startedAt,
              completedAt: trial.completedAt,
            })),
          }),
          joined,
        );
        const expectedArms: TrustedHarbor020ExpectedArm[] = [];
        for (const trial of joined) {
          const allocation = allocations.get(trial.scheduleArm.armId);
          if (allocation === undefined) fail();
          expectedArms.push({
            scheduleArmId: trial.scheduleArm.armId,
            taskId: trial.scheduleArm.taskId,
            taskRevisionDigest: trial.scheduleArm.taskRevisionDigest,
            capabilityStratum: trial.scheduleArm.capabilityStratum,
            arm: trial.scheduleArm.arm,
            order: trial.scheduleArm.order,
            harnessArchiveSha256:
              trial.scheduleArm.harness.archiveSha256,
            harborTaskName: trial.taskName,
            harborTaskChecksum: trial.taskChecksum,
          });
          graderRecords.push({
            trialId: trial.trialId,
            scheduleArmId: trial.scheduleArm.armId,
            attemptOrdinal: 1,
            passed: trial.reward === 1,
            boundedReward: trial.reward,
            infrastructureInvalidClass: null,
            integrityStatus: "passed",
            elapsedMs:
              Date.parse(trial.completedAt) - Date.parse(trial.startedAt),
            cpuUtilizationPercent: allocation.cpuUtilizationPercent,
            maxRssMb: allocation.maxRssMb,
            protocolHash: context.protocolHash,
            environmentFingerprintHash:
              context.environmentFingerprintHash,
            sandboxUsd: allocation.sandboxUsd,
          });
          atifRecords.push({
            trialId: trial.trialId,
            scheduleArmId: trial.scheduleArm.armId,
            attemptOrdinal: 1,
            trajectory: trial.trajectory,
          });
        }
        planInvocations.push({
          invocationId: invocation.invocationId,
          order: invocation.order,
          configSha256: invocation.configSha256,
          executionId: execution.executionId,
          arms: expectedArms,
        });
        harborInvocations.push({
          invocationId: invocation.invocationId,
          order: invocation.order,
          configSha256: invocation.configSha256,
          executionId: execution.executionId,
          jobResult: parsedBundle.jobResult,
          trials: joined.map((trial) => ({
            scheduleArmId: trial.scheduleArm.armId,
            attemptOrdinal: 1,
            result: trial.result,
          })),
        });
        bundleBindings.push({
          invocationId: invocation.invocationId,
          executionId: execution.executionId,
          artifactSha256: bundleInput.artifact.sha256,
          manifestPayloadSha256: parsedBundle.manifest.payloadSha256,
          configSha256: invocation.configSha256,
        });
      }
      const planWithoutHash = {
        sensitivity: "trusted-harbor-0.20.0-decoding-plan" as const,
        schemaVersion: 1 as const,
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
        sourceEvidenceHash: input.sourceEvidenceHash,
        protocolHash: context.protocolHash,
        environmentFingerprintHash:
          context.environmentFingerprintHash,
        evaluatedModel: context.evaluatedModel,
        invocations: planInvocations,
      };
      const plan: TrustedHarbor020DecodingPlan = {
        ...planWithoutHash,
        planHash: hashTrustedHarbor020DecodingPlan(planWithoutHash),
      };
      assertTrustedHarbor020DecodingPlan(plan, {
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
        sourceEvidenceHash: input.sourceEvidenceHash,
      });
      const harborOutput = encodeWrapper({
        ...header("dark-factory.harbor-0.20.0-results.v1", {
          requestId: input.requestId,
          jobSha256: input.job.jobSha256,
          sourceEvidenceHash: input.sourceEvidenceHash,
        }),
        invocations: harborInvocations,
      });
      ownedPlaintexts.push(harborOutput);
      const graderOutput = encodeWrapper({
        ...header("dark-factory.harbor-0.20.0-graders.v1", {
          requestId: input.requestId,
          jobSha256: input.job.jobSha256,
          sourceEvidenceHash: input.sourceEvidenceHash,
        }),
        records: graderRecords,
      });
      ownedPlaintexts.push(graderOutput);
      const atif = encodeWrapper({
        ...header("dark-factory.harbor-0.20.0-atif.v1", {
          requestId: input.requestId,
          jobSha256: input.job.jobSha256,
          sourceEvidenceHash: input.sourceEvidenceHash,
        }),
        records: atifRecords,
      });
      ownedPlaintexts.push(atif);
      const plaintexts: TrustedDecodedPlaintextSet = {
        atif,
        "grader-output": graderOutput,
        "harbor-output": harborOutput,
      };
      const plaintextHashes = {
        atif: hashBytes(atif),
        "grader-output": hashBytes(graderOutput),
        "harbor-output": hashBytes(harborOutput),
      };
      const normalizationAttestationHash = canonicalHash({
        domain: "dark-factory.harbor-0.20.0-normalization.v1",
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
        pinHash: input.job.pinHash,
        sourceEvidenceHash: input.sourceEvidenceHash,
        runtimeVerification: input.runtimeVerification,
        contextHash: context.contextHash,
        planHash: plan.planHash,
        bundleBindings,
        plaintextHashes,
      });
      transferred = true;
      return {
        sensitivity: "trusted-harbor-0.20.0-normalized-evidence",
        schemaVersion: 1,
        requestId: input.requestId,
        jobSha256: input.job.jobSha256,
        sourceEvidenceHash: input.sourceEvidenceHash,
        plan,
        plaintexts,
        plaintextHashes,
        normalizationAttestationHash,
      };
    } catch {
      fail();
    } finally {
      if (!transferred) {
        ownedPlaintexts.forEach((value) => value.fill(0));
      }
    }
  }
}
