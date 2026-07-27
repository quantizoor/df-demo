import { createHash } from "node:crypto";

import { canonicalJson } from "./contracts.js";
import {
  MVP_PREFLIGHT_WORKER_PATH,
  MVP_PROCESS_ENTRYPOINT,
  MVP_ROLE_MOUNT_PATH,
  type MvpCloudRuntime,
  type MvpControllerBundle,
  type MvpDaytonaRuntimeConfiguration,
  type MvpRoleSandboxLease,
  type MvpRoleSandboxSpec,
} from "./daytona-runtime.js";
import {
  asMvpPreflightDiagnosticError,
  type MvpPreflightDiagnosticCode,
  MvpPreflightDiagnosticError,
  parseMvpPreflightWorkerFailure,
} from "./preflight-diagnostics.js";

export type MvpPreflightStage = "bootstrap" | "synthetic" | "connectivity";

const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_WITH_PREFIX = /^sha256:[a-f0-9]{64}$/u;
const SAFE_CAMPAIGN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_RUN_ID = /^[0-9]{1,32}$/u;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const BOOTSTRAP_TIMEOUT_MS = 160 * 60_000;
const SYNTHETIC_TIMEOUT_MS = 10 * 60_000;
const CONNECTIVITY_TIMEOUT_MS = 20 * 60_000;
const HARBOR_REGISTRY_DOMAINS = [
  "ofhuhcpkvzjlejydnvyd.storage.supabase.co",
  "ofhuhcpkvzjlejydnvyd.supabase.co",
] as const;

export class MvpPreflightError extends Error {
  override readonly name = "MvpPreflightError";
}

export interface MvpPreflightConfiguration {
  readonly stage: MvpPreflightStage;
  readonly campaignId: string;
  readonly sourceCommit: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly imageReference: string;
  readonly priorReceiptSha256: string | null;
  readonly controllerBundle: MvpControllerBundle;
  readonly daytona: {
    readonly apiUrl: string;
    readonly target: string;
    readonly volumeId: string;
    readonly volumeSubpath: string;
    readonly nestedSecretSource: string;
  };
  readonly configurationBindingHash: string;
}

export interface MvpPreflightBootstrapEvidence {
  readonly runtimePinSha256: string;
  readonly catalogSha256: string;
  readonly inventoryDigest: string;
  readonly compatibleTaskCount: number;
  readonly sourceTaskCount: 89;
  readonly allStepVerifierEnvironmentModesSeparate: true;
  readonly runtimeCompatibilityProven: true;
  readonly officialResourcesFit: true;
}

export interface MvpSyntheticSmokeEvidence {
  readonly deterministicSelection: true;
  readonly matchedTaskCount: 5;
  readonly repetitionsPerTask: 3;
  readonly matchedCellCount: 15;
  readonly retainedPanel: true;
  readonly initialCacheMisses: 15;
  readonly retainedPanelCacheHits: 15;
  readonly promotionRefreshes: 15;
  readonly promotionSeededEntries: 15;
  readonly promotionEvidenceFresh: true;
  readonly persistedExperimentCount: 3;
  readonly persistedCampaignRevision: 2;
  readonly infrastructureInvalidWeightingIgnored: true;
}

export type MvpPreflightStageEvidence =
  | MvpPreflightBootstrapEvidence
  | MvpSyntheticSmokeEvidence
  | Readonly<Record<string, string | number | boolean>>;

export interface MvpPreflightWorkerSuccess {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-preflight-worker.v1";
  readonly stage: MvpPreflightStage;
  readonly status: "passed";
  readonly stageEvidence: MvpPreflightStageEvidence;
  readonly sandboxAccounting: {
    readonly created: number;
    readonly destroyed: number;
    readonly allDestroyed: true;
  };
  readonly containsTaskIdentifiers: false;
  readonly containsTaskLiterals: false;
  readonly containsGraderData: false;
  readonly containsRawTraces: false;
}

