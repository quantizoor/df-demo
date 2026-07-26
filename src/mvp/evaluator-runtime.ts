import { createHash, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

import type { TrustedCloudArtifactRef } from "../cloud/types.js";
import { MountedMvpCampaignStateStore } from "./campaign-state.js";
import {
  type EvaluationEnvironment,
  evaluationEnvironmentDigest,
  type EvaluationArm,
  type HiddenEvaluationCell,
  type PrivateEvaluationObservation,
  type PrivateEvaluationRequest,
  type TrustedEvaluatorPort,
  type CandidateProposal,
  canonicalJson,
  MVP_SCHEMA_VERSION,
} from "./contracts.js";
import {
  assertTrustedMvpHarborExecutionPlan,
  buildTrustedMvpHarborExecutionPlan,
  decodeTrustedMvpHarborRequestedOutput,
  MVP_HARBOR_VERSION,
  type MvpHarborBuildInput,
  type MvpHarborRuntimeArchive,
  type TrustedMvpHarborExecutionPlan,
  type TrustedMvpHarborRequestedRawOutput,
  type TrustedMvpHarborTaskBinding,
} from "./harbor.js";
import {
  MountedHiddenTaskCatalog,
  type ResolvedHarborEvaluationCell,
  type TrustedHarborTaskDefinition,
} from "./mounted-hidden-task-catalog.js";
import {
  readBoundedJson,
  readOptionalBoundedJson,
  withMountedLock,
  writeJsonAtomic,
} from "./mounted-files.js";
import {
  validateCandidateProposal,
  validateEvaluationEnvironment,
} from "./schemas.js";

export const MVP_EVALUATOR_RUNTIME_PIN_PATH =
  "private/mvp-runtime-pin.json" as const;
export const MVP_EVALUATOR_CATALOG_NAMESPACE_PATH =
  "private/catalog-namespace.json" as const;
export const MVP_EVALUATOR_READINESS_CODES = [
  "MVP_EVALUATOR_RUNTIME_PIN",
  "MVP_EVALUATOR_HIDDEN_CATALOG",
  "MVP_EVALUATOR_TASK_ELIGIBILITY",
] as const;

const REVISION = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_TASK_NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_RELATIVE_PATH =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;

export type MvpEvaluatorReadinessCode =
  (typeof MVP_EVALUATOR_READINESS_CODES)[number];

export class MvpEvaluatorReadinessError extends Error {
  override readonly name = "MvpEvaluatorReadinessError";

  public constructor(readonly code: MvpEvaluatorReadinessCode) {
    super(code);
  }
}

export interface MvpEvaluatorRuntimePin {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-evaluator-runtime-pin.v1";
  readonly harborVersion: "0.20.0";
  readonly terminalBenchVersion: string;
  readonly datasetName: string;
  readonly datasetRef: string;
  readonly datasetRevision: string;
  readonly datasetContentSha256: string;
  readonly graderProtocolVersion: string;
  readonly evaluatorVersion: string;
  readonly harborExecutable: string;
  readonly harborExecutableSha256: string;
  readonly bunExecutable: string;
  readonly bunExecutableSha256: string;
  readonly adapterPath: string;
  readonly adapterSha256: string;
  readonly piEntrypoint: string;
  readonly enabledTools: readonly string[];
  readonly timeoutSeconds: number;
  /**
   * Harbor 0.20.0 cannot attach Daytona Secrets to compose/DinD tasks.
   * Bootstrap discovery must therefore attest the exact direct-sandbox task
   * revisions eligible for this first MVP loop.
   */
  readonly directSandboxEligibleTaskRevisionDigests: readonly string[];
  readonly hiddenTaskDefinitions: readonly TrustedHarborTaskDefinition[];
  readonly imageDigest: string;
  readonly architecture: "x86_64";
  readonly runtimeAbi: "linux-x64-glibc";
  readonly resourcesDigest: string;
  readonly networkPolicyDigest: string;
  readonly samplingSettingsDigest: string;
  readonly contextSettingsDigest: string;
  readonly harnessConfigDigest: string;
  readonly extraConfigDigest: string;
}

export interface MvpPiRuntimeMaterialization {
  readonly arm: EvaluationArm;
  readonly revision: string;
  readonly treeSha: string;
  readonly lockSha256: string;
  readonly archive: MvpHarborRuntimeArchive;
}

export interface MvpPiRuntimeSourcePort {
  materialize(input: {
    readonly arm: EvaluationArm;
    readonly revision: string;
    readonly championRevision: string;
    readonly expectedChangedFiles: readonly string[] | null;
  }): Promise<MvpPiRuntimeMaterialization>;
}

export interface MvpHarborExecutionPort {
  execute(
    plan: TrustedMvpHarborExecutionPlan,
  ): Promise<TrustedMvpHarborRequestedRawOutput>;
}

export interface MvpEvaluatorRuntimeDependencies {
  readonly source: MvpPiRuntimeSourcePort;
  readonly harbor: MvpHarborExecutionPort;
}

export interface MvpEvaluatorRuntimeFactoryInput {
  readonly stateRoot: string;
  readonly evaluatedDeployment: string;
  readonly modelFamily: "claude-opus-4-8";
  readonly reasoningEffort: "high";
  readonly foundryBaseUrl: string;
  readonly candidateProposal?: CandidateProposal;
  readonly dependencies?: MvpEvaluatorRuntimeDependencies;
}

export interface MvpEvaluatorRuntime {
  readonly environment: EvaluationEnvironment;
  readonly taskCatalog: MountedHiddenTaskCatalog;
  readonly evaluator: TrustedEvaluatorPort;
}

/**
 * Concrete trusted evaluator factory. It is deliberately unusable outside an
 * evaluator Daytona sandbox and reads hidden inventory only from the
 * evaluator's isolated mounted subpath.
 */
export async function createMvpEvaluatorRuntime(
  input: MvpEvaluatorRuntimeFactoryInput,
): Promise<MvpEvaluatorRuntime> {
  assertEvaluatorCloudRole();
  const pin = await loadRuntimePin(input.stateRoot);
  const isolatedTaskRevisions = pin.hiddenTaskDefinitions
    .filter(isSeparateVerifierAttested)
    .map((definition) => definition.revisionDigest);
  if (
    isolatedTaskRevisions.length < 5 ||
    !sameStringSet(
      isolatedTaskRevisions,
      pin.directSandboxEligibleTaskRevisionDigests,
    )
  ) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_TASK_ELIGIBILITY",
    );
  }
  const namespace = await loadOrCreateCatalogNamespace(input.stateRoot);
  const privateRoot = join(input.stateRoot, "private");
  const campaignStore = new MountedMvpCampaignStateStore(
    join(privateRoot, "campaign"),
  );
  const campaign = await campaignStore.initialize({
    campaignId: requiredEnvironment("DF_MVP_CAMPAIGN_ID"),
    frozenBaselineRevision: requiredEnvironment(
      "DF_PI_BASELINE_COMMIT",
    ),
    initializedAt: new Date().toISOString(),
  });
  const catalog = new MountedHiddenTaskCatalog(privateRoot, namespace);
  try {
    await catalog.initialize({
      datasetRevision: pin.datasetRevision,
      definitions: pin.hiddenTaskDefinitions,
    });
    await catalog.list();
  } catch {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_HIDDEN_CATALOG",
    );
  }

  const endpoint = foundryEndpoint(input.foundryBaseUrl);
  const configurationHash = requiredEnvironment(
    "DF_MVP_CONFIGURATION_HASH",
  );
  if (!SHA256.test(configurationHash)) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
  const runtimePinDigest = createHash("sha256")
    .update(canonicalJson(pin))
    .digest("hex");
  const fullEnvironmentExtraConfigDigest = createHash("sha256")
    .update(
      canonicalJson({
        configurationHash,
        declaredExtraConfigDigest: pin.extraConfigDigest,
        runtimePinDigest,
      }),
    )
    .digest("hex");
  if (
    input.modelFamily !== "claude-opus-4-8" ||
    input.reasoningEffort !== "high"
  ) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
  const environment: EvaluationEnvironment = {
    terminalBenchVersion: pin.terminalBenchVersion,
    datasetRevision: pin.datasetRevision,
    graderProtocolVersion: pin.graderProtocolVersion,
    evaluatorVersion: pin.evaluatorVersion,
    modelProvider: "microsoft-foundry",
    modelDeployment: input.evaluatedDeployment,
    reasoningEffort: "high",
    samplingSettingsDigest: pin.samplingSettingsDigest,
    contextSettingsDigest: pin.contextSettingsDigest,
    sandboxProvider: "daytona",
    sandboxRegion: "eu",
    imageDigest: pin.imageDigest,
    architecture: pin.architecture,
    resourcesDigest: pin.resourcesDigest,
    networkPolicyDigest: pin.networkPolicyDigest,
    harnessConfigDigest: pin.harnessConfigDigest,
    extraConfigDigest: fullEnvironmentExtraConfigDigest,
  };
  validateEvaluationEnvironment(environment);
  if (input.candidateProposal !== undefined) {
    validateCandidateProposal(input.candidateProposal);
  }

  let dependencies = input.dependencies;
  if (dependencies === undefined) {
    const nodeRuntime = await import(
      "./evaluator-runtime-node.js"
    );
    dependencies = await nodeRuntime.createNodeMvpEvaluatorDependencies({
      stateRoot: input.stateRoot,
      pin,
      repository: {
        owner: requiredEnvironment("DF_PI_GITHUB_OWNER"),
        name: requiredEnvironment("DF_PI_GITHUB_REPOSITORY"),
        baselineCommit: requiredEnvironment(
          "DF_PI_BASELINE_COMMIT",
        ),
        baselineTree: requiredEnvironment("DF_PI_BASELINE_TREE"),
        packageLockSha256: requiredEnvironment(
          "DF_PI_PACKAGE_LOCK_SHA256",
        ),
      },
      githubBasicAuthPlaceholder: requiredEnvironment(
        "DF_GITHUB_BASIC_AUTH",
      ),
      daytona: {
        apiKeyPlaceholder: requiredEnvironment("DAYTONA_API_KEY"),
        apiUrl: requiredEnvironment("DAYTONA_API_URL"),
        target: requiredEnvironment("DAYTONA_TARGET"),
      },
      adapterPath: pin.adapterPath,
      expectedCandidate:
        input.candidateProposal === undefined
          ? null
          : {
              revision:
                input.candidateProposal.candidateRevision,
              changedFiles:
                input.candidateProposal.changedFiles,
            },
    });
  }
  return {
    environment,
    taskCatalog: catalog,
    evaluator: new MvpTrustedBatchEvaluator({
      stateRoot: input.stateRoot,
      pin,
      catalog,
      environment,
      evaluatedDeployment: input.evaluatedDeployment,
      endpointHost: endpoint.hostname,
      championRevision: campaign.championRevision,
      evaluatedSecretSourceName: requiredEnvironment(
        "DF_EVALUATED_SECRET_SOURCE",
      ),
      source: dependencies.source,
      harbor: dependencies.harbor,
      expectedCandidateProposal:
        input.candidateProposal ?? null,
    }),
  };
}

