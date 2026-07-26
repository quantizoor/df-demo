import { createHash } from "node:crypto";

import {
  type ReleaseSafeMvpCampaignReceipt,
  validateReleaseSafeMvpCampaignReceipt,
} from "./campaign-driver.js";
import type { MvpCloudConfiguration } from "./cloud-config.js";
import {
  canonicalJson,
  type CandidateProposal,
  type OptimizerInput,
} from "./contracts.js";
import {
  MVP_EVALUATOR_WORKER_PATH,
  MVP_OPTIMIZER_WORKER_PATH,
  MVP_PROCESS_ENTRYPOINT,
  MVP_ROLE_MOUNT_PATH,
  type MvpCloudRole,
  type MvpCloudRuntime,
  type MvpControllerBundle,
  type MvpRoleExecutionReceipt,
  type MvpRoleSandboxLease,
  type MvpRoleSandboxSpec,
  type MvpRoleWorkerCommand,
} from "./daytona-runtime.js";
import {
  validateCandidateProposal,
  validateMvpArtifact,
} from "./schemas.js";

const WORKER_TTL_MINUTES = 300;
const PREPARE_TIMEOUT_MS = 2 * 60_000;
const OPTIMIZER_TIMEOUT_MS = 130 * 60_000;
const EVALUATOR_TIMEOUT_MS = 160 * 60_000;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_RUN_ID = /^[0-9]{1,32}$/u;
const SAFE_PREREQUISITES = new Set([
  "MVP_CONTROLLER_BUNDLE",
  "MVP_EVALUATOR_HIDDEN_CATALOG",
  "MVP_EVALUATOR_RUNTIME_PIN",
  "MVP_EVALUATOR_TASK_ELIGIBILITY",
]);

const OPTIMIZER_DOMAINS = [
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
] as const;
const EVALUATOR_DOMAINS = [
  "api.github.com",
  "auth.docker.io",
  "ghcr.io",
  "github.com",
  "objects.githubusercontent.com",
  "production.cloudflare.docker.com",
  "registry-1.docker.io",
  "registry.npmjs.org",
] as const;

export class MvpCloudOrchestrationError extends Error {
  override readonly name = "MvpCloudOrchestrationError";
}

export interface MvpCloudLaunchIdentity {
  readonly sourceCommit: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
}

