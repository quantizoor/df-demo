import { createHash } from "node:crypto";

import { type BootstrapConfiguration, inspectBootstrapEnvironment } from "../config/environment.js";
import { inspectPiHarnessSourceEnvironment } from "../config/harness-source.js";
import { canonicalJson } from "../schemas/canonical.js";
import {
  inspectStagedControlEnvironment,
  type StagedControlConfiguration,
} from "./control-stage-configuration.js";
import {
  PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_ENVIRONMENT_NAME,
  type ProductionOptimizeBootstrapDescriptor,
  parseProductionOptimizeBootstrapDescriptorEnvironment,
} from "./production-optimize-bootstrap.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_CAMPAIGN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const SAFE_VOLUME_SUBPATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/u;
const SAFE_DOMAIN =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const CONTROL_MOUNT_PATH = "/trusted/dark-factory";
const CONTROL_ENTRYPOINT = "/app/dist/cloud/control-plane.js";
const MAXIMUM_CONTROL_TTL_MINUTES = 24 * 60;
const MAXIMUM_CONTROL_OUTPUT_BYTES = 4 * 1024 * 1024;
const OFFLINE_CONTROL_ENVIRONMENT_NAMES = [
  "DF_CLOUD_PROVIDER",
  "DF_CLOUD_REGION_CLASS",
  "DF_CONTROL_IMAGE_REFERENCE",
  "DF_CONTROL_IMAGE_DIGEST",
] as const;
const PROBE_CONTROL_ENVIRONMENT_NAMES = [
  ...OFFLINE_CONTROL_ENVIRONMENT_NAMES,
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DF_BUILD_IMAGE_REFERENCE",
  "DF_BUILD_IMAGE_DIGEST",
  "DF_EVALUATOR_IMAGE_REFERENCE",
  "DF_EVALUATOR_IMAGE_DIGEST",
] as const;
const OPTIMIZE_CONTROL_ENVIRONMENT_NAMES = [
  ...PROBE_CONTROL_ENVIRONMENT_NAMES,
  "DF_OPTIMIZER_IMAGE_REFERENCE",
  "DF_OPTIMIZER_IMAGE_DIGEST",
  "DF_FOUNDRY_RESOURCE_NAME",
  "DF_OPTIMIZER_MODEL",
  "DF_OPTIMIZER_DEPLOYMENT_NAME",
  "DF_OPTIMIZER_EFFORT",
  "DF_CLAUDE_CODE_VERSION",
  "DF_OPTIMIZER_SECRET_SOURCE",
  "DF_OPTIMIZER_SECRET_TARGET",
  "DF_EVALUATED_PROVIDER",
  "DF_EVALUATED_MODEL",
  "DF_EVALUATED_DEPLOYMENT_NAME",
  "DF_EVALUATED_REASONING",
  "DF_EVALUATED_SECRET_BINDINGS_JSON",
  "DF_GITHUB_SECRET_SOURCE",
  "DF_HARBOR_SECRET_BINDINGS_JSON",
  "DF_MODE",
  "DF_LEADERBOARD_ELIGIBILITY",
  "DF_TRUSTED_ZONE",
  "DF_SIGNING_KEY_ID",
  "DF_HARBOR_VERSION",
  "DF_TBENCH_REGISTRY_REVISION",
  "DF_TBENCH_DATASET_CONTENT_SHA256",
  "DF_TBENCH_DATASET_MANIFEST_SHA256",
  "DF_HARBOR_PACKAGE_SHA256",
  "DF_HARBOR_EXECUTABLE_SHA256",
  "DF_PI_HARBOR_ADAPTER_SHA256",
  "DF_BUDGET_USD",
  "DF_BUDGET_TOKENS",
  "DF_BUDGET_WALL_TIME_MINUTES",
  "DF_BUDGET_ATTEMPTS",
  "DF_BUDGET_PRIVACY_RELEASES",
  "DF_BUDGET_PROMOTION_LOOKS",
  "DF_BUDGET_ONLINE_ERROR",
] as const;
const OPTIMIZE_SOURCE_ENVIRONMENT_NAMES = [
  "DF_PI_GITHUB_OWNER",
  "DF_PI_GITHUB_REPOSITORY",
  "DF_PI_BRANCH",
  "DF_PI_BASELINE_COMMIT",
  "DF_PI_BASELINE_TREE",
  "DF_PI_PACKAGE_LOCK_SHA256",
  "DF_PI_CODING_AGENT_VERSION",
] as const;
const CONTROL_RUNTIME_ENVIRONMENT_NAMES = new Set<string>([
  ...OPTIMIZE_CONTROL_ENVIRONMENT_NAMES,
  ...OPTIMIZE_SOURCE_ENVIRONMENT_NAMES,
  "DF_CLOUD_EXECUTION",
  "DF_TRUSTED_CONTROL_PLANE",
  "DF_TRUSTED_VOLUME_ROOT",
  "DF_CAMPAIGN_ID",
  "DF_CAMPAIGN_STATE_ROOT",
  "DF_DAYTONA_VOLUME_ID",
  "DF_DAYTONA_VOLUME_SUBPATH",
  PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_ENVIRONMENT_NAME,
  "DAYTONA_API_KEY",
  "DAYTONA_WORKSPACE_ID",
  "DAYTONA_SANDBOX_ID",
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "LC_ALL",
  "LANG",
  "LANGUAGE",
]);
const CONTROL_RUNTIME_ENVIRONMENT_PREFIX =
  /^(?:DAYTONA|GITHUB|RUNNER|NODE|NPM|PNPM|COREPACK|LD|DYLD|LC)_/u;