export class MvpTrustedBatchEvaluator implements TrustedEvaluatorPort {
  readonly #plans = new Map<string, MvpHarborBuildInput>();

  public constructor(
    private readonly options: {
      readonly stateRoot: string;
      readonly pin: MvpEvaluatorRuntimePin;
      readonly catalog: MountedHiddenTaskCatalog;
      readonly environment: EvaluationEnvironment;
      readonly evaluatedDeployment: string;
      readonly endpointHost: string;
      readonly championRevision: string;
      readonly evaluatedSecretSourceName: string;
      readonly source: MvpPiRuntimeSourcePort;
      readonly harbor: MvpHarborExecutionPort;
      readonly expectedCandidateProposal: CandidateProposal | null;
    },
  ) {
    if (!SAFE_SECRET_NAME.test(options.evaluatedSecretSourceName)) {
      throw new MvpEvaluatorReadinessError(
        "MVP_EVALUATOR_RUNTIME_PIN",
      );
    }
  }

  public async evaluateBatch(
    requests: readonly PrivateEvaluationRequest[],
  ): Promise<readonly PrivateEvaluationObservation[]> {
    const batch = assertPrivateBatch(
      requests,
      this.options.environment,
    );
    let buildInput = this.#plans.get(batch.experimentId);
    if (batch.purpose === "screen") {
      buildInput = await this.#prepareScreen(batch.requests);
      this.#plans.set(batch.experimentId, buildInput);
      await writeJsonAtomic(
        join(
          this.options.stateRoot,
          "private",
          "plans",
          `${batch.experimentId}.json`,
        ),
        buildInput,
      );
    } else if (buildInput === undefined) {
      const restored = await readOptionalBoundedJson(
        join(
          this.options.stateRoot,
          "private",
          "plans",
          `${batch.experimentId}.json`,
        ),
      );
      if (restored === null) {
        throw new Error(
          "Promotion refresh has no sealed screening plan.",
        );
      }
      buildInput = restored as MvpHarborBuildInput;
      // Rebuilding below is the strict validator for the persisted object.
    }

    const executionPlan = buildTrustedMvpHarborExecutionPlan(
      buildInput,
      {
        purpose: batch.purpose,
        cells: batch.requests.map((request) => ({
          hiddenTaskId: request.cell.task.handle,
          arm: request.arm,
          replicateOrdinal: request.cell.repetition,
        })),
      },
    );
    assertTrustedMvpHarborExecutionPlan(executionPlan);
    const decoded = decodeTrustedMvpHarborRequestedOutput(
      executionPlan,
      await this.options.harbor.execute(executionPlan),
    );
    const requestsByIdentity = new Map(
      batch.requests.map((request) => [
        observationIdentity(
          request.cell.cellId,
          request.arm,
          request.cell.repetition,
        ),
        request,
      ]),
    );
    return [
      ...decoded.trustedMatrix.candidate,
      ...decoded.trustedMatrix.champion,
    ].map((trial) => {
      const request = requestsByIdentity.get(
        observationIdentity(
          trial.cellId,
          trial.arm,
          trial.replicateOrdinal,
        ),
      );
      if (request === undefined) {
        throw new Error(
          "Decoded Harbor output escaped its requested batch.",
        );
      }
      return {
        schemaVersion: MVP_SCHEMA_VERSION,
        experimentId: request.experimentId,
        cellId: request.cell.cellId,
        taskHandle: request.cell.task.handle,
        taskRevisionDigest: request.cell.task.revisionDigest,
        repetition: request.cell.repetition,
        arm: request.arm,
        harnessRevision: request.harnessRevision,
        environmentDigest: request.environmentDigest,
        source: "fresh",
        passed: trial.passed,
        reward: trial.reward,
        infrastructureValid: trial.infrastructureValid,
        durationMs: trial.durationMs,
        evaluatedAt: trial.evaluatedAt,
        traceArtifactRefs: trial.traceArtifactRefs,
        rawDiagnostics: trial.rawDiagnostics,
      };
    });
  }