interface MvpCloudReceiptBase {
  readonly schemaVersion: 2;
  readonly domain: "dark-factory.mvp-cloud-launch.v2";
  readonly campaignId: string;
  readonly configurationHash: string;
  readonly sourceCommit: string;
  readonly workflowRunId: string;
  readonly workflowRunAttempt: number;
  readonly provider: "daytona";
  readonly regionClass: "eu";
  readonly imageDigest: `sha256:${string}`;
  readonly controllerBundleSha256: string;
  readonly maximumIterations: 1;
  readonly protocol: {
    readonly taskCount: 5;
    readonly repetitions: 3;
    readonly matchedTrialCount: 30;
  };
  readonly outerSandboxResources: {
    readonly optimizer: MvpRoleSandboxSpec["resources"];
    readonly evaluator: MvpRoleSandboxSpec["resources"];
  };
  readonly isolation: {
    readonly policy: "distinct-provider-enforced-volume-subpaths-v1";
    readonly volumeBoundaryHash: string;
    readonly optimizerTaskDataVisible: false;
    readonly optimizerGraderVisible: false;
    readonly optimizerRawTraceVisible: false;
    readonly persistentVolumePreserved: true;
  };
  readonly executions: readonly MvpReleaseSafeRoleExecution[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly containsTaskIdentifiers: false;
  readonly containsTaskLiterals: false;
  readonly containsGraderData: false;
  readonly containsRawTraces: false;
}

export interface MvpCloudCompletedReceipt
  extends MvpCloudReceiptBase {
  readonly status: "actual-iteration-completed";
  readonly actualIterationsCompleted: 1;
  readonly iteration: ReleaseSafeMvpCampaignReceipt;
}

export interface MvpCloudBlockedReceipt extends MvpCloudReceiptBase {
  readonly status: "blocked";
  readonly actualIterationsCompleted: 0;
  readonly missingPrerequisites: readonly string[];
}

export type MvpCloudLaunchReceipt =
  | MvpCloudCompletedReceipt
  | MvpCloudBlockedReceipt;

export interface MvpReleaseSafeRoleExecution {
  readonly phase: "prepare" | "optimize" | "evaluate";
  readonly role: MvpCloudRole;
  readonly sandboxIdSha256: string;
  readonly workerOutputSha256: string;
  readonly workerOutputByteLength: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly exitCode: 0;
  readonly destroyed: true;
}

export interface LaunchMvpCloudShellOptions {
  readonly configuration: MvpCloudConfiguration;
  readonly identity: MvpCloudLaunchIdentity;
  readonly runtime: MvpCloudRuntime;
  readonly controllerBundle: MvpControllerBundle;
  readonly now?: () => Date;
}

type WorkerPayload =
  | { readonly kind: "optimizer-input"; readonly value: OptimizerInput }
  | { readonly kind: "proposal"; readonly value: CandidateProposal }
  | {
      readonly kind: "release";
      readonly value: ReleaseSafeMvpCampaignReceipt;
    }
  | {
      readonly kind: "blocked";
      readonly missingPrerequisites: readonly string[];
    };

/**
 * Trusted relay: evaluator prepare -> optimizer proposal -> evaluator run.
 * Only the two strict, task-free public objects cross between disjoint Daytona
 * subpaths. Success requires a schema-validated actual iteration release.
 */
export async function launchMvpCloudShell(
  options: LaunchMvpCloudShellOptions,
): Promise<MvpCloudLaunchReceipt> {
  assertLaunchIdentity(options.identity);
  if (options.configuration.maximumIterations !== 1) {
    throw new MvpCloudOrchestrationError(
      "The MVP launch currently permits exactly one iteration.",
    );
  }
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const optimizerSpec = roleSpecification(
    options.configuration,
    "optimizer",
  );
  const evaluatorSpec = roleSpecification(
    options.configuration,
    "evaluator",
  );
  assertRoleIsolation(optimizerSpec, evaluatorSpec);

  const leases: MvpRoleSandboxLease[] = [];
  const executions: {
    readonly phase: MvpReleaseSafeRoleExecution["phase"];
    readonly lease: MvpRoleSandboxLease;
    readonly receipt: MvpRoleExecutionReceipt;
  }[] = [];
  let outcome:
    | {
        readonly kind: "completed";
        readonly release: ReleaseSafeMvpCampaignReceipt;
      }
    | {
        readonly kind: "blocked";
        readonly missingPrerequisites: readonly string[];
      }
    | null = null;
  let primaryFailure = false;
  let cleanupFailure = false;

  try {
    const optimizer = await options.runtime.create(optimizerSpec);
    leases.push(optimizer);
    const evaluator = await options.runtime.create(evaluatorSpec);
    leases.push(evaluator);
    const optimizerBundle = await options.runtime.stage(
      optimizer,
      options.controllerBundle,
    );
    const evaluatorBundle = await options.runtime.stage(
      evaluator,
      options.controllerBundle,
    );
    if (
      optimizerBundle.sha256 !== options.controllerBundle.sha256 ||
      evaluatorBundle.sha256 !== options.controllerBundle.sha256
    ) {
      throw new MvpCloudOrchestrationError(
        "The staged controller bundle digest is inconsistent.",
      );
    }

    const prepareReceipt = await options.runtime.execute(
      evaluator,
      roleWorkerCommand("evaluator", "prepare"),
    );
    executions.push({
      phase: "prepare",
      lease: evaluator,
      receipt: prepareReceipt,
    });
    const prepared = parseWorkerPayload(
      prepareReceipt.privateWorkerOutput,
      "optimizer-input",
    );
    if (prepared.kind === "blocked") {
      outcome = prepared;
    } else if (prepared.kind !== "optimizer-input") {
      throw new MvpCloudOrchestrationError(
        "Evaluator prepare returned an invalid channel value.",
      );
    } else {
      const optimizeReceipt = await options.runtime.execute(
        optimizer,
        roleWorkerCommand("optimizer", "optimize", {
          DF_MVP_OPTIMIZER_INPUT_BASE64: encodePublicJson(
            prepared.value,
          ),
        }),
      );
      executions.push({
        phase: "optimize",
        lease: optimizer,
        receipt: optimizeReceipt,
      });
      const proposed = parseWorkerPayload(
        optimizeReceipt.privateWorkerOutput,
        "proposal",
      );
      if (proposed.kind === "blocked") {
        outcome = proposed;
      } else if (proposed.kind !== "proposal") {
        throw new MvpCloudOrchestrationError(
          "Optimizer returned an invalid public proposal.",
        );
      } else {
        const evaluateReceipt = await options.runtime.execute(
          evaluator,
          roleWorkerCommand("evaluator", "evaluate", {
            DF_MVP_CANDIDATE_PROPOSAL_BASE64: encodePublicJson(
              proposed.value,
            ),
            DF_MVP_PREPARED_INPUT_SHA256: sha256(
              canonicalJson(prepared.value),
            ),
          }),
        );
        executions.push({
          phase: "evaluate",
          lease: evaluator,
          receipt: evaluateReceipt,
        });
        const evaluated = parseWorkerPayload(
          evaluateReceipt.privateWorkerOutput,
          "release",
        );
        outcome =
          evaluated.kind === "blocked"
            ? evaluated
            : evaluated.kind === "release"
              ? { kind: "completed", release: evaluated.value }
              : null;
      }
    }
  } catch {
    primaryFailure = true;
  } finally {
    for (const lease of [...leases].reverse()) {
      try {
        await options.runtime.destroy(lease);
      } catch {
        cleanupFailure = true;
      }
    }
  }

  if (
    primaryFailure ||
    cleanupFailure ||
    leases.length !== 2 ||
    outcome === null
  ) {
    throw new MvpCloudOrchestrationError(
      "The MVP cloud launch failed closed.",
    );
  }

  const base = receiptBase(
    options.configuration,
    options.identity,
    optimizerSpec,
    evaluatorSpec,
    options.controllerBundle.sha256,
    executions,
    startedAt,
    now().toISOString(),
  );
  return outcome.kind === "blocked"
    ? {
        ...base,
        status: "blocked",
        actualIterationsCompleted: 0,
        missingPrerequisites: outcome.missingPrerequisites,
      }
    : {
        ...base,
        status: "actual-iteration-completed",
        actualIterationsCompleted: 1,
        iteration: outcome.release,
      };
}

export function roleSpecification(
  configuration: MvpCloudConfiguration,
  role: MvpCloudRole,
): MvpRoleSandboxSpec {
  const commonEnvironment = {
    CI: "true",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_ROLE: role,
    DF_MVP_CAMPAIGN_ID: configuration.campaignId,
    DF_MVP_CONFIGURATION_HASH: configuration.configurationHash,
    DF_MVP_MAX_ITERATIONS: "1",
    DF_MVP_STATE_ROOT: MVP_ROLE_MOUNT_PATH,
    DF_PI_GITHUB_OWNER: configuration.pi.owner,
    DF_PI_GITHUB_REPOSITORY: configuration.pi.repository,
    DF_PI_BRANCH: configuration.pi.branch,
    DF_PI_BASELINE_COMMIT: configuration.pi.baselineCommit,
    DF_PI_BASELINE_TREE: configuration.pi.baselineTree,
    DF_PI_PACKAGE_LOCK_SHA256:
      configuration.pi.packageLockSha256,
    DF_FOUNDRY_BASE_URL: configuration.foundry.baseUrl,
  };
  const roleEnvironment =
    role === "optimizer"
      ? {
          DF_OPTIMIZER_DEPLOYMENT:
            configuration.foundry.optimizerDeployment,
          DF_OPTIMIZER_MODEL_FAMILY:
            configuration.foundry.optimizerModelFamily,
        }
      : {
          DAYTONA_API_URL: configuration.daytona.apiUrl,
          DAYTONA_TARGET: configuration.daytona.target,
          DF_EVALUATED_DEPLOYMENT:
            configuration.foundry.evaluatedDeployment,
          DF_EVALUATED_SECRET_SOURCE:
            configuration.foundry.evaluatedSecretSource,
          DF_EVALUATED_MODEL_FAMILY:
            configuration.foundry.evaluatedModelFamily,
          DF_EVALUATED_REASONING_EFFORT:
            configuration.foundry.evaluatedReasoningEffort,
          DF_MVP_PANEL_SIZE:
            configuration.protocol.taskCount.toString(),
          DF_MVP_REPETITIONS:
            configuration.protocol.repetitions.toString(),
          DF_MVP_MATCHED_TRIAL_COUNT:
            configuration.protocol.matchedTrialCount.toString(),
        };
  return {
    role,
    ...(role === "evaluator" ? { user: "root" as const } : {}),
    requestId: `${configuration.campaignId}-${role}`,
    campaignId: configuration.campaignId,
    configurationHash: configuration.configurationHash,
    target: configuration.daytona.target,
    image: configuration.daytona.image,
    // Keep both trusted outer roles within the operator's current Daytona
    // non-GPU per-sandbox ceiling. Official task resources remain
    // independently pinned and apply only to Harbor's direct children.
    resources: {
      ...configuration.daytona.outerSandboxResources[role],
    },
    ttlMinutes: WORKER_TTL_MINUTES,
    networkAllowDomains: [
      ...new Set([
        configuration.foundry.apiHost,
        ...(role === "evaluator"
          ? [new URL(configuration.daytona.apiUrl).hostname]
          : []),
        ...(role === "optimizer"
          ? OPTIMIZER_DOMAINS
          : EVALUATOR_DOMAINS),
      ]),
    ].sort(),
    environment: {
      ...commonEnvironment,
      ...roleEnvironment,
    },
    secretReferences: [
      {
        sourceEnvironmentName:
          role === "optimizer"
            ? configuration.foundry.optimizerSecretSource
            : configuration.foundry.evaluatedSecretSource,
        targetEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
      {
        sourceEnvironmentName:
          configuration.pi.githubSecretSource,
        // This governed placeholder is wrapper-only. The stored Daytona value
        // is pre-encoded Basic auth, and child Claude/Pi environments must
        // exclude both the placeholder and Git's extraHeader configuration.
        targetEnvironmentName: "DF_GITHUB_BASIC_AUTH",
      },
      ...(role === "evaluator"
        ? [
            {
              sourceEnvironmentName:
                configuration.daytona.harborApiSecretSource,
              targetEnvironmentName: "DAYTONA_API_KEY",
            },
          ]
        : []),
    ],
    volume: {
      id: configuration.daytona.volumeId,
      subpath: `${configuration.daytona.volumeSubpath}/${role}`,
      mountPath: MVP_ROLE_MOUNT_PATH,
    },
  };
}

export function roleWorkerCommand(
  role: MvpCloudRole,
  operation: "prepare" | "optimize" | "evaluate",
  relayEnvironment: Readonly<Record<string, string>> = {},
): MvpRoleWorkerCommand {
  if (
    (role === "optimizer" && operation !== "optimize") ||
    (role === "evaluator" && operation === "optimize")
  ) {
    throw new MvpCloudOrchestrationError(
      "The MVP worker operation belongs to another role.",
    );
  }
  const workerPath =
    role === "optimizer"
      ? MVP_OPTIMIZER_WORKER_PATH
      : MVP_EVALUATOR_WORKER_PATH;
  const timeoutMs =
    operation === "prepare"
      ? PREPARE_TIMEOUT_MS
      : operation === "optimize"
        ? OPTIMIZER_TIMEOUT_MS
        : EVALUATOR_TIMEOUT_MS;
  return {
    executable: MVP_PROCESS_ENTRYPOINT,
    arguments: ["node", workerPath, operation],
    timeoutMs,
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      DF_MVP_ROLE: role,
      ...relayEnvironment,
    },
  };
}

function parseWorkerPayload(
  raw: string,
  expected: "optimizer-input" | "proposal" | "release",
): WorkerPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new MvpCloudOrchestrationError(
      "A role worker returned malformed JSON.",
    );
  }
  const record = plainRecord(value);
  if (
    record?.["domain"] ===
      "dark-factory.mvp-worker-readiness.v1" &&
    record["status"] === "blocked"
  ) {
    const keys = [
      "schemaVersion",
      "domain",
      "status",
      "role",
      "missingPrerequisites",
      "containsTaskIdentifiers",
      "containsTaskLiterals",
      "containsGraderData",
      "containsRawTraces",
    ];
    const missing = record["missingPrerequisites"];
    if (
      !hasExactKeys(record, keys) ||
      record["schemaVersion"] !== 1 ||
      !new Set(["optimizer", "evaluator"]).has(record["role"]) ||
      !Array.isArray(missing) ||
      missing.length < 1 ||
      missing.some(
        (item) =>
          typeof item !== "string" ||
          !SAFE_PREREQUISITES.has(item),
      ) ||
      record["containsTaskIdentifiers"] !== false ||
      record["containsTaskLiterals"] !== false ||
      record["containsGraderData"] !== false ||
      record["containsRawTraces"] !== false
    ) {
      throw new MvpCloudOrchestrationError(
        "A role worker returned an invalid readiness result.",
      );
    }
    return {
      kind: "blocked",
      missingPrerequisites: [...new Set(missing as string[])].sort(),
    };
  }
  if (expected === "optimizer-input") {
    validateMvpArtifact("optimizerInput", value);
    return { kind: "optimizer-input", value: value as OptimizerInput };
  }
  if (expected === "proposal") {
    validateCandidateProposal(value);
    return { kind: "proposal", value: value as CandidateProposal };
  }
  assertControllerRelease(value);
  return { kind: "release", value };
}