export type CloudControlCommand = "probe" | "synthetic" | "optimize" | "status" | "stop" | "resume";

export class CloudControlBootstrapError extends Error {
  override readonly name = "CloudControlBootstrapError";
}

export interface DaytonaControlVolume {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly subpath: string;
}

export interface DaytonaControlCreateParameters {
  readonly image: string;
  readonly resources: {
    readonly cpu: number;
    readonly memory: number;
    readonly disk: number;
  };
  readonly ephemeral: true;
  readonly autoPauseInterval: 0;
  readonly autoStopInterval: 0;
  readonly autoDeleteInterval: 0;
  readonly ttlMinutes: number;
  readonly public: false;
  readonly envVars: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly volumes: readonly DaytonaControlVolume[];
  readonly domainAllowList?: string;
  readonly networkBlockAll?: true;
}

interface DaytonaControlExecution {
  readonly result?: string;
  readonly exitCode?: number;
  readonly artifacts?: {
    readonly stdout?: string;
  };
}

export interface DaytonaControlSandbox {
  readonly id: string;
  readonly target: string;
  readonly cpu: number;
  readonly memory: number;
  readonly disk: number;
  readonly public: boolean;
  readonly autoDeleteInterval?: number;
  readonly autoPauseInterval?: number;
  readonly autoStopInterval?: number;
  readonly autoDestroyAt?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly volumes?: readonly {
    readonly volumeId: string;
    readonly mountPath: string;
    readonly subpath?: string;
  }[];
  readonly domainAllowList?: string;
  readonly networkBlockAll?: boolean;
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      environment?: Readonly<Record<string, string>>,
      timeoutSeconds?: number,
    ): Promise<DaytonaControlExecution>;
  };
  refreshData(): Promise<void>;
  delete(timeoutSeconds?: number, wait?: boolean): Promise<void>;
}

export interface DaytonaControlClient {
  create(
    parameters: DaytonaControlCreateParameters,
    options?: { readonly timeout?: number },
  ): Promise<DaytonaControlSandbox>;
}

export interface DaytonaControlClientFactory {
  create(environment: NodeJS.ProcessEnv): Promise<DaytonaControlClient>;
}

export interface CloudControlBootstrapRequest {
  readonly command: CloudControlCommand;
  readonly campaignId: string;
  readonly configuration: BootstrapConfiguration | StagedControlConfiguration;
  readonly volumeId: string;
  readonly volumeSubpath: string;
  readonly ttlMinutes: number;
  readonly networkAllowDomains: readonly string[];
  readonly controllerDaytonaSecretSource: string | null;
  readonly additionalControllerSecrets: readonly {
    readonly sourceEnvironmentName: string;
    readonly targetEnvironmentName: string;
  }[];
  readonly optimizeBootstrapDescriptor: ProductionOptimizeBootstrapDescriptor | null;
  readonly resources: {
    readonly cpu: number;
    readonly memoryGiB: number;
    readonly diskGiB: number;
  };
}