  async #prepareScreen(
    requests: readonly PrivateEvaluationRequest[],
  ): Promise<MvpHarborBuildInput> {
    const uniqueCells = uniqueHiddenCells(requests);
    const resolved =
      await this.options.catalog.resolveSelectedCells(uniqueCells);
    const eligible = new Set(
      this.options.pin.directSandboxEligibleTaskRevisionDigests,
    );
    if (
      resolved.some(
        (cell) => !eligible.has(cell.taskRevisionDigest),
      )
    ) {
      throw new MvpEvaluatorReadinessError(
        "MVP_EVALUATOR_TASK_ELIGIBILITY",
      );
    }
    const candidateRevision = singleRevision(
      requests,
      "candidate",
    );
    const requestedChampionRevision = optionalSingleRevision(
      requests,
      "champion",
    );
    const championRevision = this.options.championRevision;
    if (
      requestedChampionRevision !== null &&
      requestedChampionRevision !== championRevision
    ) {
      throw new Error(
        "Champion requests disagree with trusted campaign state.",
      );
    }
    if (candidateRevision === championRevision) {
      throw new Error("Candidate and champion revisions must differ.");
    }
    if (
      this.options.expectedCandidateProposal === null ||
      this.options.expectedCandidateProposal.candidateRevision !==
        candidateRevision
    ) {
      throw new Error(
        "Candidate revision is not bound to its trusted proposal.",
      );
    }
    // Source-controlled build/test code is never concurrent with a
    // credentialed Git fetch for the other arm.
    const champion = await this.options.source.materialize({
      arm: "champion",
      revision: championRevision,
      championRevision,
      expectedChangedFiles: null,
    });
    const candidate = await this.options.source.materialize({
      arm: "candidate",
      revision: candidateRevision,
      championRevision,
      expectedChangedFiles:
        this.options.expectedCandidateProposal.changedFiles,
    });
    const adapter = await artifactForFile(
      this.options.pin.adapterPath,
      this.options.pin.adapterSha256,
      "text/x-python",
      "trusted://mvp-private/dark-factory-pi",
    );
    const first = requests[0];
    if (first === undefined) {
      throw new Error("The screen batch is empty.");
    }
    return {
      experimentId: first.experimentId,
      experimentNumber: Number(first.experimentId.split("-", 1)[0]),
      environmentDigest: first.environmentDigest,
      datasetName: this.options.pin.datasetName,
      datasetRef: this.options.pin.datasetRef,
      jobsDirectory: join(
        this.options.stateRoot,
        "private",
        "harbor-jobs",
        first.experimentId,
      ),
      environmentType: "daytona",
      evaluatedSecretSourceName:
        this.options.evaluatedSecretSourceName,
      tasks: taskBindings(resolved),
      candidateRuntime: candidate.archive,
      championRuntime: champion.archive,
      adapter: {
        artifact: adapter,
        remotePath: this.options.pin.adapterPath,
        importPath: "dark_factory_pi:DarkFactoryPi",
      },
      model: {
        provider: "microsoft-foundry",
        deployment: this.options.evaluatedDeployment,
        modelFamily: "claude-opus-4-8",
        endpointHost: this.options.endpointHost,
        reasoningEffort: "high",
        credentialEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
      },
      piEntrypoint: this.options.pin.piEntrypoint,
      enabledTools: this.options.pin.enabledTools,
      timeoutSeconds: this.options.pin.timeoutSeconds,
    };
  }
}