function assertControllerRelease(
  value: unknown,
): asserts value is ReleaseSafeMvpCampaignReceipt {
  try {
    validateReleaseSafeMvpCampaignReceipt(value);
  } catch {
    throw new MvpCloudOrchestrationError(
      "The evaluator did not return an actual iteration release.",
    );
  }
}

function receiptBase(
  configuration: MvpCloudConfiguration,
  identity: MvpCloudLaunchIdentity,
  optimizerSpec: MvpRoleSandboxSpec,
  evaluatorSpec: MvpRoleSandboxSpec,
  controllerBundleSha256: string,
  executions: readonly {
    readonly phase: MvpReleaseSafeRoleExecution["phase"];
    readonly lease: MvpRoleSandboxLease;
    readonly receipt: MvpRoleExecutionReceipt;
  }[],
  startedAt: string,
  finishedAt: string,
): MvpCloudReceiptBase {
  const imageDigest = configuration.daytona.image.slice(
    configuration.daytona.image.lastIndexOf("@") + 1,
  );
  if (!/^sha256:[a-f0-9]{64}$/u.test(imageDigest)) {
    throw new MvpCloudOrchestrationError(
      "The MVP image digest is invalid.",
    );
  }
  if (!SHA256.test(controllerBundleSha256)) {
    throw new MvpCloudOrchestrationError(
      "The controller bundle digest is invalid.",
    );
  }
  return {
    schemaVersion: 2,
    domain: "dark-factory.mvp-cloud-launch.v2",
    campaignId: configuration.campaignId,
    configurationHash: configuration.configurationHash,
    sourceCommit: identity.sourceCommit,
    workflowRunId: identity.workflowRunId,
    workflowRunAttempt: identity.workflowRunAttempt,
    provider: "daytona",
    regionClass: "eu",
    imageDigest: imageDigest as `sha256:${string}`,
    controllerBundleSha256,
    maximumIterations: 1,
    protocol: structuredClone(configuration.protocol),
    outerSandboxResources: {
      optimizer: structuredClone(optimizerSpec.resources),
      evaluator: structuredClone(evaluatorSpec.resources),
    },
    isolation: {
      policy: "distinct-provider-enforced-volume-subpaths-v1",
      volumeBoundaryHash: volumeBoundaryHash(
        configuration,
        optimizerSpec.volume.subpath,
        evaluatorSpec.volume.subpath,
      ),
      optimizerTaskDataVisible: false,
      optimizerGraderVisible: false,
      optimizerRawTraceVisible: false,
      persistentVolumePreserved: true,
    },
    executions: executions.map(({ phase, lease, receipt }) => ({
      phase,
      role: lease.role,
      sandboxIdSha256: sha256(lease.sandboxId),
      workerOutputSha256: receipt.outputSha256,
      workerOutputByteLength: receipt.outputByteLength,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      exitCode: 0 as const,
      destroyed: true as const,
    })),
    startedAt,
    finishedAt,
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderData: false,
    containsRawTraces: false,
  };
}