export interface CloudControlBootstrapReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.cloud-control-bootstrap.v1";
  readonly provider: "daytona";
  readonly command: CloudControlCommand;
  readonly campaignId: string;
  readonly sandboxIdHash: string;
  readonly imageReference: string;
  readonly imageDigest: `sha256:${string}`;
  readonly target: string;
  readonly volumeBindingHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: 0;
  readonly outputSha256: string;
  readonly outputByteLength: number;
  readonly teardownConfirmed: true;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quotePosix(value: string): string {
  if (value.includes("\u0000")) {
    throw new CloudControlBootstrapError("Control command contains a NUL byte.");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function positiveInteger(environment: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = Number(environment[name]);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new CloudControlBootstrapError(`${name} must be a bounded positive integer.`);
  }
  return value;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new CloudControlBootstrapError(`${name} is required.`);
  }
  return value;
}

function parseControllerSecrets(
  environment: NodeJS.ProcessEnv,
): CloudControlBootstrapRequest["additionalControllerSecrets"] {
  const raw = environment["DF_CONTROL_SECRET_BINDINGS_JSON"]?.trim() ?? "[]";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CloudControlBootstrapError("DF_CONTROL_SECRET_BINDINGS_JSON must be canonical JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new CloudControlBootstrapError("Controller secret bindings must be a bounded array.");
  }
  const targets = new Set<string>();
  return parsed.map((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "sourceEnvironmentName") ||
      !Object.hasOwn(value, "targetEnvironmentName")
    ) {
      throw new CloudControlBootstrapError("Controller secret binding is malformed.");
    }
    const source = (value as { sourceEnvironmentName?: unknown }).sourceEnvironmentName;
    const target = (value as { targetEnvironmentName?: unknown }).targetEnvironmentName;
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      !SAFE_ENVIRONMENT_NAME.test(source) ||
      !SAFE_ENVIRONMENT_NAME.test(target) ||
      CONTROL_RUNTIME_ENVIRONMENT_NAMES.has(target) ||
      CONTROL_RUNTIME_ENVIRONMENT_PREFIX.test(target) ||
      targets.has(target)
    ) {
      throw new CloudControlBootstrapError(
        "Controller secret binding contains an unsafe or duplicate target.",
      );
    }
    targets.add(target);
    return {
      sourceEnvironmentName: source,
      targetEnvironmentName: target,
    };
  });
}

function normalizeDomains(raw: string): readonly string[] {
  const domains = [
    ...new Set(
      raw
        .split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0),
    ),
  ].sort();
  if (
    domains.length > 32 ||
    domains.some(
      (domain) =>
        !SAFE_DOMAIN.test(domain) || domain === "localhost" || /^\d+(?:\.\d+){3}$/u.test(domain),
    )
  ) {
    throw new CloudControlBootstrapError("Controller network allowlist contains an unsafe domain.");
  }
  return domains;
}

