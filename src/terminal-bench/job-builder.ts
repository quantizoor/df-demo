import type {
  CloudProviderName,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import type { HarnessArtifactReference } from "../evaluator/contracts.js";
import type { HiddenTaskId } from "../evaluation/types.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import {
  assertTrustedHarborJobArtifact,
  computeTrustedHarborJobHash,
  hashHarborAgentIsolationPolicy,
  type TrustedHarborInvocation,
  type TrustedHarborJobArtifact,
  type TrustedHarborUpload,
} from "./harbor.js";
import type { PiHarborAgentSpec } from "./pi-agent.js";
import {
  assertTerminalBench21Pin,
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "./pin.js";
import {
  assertTrustedMatchedPanel,
  type MatchedArmKind,
  type TrustedHiddenTaskCell,
  type TrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "./trusted.js";
import type {
  TrustedHarborJobBuildRequest,
  TrustedHarborJobBuilder,
} from "./runner.js";

export interface TrustedResolvedTask {
  readonly sensitivity: "trusted-hidden-task-resolution";
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly packageTaskName: string;
}

export interface TrustedHiddenTaskResolver {
  resolve(
    taskId: HiddenTaskId,
    taskRevisionDigest: string,
  ): Promise<TrustedResolvedTask>;
}

export interface TrustedHarnessRuntimeResolver {
  resolve(harness: HarnessArtifactReference): Promise<TrustedHarnessRuntimeResolution>;
}

export interface TrustedHarnessRuntimeResolution {
  readonly sensitivity: "trusted-harness-runtime-resolution";
  readonly harness: HarnessArtifactReference;
  readonly artifact: TrustedCloudArtifactRef;
  readonly validationLevel: "release";
  readonly buildReceiptHash: string;
  readonly verifiedAt: string;
  readonly resolutionHash: string;
}

export interface TrustedCanonicalJsonPublisher {
  publish(input: {
    readonly sensitivity: "hidden-harbor-config";
    readonly logicalName: string;
    readonly canonicalJson: string;
    readonly sha256: string;
  }): Promise<TrustedCloudArtifactRef>;
}

export interface TerminalBench21JobBuilderOptions {
  readonly pin: TerminalBench21Pin;
  readonly taskResolver: TrustedHiddenTaskResolver;
  readonly runtimeResolver: TrustedHarnessRuntimeResolver;
  readonly publisher: TrustedCanonicalJsonPublisher;
  readonly adapterArtifact: TrustedCloudArtifactRef;
  readonly outputPackagerArtifact: TrustedCloudArtifactRef;
  readonly remoteUploadRoot: string;
  readonly remoteOutputRoot: string;
  readonly environmentType: CloudProviderName;
  readonly modelApiAllowedHosts: readonly string[];
  readonly piEntrypoint: string;
}

interface AgentRuntime {
  readonly arm: MatchedArmKind;
  readonly harness: HarnessArtifactReference;
  readonly artifact: TrustedCloudArtifactRef;
  readonly remotePath: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_HOST =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const SAFE_RELATIVE_PATH =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const TRUSTED_URI =
  /^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export class TrustedHarborJobBuildError extends Error {
  override readonly name = "TrustedHarborJobBuildError";
}

function assertRemoteRoot(root: string, label: string): void {
  if (
    !root.startsWith("/") ||
    !root.endsWith("/") ||
    root === "/" ||
    root.includes("/../") ||
    root.includes("\u0000")
  ) {
    throw new TrustedHarborJobBuildError(`${label} is not a sealed remote directory.`);
  }
}

function assertArtifact(artifact: TrustedCloudArtifactRef, label: string): void {
  if (
    !TRUSTED_URI.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0
  ) {
    throw new TrustedHarborJobBuildError(`${label} is not content-addressed.`);
  }
}

function runtimeResolutionPayload(
  resolution: TrustedHarnessRuntimeResolution,
): Readonly<Record<string, unknown>> {
  return {
    sensitivity: resolution.sensitivity,
    harness: resolution.harness,
    artifact: resolution.artifact,
    validationLevel: resolution.validationLevel,
    buildReceiptHash: resolution.buildReceiptHash,
    verifiedAt: resolution.verifiedAt,
  };
}

export function computeHarnessRuntimeResolutionHash(
  resolution: TrustedHarnessRuntimeResolution,
): string {
  return canonicalHash(runtimeResolutionPayload(resolution));
}

function assertRuntimeResolution(
  resolution: TrustedHarnessRuntimeResolution,
  harness: HarnessArtifactReference,
  label: string,
): void {
  assertArtifact(resolution.artifact, label);
  if (
    resolution.sensitivity !== "trusted-harness-runtime-resolution" ||
    canonicalHash(resolution.harness) !== canonicalHash(harness) ||
    resolution.validationLevel !== "release" ||
    !SHA256.test(resolution.buildReceiptHash) ||
    !Number.isFinite(Date.parse(resolution.verifiedAt)) ||
    resolution.artifact.sha256 !== harness.archiveSha256 ||
    !new Set(["application/gzip", "application/x-tar"]).has(
      resolution.artifact.mediaType,
    ) ||
    resolution.resolutionHash !==
      computeHarnessRuntimeResolutionHash(resolution)
  ) {
    throw new TrustedHarborJobBuildError(
      "A resolved harness runtime is not a release-validated build of the sealed harness.",
    );
  }
}

function onlyHarness(
  schedule: TrustedMatchedArmSchedule,
  arm: MatchedArmKind,
): HarnessArtifactReference | undefined {
  const harnesses = schedule.arms
    .filter((entry) => entry.arm === arm)
    .map((entry) => entry.harness);
  if (harnesses.length === 0) return undefined;
  const first = harnesses[0]!;
  if (
    harnesses.some(
      (harness) =>
        harness.commitSha !== first.commitSha ||
        harness.treeSha !== first.treeSha ||
        harness.archiveSha256 !== first.archiveSha256 ||
        harness.uri !== first.uri,
    )
  ) {
    throw new TrustedHarborJobBuildError(
      "A sealed arm kind resolves to more than one harness.",
    );
  }
  return first;
}

function assertScheduleMatchesPanel(
  panel: TrustedMatchedPanel,
  schedule: TrustedMatchedArmSchedule,
): void {
  assertTrustedMatchedPanel(panel);
  const expectedArms = panel.stage === "repair" ? panel.cells.length : panel.cells.length * 2;
  if (
    schedule.sensitivity !== "hidden-benchmark-schedule" ||
    schedule.requestId !== panel.requestId ||
    schedule.stage !== panel.stage ||
    schedule.cellCount !== panel.cells.length ||
    schedule.armCount !== expectedArms ||
    schedule.arms.length !== expectedArms
  ) {
    throw new TrustedHarborJobBuildError(
      "Hidden panel and matched-arm schedule do not correlate.",
    );
  }
  for (const [cellOrdinal, cell] of panel.cells.entries()) {
    const arms = schedule.arms.filter((arm) => arm.cellOrdinal === cellOrdinal);
    const expectedKinds =
      panel.stage === "repair"
        ? (["candidate"] as const)
        : (["candidate", "champion"] as const);
    if (
      arms.length !== expectedKinds.length ||
      expectedKinds.some((kind) => !arms.some((arm) => arm.arm === kind)) ||
      arms.some(
        (arm) =>
          arm.taskId !== cell.taskId ||
          arm.taskRevisionDigest !== cell.taskRevisionDigest ||
          arm.replicateOrdinal !== cell.replicateOrdinal ||
          arm.order !== cell.order,
      )
    ) {
      throw new TrustedHarborJobBuildError(
        "A hidden schedule arm does not match its sealed cell.",
      );
    }
  }
}

function roleForRuntime(arm: MatchedArmKind): "candidate-runtime" | "champion-runtime" {
  return arm === "candidate" ? "candidate-runtime" : "champion-runtime";
}

function configRole(
  order: TrustedHarborInvocation["order"],
): "config-repair" | "config-ab" | "config-ba" {
  if (order === "repair") return "config-repair";
  return order === "AB" ? "config-ab" : "config-ba";
}

function invocationAgentOrder(
  order: TrustedHarborInvocation["order"],
): readonly MatchedArmKind[] {
  if (order === "repair") return ["candidate"];
  return order === "AB" ? ["candidate", "champion"] : ["champion", "candidate"];
}

function cellsForInvocation(
  panel: TrustedMatchedPanel,
  order: TrustedHarborInvocation["order"],
): readonly TrustedHiddenTaskCell[] {
  if (order === "repair") return panel.cells;
  return panel.cells.filter((cell) => cell.order === order);
}

function createAgentConfig(
  runtime: AgentRuntime,
  agent: PiHarborAgentSpec,
  options: TerminalBench21JobBuilderOptions,
): Readonly<Record<string, unknown>> {
  return {
    name: `dark-factory-${runtime.arm}`,
    import_path: agent.adapterImportPath,
    model_name: `${agent.evaluatedModel.provider}/${agent.evaluatedModel.modelId}`,
    n_concurrent: 1,
    extra_allowed_hosts: [...options.modelApiAllowedHosts],
    include_logs: ["dark-factory-pi.jsonl"],
    skills: [],
    mcp_servers: [],
    override_timeout_sec: agent.timeoutMs / 1_000,
    max_timeout_sec: agent.timeoutMs / 1_000,
    kwargs: {
      runtime_archive_path: runtime.remotePath,
      runtime_sha256: runtime.artifact.sha256,
      pi_entrypoint: options.piEntrypoint,
      thinking: agent.evaluatedModel.thinkingLevel,
      enabled_tools: agent.enabledTools,
      credential_environment_names:
        agent.credentialEnvironmentNames,
      ...(agent.evaluatedModel.foundryResourceName === undefined
        ? {}
        : {
            foundry_resource_name:
              agent.evaluatedModel.foundryResourceName,
            model_family:
              agent.evaluatedModel.modelFamily!,
          }),
    },
  };
}

function createHiddenConfig(input: {
  readonly invocationId: string;
  readonly outputRoot: string;
  readonly pin: TerminalBench21Pin;
  readonly taskNames: readonly string[];
  readonly agentOrder: readonly MatchedArmKind[];
  readonly runtimes: ReadonlyMap<MatchedArmKind, AgentRuntime>;
  readonly agent: PiHarborAgentSpec;
  readonly options: TerminalBench21JobBuilderOptions;
}): Readonly<Record<string, unknown>> {
  return {
    job_name: input.invocationId,
    jobs_dir: input.outputRoot.slice(0, -1),
    n_attempts: 1,
    n_concurrent_trials: 1,
    quiet: true,
    retry: {
      max_retries: 0,
    },
    environment: {
      type: input.options.environmentType,
      delete: true,
      force_build: false,
    },
    verifier: {
      disable: false,
    },
    agents: input.agentOrder.map((arm) => {
      const runtime = input.runtimes.get(arm);
      if (runtime === undefined) {
        throw new TrustedHarborJobBuildError("A required sealed runtime is absent.");
      }
      return createAgentConfig(runtime, input.agent, input.options);
    }),
    datasets: [
      {
        name: input.pin.dataset,
        ref: String(input.pin.registryRevision),
        overwrite: false,
        task_names: input.taskNames,
      },
    ],
  };
}

async function resolveTaskNames(
  cells: readonly TrustedHiddenTaskCell[],
  resolver: TrustedHiddenTaskResolver,
): Promise<readonly string[]> {
  const names: string[] = [];
  try {
    for (const cell of cells) {
      const resolved = await resolver.resolve(
        cell.taskId,
        cell.taskRevisionDigest,
      );
      if (
        resolved.sensitivity !== "trusted-hidden-task-resolution" ||
        resolved.taskId !== cell.taskId ||
        resolved.taskRevisionDigest !== cell.taskRevisionDigest ||
        !SAFE_TASK_NAME.test(resolved.packageTaskName)
      ) {
        throw new TrustedHarborJobBuildError("Hidden task resolution failed closed.");
      }
      names.push(resolved.packageTaskName);
    }
  } catch {
    throw new TrustedHarborJobBuildError(
      "Hidden task resolution failed without releasing task material.",
    );
  }
  if (new Set(names).size !== names.length) {
    throw new TrustedHarborJobBuildError(
      "Hidden task resolution produced a duplicate package task.",
    );
  }
  return names;
}

/**
 * This class belongs in the trusted cloud broker/evaluator deployment. Its
 * return value is release-safe, but the intermediate config JSON is not.
 */
export class TerminalBench21TrustedJobBuilder implements TrustedHarborJobBuilder {
  readonly #options: TerminalBench21JobBuilderOptions;

  constructor(options: TerminalBench21JobBuilderOptions) {
    assertTerminalBench21Pin(options.pin);
    assertRemoteRoot(options.remoteUploadRoot, "Remote upload root");
    assertRemoteRoot(options.remoteOutputRoot, "Remote output root");
    assertArtifact(options.adapterArtifact, "Pi adapter");
    assertArtifact(options.outputPackagerArtifact, "Harbor output packager");
    if (
      options.adapterArtifact.sha256 !== options.pin.piHarborAdapterSha256 ||
      !new Set(["text/x-python", "text/plain"]).has(
        options.adapterArtifact.mediaType,
      ) ||
      !new Set([
        "application/javascript",
        "text/javascript",
        "text/plain",
      ]).has(options.outputPackagerArtifact.mediaType) ||
      options.modelApiAllowedHosts.length === 0 ||
      options.modelApiAllowedHosts.some((host) => !SAFE_HOST.test(host)) ||
      new Set(options.modelApiAllowedHosts).size !==
        options.modelApiAllowedHosts.length ||
      !new Set(["daytona", "e2b", "modal"]).has(
        options.environmentType,
      ) ||
      !SAFE_RELATIVE_PATH.test(options.piEntrypoint)
    ) {
      throw new TrustedHarborJobBuildError(
        "Trusted Harbor builder options are not immutable or allowlisted.",
      );
    }
    this.#options = options;
  }

  async build(request: TrustedHarborJobBuildRequest): Promise<TrustedHarborJobArtifact> {
    if (
      request.sensitivity !== "hidden-harbor-build-request" ||
      canonicalHash(request.pin) !== canonicalHash(this.#options.pin) ||
      canonicalHash(request.isolationPolicy) !==
        hashHarborAgentIsolationPolicy() ||
      request.agent.adapterSha256 !== this.#options.pin.piHarborAdapterSha256
    ) {
      throw new TrustedHarborJobBuildError(
        "Harbor build request violates its immutable pin or isolation policy.",
      );
    }
    if (request.agent.evaluatedModel.provider === "microsoft-foundry") {
      const resource =
        request.agent.evaluatedModel.foundryResourceName;
      if (
        resource === undefined ||
        this.#options.modelApiAllowedHosts.length !== 1 ||
        this.#options.modelApiAllowedHosts[0] !==
          `${resource}.services.ai.azure.com`
      ) {
        throw new TrustedHarborJobBuildError(
          "Microsoft Foundry evaluation requires its exact derived API host.",
        );
      }
    }
    assertScheduleMatchesPanel(request.panel, request.schedule);

    const candidate = onlyHarness(request.schedule, "candidate");
    const champion = onlyHarness(request.schedule, "champion");
    if (
      candidate === undefined ||
      (request.panel.stage === "repair" && champion !== undefined) ||
      (request.panel.stage !== "repair" && champion === undefined)
    ) {
      throw new TrustedHarborJobBuildError(
        "Harbor build request has the wrong stage-specific harness set.",
      );
    }

    const runtimes = new Map<MatchedArmKind, AgentRuntime>();
    for (const [arm, harness] of [
      ["candidate", candidate],
      ...(champion === undefined
        ? []
        : ([["champion", champion]] as const)),
    ] as const) {
      let resolution: TrustedHarnessRuntimeResolution;
      try {
        resolution = await this.#options.runtimeResolver.resolve(harness);
      } catch {
        throw new TrustedHarborJobBuildError(
          "A sealed harness runtime could not be resolved.",
        );
      }
      assertRuntimeResolution(resolution, harness, `${arm} runtime`);
      runtimes.set(arm, {
        arm,
        harness,
        artifact: resolution.artifact,
        remotePath: `${this.#options.remoteUploadRoot}${arm}.tar`,
      });
    }

    const orders: readonly TrustedHarborInvocation["order"][] =
      request.panel.stage === "repair" ? ["repair"] : ["AB", "BA"];
    const uploads: TrustedHarborUpload[] = [];
    const invocations: TrustedHarborInvocation[] = [];
    for (const order of orders) {
      const cells = cellsForInvocation(request.panel, order);
      const taskNames = await resolveTaskNames(
        cells,
        this.#options.taskResolver,
      );
      const invocationId = `${request.panel.requestId}-${order.toLowerCase()}`;
      const agentOrder = invocationAgentOrder(order);
      const config = createHiddenConfig({
        invocationId,
        outputRoot: this.#options.remoteOutputRoot,
        pin: request.pin,
        taskNames,
        agentOrder,
        runtimes,
        agent: request.agent,
        options: this.#options,
      });
      const configJson = canonicalJson(config);
      const configSha256 = canonicalHash(config);
      let artifact: TrustedCloudArtifactRef;
      try {
        artifact = await this.#options.publisher.publish({
          sensitivity: "hidden-harbor-config",
          logicalName: invocationId,
          canonicalJson: configJson,
          sha256: configSha256,
        });
      } catch {
        throw new TrustedHarborJobBuildError(
          "A hidden Harbor configuration could not be published.",
        );
      }
      assertArtifact(artifact, "Harbor config");
      if (
        artifact.sha256 !== configSha256 ||
        artifact.mediaType !== "application/json" ||
        artifact.byteLength !== Buffer.byteLength(configJson, "utf8")
      ) {
        throw new TrustedHarborJobBuildError(
          "Published Harbor config changed its canonical content.",
        );
      }
      const remoteConfigPath =
        `${this.#options.remoteUploadRoot}config-${order.toLowerCase()}.json`;
      uploads.push({
        role: configRole(order),
        artifact,
        remotePath: remoteConfigPath,
      });
      invocations.push({
        invocationId,
        order,
        configSha256,
        remoteConfigPath,
        remoteHarborJobPath:
          `${this.#options.remoteOutputRoot}${invocationId}`,
        remoteOutputPath:
          `${this.#options.remoteOutputRoot}${invocationId}.harbor-output.tar`,
        cellCount: cells.length,
        armCount: cells.length * agentOrder.length,
        agentOrder,
        nAttempts: 1,
        nConcurrentTrials: 1,
        harborRetries: 0,
      });
    }

    uploads.push({
      role: "output-packager",
      artifact: this.#options.outputPackagerArtifact,
      remotePath:
        `${this.#options.remoteUploadRoot}package-harbor-output.mjs`,
    });
    uploads.push({
      role: "pi-adapter",
      artifact: this.#options.adapterArtifact,
      remotePath: `${this.#options.remoteUploadRoot}dark_factory_pi.py`,
    });
    for (const arm of ["candidate", "champion"] as const) {
      const runtime = runtimes.get(arm);
      if (runtime !== undefined) {
        uploads.push({
          role: roleForRuntime(arm),
          artifact: runtime.artifact,
          remotePath: runtime.remotePath,
        });
      }
    }

    const provisional: TrustedHarborJobArtifact = {
      sensitivity: "hidden-harbor-job",
      requestId: request.panel.requestId,
      stage: request.panel.stage,
      pinHash: hashTerminalBench21Pin(request.pin),
      isolationPolicyHash: hashHarborAgentIsolationPolicy(),
      jobSha256: "0".repeat(64),
      cellCount: request.schedule.cellCount,
      armCount: request.schedule.armCount,
      uploads,
      invocations,
    };
    const job: TrustedHarborJobArtifact = {
      ...provisional,
      jobSha256: computeTrustedHarborJobHash(provisional),
    };
    assertTrustedHarborJobArtifact(job, hashTerminalBench21Pin(request.pin));
    return job;
  }
}