interface ValidatedBatch {
  readonly experimentId: string;
  readonly purpose: "screen" | "promotion-refresh";
  readonly requests: readonly PrivateEvaluationRequest[];
}

function assertPrivateBatch(
  requests: readonly PrivateEvaluationRequest[],
  environment: EvaluationEnvironment,
): ValidatedBatch {
  if (requests.length < 1 || requests.length > 30) {
    throw new Error("A trusted batch must contain one to thirty cells.");
  }
  const experimentId = requests[0]?.experimentId;
  const environmentDigest = evaluationEnvironmentDigest(environment);
  const identities = new Set<string>();
  for (const request of requests) {
    const identity = observationIdentity(
      request.cell.cellId,
      request.arm,
      request.cell.repetition,
    );
    if (
      request.schemaVersion !== MVP_SCHEMA_VERSION ||
      request.experimentId !== experimentId ||
      request.environmentDigest !== environmentDigest ||
      JSON.stringify(request.environment) !==
        JSON.stringify(environment) ||
      !REVISION.test(request.harnessRevision) ||
      !SHA256.test(request.cell.cellId) ||
      identities.has(identity)
    ) {
      throw new Error("A trusted evaluation batch is not canonical.");
    }
    identities.add(identity);
  }
  const candidateCount = requests.filter(
    (request) => request.arm === "candidate",
  ).length;
  const purpose =
    candidateCount === 15 ? "screen" : "promotion-refresh";
  if (
    (purpose === "screen" &&
      new Set(
        requests
          .filter((request) => request.arm === "candidate")
          .map((request) => request.cell.cellId),
      ).size !== 15) ||
    (purpose === "promotion-refresh" &&
      requests.some((request) => request.arm !== "champion"))
  ) {
    throw new Error("The evaluator batch violates cache-aware staging.");
  }
  return {
    experimentId: experimentId ?? "",
    purpose,
    requests,
  };
}