export interface MvpPreflightReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-preflight.receipt.v1";
  readonly stage: MvpPreflightStage;
  readonly status: "passed";
  readonly campaignId: string;
  readonly sourceCommit: string;
  readonly imageDigest: `sha256:${string}`;
  readonly configurationBindingHash: string;
  readonly controllerBundleSha256: string;
  readonly priorReceiptSha256: string | null;
  readonly actualIterationsCompleted: 0;
  readonly counters: {
    readonly optimizerInvocations: 0;
    readonly modelRequests: 0;
    readonly harborTrials: 0;
  };
  readonly sandboxes: {
    readonly created: number;
    readonly destroyed: number;
    readonly allDestroyed: true;
  };
  readonly stageEvidence: MvpPreflightStageEvidence;
  readonly containsTaskIdentifiers: false;
  readonly containsTaskLiterals: false;
  readonly containsGraderData: false;
  readonly containsRawTraces: false;
}

export interface LaunchMvpPreflightOptions {
  readonly configuration: MvpPreflightConfiguration;
  readonly runtime: MvpCloudRuntime;
}

export async function launchMvpPreflight(
  options: LaunchMvpPreflightOptions,
): Promise<MvpPreflightReceipt> {
  let specification: MvpRoleSandboxSpec;
  try {
    assertMvpPreflightConfiguration(options.configuration);
    specification = mvpPreflightSandboxSpecification(options.configuration);
  } catch (error) {
    throw asMvpPreflightDiagnosticError(error, "outer-configuration");
  }
  let lease: MvpRoleSandboxLease | null = null;
  let worker: MvpPreflightWorkerSuccess | null = null;
  let failure: MvpPreflightDiagnosticError | null = null;
  let phase: MvpPreflightDiagnosticCode = "outer-create";
  try {
    lease = await options.runtime.create(specification);
    phase = "outer-stage";
    const staged = await options.runtime.stage(lease, options.configuration.controllerBundle);
    if (staged.sha256 !== options.configuration.controllerBundle.sha256) {
      throw new MvpPreflightError("The staged preflight controller digest changed.");
    }
    phase = "outer-execute";
    const executed = await options.runtime.execute(lease, {
      executable: MVP_PROCESS_ENTRYPOINT,
      arguments: ["node", MVP_PREFLIGHT_WORKER_PATH, options.configuration.stage],
      timeoutMs: stageTimeout(options.configuration.stage),
      environment: {
        CI: "true",
        DF_CLOUD_EXECUTION: "1",
        DF_MVP_ROLE: "evaluator",
      },
    });
    phase = "worker-output-invalid";
    worker = parseMvpPreflightWorkerSuccess(
      executed.privateWorkerOutput,
      options.configuration.stage,
    );
  } catch (error) {
    failure = asMvpPreflightDiagnosticError(error, phase);
  } finally {
    if (lease !== null) {
      try {
        await options.runtime.destroy(lease);
      } catch {
        failure = new MvpPreflightDiagnosticError("outer-cleanup");
      }
    }
  }
  if (failure !== null) {
    throw failure;
  }
  if (lease === null || worker === null) {
    throw new MvpPreflightDiagnosticError("worker-output-invalid");
  }

  const imageDigest = options.configuration.imageReference.slice(
    options.configuration.imageReference.lastIndexOf("@") + 1,
  );
  if (!SHA256_WITH_PREFIX.test(imageDigest)) {
    throw new MvpPreflightError("The preflight image digest is invalid.");
  }
  const nestedCreated = worker.sandboxAccounting.created;
  const nestedDestroyed = worker.sandboxAccounting.destroyed;
  return {
    schemaVersion: 1,
    domain: "dark-factory.mvp-preflight.receipt.v1",
    stage: options.configuration.stage,
    status: "passed",
    campaignId: options.configuration.campaignId,
    sourceCommit: options.configuration.sourceCommit,
    imageDigest: imageDigest as `sha256:${string}`,
    configurationBindingHash: options.configuration.configurationBindingHash,
    controllerBundleSha256: options.configuration.controllerBundle.sha256,
    priorReceiptSha256: options.configuration.priorReceiptSha256,
    actualIterationsCompleted: 0,
    counters: {
      optimizerInvocations: 0,
      modelRequests: 0,
      harborTrials: 0,
    },
    sandboxes: {
      created: nestedCreated + 1,
      destroyed: nestedDestroyed + 1,
      allDestroyed: true,
    },
    stageEvidence: worker.stageEvidence,
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderData: false,
    containsRawTraces: false,
  };
}