export function parseCloudControlBootstrapEnvironment(
  environment: NodeJS.ProcessEnv,
  command: string,
  campaignId: string,
): CloudControlBootstrapRequest {
  if (
    environment["GITHUB_ACTIONS"] !== "true" ||
    environment["RUNNER_ENVIRONMENT"] !== "github-hosted"
  ) {
    throw new CloudControlBootstrapError(
      "Control bootstrap may run only on a GitHub-hosted cloud runner.",
    );
  }
  if (!["probe", "synthetic", "optimize", "status", "stop", "resume"].includes(command)) {
    throw new CloudControlBootstrapError("Unknown control-plane command.");
  }
  if (!SAFE_CAMPAIGN_ID.test(campaignId)) {
    throw new CloudControlBootstrapError("Campaign identifier is malformed.");
  }
  const typedCommand = command as CloudControlCommand;
  let configuration: BootstrapConfiguration | StagedControlConfiguration;
  if (typedCommand === "optimize") {
    const readiness = inspectBootstrapEnvironment(environment);
    if (!readiness.ready || readiness.configuration === null) {
      throw new CloudControlBootstrapError(
        `Paid optimize configuration is incomplete (${[
          ...readiness.missing.map((name) => `missing:${name}`),
          ...readiness.invalid.map((name) => `invalid:${name}`),
        ].join(",")}).`,
      );
    }
    configuration = readiness.configuration;
  } else {
    const readiness = inspectStagedControlEnvironment(
      environment,
      typedCommand === "probe" ? "probe" : "offline",
    );
    if (!readiness.ready || readiness.configuration === null) {
      throw new CloudControlBootstrapError(
        `Control-stage configuration is incomplete (${[
          ...readiness.missing.map((name) => `missing:${name}`),
          ...readiness.invalid.map((name) => `invalid:${name}`),
        ].join(",")}).`,
      );
    }
    configuration = readiness.configuration;
  }
  if (configuration.cloudProvider !== "daytona") {
    throw new CloudControlBootstrapError("The MVP control bootstrap supports Daytona only.");
  }
  if (environment["DAYTONA_TARGET"]?.trim() !== configuration.cloudRegionClass) {
    throw new CloudControlBootstrapError(
      "DAYTONA_TARGET must exactly equal DF_CLOUD_REGION_CLASS.",
    );
  }
  const volumeId = required(environment, "DF_DAYTONA_VOLUME_ID");
  const volumeSubpath = required(environment, "DF_DAYTONA_VOLUME_SUBPATH");
  const controllerDaytonaSecretSource =
    typedCommand === "probe" || typedCommand === "optimize"
      ? required(environment, "DF_CONTROL_DAYTONA_SECRET_SOURCE")
      : null;
  if (
    !SAFE_ID.test(volumeId) ||
    !SAFE_VOLUME_SUBPATH.test(volumeSubpath) ||
    (controllerDaytonaSecretSource !== null &&
      !SAFE_ENVIRONMENT_NAME.test(controllerDaytonaSecretSource))
  ) {
    throw new CloudControlBootstrapError(
      "Control volume or organization-secret identifier is malformed.",
    );
  }
  if (
    typedCommand === "optimize" &&
    environment["DF_PAID_RUN_AUTHORIZATION"] !==
      `RUN:${campaignId}:${configuration.images.control.digest}`
  ) {
    throw new CloudControlBootstrapError(
      "Paid optimization requires an exact image-bound workflow authorization.",
    );
  }
  if (typedCommand === "optimize") {
    const sourceReadiness = inspectPiHarnessSourceEnvironment(environment);
    if (!sourceReadiness.ready) {
      throw new CloudControlBootstrapError(
        `Pi source configuration is incomplete (${[
          ...sourceReadiness.missing.map((name) => `missing:${name}`),
          ...sourceReadiness.invalid.map((name) => `invalid:${name}`),
        ].join(",")}).`,
      );
    }
  }
  let optimizeBootstrapDescriptor: ProductionOptimizeBootstrapDescriptor | null = null;
  if (typedCommand === "optimize") {
    try {
      optimizeBootstrapDescriptor = parseProductionOptimizeBootstrapDescriptorEnvironment(
        environment,
        campaignId,
      );
    } catch {
      throw new CloudControlBootstrapError(
        "Production optimize bootstrap descriptor is missing or invalid.",
      );
    }
  }
  // Validate configured organization-secret bindings for every command, even
  // when the current stage will not forward them. This prevents a dormant
  // unsafe override from becoming active only when a later paid command runs.
  const controllerSecrets = parseControllerSecrets(environment);
  return {
    command: typedCommand,
    campaignId,
    configuration,
    volumeId,
    volumeSubpath,
    ttlMinutes: positiveInteger(environment, "DF_CONTROL_TTL_MINUTES", MAXIMUM_CONTROL_TTL_MINUTES),
    networkAllowDomains:
      typedCommand === "probe" || typedCommand === "optimize"
        ? normalizeDomains(required(environment, "DF_CONTROL_NETWORK_ALLOW_DOMAINS"))
        : [],
    controllerDaytonaSecretSource,
    additionalControllerSecrets: typedCommand === "optimize" ? controllerSecrets : [],
    optimizeBootstrapDescriptor,
    resources: {
      cpu: positiveInteger(environment, "DF_CONTROL_CPU", 32),
      memoryGiB: positiveInteger(environment, "DF_CONTROL_MEMORY_GIB", 128),
      diskGiB: positiveInteger(environment, "DF_CONTROL_DISK_GIB", 1024),
    },
  };
}

function controlEnvironment(
  request: CloudControlBootstrapRequest,
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const names: readonly string[] =
    request.command === "optimize"
      ? [...OPTIMIZE_CONTROL_ENVIRONMENT_NAMES, ...OPTIMIZE_SOURCE_ENVIRONMENT_NAMES]
      : request.command === "probe"
        ? PROBE_CONTROL_ENVIRONMENT_NAMES
        : OFFLINE_CONTROL_ENVIRONMENT_NAMES;
  const result: Record<string, string> = {
    DF_CLOUD_EXECUTION: "1",
    DF_TRUSTED_CONTROL_PLANE: "1",
    DF_TRUSTED_VOLUME_ROOT: CONTROL_MOUNT_PATH,
    DF_CAMPAIGN_ID: request.campaignId,
    DF_CAMPAIGN_STATE_ROOT: `${CONTROL_MOUNT_PATH}/campaign-state`,
    DF_DAYTONA_VOLUME_ID: request.volumeId,
    DF_DAYTONA_VOLUME_SUBPATH: request.volumeSubpath,
  };
  for (const name of names) {
    const value = source[name];
    if (value === undefined || value.length === 0) {
      throw new CloudControlBootstrapError(
        `Validated configuration field ${name} disappeared before launch.`,
      );
    }
    result[name] = value;
  }
  if (request.command === "optimize") {
    if (request.optimizeBootstrapDescriptor === null) {
      throw new CloudControlBootstrapError(
        "Validated optimize bootstrap descriptor disappeared before launch.",
      );
    }
    result[PRODUCTION_OPTIMIZE_BOOTSTRAP_DESCRIPTOR_ENVIRONMENT_NAME] = canonicalJson(
      request.optimizeBootstrapDescriptor,
    );
  }
  return result;
}