function uniqueHiddenCells(
  requests: readonly PrivateEvaluationRequest[],
): readonly HiddenEvaluationCell[] {
  const cells = new Map<string, HiddenEvaluationCell>();
  for (const request of requests) {
    const existing = cells.get(request.cell.cellId);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(request.cell)
    ) {
      throw new Error("A cell ID maps to conflicting hidden cells.");
    }
    cells.set(request.cell.cellId, request.cell);
  }
  return [...cells.values()];
}

function taskBindings(
  resolved: readonly ResolvedHarborEvaluationCell[],
): readonly TrustedMvpHarborTaskBinding[] {
  const grouped = new Map<
    string,
    ResolvedHarborEvaluationCell[]
  >();
  for (const cell of resolved) {
    const list = grouped.get(cell.taskHandle) ?? [];
    list.push(cell);
    grouped.set(cell.taskHandle, list);
  }
  if (grouped.size !== 5) {
    throw new Error("A screen must resolve exactly five hidden tasks.");
  }
  return [...grouped.values()].map((cells) => {
    cells.sort((left, right) => left.repetition - right.repetition);
    const first = cells[0];
    if (
      first === undefined ||
      cells.length !== 3 ||
      cells.some(
        (cell, index) =>
          cell.repetition !== index + 1 ||
          cell.taskRevisionDigest !== first.taskRevisionDigest ||
          cell.harborTaskLocator !== first.harborTaskLocator,
      ) ||
      !SAFE_TASK_NAME.test(first.harborTaskLocator)
    ) {
      throw new Error(
        "A hidden task does not have three sealed replicates.",
      );
    }
    return {
      sensitivity: "trusted-hidden-mvp-task",
      hiddenTaskId: first.taskHandle,
      taskRevisionDigest: first.taskRevisionDigest,
      harborTaskName: first.harborTaskLocator,
      cellIds: [
        cells[0]!.cellId,
        cells[1]!.cellId,
        cells[2]!.cellId,
      ],
    };
  });
}