function assertLaunchIdentity(
  identity: MvpCloudLaunchIdentity,
): void {
  if (
    !SHA1.test(identity.sourceCommit) ||
    !SAFE_RUN_ID.test(identity.workflowRunId) ||
    !Number.isSafeInteger(identity.workflowRunAttempt) ||
    identity.workflowRunAttempt < 1
  ) {
    throw new MvpCloudOrchestrationError(
      "The GitHub-hosted launch identity is invalid.",
    );
  }
}

function assertRoleIsolation(
  optimizer: MvpRoleSandboxSpec,
  evaluator: MvpRoleSandboxSpec,
): void {
  const optimizerEnvironment = JSON.stringify(optimizer.environment);
  const optimizerSecretTargets = new Set(
    optimizer.secretReferences.map(
      (reference) => reference.targetEnvironmentName,
    ),
  );
  if (
    optimizer.volume.id !== evaluator.volume.id ||
    optimizer.volume.subpath === evaluator.volume.subpath ||
    optimizer.volume.mountPath !== evaluator.volume.mountPath ||
    [
      "DF_EVALUATED_DEPLOYMENT",
      "DF_MVP_PANEL_SIZE",
      "DF_MVP_REPETITIONS",
      "DF_MVP_MATCHED_TRIAL_COUNT",
    ].some((name) => optimizerEnvironment.includes(name)) ||
    optimizerSecretTargets.has("DAYTONA_API_KEY")
  ) {
    throw new MvpCloudOrchestrationError(
      "The optimizer and evaluator role boundaries overlap.",
    );
  }
}

function encodePublicJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
}

function plainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function volumeBoundaryHash(
  configuration: MvpCloudConfiguration,
  optimizerSubpath: string,
  evaluatorSubpath: string,
): string {
  return sha256(
    JSON.stringify({
      policy: "distinct-provider-enforced-volume-subpaths-v1",
      configurationHash: configuration.configurationHash,
      volumeId: configuration.daytona.volumeId,
      optimizerSubpath,
      evaluatorSubpath,
      mountPath: MVP_ROLE_MOUNT_PATH,
    }),
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
