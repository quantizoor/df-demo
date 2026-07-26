import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { TrustedHarborInvocation } from "../terminal-bench/harbor.js";
import type {
  MatchedArmKind,
  MatchedArmOrder,
} from "../terminal-bench/trusted.js";
import type { HiddenTaskId } from "../evaluation/types.js";
import type {
  RawTrajectory,
  RawTrajectoryEvent,
  ScalarGraderOutcomeInput,
} from "../evaluation/behavior.js";
import type {
  TrustedDecodedAttemptCost,
  TrustedDecodedEvaluation,
  TrustedDecodedEvaluationAttempt,
} from "./deriver.js";
import type {
  TrustedEvaluatorPortBoundary,
  TrustedHarborRawArtifactDecoder,
  TrustedHarborRawDecoderResult,
} from "./raw-reader.js";

/**
 * Official PyPI artifact:
 * harbor-0.20.0-py3-none-any.whl
 *
 * This is intentionally a byte-level release pin rather than a floating
 * package version. A new Harbor wheel requires a new explicit decoder.
 */
export const HARBOR_0_20_0_WHEEL_SHA256 =
  "4b7e48223aea2384cdb8c9eff35eaebd482fc9b1ec09f8193a121c47356ff19a";
export const HARBOR_0_20_0_VERSION = "0.20.0" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const MAXIMUM_DOCUMENT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_STEPS = 20_000;
const MAXIMUM_EVENTS = 20_000;
const MAXIMUM_TEXT_BYTES = 16 * 1024 * 1024;
const MAXIMUM_JSON_DEPTH = 128;

type PlainRecord = Readonly<Record<string, unknown>>;

export interface TrustedHarbor020ExpectedArm {
  readonly scheduleArmId: string;
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly capabilityStratum: string;
  readonly arm: MatchedArmKind;
  readonly order: MatchedArmOrder;
  readonly harnessArchiveSha256: string;
  readonly harborTaskName: string;
  readonly harborTaskChecksum: string;
}

export interface TrustedHarbor020ExpectedInvocation {
  readonly invocationId: string;
  readonly order: TrustedHarborInvocation["order"];
  readonly configSha256: string;
  readonly executionId: string;
  readonly arms: readonly TrustedHarbor020ExpectedArm[];
}

/**
 * Stored only in the trusted evaluator. `harborTaskName` is deliberately
 * task-identifying and must never cross the release boundary.
 */
export interface TrustedHarbor020DecodingPlan {
  readonly sensitivity: "trusted-harbor-0.20.0-decoding-plan";
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly jobSha256: string;
  readonly sourceEvidenceHash: string;
  readonly protocolHash: string;
  readonly environmentFingerprintHash: string;
  readonly evaluatedModel: {
    readonly provider: string;
    readonly modelId: string;
  };
  readonly invocations: readonly TrustedHarbor020ExpectedInvocation[];
  readonly planHash: string;
}

export interface TrustedHarbor020DecodingPlanProvider {
  readonly boundary: TrustedEvaluatorPortBoundary;
  load(input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  }): Promise<TrustedHarbor020DecodingPlan>;
}

export interface StrictHarbor020RawArtifactDecoderOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly plans: TrustedHarbor020DecodingPlanProvider;
}

export class Harbor020DecodingError extends Error {
  override readonly name = "Harbor020DecodingError";

  constructor() {
    super("Harbor v0.20.0 evidence failed strict trusted decoding.");
  }
}

function fail(): never {
  throw new Harbor020DecodingError();
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

function exactKeys(
  value: unknown,
  keys: readonly string[],
): PlainRecord {
  const object = record(value);
  const actual = Object.keys(object);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    fail();
  }
  return object;
}

function allowedKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): PlainRecord {
  const object = record(value);
  const actual = Object.keys(object);
  if (
    actual.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  ) {
    fail();
  }
  return object;
}

function stringValue(value: unknown, maximumBytes = 4_096): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\u0000") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail();
  }
  return value;
}

function optionalString(
  value: unknown,
  maximumBytes = 4_096,
): string | null {
  return value === null || value === undefined
    ? null
    : stringValue(value, maximumBytes);
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
  return value;
}

function safeId(value: unknown): string {
  const result = stringValue(value, 128);
  if (!SAFE_ID.test(result)) fail();
  return result;
}

function uuid(value: unknown): string {
  const result = stringValue(value, 64).toLowerCase();
  if (!UUID.test(result)) fail();
  return result;
}

function safeInteger(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    fail();
  }
  return value;
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