function singleRevision(
  requests: readonly PrivateEvaluationRequest[],
  arm: EvaluationArm,
): string {
  const revisions = new Set(
    requests
      .filter((request) => request.arm === arm)
      .map((request) => request.harnessRevision),
  );
  if (revisions.size !== 1) {
    throw new Error(`The ${arm} arm must have one exact revision.`);
  }
  return [...revisions][0]!;
}

function optionalSingleRevision(
  requests: readonly PrivateEvaluationRequest[],
  arm: EvaluationArm,
): string | null {
  const matching = requests.filter(
    (request) => request.arm === arm,
  );
  return matching.length === 0
    ? null
    : singleRevision(matching, arm);
}

function observationIdentity(
  cellId: string,
  arm: EvaluationArm,
  repetition: number,
): string {
  return `${cellId}|${arm}|${repetition}`;
}

async function loadRuntimePin(
  stateRoot: string,
): Promise<MvpEvaluatorRuntimePin> {
  try {
    const value = await readBoundedJson(
      join(stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH),
    );
    assertRuntimePin(value);
    return value;
  } catch {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
}

function assertRuntimePin(
  value: unknown,
): asserts value is MvpEvaluatorRuntimePin {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Runtime pin is not an object.");
  }
  const pin = value as Partial<MvpEvaluatorRuntimePin>;
  const expectedKeys = [
    "schemaVersion",
    "domain",
    "harborVersion",
    "terminalBenchVersion",
    "datasetName",
    "datasetRef",
    "datasetRevision",
    "datasetContentSha256",
    "graderProtocolVersion",
    "evaluatorVersion",
    "harborExecutable",
    "harborExecutableSha256",
    "bunExecutable",
    "bunExecutableSha256",
    "adapterPath",
    "adapterSha256",
    "piEntrypoint",
    "enabledTools",
    "timeoutSeconds",
    "directSandboxEligibleTaskRevisionDigests",
    "hiddenTaskDefinitions",
    "imageDigest",
    "architecture",
    "runtimeAbi",
    "resourcesDigest",
    "networkPolicyDigest",
    "samplingSettingsDigest",
    "contextSettingsDigest",
    "harnessConfigDigest",
    "extraConfigDigest",
  ];
  if (
    Object.keys(value as object).length !== expectedKeys.length ||
    Object.keys(value as object).some(
      (key) => !expectedKeys.includes(key),
    ) ||
    pin.schemaVersion !== 1 ||
    pin.domain !== "dark-factory.mvp-evaluator-runtime-pin.v1" ||
    pin.harborVersion !== MVP_HARBOR_VERSION ||
    typeof pin.terminalBenchVersion !== "string" ||
    typeof pin.datasetName !== "string" ||
    typeof pin.datasetRef !== "string" ||
    typeof pin.datasetRevision !== "string" ||
    !SHA256.test(pin.datasetContentSha256 ?? "") ||
    typeof pin.graderProtocolVersion !== "string" ||
    typeof pin.evaluatorVersion !== "string" ||
    typeof pin.harborExecutable !== "string" ||
    !pin.harborExecutable.startsWith("/") ||
    pin.harborExecutable.includes("/../") ||
    !SHA256.test(pin.harborExecutableSha256 ?? "") ||
    typeof pin.bunExecutable !== "string" ||
    !pin.bunExecutable.startsWith("/") ||
    pin.bunExecutable.includes("/../") ||
    !SHA256.test(pin.bunExecutableSha256 ?? "") ||
    typeof pin.adapterPath !== "string" ||
    !pin.adapterPath.startsWith("/") ||
    pin.adapterPath.includes("/../") ||
    !SHA256.test(pin.adapterSha256 ?? "") ||
    typeof pin.piEntrypoint !== "string" ||
    !SAFE_RELATIVE_PATH.test(pin.piEntrypoint) ||
    pin.piEntrypoint !== "packages/coding-agent/dist/pi" ||
    !Array.isArray(pin.enabledTools) ||
    pin.enabledTools.length < 1 ||
    pin.enabledTools.length > 32 ||
    !Number.isSafeInteger(pin.timeoutSeconds) ||
    (pin.timeoutSeconds ?? 0) < 60 ||
    !Array.isArray(pin.directSandboxEligibleTaskRevisionDigests) ||
    pin.directSandboxEligibleTaskRevisionDigests.length < 5 ||
    pin.directSandboxEligibleTaskRevisionDigests.some(
      (digest) => !SHA256.test(digest),
    ) ||
    !Array.isArray(pin.hiddenTaskDefinitions) ||
    pin.hiddenTaskDefinitions.length < 5 ||
    new Set(pin.hiddenTaskDefinitions.map((item) => item.revisionDigest))
        .size !== pin.hiddenTaskDefinitions.length ||
    new Set(pin.directSandboxEligibleTaskRevisionDigests).size !==
      pin.directSandboxEligibleTaskRevisionDigests.length ||
    pin.hiddenTaskDefinitions.length !==
      pin.directSandboxEligibleTaskRevisionDigests.length ||
    pin.hiddenTaskDefinitions.some(
      (definition) =>
        !pin.directSandboxEligibleTaskRevisionDigests?.includes(
          definition.revisionDigest,
        ),
    ) ||
    !SHA256.test(pin.imageDigest ?? "") ||
    pin.architecture !== "x86_64" ||
    pin.runtimeAbi !== "linux-x64-glibc" ||
    [
      pin.resourcesDigest,
      pin.networkPolicyDigest,
      pin.samplingSettingsDigest,
      pin.contextSettingsDigest,
      pin.harnessConfigDigest,
      pin.extraConfigDigest,
    ].some((digest) => !SHA256.test(digest ?? ""))
  ) {
    throw new Error("Runtime pin is incomplete.");
  }
}