function controllerSecrets(
  request: CloudControlBootstrapRequest,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  if (request.command === "probe" || request.command === "optimize") {
    if (request.controllerDaytonaSecretSource === null) {
      throw new CloudControlBootstrapError(
        "Validated nested Daytona secret reference disappeared before launch.",
      );
    }
    result["DAYTONA_API_KEY"] = request.controllerDaytonaSecretSource;
  }
  if (request.command === "optimize") {
    for (const binding of request.additionalControllerSecrets) {
      if (Object.hasOwn(result, binding.targetEnvironmentName)) {
        throw new CloudControlBootstrapError("Controller secret target is duplicated.");
      }
      result[binding.targetEnvironmentName] = binding.sourceEnvironmentName;
    }
  }
  return result;
}

function controlCommand(request: CloudControlBootstrapRequest): string {
  return [
    quotePosix("/usr/local/bin/node"),
    quotePosix(CONTROL_ENTRYPOINT),
    quotePosix(request.command),
    quotePosix("--campaign"),
    quotePosix(request.campaignId),
  ].join(" ");
}

function outputOf(execution: DaytonaControlExecution): string {
  const output = execution.artifacts?.stdout ?? execution.result;
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output, "utf8") > MAXIMUM_CONTROL_OUTPUT_BYTES
  ) {
    throw new CloudControlBootstrapError(
      "Control plane returned malformed or oversized release-safe output.",
    );
  }
  return output;
}

function sameVolume(
  actual: DaytonaControlSandbox["volumes"],
  expected: DaytonaControlVolume,
): boolean {
  return (
    actual?.length === 1 &&
    actual[0]?.volumeId === expected.volumeId &&
    actual[0]?.mountPath === expected.mountPath &&
    actual[0]?.subpath === expected.subpath
  );
}