function canonicalUtcTimestamp(value: unknown): string {
  const input = stringValue(value, 64);
  const match =
    /^(?<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<zone>Z|\+00:00)?$/u.exec(
      input,
    );
  if (match?.groups === undefined) fail();
  const fraction = (match.groups["fraction"] ?? "").padEnd(3, "0").slice(0, 3);
  const normalized = `${match.groups["date"]}.${fraction}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) fail();
  const result = new Date(parsed).toISOString();
  if (result !== normalized) fail();
  return result;
}

function jsonDepth(value: unknown, depth = 0): void {
  if (depth > MAXIMUM_JSON_DEPTH) fail();
  if (Array.isArray(value)) {
    for (const item of value) jsonDepth(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail();
    for (const item of Object.values(value)) jsonDepth(item, depth + 1);
    return;
  }
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    fail();
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail();
}

/**
 * Raw ingress must wrap Harbor files as canonical JSON. Requiring a byte-for-
 * byte canonical encoding rejects duplicate keys, trailing material, BOMs,
 * numeric ambiguity, and parser differentials before schema validation.
 */
function parseCanonicalDocument(bytes: Uint8Array): PlainRecord {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 2 ||
    bytes.byteLength > MAXIMUM_DOCUMENT_BYTES
  ) {
    fail();
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail();
  }
  jsonDepth(parsed);
  if (canonicalJson(parsed) !== text) fail();
  return record(parsed);
}

function decodingPlanMaterial(
  plan: Omit<TrustedHarbor020DecodingPlan, "planHash">,
): PlainRecord {
  return {
    domain: "dark-factory.harbor-0.20.0-decoding-plan.v1",
    sensitivity: plan.sensitivity,
    schemaVersion: plan.schemaVersion,
    requestId: plan.requestId,
    jobSha256: plan.jobSha256,
    sourceEvidenceHash: plan.sourceEvidenceHash,
    protocolHash: plan.protocolHash,
    environmentFingerprintHash: plan.environmentFingerprintHash,
    evaluatedModel: plan.evaluatedModel,
    invocations: plan.invocations,
  };
}

export function hashTrustedHarbor020DecodingPlan(
  plan: Omit<TrustedHarbor020DecodingPlan, "planHash">,
): string {
  return canonicalHash(decodingPlanMaterial(plan));
}

function assertPlan(
  plan: TrustedHarbor020DecodingPlan,
  input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  },
): void {
  exactKeys(plan, [
    "sensitivity",
    "schemaVersion",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "protocolHash",
    "environmentFingerprintHash",
    "evaluatedModel",
    "invocations",
    "planHash",
  ]);
  const model = exactKeys(plan.evaluatedModel, ["provider", "modelId"]);
  if (
    plan.sensitivity !== "trusted-harbor-0.20.0-decoding-plan" ||
    plan.schemaVersion !== 1 ||
    plan.requestId !== input.requestId ||
    plan.jobSha256 !== input.jobSha256 ||
    plan.sourceEvidenceHash !== input.sourceEvidenceHash ||
    !SAFE_ID.test(plan.requestId) ||
    !SAFE_MODEL_ID.test(stringValue(model["provider"], 256)) ||
    !SAFE_MODEL_ID.test(stringValue(model["modelId"], 256)) ||
    !Array.isArray(plan.invocations) ||
    plan.invocations.length < 1 ||
    plan.invocations.length > 3
  ) {
    fail();
  }
  digest(plan.jobSha256);
  digest(plan.sourceEvidenceHash);
  digest(plan.protocolHash);
  digest(plan.environmentFingerprintHash);
  digest(plan.planHash);
  const invocationIds = new Set<string>();
  const executionIds = new Set<string>();
  const scheduleArmIds = new Set<string>();
  const taskArmPairs = new Set<string>();
  for (const invocation of plan.invocations) {
    exactKeys(invocation, [
      "invocationId",
      "order",
      "configSha256",
      "executionId",
      "arms",
    ]);
    const invocationId = safeId(invocation.invocationId);
    const executionId = safeId(invocation.executionId);
    if (
      invocationIds.has(invocationId) ||
      executionIds.has(executionId) ||
      !new Set(["repair", "AB", "BA"]).has(invocation.order) ||
      !Array.isArray(invocation.arms) ||
      invocation.arms.length < 1 ||
      invocation.arms.length > 12
    ) {
      fail();
    }
    digest(invocation.configSha256);
    invocationIds.add(invocationId);
    executionIds.add(executionId);
    for (const arm of invocation.arms) {
      exactKeys(arm, [
        "scheduleArmId",
        "taskId",
        "taskRevisionDigest",
        "capabilityStratum",
        "arm",
        "order",
        "harnessArchiveSha256",
        "harborTaskName",
        "harborTaskChecksum",
      ]);
      const scheduleArmId = safeId(arm.scheduleArmId);
      const pair = `${arm.taskId}:${arm.arm}`;
      if (
        scheduleArmIds.has(scheduleArmId) ||
        taskArmPairs.has(pair) ||
        (arm.arm !== "candidate" && arm.arm !== "champion") ||
        (arm.order !== "AB" && arm.order !== "BA") ||
        (invocation.order !== "repair" && arm.order !== invocation.order) ||
        (invocation.order === "repair" && arm.arm !== "candidate") ||
        !SAFE_ID.test(arm.capabilityStratum) ||
        !SAFE_TASK_NAME.test(arm.harborTaskName)
      ) {
        fail();
      }
      digest(arm.taskId);
      digest(arm.taskRevisionDigest);
      digest(arm.harnessArchiveSha256);
      digest(arm.harborTaskChecksum);
      scheduleArmIds.add(scheduleArmId);
      taskArmPairs.add(pair);
    }
  }
  if (
    scheduleArmIds.size < 1 ||
    scheduleArmIds.size > 24 ||
    plan.planHash !==
      hashTrustedHarbor020DecodingPlan({
        sensitivity: plan.sensitivity,
        schemaVersion: plan.schemaVersion,
        requestId: plan.requestId,
        jobSha256: plan.jobSha256,
        sourceEvidenceHash: plan.sourceEvidenceHash,
        protocolHash: plan.protocolHash,
        environmentFingerprintHash: plan.environmentFingerprintHash,
        evaluatedModel: plan.evaluatedModel,
        invocations: plan.invocations,
      })
  ) {
    fail();
  }
}

/**
 * Public fail-closed validator used by trusted ingress before it commits a
 * decoding plan. The plan may contain task-identifying Harbor names and must
 * remain inside the trusted evaluator.
 */
export function assertTrustedHarbor020DecodingPlan(
  plan: TrustedHarbor020DecodingPlan,
  input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  },
): void {
  assertPlan(plan, input);
}

function assertEnvelopeHeader(
  value: PlainRecord,
  schemaVersion: string,
  input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly sourceEvidenceHash: string;
  },
): void {
  if (
    value["schemaVersion"] !== schemaVersion ||
    value["harborVersion"] !== HARBOR_0_20_0_VERSION ||
    value["harborWheelSha256"] !== HARBOR_0_20_0_WHEEL_SHA256 ||
    value["requestId"] !== input.requestId ||
    value["jobSha256"] !== input.jobSha256 ||
    value["sourceEvidenceHash"] !== input.sourceEvidenceHash
  ) {
    fail();
  }
}

function validateJobStats(
  value: unknown,
  expectedTrials: number,
): ValidatedJobStats {
  const stats = exactKeys(value, [
    "n_completed_trials",
    "n_errored_trials",
    "n_running_trials",
    "n_pending_trials",
    "n_cancelled_trials",
    "n_retries",
    "evals",
    "n_input_tokens",
    "n_cache_tokens",
    "n_output_tokens",
    "cost_usd",
  ]);
  if (
    safeInteger(stats["n_completed_trials"]) !== expectedTrials ||
    safeInteger(stats["n_errored_trials"]) !== 0 ||
    safeInteger(stats["n_running_trials"]) !== 0 ||
    safeInteger(stats["n_pending_trials"]) !== 0 ||
    safeInteger(stats["n_cancelled_trials"]) !== 0 ||
    safeInteger(stats["n_retries"]) !== 0
  ) {
    fail();
  }
  record(stats["evals"]);
  return {
    inputTokens:
      stats["n_input_tokens"] === null
        ? null
        : safeInteger(stats["n_input_tokens"]),
    cachedTokens:
      stats["n_cache_tokens"] === null
        ? null
        : safeInteger(stats["n_cache_tokens"]),
    outputTokens:
      stats["n_output_tokens"] === null
        ? null
        : safeInteger(stats["n_output_tokens"]),
    modelUsd:
      stats["cost_usd"] === null
        ? null
        : finiteNonNegative(stats["cost_usd"]),
  };
}

interface ValidatedJobStats {
  readonly inputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly outputTokens: number | null;
  readonly modelUsd: number | null;
}

interface ValidatedJobResult {
  readonly id: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stats: ValidatedJobStats;
}

function validateJobResult(
  value: unknown,
  expectedTrials: number,
): ValidatedJobResult {
  const result = exactKeys(value, [
    "id",
    "started_at",
    "updated_at",
    "finished_at",
    "n_total_trials",
    "stats",
  ]);
  const startedAt = canonicalUtcTimestamp(result["started_at"]);
  const updatedAt = canonicalUtcTimestamp(result["updated_at"]);
  const finishedAt = canonicalUtcTimestamp(result["finished_at"]);
  if (
    safeInteger(result["n_total_trials"]) !== expectedTrials ||
    Date.parse(updatedAt) < Date.parse(startedAt) ||
    Date.parse(finishedAt) < Date.parse(startedAt) ||
    Date.parse(updatedAt) > Date.parse(finishedAt)
  ) {
    fail();
  }
  const stats = validateJobStats(result["stats"], expectedTrials);
  return { id: uuid(result["id"]), startedAt, finishedAt, stats };
}

function validateTaskId(value: unknown): void {
  const taskId = record(value);
  const keys = Object.keys(taskId).sort();
  const variant =
    keys.length === 1 && keys[0] === "path"
      ? "local"
      : keys.length === 3 &&
          keys[0] === "git_commit_id" &&
          keys[1] === "git_url" &&
          keys[2] === "path"
        ? "git"
        : keys.length === 3 &&
            keys[0] === "name" &&
            keys[1] === "org" &&
            keys[2] === "ref"
          ? "package"
          : null;
  if (variant === null) fail();
  for (const item of Object.values(taskId)) {
    if (item !== null) stringValue(item, 4_096);
  }
}

function validateTaskConfig(value: unknown): PlainRecord {
  const task = allowedKeys(
    value,
    [
      "path",
      "git_url",
      "git_commit_id",
      "name",
      "ref",
      "overwrite",
      "download_dir",
      "source",
    ],
    ["path", "name"],
  );
  if (task["overwrite"] !== undefined && typeof task["overwrite"] !== "boolean") {
    fail();
  }
  for (const field of [
    "path",
    "git_url",
    "git_commit_id",
    "name",
    "ref",
    "download_dir",
    "source",
  ]) {
    optionalString(task[field], 8_192);
  }
  return task;
}

function validateAgentConfig(
  value: unknown,
  expected: TrustedHarbor020ExpectedArm,
  model: TrustedHarbor020DecodingPlan["evaluatedModel"],
): void {
  const config = allowedKeys(
    value,
    [
      "name",
      "import_path",
      "model_name",
      "n_concurrent",
      "concurrency_group",
      "skills",
      "override_timeout_sec",
      "override_setup_timeout_sec",
      "max_timeout_sec",
      "resume_trajectory",
      "load_trajectory",
      "extra_allowed_hosts",
      "include_logs",
      "exclude_logs",
      "kwargs",
      "env",
      "mcp_servers",
    ],
    ["name", "import_path", "model_name", "kwargs"],
  );
  const kwargs = exactKeys(config["kwargs"], [
    "runtime_archive_path",
    "runtime_sha256",
    "pi_entrypoint",
    "thinking",
    "enabled_tools",
    "credential_environment_names",
    ...(model.provider === "microsoft-foundry"
      ? ["foundry_resource_name", "model_family"]
      : []),
  ]);
  const expectedModel = `${model.provider}/${model.modelId}`;
  if (
    config["name"] !== `dark-factory-${expected.arm}` ||
    config["model_name"] !== expectedModel ||
    kwargs["runtime_sha256"] !== expected.harnessArchiveSha256 ||
    typeof config["import_path"] !== "string" ||
    !String(config["import_path"]).endsWith(":DarkFactoryPi") ||
    config["resume_trajectory"] === true ||
    config["load_trajectory"] !== undefined &&
      config["load_trajectory"] !== null
  ) {
    fail();
  }
  if (model.provider === "microsoft-foundry") {
    const resource = kwargs["foundry_resource_name"];
    const allowedHosts = config["extra_allowed_hosts"];
    if (
      typeof resource !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(resource) ||
      !Array.isArray(allowedHosts) ||
      allowedHosts.length !== 1 ||
      allowedHosts[0] !== `${resource}.services.ai.azure.com` ||
      kwargs["model_family"] !== "claude-opus-4-8" ||
      kwargs["thinking"] !== "high" ||
      JSON.stringify(kwargs["credential_environment_names"]) !==
        JSON.stringify(["ANTHROPIC_FOUNDRY_API_KEY"])
    ) {
      fail();
    }
  }
  stringValue(kwargs["runtime_archive_path"], 8_192);
  stringValue(kwargs["pi_entrypoint"], 512);
  stringValue(kwargs["thinking"], 32);
  if (
    !Array.isArray(kwargs["enabled_tools"]) ||
    kwargs["enabled_tools"].length < 1 ||
    kwargs["enabled_tools"].some(
      (tool) => typeof tool !== "string" || !SAFE_ID.test(tool),
    ) ||
    !Array.isArray(kwargs["credential_environment_names"]) ||
    kwargs["credential_environment_names"].length < 1 ||
    kwargs["credential_environment_names"].some(
      (name) =>
        typeof name !== "string" ||
        !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(name),
    )
  ) {
    fail();
  }
  for (const field of ["skills", "mcp_servers"]) {
    if (
      config[field] !== undefined &&
      (!Array.isArray(config[field]) || config[field].length !== 0)
    ) {
      fail();
    }
  }
}

interface ValidatedAgentContext {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly modelUsd: number;
}

function validateAgentContext(value: unknown): ValidatedAgentContext {
  const context = exactKeys(value, [
    "n_input_tokens",
    "n_cache_tokens",
    "n_output_tokens",
    "cost_usd",
    "rollout_details",
    "metadata",
  ]);
  if (
    context["rollout_details"] !== null ||
    context["metadata"] !== null
  ) {
    fail();
  }
  const inputTokens = safeInteger(context["n_input_tokens"]);
  const cachedTokens = safeInteger(context["n_cache_tokens"]);
  if (cachedTokens > inputTokens) fail();
  return {
    inputTokens,
    cachedTokens,
    outputTokens: safeInteger(context["n_output_tokens"]),
    modelUsd: finiteNonNegative(context["cost_usd"]),
  };
}

function validateTiming(value: unknown): {
  readonly startedAt: string;
  readonly finishedAt: string;
} {
  const timing = exactKeys(value, ["started_at", "finished_at"]);
  const startedAt = canonicalUtcTimestamp(timing["started_at"]);
  const finishedAt = canonicalUtcTimestamp(timing["finished_at"]);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) fail();
  return { startedAt, finishedAt };
}

interface ValidatedTrial {
  readonly trialId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly reward: number;
  readonly agentContext: ValidatedAgentContext;
}

function validateTrial(
  value: unknown,
  expected: TrustedHarbor020ExpectedArm,
  jobId: string,
  model: TrustedHarbor020DecodingPlan["evaluatedModel"],
): ValidatedTrial {
  const trial = exactKeys(value, [
    "id",
    "task_name",
    "trial_name",
    "trial_uri",
    "task_id",
    "source",
    "task_checksum",
    "config",
    "agent_info",
    "agent_result",
    "verifier_result",
    "verifier_environment_mode",
    "exception_info",
    "started_at",
    "finished_at",
    "environment_setup",
    "agent_setup",
    "agent_execution",
    "verifier",
    "step_results",
  ]);
  if (
    trial["task_name"] !== expected.harborTaskName ||
    trial["task_checksum"] !== expected.harborTaskChecksum ||
    !new Set(["shared", "separate"]).has(
      trial["verifier_environment_mode"] as string,
    ) ||
    trial["exception_info"] !== null ||
    trial["step_results"] !== null
  ) {
    fail();
  }
  const trialId = uuid(trial["id"]);
  safeId(trial["trial_name"]);
  stringValue(trial["trial_uri"], 8_192);
  optionalString(trial["source"], 512);
  validateTaskId(trial["task_id"]);

  const config = allowedKeys(
    trial["config"],
    [
      "task",
      "trial_name",
      "trials_dir",
      "install_only",
      "timeout_multiplier",
      "agent_timeout_multiplier",
      "verifier_timeout_multiplier",
      "agent_setup_timeout_multiplier",
      "environment_build_timeout_multiplier",
      "agent",
      "environment",
      "verifier",
      "artifacts",
      "extra_instruction_paths",
      "job_id",
      "source_trial",
    ],
    ["task", "trial_name", "agent", "job_id"],
  );
  validateTaskConfig(config["task"]);
  if (
    config["trial_name"] !== trial["trial_name"] ||
    uuid(config["job_id"]) !== jobId ||
    config["install_only"] === true ||
    (config["source_trial"] !== undefined &&
      config["source_trial"] !== null)
  ) {
    fail();
  }
  validateAgentConfig(config["agent"], expected, model);

  const agentInfo = exactKeys(trial["agent_info"], [
    "name",
    "version",
    "model_info",
  ]);
  const modelInfo = exactKeys(agentInfo["model_info"], ["name", "provider"]);
  if (
    agentInfo["name"] !== "dark-factory-pi" ||
    modelInfo["name"] !== model.modelId ||
    modelInfo["provider"] !== model.provider
  ) {
    fail();
  }
  stringValue(agentInfo["version"], 512);

  const agentContext = validateAgentContext(trial["agent_result"]);
  const verifier = exactKeys(trial["verifier_result"], ["rewards"]);
  const rewards = exactKeys(verifier["rewards"], ["reward"]);
  const reward = finiteNonNegative(rewards["reward"]);
  if (reward > 1) fail();

  const startedAt = canonicalUtcTimestamp(trial["started_at"]);
  const finishedAt = canonicalUtcTimestamp(trial["finished_at"]);
  const execution = validateTiming(trial["agent_execution"]);
  validateTiming(trial["environment_setup"]);
  validateTiming(trial["agent_setup"]);
  validateTiming(trial["verifier"]);
  if (
    Date.parse(finishedAt) < Date.parse(startedAt) ||
    Date.parse(execution.startedAt) < Date.parse(startedAt) ||
    Date.parse(execution.finishedAt) > Date.parse(finishedAt)
  ) {
    fail();
  }
  return {
    trialId,
    startedAt: execution.startedAt,
    completedAt: execution.finishedAt,
    reward,
    agentContext,
  };
}

interface HarborTrialJoin {
  readonly expected: TrustedHarbor020ExpectedArm;
  readonly trial: ValidatedTrial;
}

function decodeHarborDocument(
  value: PlainRecord,
  plan: TrustedHarbor020DecodingPlan,
): ReadonlyMap<string, HarborTrialJoin> {
  exactKeys(value, [
    "schemaVersion",
    "harborVersion",
    "harborWheelSha256",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "invocations",
  ]);
  assertEnvelopeHeader(
    value,
    "dark-factory.harbor-0.20.0-results.v1",
    plan,
  );
  if (
    !Array.isArray(value["invocations"]) ||
    value["invocations"].length !== plan.invocations.length
  ) {
    fail();
  }
  const byInvocation = new Map(
    plan.invocations.map((invocation) => [
      invocation.invocationId,
      invocation,
    ] as const),
  );
  const joined = new Map<string, HarborTrialJoin>();
  for (const rawInvocation of value["invocations"]) {
    const invocation = exactKeys(rawInvocation, [
      "invocationId",
      "order",
      "configSha256",
      "executionId",
      "jobResult",
      "trials",
    ]);
    const expectedInvocation = byInvocation.get(
      safeId(invocation["invocationId"]),
    );
    if (
      expectedInvocation === undefined ||
      invocation["order"] !== expectedInvocation.order ||
      invocation["configSha256"] !== expectedInvocation.configSha256 ||
      invocation["executionId"] !== expectedInvocation.executionId ||
      !Array.isArray(invocation["trials"]) ||
      invocation["trials"].length !== expectedInvocation.arms.length
    ) {
      fail();
    }
    const job = validateJobResult(
      invocation["jobResult"],
      expectedInvocation.arms.length,
    );
    const byArm = new Map(
      expectedInvocation.arms.map((arm) => [arm.scheduleArmId, arm] as const),
    );
    const invocationTrials: ValidatedTrial[] = [];
    for (const rawTrial of invocation["trials"]) {
      const item = exactKeys(rawTrial, [
        "scheduleArmId",
        "attemptOrdinal",
        "result",
      ]);
      const scheduleArmId = safeId(item["scheduleArmId"]);
      const expected = byArm.get(scheduleArmId);
      if (
        expected === undefined ||
        safeInteger(item["attemptOrdinal"]) !== 1 ||
        joined.has(scheduleArmId)
      ) {
        fail();
      }
      const trial = validateTrial(
        item["result"],
        expected,
        job.id,
        plan.evaluatedModel,
      );
      invocationTrials.push(trial);
      joined.set(scheduleArmId, { expected, trial });
    }
    const aggregate = invocationTrials.reduce(
      (sum, trial) => ({
        inputTokens: sum.inputTokens + trial.agentContext.inputTokens,
        cachedTokens: sum.cachedTokens + trial.agentContext.cachedTokens,
        outputTokens: sum.outputTokens + trial.agentContext.outputTokens,
        modelUsd: sum.modelUsd + trial.agentContext.modelUsd,
      }),
      {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        modelUsd: 0,
      },
    );
    if (
      job.stats.inputTokens !== aggregate.inputTokens ||
      job.stats.cachedTokens !== aggregate.cachedTokens ||
      job.stats.outputTokens !== aggregate.outputTokens ||
      job.stats.modelUsd === null ||
      Math.abs(job.stats.modelUsd - aggregate.modelUsd) > 1e-9
    ) {
      fail();
    }
  }
  const expectedArmCount = plan.invocations.reduce(
    (sum, invocation) => sum + invocation.arms.length,
    0,
  );
  if (joined.size !== expectedArmCount) fail();
  return joined;
}

interface GraderJoin {
  readonly trialId: string;
  readonly scheduleArmId: string;
  readonly attemptOrdinal: 1;
  readonly grader: Omit<
    ScalarGraderOutcomeInput,
    "oneUseAttemptDigest"
  >;
  readonly sandboxUsd: number;
}

function decodeGraderDocument(
  value: PlainRecord,
  plan: TrustedHarbor020DecodingPlan,
  harbor: ReadonlyMap<string, HarborTrialJoin>,
): ReadonlyMap<string, GraderJoin> {
  exactKeys(value, [
    "schemaVersion",
    "harborVersion",
    "harborWheelSha256",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "records",
  ]);
  assertEnvelopeHeader(
    value,
    "dark-factory.harbor-0.20.0-graders.v1",
    plan,
  );
  if (
    !Array.isArray(value["records"]) ||
    value["records"].length !== harbor.size
  ) {
    fail();
  }
  const result = new Map<string, GraderJoin>();
  for (const raw of value["records"]) {
    const recordValue = exactKeys(raw, [
      "trialId",
      "scheduleArmId",
      "attemptOrdinal",
      "passed",
      "boundedReward",
      "infrastructureInvalidClass",
      "integrityStatus",
      "elapsedMs",
      "cpuUtilizationPercent",
      "maxRssMb",
      "protocolHash",
      "environmentFingerprintHash",
      "sandboxUsd",
    ]);
    const scheduleArmId = safeId(recordValue["scheduleArmId"]);
    const source = harbor.get(scheduleArmId);
    const reward = finiteNonNegative(recordValue["boundedReward"]);
    const elapsedMs = safeInteger(recordValue["elapsedMs"]);
    const cpuUtilizationPercent = nullableFiniteNonNegative(
      recordValue["cpuUtilizationPercent"],
    );
    if (
      source === undefined ||
      result.has(scheduleArmId) ||
      uuid(recordValue["trialId"]) !== source.trial.trialId ||
      safeInteger(recordValue["attemptOrdinal"]) !== 1 ||
      typeof recordValue["passed"] !== "boolean" ||
      reward > 1 ||
      reward !== source.trial.reward ||
      recordValue["passed"] !== (reward === 1) ||
      recordValue["infrastructureInvalidClass"] !== null ||
      recordValue["integrityStatus"] !== "passed" ||
      recordValue["protocolHash"] !== plan.protocolHash ||
      recordValue["environmentFingerprintHash"] !==
        plan.environmentFingerprintHash ||
      elapsedMs !==
        Date.parse(source.trial.completedAt) -
          Date.parse(source.trial.startedAt) ||
      (cpuUtilizationPercent !== null && cpuUtilizationPercent > 100)
    ) {
      fail();
    }
    result.set(scheduleArmId, {
      trialId: source.trial.trialId,
      scheduleArmId,
      attemptOrdinal: 1,
      grader: {
        passed: recordValue["passed"],
        boundedReward: reward,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedMs,
        cpuUtilizationPercent,
        maxRssMb: nullableFiniteNonNegative(recordValue["maxRssMb"]),
        protocolHash: plan.protocolHash,
        environmentFingerprintHash: plan.environmentFingerprintHash,
      },
      sandboxUsd: finiteNonNegative(recordValue["sandboxUsd"]),
    });
  }
  return result;
}

function validateMetrics(value: unknown): {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly costUsd: number;
} {
  const metrics = allowedKeys(
    value,
    [
      "prompt_tokens",
      "completion_tokens",
      "cached_tokens",
      "cost_usd",
      "prompt_token_ids",
      "completion_token_ids",
      "logprobs",
      "extra",
    ],
    ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd"],
  );
  if (
    metrics["prompt_token_ids"] !== undefined ||
    metrics["completion_token_ids"] !== undefined ||
    metrics["logprobs"] !== undefined ||
    metrics["extra"] !== undefined
  ) {
    fail();
  }
  const promptTokens = safeInteger(metrics["prompt_tokens"]);
  const cachedTokens = safeInteger(metrics["cached_tokens"]);
  if (cachedTokens > promptTokens) fail();
  return {
    promptTokens,
    completionTokens: safeInteger(metrics["completion_tokens"]),
    cachedTokens,
    costUsd: finiteNonNegative(metrics["cost_usd"]),
  };
}

function genericToolCategory(name: string): string {
  const normalized = name.replace(/[-_]/gu, "").toLowerCase();
  if (/^(read|readfile|cat|view|open)$/u.test(normalized)) return "read";
  if (/^(write|writefile|edit|applypatch|patch)$/u.test(normalized)) {
    return "write";
  }
  if (/^(bash|shell|execute|exec|command|terminal)$/u.test(normalized)) {
    return "execute";
  }
  if (/^(grep|rg|search|find|glob)$/u.test(normalized)) return "search";
  if (/^(plan|todo|updateplan)$/u.test(normalized)) return "plan";
  if (/^(inspect|stat|list|ls)$/u.test(normalized)) return "inspect";
  if (/^(browser|web|fetch|http|network)$/u.test(normalized)) return "network";
  return "other";
}

interface AtifDecodeResult {
  readonly trajectory: RawTrajectory;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly modelUsd: number;
}

function validateAtifTrajectory(
  value: unknown,
  source: HarborTrialJoin,
  expectedModel: TrustedHarbor020DecodingPlan["evaluatedModel"],
): AtifDecodeResult {
  const trajectory = allowedKeys(
    value,
    [
      "schema_version",
      "session_id",
      "trajectory_id",
      "agent",
      "steps",
      "notes",
      "final_metrics",
      "continued_trajectory_ref",
      "extra",
      "subagent_trajectories",
    ],
    [
      "schema_version",
      "session_id",
      "trajectory_id",
      "agent",
      "steps",
      "final_metrics",
    ],
  );
  if (
    trajectory["schema_version"] !== "ATIF-v1.7" ||
    trajectory["notes"] !== undefined ||
    trajectory["continued_trajectory_ref"] !== undefined ||
    trajectory["subagent_trajectories"] !== undefined ||
    !Array.isArray(trajectory["steps"]) ||
    trajectory["steps"].length < 2 ||
    trajectory["steps"].length > MAXIMUM_STEPS
  ) {
    fail();
  }
  const rootExtra = exactKeys(trajectory["extra"], ["dark_factory"]);
  const darkFactoryExtra = exactKeys(rootExtra["dark_factory"], [
    "compaction_count",
    "retry_count",
    "bash_update_count",
    "agent_settled",
  ]);
  const compactionCount = safeInteger(
    darkFactoryExtra["compaction_count"],
  );
  const retryCount = safeInteger(darkFactoryExtra["retry_count"]);
  const bashUpdateCount = safeInteger(
    darkFactoryExtra["bash_update_count"],
  );
  if (
    darkFactoryExtra["agent_settled"] !== true ||
    compactionCount > 1_000 ||
    retryCount > 1_000 ||
    bashUpdateCount > 1_000_000
  ) {
    fail();
  }
  safeId(trajectory["session_id"]);
  const trajectoryId = stringValue(trajectory["trajectory_id"], 128);
  if (!/^pi-trajectory-[a-f0-9]{64}$/u.test(trajectoryId)) fail();

  const agent = allowedKeys(
    trajectory["agent"],
    ["name", "version", "model_name", "tool_definitions", "extra"],
    ["name", "version", "model_name", "extra"],
  );
  const agentExtra = exactKeys(agent["extra"], ["runtime_sha256"]);
  if (
    agent["name"] !== "dark-factory-pi" ||
    agent["version"] !== source.expected.harnessArchiveSha256 ||
    agent["model_name"] !==
      `${expectedModel.provider}/${expectedModel.modelId}` ||
    agentExtra["runtime_sha256"] !==
      source.expected.harnessArchiveSha256 ||
    agent["tool_definitions"] !== undefined
  ) {
    fail();
  }

  const events: RawTrajectoryEvent[] = [];
  const globalToolCallIds = new Set<string>();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  for (const [index, rawStep] of trajectory["steps"].entries()) {
    const step = allowedKeys(
      rawStep,
      [
        "step_id",
        "timestamp",
        "source",
        "model_name",
        "reasoning_effort",
        "message",
        "reasoning_content",
        "tool_calls",
        "observation",
        "metrics",
        "is_copied_context",
        "llm_call_count",
        "extra",
      ],
      ["step_id", "timestamp", "source", "message"],
    );
    if (
      safeInteger(step["step_id"]) !== index + 1 ||
      !new Set(["system", "user", "agent"]).has(step["source"] as string) ||
      typeof step["message"] !== "string" ||
      Buffer.byteLength(step["message"], "utf8") > MAXIMUM_TEXT_BYTES ||
      step["is_copied_context"] !== undefined ||
      step["extra"] !== undefined
    ) {
      fail();
    }
    canonicalUtcTimestamp(step["timestamp"]);
    const isAgent = step["source"] === "agent";
    if (
      !isAgent &&
      [
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "metrics",
        "llm_call_count",
      ].some((field) => step[field] !== undefined)
    ) {
      fail();
    }
    if (!isAgent) continue;
    if (
      typeof step["model_name"] !== "string" ||
      step["model_name"].length === 0 ||
      (typeof step["reasoning_effort"] !== "string" &&
        typeof step["reasoning_effort"] !== "number") ||
      (typeof step["reasoning_effort"] === "number" &&
        !Number.isFinite(step["reasoning_effort"])) ||
      step["llm_call_count"] !== 1 ||
      step["observation"] !== undefined &&
        step["tool_calls"] === undefined
    ) {
      fail();
    }
    if (
      step["reasoning_content"] !== undefined &&
      (typeof step["reasoning_content"] !== "string" ||
        Buffer.byteLength(step["reasoning_content"], "utf8") >
          MAXIMUM_TEXT_BYTES)
    ) {
      fail();
    }
    const stepMetrics = validateMetrics(step["metrics"]);
    promptTokens += stepMetrics.promptTokens;
    completionTokens += stepMetrics.completionTokens;
    cachedTokens += stepMetrics.cachedTokens;
    costUsd += stepMetrics.costUsd;

    const stepToolIds = new Set<string>();
    if (step["tool_calls"] !== undefined) {
      if (
        !Array.isArray(step["tool_calls"]) ||
        step["tool_calls"].length < 1 ||
        step["tool_calls"].length > 1_024
      ) {
        fail();
      }
      for (const rawCall of step["tool_calls"]) {
        const call = allowedKeys(
          rawCall,
          ["tool_call_id", "function_name", "arguments", "extra"],
          ["tool_call_id", "function_name", "arguments"],
        );
        const toolCallId = safeId(call["tool_call_id"]);
        const functionName = safeId(call["function_name"]);
        if (
          stepToolIds.has(toolCallId) ||
          globalToolCallIds.has(toolCallId) ||
          call["extra"] !== undefined
        ) {
          fail();
        }
        const argumentsValue = record(call["arguments"]);
        jsonDepth(argumentsValue);
        stepToolIds.add(toolCallId);
        globalToolCallIds.add(toolCallId);
        events.push({
          kind: "tool-call",
          category: genericToolCategory(functionName),
          invocationValid: true,
          actionFingerprint: canonicalHash({
            domain: "dark-factory.atif-tool-action.v1",
            functionName,
            arguments: argumentsValue,
          }),
        });
      }
    }
    if (step["observation"] !== undefined) {
      const observation = exactKeys(step["observation"], ["results"]);
      if (
        !Array.isArray(observation["results"]) ||
        observation["results"].length !== stepToolIds.size
      ) {
        fail();
      }
      const observed = new Set<string>();
      for (const rawResult of observation["results"]) {
        const result = allowedKeys(
          rawResult,
          [
            "source_call_id",
            "content",
            "subagent_trajectory_ref",
            "extra",
          ],
          ["source_call_id", "content", "extra"],
        );
        const sourceCallId = safeId(result["source_call_id"]);
        const extra = exactKeys(result["extra"], ["is_error"]);
        if (
          !stepToolIds.has(sourceCallId) ||
          observed.has(sourceCallId) ||
          typeof result["content"] !== "string" ||
          Buffer.byteLength(result["content"], "utf8") >
            MAXIMUM_TEXT_BYTES ||
          typeof extra["is_error"] !== "boolean" ||
          result["subagent_trajectory_ref"] !== undefined
        ) {
          fail();
        }
        observed.add(sourceCallId);
        events.push({
          kind: "tool-result",
          exitCode: extra["is_error"] ? 1 : 0,
          terminatedBySignal: false,
        });
        events.push({ kind: "output-inspection" });
      }
    }
  }
  if (
    (trajectory["steps"][0] as PlainRecord)["source"] !== "user" ||
    (trajectory["steps"].at(-1) as PlainRecord)["source"] !== "agent" ||
    events.length + compactionCount + retryCount + 1 > MAXIMUM_EVENTS
  ) {
    fail();
  }
  for (let index = 0; index < compactionCount; index += 1) {
    events.push({ kind: "compaction" });
  }
  for (let index = 0; index < retryCount; index += 1) {
    events.push({ kind: "recovery" });
  }
  events.push({ kind: "stop", reason: "completed" });

  const finalMetrics = exactKeys(trajectory["final_metrics"], [
    "total_prompt_tokens",
    "total_completion_tokens",
    "total_cached_tokens",
    "total_cost_usd",
    "total_steps",
  ]);
  if (
    safeInteger(finalMetrics["total_prompt_tokens"]) !== promptTokens ||
    safeInteger(finalMetrics["total_completion_tokens"]) !==
      completionTokens ||
    safeInteger(finalMetrics["total_cached_tokens"]) !== cachedTokens ||
    finiteNonNegative(finalMetrics["total_cost_usd"]) !== costUsd ||
    safeInteger(finalMetrics["total_steps"]) !== trajectory["steps"].length ||
    promptTokens !== source.trial.agentContext.inputTokens ||
    completionTokens !== source.trial.agentContext.outputTokens ||
    cachedTokens !== source.trial.agentContext.cachedTokens ||
    Math.abs(costUsd - source.trial.agentContext.modelUsd) > 1e-9
  ) {
    fail();
  }
  return {
    trajectory: {
      events,
      elapsedMs:
        Date.parse(source.trial.completedAt) -
        Date.parse(source.trial.startedAt),
      planningTokens: 0,
      actionTokens: completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    modelUsd: costUsd,
  };
}

function decodeAtifDocument(
  value: PlainRecord,
  plan: TrustedHarbor020DecodingPlan,
  harbor: ReadonlyMap<string, HarborTrialJoin>,
): ReadonlyMap<string, AtifDecodeResult> {
  exactKeys(value, [
    "schemaVersion",
    "harborVersion",
    "harborWheelSha256",
    "requestId",
    "jobSha256",
    "sourceEvidenceHash",
    "records",
  ]);
  assertEnvelopeHeader(
    value,
    "dark-factory.harbor-0.20.0-atif.v1",
    plan,
  );
  if (
    !Array.isArray(value["records"]) ||
    value["records"].length !== harbor.size
  ) {
    fail();
  }
  const result = new Map<string, AtifDecodeResult>();
  for (const raw of value["records"]) {
    const recordValue = exactKeys(raw, [
      "trialId",
      "scheduleArmId",
      "attemptOrdinal",
      "trajectory",
    ]);
    const scheduleArmId = safeId(recordValue["scheduleArmId"]);
    const source = harbor.get(scheduleArmId);
    if (
      source === undefined ||
      result.has(scheduleArmId) ||
      uuid(recordValue["trialId"]) !== source.trial.trialId ||
      safeInteger(recordValue["attemptOrdinal"]) !== 1
    ) {
      fail();
    }
    result.set(
      scheduleArmId,
      validateAtifTrajectory(
        recordValue["trajectory"],
        source,
        plan.evaluatedModel,
      ),
    );
  }
  return result;
}

function attemptDigest(input: {
  readonly requestId: string;
  readonly jobSha256: string;
  readonly sourceEvidenceHash: string;
  readonly rawManifestHash: string;
  readonly rawArtifactSetHash: string;
  readonly scheduleArmId: string;
  readonly trialId: string;
  readonly attemptOrdinal: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly grader: Omit<ScalarGraderOutcomeInput, "oneUseAttemptDigest">;
  readonly atif: RawTrajectory;
  readonly cost: TrustedDecodedAttemptCost;
}): string {
  return canonicalHash({
    domain: "dark-factory.harbor-0.20.0-attempt.v1",
    ...input,
  });
}

/**
 * Strict decoder for canonical trusted wrappers around Harbor v0.20.0
 * `JobResult`, per-trial `TrialResult`, verifier rewards, and ATIF-v1.7.
 *
 * The wrappers are created by the trusted bundle normalizer. They contain raw
 * task prose only inside official Harbor/ATIF fields, which are validated and
 * discarded. The emitted object contains opaque task digests, scalar grader
 * data, generic behavioral events, hashes, counts, and costs only.
 */
export class StrictHarbor020RawArtifactDecoder
  implements TrustedHarborRawArtifactDecoder
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #plans: TrustedHarbor020DecodingPlanProvider;

  constructor(options: StrictHarbor020RawArtifactDecoderOptions) {
    const expectedBoundary =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    if (options.plans.boundary !== expectedBoundary) fail();
    this.boundary = expectedBoundary;
    this.#plans = options.plans;
  }

  async decode(input: {
    readonly requestId: string;
    readonly jobSha256: string;
    readonly runtimeAttestationHash: string;
    readonly sourceEvidenceHash: string;
    readonly rawManifestHash: string;
    readonly rawArtifactSetHash: string;
    readonly plaintexts: Readonly<
      Record<"atif" | "grader-output" | "harbor-output", Uint8Array>
    >;
    readonly inputBindingHash: string;
  }): Promise<TrustedHarborRawDecoderResult> {
    try {
      safeId(input.requestId);
      for (const value of [
        input.jobSha256,
        input.runtimeAttestationHash,
        input.sourceEvidenceHash,
        input.rawManifestHash,
        input.rawArtifactSetHash,
        input.inputBindingHash,
      ]) {
        digest(value);
      }
      const plan = await this.#plans.load({
        requestId: input.requestId,
        jobSha256: input.jobSha256,
        sourceEvidenceHash: input.sourceEvidenceHash,
      });
      assertPlan(plan, input);
      const harbor = decodeHarborDocument(
        parseCanonicalDocument(input.plaintexts["harbor-output"]),
        plan,
      );
      const graders = decodeGraderDocument(
        parseCanonicalDocument(input.plaintexts["grader-output"]),
        plan,
        harbor,
      );
      const atif = decodeAtifDocument(
        parseCanonicalDocument(input.plaintexts.atif),
        plan,
        harbor,
      );

      const attempts: TrustedDecodedEvaluationAttempt[] = [];
      for (const expectedInvocation of plan.invocations) {
        for (const expected of expectedInvocation.arms) {
          const source = harbor.get(expected.scheduleArmId);
          const graderJoin = graders.get(expected.scheduleArmId);
          const atifJoin = atif.get(expected.scheduleArmId);
          if (
            source === undefined ||
            graderJoin === undefined ||
            atifJoin === undefined
          ) {
            fail();
          }
          const cost: TrustedDecodedAttemptCost = {
            inputTokens: atifJoin.inputTokens,
            outputTokens: atifJoin.outputTokens,
            modelUsd: atifJoin.modelUsd,
            sandboxUsd: graderJoin.sandboxUsd,
          };
          const digestValue = attemptDigest({
            requestId: input.requestId,
            jobSha256: input.jobSha256,
            sourceEvidenceHash: input.sourceEvidenceHash,
            rawManifestHash: input.rawManifestHash,
            rawArtifactSetHash: input.rawArtifactSetHash,
            scheduleArmId: expected.scheduleArmId,
            trialId: source.trial.trialId,
            attemptOrdinal: 1,
            startedAt: source.trial.startedAt,
            completedAt: source.trial.completedAt,
            grader: graderJoin.grader,
            atif: atifJoin.trajectory,
            cost,
          });
          attempts.push({
            sensitivity: "trusted-decoded-evaluation-attempt",
            attemptDigest: digestValue,
            scheduleArmId: expected.scheduleArmId,
            taskId: expected.taskId,
            taskRevisionDigest: expected.taskRevisionDigest,
            capabilityStratum: expected.capabilityStratum,
            arm: expected.arm,
            order: expected.order,
            harnessArchiveSha256: expected.harnessArchiveSha256,
            attemptOrdinal: 1,
            startedAt: source.trial.startedAt,
            completedAt: source.trial.completedAt,
            grader: {
              ...graderJoin.grader,
              oneUseAttemptDigest: digestValue,
            },
            atif: atifJoin.trajectory,
            cost,
          });
        }
      }
      const decoded: TrustedDecodedEvaluation = {
        sensitivity: "trusted-decoded-evaluation",
        requestId: input.requestId,
        jobSha256: input.jobSha256,
        runtimeAttestationHash: input.runtimeAttestationHash,
        rawManifestHash: input.rawManifestHash,
        rawArtifactSetHash: input.rawArtifactSetHash,
        attempts,
      };
      return {
        decoded,
        inputBindingHash: input.inputBindingHash,
      };
    } catch {
      fail();
    }
  }
}