function isSeparateVerifierAttested(
  definition: TrustedHarborTaskDefinition,
): boolean {
  const attestation = (
    definition as Partial<TrustedHarborTaskDefinition>
  ).graderIsolation;
  return (
    attestation !== undefined &&
    attestation.verifierEnvironmentMode === "separate" &&
    attestation.allStepVerifierEnvironmentModesSeparate === true &&
    SHA256.test(attestation.sourceDigest)
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    JSON.stringify([...left].sort()) ===
      JSON.stringify([...right].sort())
  );
}

async function loadOrCreateCatalogNamespace(
  stateRoot: string,
): Promise<string> {
  const path = join(
    stateRoot,
    MVP_EVALUATOR_CATALOG_NAMESPACE_PATH,
  );
  return withMountedLock(
    join(stateRoot, "private"),
    "catalog-namespace",
    async () => {
      const existing = await readOptionalBoundedJson(path, 2_048);
      if (
        existing !== null &&
        typeof existing === "object" &&
        !Array.isArray(existing) &&
        Object.getPrototypeOf(existing) === Object.prototype
      ) {
        const record = existing as Readonly<Record<string, unknown>>;
        const namespace = record["namespace"];
        if (
          Object.keys(record).length === 3 &&
          record["schemaVersion"] === 1 &&
          record["domain"] ===
            "dark-factory.mvp-catalog-namespace.v1" &&
          typeof namespace === "string" &&
          /^[a-f0-9]{64}$/u.test(namespace)
        ) {
          return namespace;
        }
        throw new Error("Catalog namespace state is invalid.");
      }
      const namespace = randomBytes(32).toString("hex");
      await writeJsonAtomic(path, {
        schemaVersion: 1,
        domain: "dark-factory.mvp-catalog-namespace.v1",
        namespace,
      });
      return namespace;
    },
  );
}

async function artifactForFile(
  path: string,
  expectedSha256: string,
  mediaType: string,
  uri: TrustedCloudArtifactRef["uri"],
): Promise<TrustedCloudArtifactRef> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1) {
      throw new Error("Pinned artifact is unavailable.");
    }
    const bytes = await handle.readFile();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== expectedSha256) {
      throw new Error("Pinned artifact digest changed.");
    }
    return { uri, sha256, mediaType, byteLength: bytes.byteLength };
  } finally {
    await handle.close();
  }
}

function foundryEndpoint(value: string): URL {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    !endpoint.hostname.endsWith(".services.ai.azure.com") ||
    endpoint.pathname.replace(/\/+$/u, "") !== "/anthropic"
  ) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
  return endpoint;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
  return value;
}

function assertEvaluatorCloudRole(): void {
  if (
    process.platform !== "linux" ||
    process.env["DF_CLOUD_EXECUTION"] !== "1" ||
    process.env["DF_MVP_ROLE"] !== "evaluator" ||
    process.env["DAYTONA_SANDBOX_ID"] === undefined
  ) {
    throw new MvpEvaluatorReadinessError(
      "MVP_EVALUATOR_RUNTIME_PIN",
    );
  }
}