export function mvpPreflightSandboxSpecification(
  configuration: MvpPreflightConfiguration,
): MvpRoleSandboxSpec {
  assertMvpPreflightConfiguration(configuration);
  const networkBlockAll = configuration.stage === "synthetic";
  const networkAllowDomains =
    configuration.stage === "bootstrap"
      ? [new URL(configuration.daytona.apiUrl).hostname, ...HARBOR_REGISTRY_DOMAINS].sort()
      : configuration.stage === "synthetic"
        ? []
        : [new URL(configuration.daytona.apiUrl).hostname];
  return {
    role: "evaluator",
    user: "root",
    requestId: `${configuration.campaignId}-${configuration.stage}-${configuration.workflowRunId}-${configuration.workflowRunAttempt}`,
    campaignId: configuration.campaignId,
    configurationHash: configuration.configurationBindingHash,
    target: configuration.daytona.target,
    image: configuration.imageReference,
    resources: {
      cpu: 4,
      memoryGiB: 8,
      diskGiB: 10,
    },
    ttlMinutes:
      configuration.stage === "bootstrap" ? 170 : configuration.stage === "synthetic" ? 15 : 25,
    networkBlockAll,
    networkAllowDomains,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      DF_MVP_ROLE: "evaluator",
      DF_MVP_PREFLIGHT_STAGE: configuration.stage,
      DF_MVP_CAMPAIGN_ID: configuration.campaignId,
      DF_MVP_CONFIGURATION_HASH: configuration.configurationBindingHash,
      DF_MVP_MAX_ITERATIONS: "0",
      DF_MVP_STATE_ROOT: MVP_ROLE_MOUNT_PATH,
      DF_MVP_SOURCE_COMMIT: configuration.sourceCommit,
      DF_MVP_IMAGE_REFERENCE: configuration.imageReference,
      DF_MVP_CONTROLLER_BUNDLE_SHA256: configuration.controllerBundle.sha256,
      DAYTONA_API_URL: configuration.daytona.apiUrl,
      DAYTONA_TARGET: configuration.daytona.target,
      DO_NOT_TRACK: "1",
      HARBOR_TELEMETRY_ENABLED: "false",
    },
    secretReferences:
      configuration.stage === "bootstrap"
        ? [
            {
              sourceEnvironmentName: configuration.daytona.nestedSecretSource,
              targetEnvironmentName: "DAYTONA_API_KEY",
            },
          ]
        : [],
    volume: {
      id: configuration.daytona.volumeId,
      subpath: `${configuration.daytona.volumeSubpath}/evaluator`,
      mountPath: MVP_ROLE_MOUNT_PATH,
    },
  };
}

export function mvpPreflightDaytonaConfiguration(
  configuration: MvpPreflightConfiguration,
): MvpDaytonaRuntimeConfiguration {
  assertMvpPreflightConfiguration(configuration);
  const resources = {
    cpu: 4,
    memoryGiB: 8,
    diskGiB: 10,
  } as const;
  return {
    campaignId: configuration.campaignId,
    configurationHash: configuration.configurationBindingHash,
    daytona: {
      apiUrl: configuration.daytona.apiUrl,
      target: configuration.daytona.target,
      images: {
        evaluator: configuration.imageReference,
      },
      volumeId: configuration.daytona.volumeId,
      apiKeyEnvironmentName: "DAYTONA_API_KEY",
      outerSandboxResources: {
        optimizer: resources,
        evaluator: resources,
      },
    },
  };
}