export async function launchDaytonaControlPlane(
  request: CloudControlBootstrapRequest,
  factory: DaytonaControlClientFactory,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
): Promise<CloudControlBootstrapReceipt> {
  const startedAt = now();
  const volume: DaytonaControlVolume = {
    volumeId: request.volumeId,
    mountPath: CONTROL_MOUNT_PATH,
    subpath: request.volumeSubpath,
  };
  const domains =
    request.command === "probe" || request.command === "optimize"
      ? [...request.networkAllowDomains].sort()
      : [];
  const parameters: DaytonaControlCreateParameters = {
    image: request.configuration.images.control.reference,
    resources: {
      cpu: request.resources.cpu,
      memory: request.resources.memoryGiB,
      disk: request.resources.diskGiB,
    },
    ephemeral: true,
    autoPauseInterval: 0,
    autoStopInterval: 0,
    autoDeleteInterval: 0,
    ttlMinutes: request.ttlMinutes,
    public: false,
    envVars: controlEnvironment(request, environment),
    secrets: controllerSecrets(request),
    labels: {
      "dark-factory-control": "1",
      "df-campaign-sha256": hash(request.campaignId),
      "df-control-image-sha256": request.configuration.images.control.digest.slice(
        "sha256:".length,
      ),
    },
    volumes: [volume],
    ...(domains.length === 0
      ? { networkBlockAll: true as const }
      : { domainAllowList: domains.join(",") }),
  };

  let sandbox: DaytonaControlSandbox | undefined;
  let receipt: CloudControlBootstrapReceipt | undefined;
  let primaryFailure: { readonly error: unknown } | undefined;
  let teardownFailure: { readonly error: unknown } | undefined;
  try {
    const client = await factory.create(environment);
    sandbox = await client.create(parameters, { timeout: 10 * 60 });
    await sandbox.refreshData();
    const actualDomains =
      sandbox.domainAllowList
        ?.split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter((domain) => domain.length > 0)
        .sort() ?? [];
    const actualDestroyAt = Date.parse(sandbox.autoDestroyAt ?? "");
    if (
      !SAFE_ID.test(sandbox.id) ||
      sandbox.target !== request.configuration.cloudRegionClass ||
      sandbox.cpu !== request.resources.cpu ||
      sandbox.memory !== request.resources.memoryGiB ||
      sandbox.disk !== request.resources.diskGiB ||
      sandbox.public !== false ||
      sandbox.autoDeleteInterval !== 0 ||
      sandbox.autoPauseInterval !== 0 ||
      sandbox.autoStopInterval !== 0 ||
      sandbox.env?.["DF_TRUSTED_CONTROL_PLANE"] !== "1" ||
      sandbox.env?.["DF_CLOUD_EXECUTION"] !== "1" ||
      (sandbox.env?.["DAYTONA_WORKSPACE_ID"] !== sandbox.id &&
        sandbox.env?.["DAYTONA_SANDBOX_ID"] !== sandbox.id) ||
      !sameVolume(sandbox.volumes, volume) ||
      !Number.isFinite(actualDestroyAt) ||
      actualDestroyAt <= startedAt.getTime() ||
      actualDestroyAt > startedAt.getTime() + request.ttlMinutes * 60_000 + 60_000 ||
      (domains.length === 0
        ? sandbox.networkBlockAll !== true
        : sandbox.networkBlockAll === true ||
          JSON.stringify(actualDomains) !== JSON.stringify(domains))
    ) {
      throw new CloudControlBootstrapError(
        "Daytona did not attest the exact trusted control-plane profile.",
      );
    }
    const execution = await sandbox.process.executeCommand(
      controlCommand(request),
      "/",
      { LC_ALL: "C" },
      Math.max(1, request.ttlMinutes * 60 - 120),
    );
    const output = outputOf(execution);
    if (execution.exitCode !== 0) {
      throw new CloudControlBootstrapError("Trusted control-plane command failed closed.");
    }
    const finishedAt = now();
    receipt = {
      schemaVersion: 1,
      domain: "dark-factory.cloud-control-bootstrap.v1",
      provider: "daytona",
      command: request.command,
      campaignId: request.campaignId,
      sandboxIdHash: hash(sandbox.id),
      imageReference: request.configuration.images.control.reference,
      imageDigest: request.configuration.images.control.digest,
      target: request.configuration.cloudRegionClass,
      volumeBindingHash: hash(
        `${request.volumeId}\u0000${request.volumeSubpath}\u0000${CONTROL_MOUNT_PATH}`,
      ),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      exitCode: 0,
      outputSha256: hash(output),
      outputByteLength: Buffer.byteLength(output, "utf8"),
      teardownConfirmed: true,
    };
  } catch (error) {
    primaryFailure = { error };
  } finally {
    if (sandbox !== undefined) {
      try {
        await sandbox.delete(60, true);
      } catch (error) {
        teardownFailure = { error };
      }
    }
  }
  if (teardownFailure !== undefined) {
    throw new CloudControlBootstrapError(
      primaryFailure === undefined
        ? "Control-plane teardown could not be confirmed."
        : "Control-plane command failed and teardown could not be confirmed.",
      {
        cause:
          primaryFailure === undefined
            ? teardownFailure.error
            : new AggregateError(
                [primaryFailure.error, teardownFailure.error],
                "Control-plane command and teardown both failed.",
              ),
      },
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure.error;
  if (receipt === undefined) {
    throw new CloudControlBootstrapError(
      "Control-plane command completed without an attested receipt.",
    );
  }
  return receipt;
}

export class OfficialDaytonaControlClientFactory implements DaytonaControlClientFactory {
  async create(environment: NodeJS.ProcessEnv): Promise<DaytonaControlClient> {
    const apiKey = environment["DAYTONA_API_KEY"];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new CloudControlBootstrapError(
        "GitHub-hosted bootstrap lacks its Daytona API credential.",
      );
    }
    const sdk = await import("@daytona/sdk");
    const configuration = {
      apiKey,
      otelEnabled: false,
      ...(environment["DAYTONA_API_URL"] === undefined
        ? {}
        : { apiUrl: environment["DAYTONA_API_URL"] }),
      ...(environment["DAYTONA_TARGET"] === undefined
        ? {}
        : { target: environment["DAYTONA_TARGET"] }),
    };
    return new sdk.Daytona(configuration) as unknown as DaytonaControlClient;
  }
}