export function preflightConfigurationBindingHash(
  input: Omit<MvpPreflightConfiguration, "configurationBindingHash">,
): string {
  return digest({
    domain: "dark-factory.mvp-preflight-configuration.v1",
    stage: input.stage,
    campaignId: input.campaignId,
    sourceCommit: input.sourceCommit,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    imageReference: input.imageReference,
    priorReceiptSha256: input.priorReceiptSha256,
    controllerBundleSha256: input.controllerBundle.sha256,
    daytona: input.daytona,
    maximumIterations: 0,
    resources: { cpu: 4, memoryGiB: 8, diskGiB: 10 },
  });
}

export function parseMvpPreflightWorkerSuccess(
  raw: string,
  expectedStage: MvpPreflightStage,
): MvpPreflightWorkerSuccess {
  const diagnostic = parseMvpPreflightWorkerFailure(raw);
  if (diagnostic !== null) {
    throw new MvpPreflightDiagnosticError(diagnostic);
  }
  if (Buffer.byteLength(raw, "utf8") > 64 * 1_024) {
    throw new MvpPreflightError("The preflight worker output is oversized.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new MvpPreflightError("The preflight worker returned malformed JSON.");
  }
  const value = plainRecord(parsed);
  if (
    value === null ||
    !hasExactKeys(value, [
      "schemaVersion",
      "domain",
      "stage",
      "status",
      "stageEvidence",
      "sandboxAccounting",
      "containsTaskIdentifiers",
      "containsTaskLiterals",
      "containsGraderData",
      "containsRawTraces",
    ]) ||
    value["schemaVersion"] !== 1 ||
    value["domain"] !== "dark-factory.mvp-preflight-worker.v1" ||
    value["stage"] !== expectedStage ||
    value["status"] !== "passed" ||
    value["containsTaskIdentifiers"] !== false ||
    value["containsTaskLiterals"] !== false ||
    value["containsGraderData"] !== false ||
    value["containsRawTraces"] !== false
  ) {
    throw new MvpPreflightError("The preflight worker result is not release-safe.");
  }
  const accounting = plainRecord(value["sandboxAccounting"]);
  if (
    accounting === null ||
    !hasExactKeys(accounting, ["created", "destroyed", "allDestroyed"]) ||
    !Number.isSafeInteger(accounting["created"]) ||
    (accounting["created"] as number) < 0 ||
    accounting["destroyed"] !== accounting["created"] ||
    accounting["allDestroyed"] !== true
  ) {
    throw new MvpPreflightError("The preflight worker did not prove sandbox cleanup.");
  }
  assertStageEvidence(value["stageEvidence"], expectedStage);
  return parsed as MvpPreflightWorkerSuccess;
}

export function assertMvpPreflightConfiguration(configuration: MvpPreflightConfiguration): void {
  let apiUrl: URL;
  try {
    apiUrl = new URL(configuration.daytona.apiUrl);
  } catch {
    throw new MvpPreflightError("The preflight Daytona endpoint is invalid.");
  }
  const expectedHash = preflightConfigurationBindingHash({
    stage: configuration.stage,
    campaignId: configuration.campaignId,
    sourceCommit: configuration.sourceCommit,
    workflowRunId: configuration.workflowRunId,
    workflowRunAttempt: configuration.workflowRunAttempt,
    imageReference: configuration.imageReference,
    priorReceiptSha256: configuration.priorReceiptSha256,
    controllerBundle: configuration.controllerBundle,
    daytona: configuration.daytona,
  });
  if (
    !["bootstrap", "synthetic", "connectivity"].includes(configuration.stage) ||
    !SAFE_CAMPAIGN.test(configuration.campaignId) ||
    !SHA1.test(configuration.sourceCommit) ||
    !SAFE_RUN_ID.test(configuration.workflowRunId) ||
    !Number.isSafeInteger(configuration.workflowRunAttempt) ||
    configuration.workflowRunAttempt < 1 ||
    !IMMUTABLE_IMAGE.test(configuration.imageReference) ||
    (configuration.stage === "bootstrap"
      ? configuration.priorReceiptSha256 !== null
      : !SHA256.test(configuration.priorReceiptSha256 ?? "")) ||
    !configuration.controllerBundle.localPath.startsWith("/") ||
    configuration.controllerBundle.localPath === "/" ||
    configuration.controllerBundle.localPath.includes("/../") ||
    !SHA256.test(configuration.controllerBundle.sha256) ||
    apiUrl.protocol !== "https:" ||
    apiUrl.hostname !== "app.daytona.io" ||
    apiUrl.pathname.replace(/\/+$/u, "") !== "/api" ||
    !/(?:^|[-_.])eu(?:$|[-_.])/iu.test(configuration.daytona.target) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(configuration.daytona.volumeId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,8}$/u.test(
      configuration.daytona.volumeSubpath,
    ) ||
    !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(configuration.daytona.nestedSecretSource) ||
    configuration.configurationBindingHash !== expectedHash
  ) {
    throw new MvpPreflightError("The source-bound preflight configuration is invalid.");
  }
}

function assertStageEvidence(value: unknown, stage: MvpPreflightStage): void {
  const evidence = plainRecord(value);
  if (evidence === null) {
    throw new MvpPreflightError("The preflight stage evidence is invalid.");
  }
  if (stage === "bootstrap") {
    if (
      !hasExactKeys(evidence, [
        "runtimePinSha256",
        "catalogSha256",
        "inventoryDigest",
        "compatibleTaskCount",
        "sourceTaskCount",
        "allStepVerifierEnvironmentModesSeparate",
        "runtimeCompatibilityProven",
        "officialResourcesFit",
      ]) ||
      !SHA256.test(String(evidence["runtimePinSha256"] ?? "")) ||
      !SHA256.test(String(evidence["catalogSha256"] ?? "")) ||
      !SHA256.test(String(evidence["inventoryDigest"] ?? "")) ||
      !Number.isSafeInteger(evidence["compatibleTaskCount"]) ||
      (evidence["compatibleTaskCount"] as number) < 5 ||
      evidence["sourceTaskCount"] !== 89 ||
      evidence["allStepVerifierEnvironmentModesSeparate"] !== true ||
      evidence["runtimeCompatibilityProven"] !== true ||
      evidence["officialResourcesFit"] !== true
    ) {
      throw new MvpPreflightError("The private bootstrap evidence is incomplete.");
    }
    return;
  }
  if (stage === "synthetic") {
    const expected: MvpSyntheticSmokeEvidence = {
      deterministicSelection: true,
      matchedTaskCount: 5,
      repetitionsPerTask: 3,
      matchedCellCount: 15,
      retainedPanel: true,
      initialCacheMisses: 15,
      retainedPanelCacheHits: 15,
      promotionRefreshes: 15,
      promotionSeededEntries: 15,
      promotionEvidenceFresh: true,
      persistedExperimentCount: 3,
      persistedCampaignRevision: 2,
      infrastructureInvalidWeightingIgnored: true,
    };
    if (canonicalJson(evidence) !== canonicalJson(expected)) {
      throw new MvpPreflightError("The no-model synthetic evidence is incomplete.");
    }
    return;
  }
  throw new MvpPreflightError("The connectivity evidence schema has not been introduced yet.");
}

function stageTimeout(stage: MvpPreflightStage): number {
  return stage === "bootstrap"
    ? BOOTSTRAP_TIMEOUT_MS
    : stage === "synthetic"
      ? SYNTHETIC_TIMEOUT_MS
      : CONNECTIVITY_TIMEOUT_MS;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
