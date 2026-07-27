import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { initializeLocalRealOptimization, readLocalFoundryCredentials } from "../real/config.js";
import {
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealActiveExperiment,
  type LocalRealArmReceipt,
  type LocalRealCandidateReceipt,
  type LocalRealDecision,
  type LocalRealOptimizerReceipt,
  type LocalRealPanelAttempt,
} from "../real/contracts.js";
import {
  inspectLocalRealRunnerLock,
  listLocalRealExperimentIds,
  loadLocalRealCampaign,
  readLocalRealStopRequest,
} from "../real/state.js";
import type {
  DashboardArmDetail,
  DashboardArtifactCategory,
  DashboardArtifactChunk,
  DashboardArtifactDescriptor,
  DashboardCampaignDetail,
  DashboardCampaignEventSnapshot,
  DashboardCampaignSummary,
  DashboardCreateCampaignInput,
  DashboardExperimentDetail,
  DashboardExperimentPage,
  DashboardExperimentSummary,
  DashboardHarborProgress,
  DashboardHarborTrialProgress,
  DashboardOptimizerAudit,
  DashboardOptimizerAuditAttempt,
  DashboardOptimizerDetail,
  DashboardOptimizerEnvironmentEntry,
  DashboardOptimizerExecutionContract,
  DashboardOptimizerSourceContext,
  DashboardPanelAttemptDetail,
  DashboardPerformancePoint,
  DashboardPublicationDetail,
  DashboardTaskLogChunk,
  DashboardTaskLogDescriptor,
  DashboardTaskLogIndex,
  DashboardTaskLogSource,
  DashboardValidationCommand,
} from "./contracts.js";

const SAFE_CAMPAIGN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const MAXIMUM_ARTIFACT_CHUNK_BYTES = 256 * 1024;
const MAXIMUM_EXPERIMENT_JSON_BYTES = 32 * 1024 * 1024;
const MAXIMUM_ARTIFACT_FILES = 2_000;
const MAXIMUM_HARBOR_TRIALS = 200;
const SAFE_HARBOR_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const TASK_LOG_SOURCES: readonly {
  readonly source: Exclude<DashboardTaskLogSource, "job">;
  readonly path: readonly string[];
  readonly label: string;
  readonly contentType: DashboardTaskLogDescriptor["contentType"];
}[] = [
  {
    source: "agent",
    path: ["agent", "dark-factory-pi.jsonl"],
    label: "Pi verbose events",
    contentType: "application/jsonl",
  },
  {
    source: "trial",
    path: ["trial.log"],
    label: "Harbor trial lifecycle",
    contentType: "text/plain",
  },
  {
    source: "trajectory",
    path: ["agent", "trajectory.json"],
    label: "Agent trajectory",
    contentType: "application/json",
  },
  {
    source: "verifier",
    path: ["verifier", "test-stdout.txt"],
    label: "Verifier output",
    contentType: "text/plain",
  },
  {
    source: "reward",
    path: ["verifier", "reward.txt"],
    label: "Verifier reward",
    contentType: "text/plain",
  },
  {
    source: "exception",
    path: ["exception.txt"],
    label: "Trial exception",
    contentType: "text/plain",
  },
];

interface DashboardHarborConfiguration {
  readonly jobName: string;
  readonly arm: "champion" | "candidate";
  readonly panelAttempt: number;
  readonly updatedAt: Date;
  readonly taskNames: readonly string[];
  readonly attempts: number;
}

interface DashboardTaskLogEntry {
  readonly descriptor: DashboardTaskLogDescriptor;
  readonly path: string;
}

interface DashboardTaskLogContext {
  readonly index: DashboardTaskLogIndex;
  readonly entries: readonly DashboardTaskLogEntry[];
}

export async function listDashboardCampaigns(
  stateRoot: string,
): Promise<readonly DashboardCampaignSummary[]> {
  const root = join(resolveStateRoot(stateRoot), "real", "campaigns");
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const campaigns: DashboardCampaignSummary[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SAFE_CAMPAIGN_ID.test(entry.name)) continue;
    try {
      campaigns.push(await getDashboardCampaignSummary(stateRoot, entry.name));
    } catch {
      // A partial or corrupt directory is not a campaign. The initialization
      // flow can safely recover valid partial campaigns.
    }
  }
  return campaigns.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getDashboardCampaign(
  stateRoot: string,
  campaignId: string,
): Promise<DashboardCampaignDetail> {
  const loaded = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  const [summary, harborProgress] = await Promise.all([
    campaignSummary(loaded),
    loaded.state.activeExperiment === null
      ? null
      : loadHarborProgress(
          loaded.paths.root,
          join(loaded.paths.experiments, loaded.state.activeExperiment.experimentId),
        ),
  ]);
  return {
    ...summary,
    configuration: {
      piOrigin: loaded.config.piOrigin,
      optimizerDeployment: loaded.config.optimizer.deployment,
      evaluatedDeployment: loaded.config.evaluatedAgent.deployment,
      optimizerMaximumCostUsd: loaded.config.optimizer.maximumCostUsd,
      optimizerMaximumTurns: loaded.config.optimizer.maximumTurns,
      maximumPanelAttempts: loaded.config.evaluation.maximumPanelAttempts,
      evaluationConcurrency: loaded.config.evaluation.concurrency,
      publicationEnabled: loaded.config.publication.enabled,
      publicationRemote: loaded.config.publication.remoteName,
      explicitlyUnbounded: loaded.config.budget.explicitlyUnbounded,
    },
    taskHealth: loaded.catalog.tasks.map((task) => ({
      name: task.name,
      difficulty: task.difficulty,
      empiricalFailureRate: task.empiricalFailureRate,
      selections: task.selections,
    })),
    harborProgress,
  };
}

export async function createDashboardCampaign(
  input: DashboardCreateCampaignInput,
): Promise<DashboardCampaignDetail> {
  const stateRoot = resolveStateRoot(input.stateRoot);
  const workspace = resolve(stateRoot, "..", "..");
  await initializeLocalRealOptimization({
    stateRoot,
    campaignId: input.campaignId,
    piRepository: input.piRepository ?? resolve(workspace, "..", "df-pi-tbench"),
    credentialsFile: input.credentialsFile ?? join(stateRoot, "config", "foundry.env"),
    claudeExecutable:
      input.claudeExecutable ??
      join(stateRoot, "tools", "claude", "node_modules", ".bin", "claude"),
    ...(input.budget.type === "capped"
      ? { maximumCampaignCostUsd: input.budget.maximumUsd }
      : { allowUnboundedCost: true }),
  });
  return getDashboardCampaign(stateRoot, input.campaignId);
}

export async function getDashboardCampaignSummary(
  stateRoot: string,
  campaignId: string,
): Promise<DashboardCampaignSummary> {
  const loaded = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  return campaignSummary(loaded);
}

export async function listDashboardExperiments(
  stateRoot: string,
  campaignId: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<DashboardExperimentPage> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("Experiment page limit must be between 1 and 200");
  }
  const all = [...(await listLocalRealExperimentIds(campaign.paths))].sort().reverse();
  const start =
    options.cursor === undefined
      ? 0
      : Math.max(0, all.findIndex((experimentId) => experimentId === options.cursor) + 1);
  const selected = all.slice(start, start + limit);
  const items = await Promise.all(
    selected.map((experimentId) =>
      experimentSummary(campaign.paths.experiments, experimentId, campaign.state.activeExperiment),
    ),
  );
  return {
    items,
    nextCursor: start + limit < all.length ? (selected.at(-1) ?? null) : null,
  };
}

export async function getDashboardExperiment(
  stateRoot: string,
  campaignId: string,
  experimentId: string,
): Promise<DashboardExperimentDetail> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  const summary = await experimentSummary(
    campaign.paths.experiments,
    experimentId,
    campaign.state.activeExperiment,
  );
  const directory = join(campaign.paths.experiments, experimentId);
  const [
    optimizer,
    candidate,
    decision,
    publication,
    accepted,
    receipt,
    artifacts,
    harborProgress,
  ] = await Promise.all([
    readJson<LocalRealOptimizerReceipt>(join(directory, "optimizer", "receipt.json")),
    readJson<LocalRealCandidateReceipt>(join(directory, "candidate", "receipt.json")),
    readJson<LocalRealDecision>(join(directory, "decision.json")),
    readJson<{
      readonly commit?: string;
      readonly status?: string;
      readonly experimentRef?: string;
      readonly championRef?: string;
    }>(join(directory, "publication.json")),
    readJson<{ readonly attempt?: LocalRealPanelAttempt }>(
      join(directory, "panel", "accepted.json"),
    ),
    readJson<Record<string, unknown>>(join(directory, "receipt.json")),
    listDashboardArtifacts(stateRoot, campaignId, experimentId),
    loadHarborProgress(campaign.paths.root, directory),
  ]);
  const panelAttempts = (await loadPanelAttempts(directory)).map(projectPanelAttempt);
  const artifactByLabel = new Map(artifacts.map((artifact) => [artifact.label, artifact.id]));
  const optimizerAudit = await loadOptimizerAudit({
    directory,
    repositoryOrigin: campaign.config.piOrigin,
    artifactByLabel,
    optimizerPhaseActive:
      campaign.state.activeExperiment?.experimentId === experimentId &&
      campaign.state.activeExperiment.phase === "optimizer",
  });
  const projectedCandidate =
    candidate === null ? null : projectCandidate(candidate, artifactByLabel);
  return {
    ...summary,
    panelAttempts,
    optimizer: optimizer === null ? null : projectOptimizer(optimizer),
    optimizerAudit,
    candidate: projectedCandidate,
    championEvaluation:
      accepted?.attempt?.champion === undefined ? null : projectArm(accepted.attempt.champion),
    candidateEvaluation: projectOptionalArm(receipt?.["candidateEvaluation"]),
    harborProgress,
    decision,
    publication: projectPublication(publication),
    validationCommands: projectedCandidate?.validationCommands ?? [],
    artifacts,
  };
}

export async function getDashboardPerformance(
  stateRoot: string,
  campaignId: string,
): Promise<readonly DashboardPerformancePoint[]> {
  const experiments: DashboardExperimentSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await listDashboardExperiments(stateRoot, campaignId, {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    experiments.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  let cumulativeCostUsd = 0;
  return experiments
    .sort((left, right) => left.experimentNumber - right.experimentNumber)
    .map((experiment) => {
      cumulativeCostUsd += experiment.costUsd ?? 0;
      return {
        experimentId: experiment.experimentId,
        experimentNumber: experiment.experimentNumber,
        completedAt: experiment.completedAt,
        durationMs: experiment.durationMs,
        panelDigest: experiment.panelDigest,
        championMeanReward: experiment.championMeanReward,
        candidateMeanReward: experiment.candidateMeanReward,
        meanRewardDelta: experiment.meanRewardDelta,
        promoted: experiment.disposition === "promote",
        costUsd: experiment.costUsd,
        cumulativeCostUsd: rounded(cumulativeCostUsd),
        confidenceCandidateBetter: experiment.confidenceCandidateBetter,
      };
    });
}

export async function listDashboardArtifacts(
  stateRoot: string,
  campaignId: string,
  experimentId: string,
): Promise<readonly DashboardArtifactDescriptor[]> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  const experimentDirectory = join(campaign.paths.experiments, experimentId);
  await assertContainedDirectory(campaign.paths.experiments, experimentDirectory);
  const files = await walkArtifactFiles(experimentDirectory);
  const descriptors: DashboardArtifactDescriptor[] = [];
  for (const path of files) {
    const artifact = await describeArtifact(experimentDirectory, path);
    if (artifact !== null) descriptors.push(artifact);
  }
  return descriptors.sort((left, right) => left.label.localeCompare(right.label));
}

export async function readDashboardArtifactChunk(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly experimentId: string;
  readonly artifactId: string;
  readonly offset?: number;
  readonly limit?: number;
}): Promise<DashboardArtifactChunk> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(input.stateRoot), input.campaignId);
  const experimentDirectory = join(campaign.paths.experiments, input.experimentId);
  await assertContainedDirectory(campaign.paths.experiments, experimentDirectory);
  const files = await walkArtifactFiles(experimentDirectory);
  let selected: string | null = null;
  for (const path of files) {
    const relativePath = relative(experimentDirectory, path);
    if (artifactId(relativePath) === input.artifactId && isAllowedArtifact(relativePath)) {
      selected = path;
      break;
    }
  }
  if (selected === null) throw new Error("Dashboard artifact was not found");
  await assertContainedRegularFile(experimentDirectory, selected);
  const information = await stat(selected);
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 64 * 1024;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > information.size ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_ARTIFACT_CHUNK_BYTES
  ) {
    throw new Error("Dashboard artifact range is invalid");
  }
  const requested = Math.min(limit, information.size - offset);
  const handle = await open(selected, "r");
  try {
    const buffer = Buffer.alloc(requested + 4);
    const { bytesRead } = await handle.read(buffer, 0, requested + 4, offset);
    let safeBytes = Math.min(bytesRead, requested);
    while (
      safeBytes > 0 &&
      safeBytes < bytesRead &&
      (buffer[safeBytes] as number) >= 0x80 &&
      (buffer[safeBytes] as number) < 0xc0
    ) {
      safeBytes -= 1;
    }
    const content = buffer.subarray(0, safeBytes).toString("utf8");
    const nextOffset = offset + safeBytes;
    return {
      id: input.artifactId,
      offset,
      nextOffset,
      eof: nextOffset >= information.size,
      encoding: "utf8",
      content,
    };
  } finally {
    await handle.close();
  }
}

export async function listDashboardTaskLogs(
  stateRoot: string,
  campaignId: string,
): Promise<DashboardTaskLogIndex | null> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(stateRoot), campaignId);
  return (await discoverDashboardTaskLogContext(campaign))?.index ?? null;
}

export async function readDashboardTaskLogChunk(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly logId: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly tail?: boolean;
}): Promise<DashboardTaskLogChunk> {
  const campaign = await loadLocalRealCampaign(resolveStateRoot(input.stateRoot), input.campaignId);
  const context = await discoverDashboardTaskLogContext(campaign);
  const selected = context?.entries.find((entry) => entry.descriptor.id === input.logId);
  if (selected === undefined) throw new Error("Dashboard task log was not found");
  await assertContainedRegularFile(campaign.paths.harbor, selected.path);
  const credentials = await readLocalFoundryCredentials(campaign.config.credentialsFile);
  return readCredentialRedactedTaskLogChunk({
    id: input.logId,
    path: selected.path,
    credential: credentials.apiKey,
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.tail === undefined ? {} : { tail: input.tail }),
  });
}

export async function dashboardCampaignEventSnapshot(
  stateRoot: string,
  campaignId: string,
): Promise<DashboardCampaignEventSnapshot> {
  const campaign = await getDashboardCampaignSummary(stateRoot, campaignId);
  const activeArtifacts =
    campaign.activeExperiment === null
      ? []
      : await listDashboardArtifacts(
          stateRoot,
          campaignId,
          campaign.activeExperiment.experimentId,
        ).catch(() => []);
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify({
          campaign,
          activeArtifacts: activeArtifacts.map((artifact) => [
            artifact.id,
            artifact.sizeBytes,
            artifact.updatedAt,
          ]),
        }),
      )
      .digest("hex"),
    campaign,
  };
}

async function campaignSummary(
  loaded: Awaited<ReturnType<typeof loadLocalRealCampaign>>,
): Promise<DashboardCampaignSummary> {
  const [lock, stop, launchStarting] = await Promise.all([
    inspectLocalRealRunnerLock(loaded.paths),
    readLocalRealStopRequest(loaded.paths),
    dashboardLaunchIsStarting(loaded.paths.root, loaded.state.campaignId),
  ]);
  const operationalStatus =
    stop !== null && lock.live
      ? "stopping"
      : lock.live
        ? "running"
        : launchStarting
          ? "starting"
          : loaded.state.status === "running" || loaded.state.status === "stop-requested"
            ? "interrupted"
            : loaded.state.status === "initialized"
              ? "ready"
              : loaded.state.status;
  const saturated = loaded.state.saturationHistory.filter(Boolean).length;
  return {
    campaignId: loaded.state.campaignId,
    createdAt: loaded.config.createdAt,
    operationalStatus,
    durableStatus: loaded.state.status,
    runnerLive: lock.live,
    stopRequested: stop !== null,
    stopMode: stop?.mode ?? null,
    activeExperiment: loaded.state.activeExperiment,
    championRevision: loaded.state.championRevision,
    baselineRevision: loaded.config.baselineRevision,
    completedExperiments: loaded.state.completedExperiments,
    promotions: loaded.state.promotions,
    totalCostUsd: loaded.state.totalCostUsd,
    maximumCampaignCostUsd: loaded.config.budget.maximumCampaignCostUsd,
    saturationRate:
      loaded.state.saturationHistory.length === 0
        ? 0
        : saturated / loaded.state.saturationHistory.length,
    taskCount: loaded.catalog.tasks.length,
    stopReason: loaded.state.stopReason,
    blockedReason: loaded.state.blockedReason,
    updatedAt: loaded.state.updatedAt,
  };
}

async function dashboardLaunchIsStarting(
  campaignRoot: string,
  campaignId: string,
): Promise<boolean> {
  const stateRoot = resolve(campaignRoot, "..", "..", "..");
  const launches = join(stateRoot, "dashboard", "launches");
  let entries: Dirent[];
  try {
    entries = await readdir(launches, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!entry.isDirectory()) continue;
    const launch = await readJson<Record<string, unknown>>(
      join(launches, entry.name, "launch.json"),
    );
    if (
      launch?.["campaignId"] !== campaignId ||
      !Number.isSafeInteger(launch["pid"]) ||
      typeof launch["startedAt"] !== "string" ||
      Date.now() - Date.parse(launch["startedAt"]) > 30_000
    ) {
      continue;
    }
    try {
      process.kill(launch["pid"] as number, 0);
      return true;
    } catch (error) {
      if (isNodeError(error, "EPERM")) return true;
      if (!isNodeError(error, "ESRCH")) throw error;
    }
  }
  return false;
}

async function experimentSummary(
  experimentsRoot: string,
  experimentId: string,
  activeExperiment: LocalRealActiveExperiment | null = null,
): Promise<DashboardExperimentSummary> {
  const directory = join(experimentsRoot, experimentId);
  await assertContainedDirectory(experimentsRoot, directory);
  const [experiment, receipt, optimizer, candidate, decision, accepted, publication] =
    await Promise.all([
      readJson<Record<string, unknown>>(join(directory, "experiment.json")),
      readJson<Record<string, unknown>>(join(directory, "receipt.json")),
      readJson<LocalRealOptimizerReceipt>(join(directory, "optimizer", "receipt.json")),
      readJson<LocalRealCandidateReceipt>(join(directory, "candidate", "receipt.json")),
      readJson<LocalRealDecision>(join(directory, "decision.json")),
      readJson<{ readonly panelDigest?: string }>(join(directory, "panel", "accepted.json")),
      readJson<{ readonly commit?: string }>(join(directory, "publication.json")),
    ]);
  const experimentNumber =
    typeof experiment?.["experimentNumber"] === "number"
      ? experiment["experimentNumber"]
      : Number.parseInt(experimentId.slice(0, 6), 10);
  const cost =
    typeof receipt?.["totalExperimentCostUsd"] === "number"
      ? receipt["totalExperimentCostUsd"]
      : null;
  const startedAt = typeof experiment?.["startedAt"] === "string" ? experiment["startedAt"] : null;
  const completedAt = typeof receipt?.["completedAt"] === "string" ? receipt["completedAt"] : null;
  const durationMs =
    startedAt === null || completedAt === null
      ? null
      : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return {
    experimentId,
    experimentNumber,
    championRevision:
      typeof experiment?.["championBefore"] === "string" ? experiment["championBefore"] : null,
    candidateRevision: candidate?.tree ?? null,
    startedAt,
    completedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    phase:
      receipt !== null
        ? "completed"
        : activeExperiment?.experimentId === experimentId
          ? activeExperiment.phase
          : inferExperimentPhase(optimizer, candidate, decision),
    hypothesisSummary: optimizer?.hypothesisSummary ?? null,
    disposition: decision?.disposition ?? null,
    championMeanReward: decision?.championMeanReward ?? null,
    candidateMeanReward: decision?.candidateMeanReward ?? null,
    meanRewardDelta: decision?.meanRewardDelta ?? null,
    confidenceCandidateBetter: decision?.confidenceCandidateBetter ?? null,
    costUsd: cost,
    changedFiles: candidate?.changedFiles ?? [],
    panelDigest: accepted?.panelDigest ?? null,
    publicationCommit: publication?.commit ?? null,
  };
}

function inferExperimentPhase(
  optimizer: LocalRealOptimizerReceipt | null,
  candidate: LocalRealCandidateReceipt | null,
  decision: LocalRealDecision | null,
): DashboardExperimentSummary["phase"] {
  if (decision !== null) return "decision";
  if (candidate !== null) return candidate.valid ? "candidate-evaluation" : "candidate-validation";
  if (optimizer !== null) return "candidate-validation";
  return "panel-screening";
}

async function loadHarborProgress(
  campaignRoot: string,
  experimentDirectory: string,
): Promise<DashboardHarborProgress | null> {
  for (const configuration of await discoverHarborConfigurations(experimentDirectory)) {
    return projectHarborProgress(
      campaignRoot,
      configuration.jobName,
      configuration.arm,
      configuration.panelAttempt,
      configuration.updatedAt,
      configuration.taskNames,
      configuration.attempts,
    );
  }
  return null;
}

async function discoverHarborConfigurations(
  experimentDirectory: string,
): Promise<readonly DashboardHarborConfiguration[]> {
  const harborArtifacts = join(experimentDirectory, "harbor");
  let entries: Dirent[];
  try {
    entries = await readdir(harborArtifacts, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const configurations: {
    readonly path: string;
    readonly jobName: string;
    readonly arm: "champion" | "candidate";
    readonly panelAttempt: number;
    readonly updatedAt: Date;
  }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith("-config.json")) continue;
    const jobName = entry.name.slice(0, -"-config.json".length);
    const identity = /-(champion|candidate)-p(\d{2})$/u.exec(jobName);
    if (identity === null || !SAFE_HARBOR_NAME.test(jobName)) continue;
    const information = await lstat(join(harborArtifacts, entry.name));
    if (information.isSymbolicLink() || !information.isFile()) continue;
    const panelAttempt = Number.parseInt(identity[2] ?? "", 10);
    if (!Number.isSafeInteger(panelAttempt) || panelAttempt < 1) continue;
    configurations.push({
      path: join(harborArtifacts, entry.name),
      jobName,
      arm: identity[1] as "champion" | "candidate",
      panelAttempt,
      updatedAt: information.mtime,
    });
  }
  configurations.sort(
    (left, right) =>
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      right.jobName.localeCompare(left.jobName),
  );
  const discovered: DashboardHarborConfiguration[] = [];
  for (const configuration of configurations) {
    const value = await readLiveJson<Record<string, unknown>>(configuration.path);
    const parsed = harborConfiguration(value);
    if (
      parsed === null ||
      (typeof value?.["job_name"] === "string" && value["job_name"] !== configuration.jobName)
    ) {
      continue;
    }
    discovered.push({
      jobName: configuration.jobName,
      arm: configuration.arm,
      panelAttempt: configuration.panelAttempt,
      updatedAt: configuration.updatedAt,
      taskNames: parsed.taskNames,
      attempts: parsed.attempts,
    });
  }
  return discovered;
}

function harborConfiguration(
  value: Record<string, unknown> | null,
): { readonly taskNames: readonly string[]; readonly attempts: number } | null {
  if (value === null) return null;
  const attempts = nonnegativeInteger(value["n_attempts"]);
  const datasets = value["datasets"];
  if (attempts === null || attempts < 1 || !Array.isArray(datasets) || datasets.length !== 1) {
    return null;
  }
  const dataset = recordValue(datasets[0]);
  const names = dataset?.["task_names"];
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length * attempts > MAXIMUM_HARBOR_TRIALS
  ) {
    return null;
  }
  const taskNames: string[] = [];
  for (const name of names) {
    if (typeof name !== "string" || !SAFE_HARBOR_NAME.test(name) || taskNames.includes(name)) {
      return null;
    }
    taskNames.push(name);
  }
  return { taskNames, attempts };
}

async function discoverDashboardTaskLogContext(
  campaign: Awaited<ReturnType<typeof loadLocalRealCampaign>>,
): Promise<DashboardTaskLogContext | null> {
  const experimentIds = [...(await listLocalRealExperimentIds(campaign.paths))].sort();
  const experimentId =
    campaign.state.activeExperiment?.experimentId ?? experimentIds.at(-1) ?? null;
  if (experimentId === null) return null;
  const experimentDirectory = join(campaign.paths.experiments, experimentId);
  await assertContainedDirectory(campaign.paths.experiments, experimentDirectory);
  for (const configuration of await discoverHarborConfigurations(experimentDirectory)) {
    const progress = await projectHarborProgress(
      campaign.paths.root,
      configuration.jobName,
      configuration.arm,
      configuration.panelAttempt,
      configuration.updatedAt,
      configuration.taskNames,
      configuration.attempts,
    );
    const entries = await loadDashboardTaskLogEntries(
      campaign.paths.harbor,
      configuration.jobName,
      progress,
    );
    const newestLog = entries.reduce<Date | null>((newest, entry) => {
      const updated = new Date(entry.descriptor.updatedAt);
      return newest === null || updated > newest ? updated : newest;
    }, null);
    return {
      index: {
        experimentId,
        arm: progress.arm,
        panelAttempt: progress.panelAttempt,
        status: progress.status,
        updatedAt:
          newestLog !== null && newestLog.getTime() > Date.parse(progress.updatedAt)
            ? newestLog.toISOString()
            : progress.updatedAt,
        credentialValuesRedacted: true,
        logs: entries.map((entry) => entry.descriptor),
      },
      entries,
    };
  }
  return null;
}

async function loadDashboardTaskLogEntries(
  harborRoot: string,
  jobName: string,
  progress: DashboardHarborProgress,
): Promise<readonly DashboardTaskLogEntry[]> {
  const jobDirectory = join(harborRoot, jobName);
  try {
    await assertContainedDirectory(harborRoot, jobDirectory);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    return [];
  }
  const entries: DashboardTaskLogEntry[] = [];
  const jobLog = await describeDashboardTaskLog({
    harborRoot,
    jobName,
    trialName: null,
    taskName: null,
    status: progress.status,
    reward: null,
    source: "job",
    label: "Harbor job lifecycle",
    contentType: "text/plain",
    path: join(jobDirectory, "job.log"),
  });
  if (jobLog !== null) entries.push(jobLog);
  for (const trial of progress.trials) {
    if (trial.trialName === null) continue;
    const trialDirectory = join(jobDirectory, trial.trialName);
    try {
      await assertContainedDirectory(jobDirectory, trialDirectory);
    } catch {
      continue;
    }
    for (const source of TASK_LOG_SOURCES) {
      const entry = await describeDashboardTaskLog({
        harborRoot,
        jobName,
        trialName: trial.trialName,
        taskName: trial.taskName,
        status: trial.status,
        reward: trial.reward,
        source: source.source,
        label: source.label,
        contentType: source.contentType,
        path: join(trialDirectory, ...source.path),
      });
      if (entry !== null) entries.push(entry);
    }
  }
  return entries;
}

async function describeDashboardTaskLog(input: {
  readonly harborRoot: string;
  readonly jobName: string;
  readonly trialName: string | null;
  readonly taskName: string | null;
  readonly status: DashboardHarborTrialProgress["status"];
  readonly reward: number | null;
  readonly source: DashboardTaskLogSource;
  readonly label: string;
  readonly contentType: DashboardTaskLogDescriptor["contentType"];
  readonly path: string;
}): Promise<DashboardTaskLogEntry | null> {
  try {
    await assertContainedRegularFile(input.harborRoot, input.path);
    const information = await stat(input.path);
    return {
      descriptor: {
        id: taskLogId(input.jobName, input.trialName, input.source),
        taskName: input.taskName,
        trialName: input.trialName,
        status: input.status,
        reward: input.reward,
        source: input.source,
        label: input.label,
        contentType: input.contentType,
        sizeBytes: information.size,
        updatedAt: information.mtime.toISOString(),
      },
      path: input.path,
    };
  } catch {
    return null;
  }
}

function taskLogId(
  jobName: string,
  trialName: string | null,
  source: DashboardTaskLogSource,
): string {
  return createHash("sha256")
    .update(JSON.stringify([jobName, trialName, source]))
    .digest("base64url")
    .slice(0, 24);
}

async function readCredentialRedactedTaskLogChunk(input: {
  readonly id: string;
  readonly path: string;
  readonly credential: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly tail?: boolean;
}): Promise<DashboardTaskLogChunk> {
  const information = await stat(input.path);
  const limit = input.limit ?? 64 * 1024;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAXIMUM_ARTIFACT_CHUNK_BYTES ||
    (input.tail === true && input.offset !== undefined)
  ) {
    throw new Error("Dashboard task log range is invalid");
  }
  const offset =
    input.tail === true
      ? Math.max(0, information.size - limit)
      : input.offset === undefined
        ? 0
        : input.offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > information.size) {
    throw new Error("Dashboard task log range is invalid");
  }
  const credential = Buffer.from(input.credential, "utf8");
  if (credential.length === 0) {
    throw new Error("Dashboard task log redaction is unavailable");
  }
  const requested = Math.min(limit, information.size - offset);
  const overlap = Math.max(0, credential.length - 1);
  const scanStart = Math.max(0, offset - overlap);
  const scanEnd = Math.min(information.size, offset + requested + overlap);
  const handle = await open(input.path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, scanEnd - scanStart));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, scanStart);
    const scanned = buffer.subarray(0, bytesRead);
    maskCredentialBytes(scanned, credential);
    const requestedStart = Math.min(bytesRead, offset - scanStart);
    const requestedEnd = Math.min(bytesRead, requestedStart + requested);
    let safeStart = requestedStart;
    while (safeStart < requestedEnd && isUtf8ContinuationByte(scanned[safeStart] as number)) {
      safeStart += 1;
    }
    let safeEnd = requestedEnd;
    while (
      safeEnd > safeStart &&
      safeEnd < bytesRead &&
      isUtf8ContinuationByte(scanned[safeEnd] as number)
    ) {
      safeEnd -= 1;
    }
    const content = scanned.subarray(safeStart, safeEnd).toString("utf8");
    const returnedOffset = scanStart + safeStart;
    const nextOffset = scanStart + safeEnd;
    return {
      id: input.id,
      offset: returnedOffset,
      nextOffset,
      eof: nextOffset >= information.size,
      encoding: "utf8",
      content,
    };
  } finally {
    await handle.close();
  }
}

function maskCredentialBytes(bytes: Buffer, credential: Buffer): void {
  const marker = Buffer.from("[REDACTED]", "utf8");
  const replacement = Buffer.alloc(credential.length, 0x2a);
  marker.copy(replacement, 0, 0, Math.min(marker.length, replacement.length));
  let offset = 0;
  while (offset <= bytes.length - credential.length) {
    const found = bytes.indexOf(credential, offset);
    if (found < 0) break;
    replacement.copy(bytes, found);
    offset = found + credential.length;
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return value >= 0x80 && value < 0xc0;
}

async function projectHarborProgress(
  campaignRoot: string,
  jobName: string,
  arm: "champion" | "candidate",
  panelAttempt: number,
  configurationUpdatedAt: Date,
  taskNames: readonly string[],
  attempts: number,
): Promise<DashboardHarborProgress> {
  const jobDirectory = join(campaignRoot, "harbor", jobName);
  const jobResult = await readLiveJson<Record<string, unknown>>(join(jobDirectory, "result.json"));
  const jobStats = recordValue(jobResult?.["stats"]);
  const allowedTasks = new Set(taskNames);
  const trials = await loadHarborTrials(jobDirectory, allowedTasks);
  const knownPerTask = new Map<string, number>();
  for (const trial of trials) {
    knownPerTask.set(trial.taskName, (knownPerTask.get(trial.taskName) ?? 0) + 1);
  }
  for (const taskName of taskNames) {
    for (let index = knownPerTask.get(taskName) ?? 0; index < attempts; index += 1) {
      trials.push({
        taskName,
        trialName: null,
        status: "pending",
        reward: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        inputTokens: null,
        cacheTokens: null,
        outputTokens: null,
        costUsd: null,
      });
    }
  }
  const order = new Map(taskNames.map((taskName, index) => [taskName, index]));
  const statusOrder = new Map([
    ["running", 0],
    ["error", 1],
    ["cancelled", 2],
    ["completed", 3],
    ["pending", 4],
  ]);
  trials.sort(
    (left, right) =>
      (order.get(left.taskName) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.taskName) ?? Number.MAX_SAFE_INTEGER) ||
      (statusOrder.get(left.status) ?? 9) - (statusOrder.get(right.status) ?? 9) ||
      (left.trialName ?? "").localeCompare(right.trialName ?? ""),
  );

  const totalTrials = taskNames.length * attempts;
  const resultTrials = trials.filter(
    (trial) =>
      trial.status === "completed" || trial.status === "error" || trial.status === "cancelled",
  );
  const completedRows = trials.filter((trial) => trial.status === "completed").length;
  const runningRows = trials.filter((trial) => trial.status === "running").length;
  const erroredRows = trials.filter((trial) => trial.status === "error").length;
  const cancelledRows = trials.filter((trial) => trial.status === "cancelled").length;
  const terminalRows = completedRows + erroredRows + cancelledRows;
  // Harbor's aggregate result can lag behind (or be deliberately reconstructed from)
  // the individual trial results. Once every expected trial has a terminal result,
  // those files are the authoritative snapshot and stale running/pending counters must
  // not make a completed panel appear incomplete.
  const terminalSnapshotComplete = terminalRows === totalTrials;
  const completedTrials = terminalSnapshotComplete
    ? completedRows
    : (boundedCounter(jobStats?.["n_completed_trials"], totalTrials) ?? completedRows);
  const runningTrials = terminalSnapshotComplete
    ? 0
    : (boundedCounter(jobStats?.["n_running_trials"], totalTrials) ?? runningRows);
  const erroredTrials = terminalSnapshotComplete
    ? erroredRows
    : (boundedCounter(jobStats?.["n_errored_trials"], totalTrials) ?? erroredRows);
  const cancelledTrials = terminalSnapshotComplete
    ? cancelledRows
    : (boundedCounter(jobStats?.["n_cancelled_trials"], totalTrials) ?? cancelledRows);
  const reportedPending = terminalSnapshotComplete
    ? 0
    : boundedCounter(jobStats?.["n_pending_trials"], totalTrials);
  const pendingTrials =
    reportedPending ??
    Math.max(
      0,
      totalTrials - completedTrials - runningTrials - erroredTrials - cancelledTrials,
    );
  const startedAt = timestampValue(jobResult?.["started_at"]);
  const updatedAt =
    timestampValue(jobResult?.["updated_at"]) ?? configurationUpdatedAt.toISOString();
  const completedAt = timestampValue(jobResult?.["finished_at"]);
  const status =
    completedAt !== null
      ? erroredTrials > 0
        ? "error"
        : cancelledTrials > 0
          ? "cancelled"
          : "completed"
      : runningTrials > 0
        ? "running"
        : pendingTrials > 0
          ? "pending"
          : erroredTrials > 0
            ? "error"
            : completedTrials >= totalTrials
              ? "completed"
              : "pending";
  return {
    arm,
    panelAttempt,
    status,
    taskNames,
    totalTrials,
    completedTrials,
    runningTrials,
    pendingTrials,
    erroredTrials,
    cancelledTrials,
    inputTokens:
      nonnegativeNumberOrNull(jobStats?.["n_input_tokens"]) ??
      sumTrialMetric(resultTrials, "inputTokens"),
    cacheTokens:
      nonnegativeNumberOrNull(jobStats?.["n_cache_tokens"]) ??
      sumTrialMetric(resultTrials, "cacheTokens"),
    outputTokens:
      nonnegativeNumberOrNull(jobStats?.["n_output_tokens"]) ??
      sumTrialMetric(resultTrials, "outputTokens"),
    costUsd:
      nonnegativeNumberOrNull(jobStats?.["cost_usd"]) ?? sumTrialMetric(resultTrials, "costUsd"),
    startedAt,
    updatedAt,
    completedAt,
    trials,
  };
}

async function loadHarborTrials(
  jobDirectory: string,
  allowedTasks: ReadonlySet<string>,
): Promise<DashboardHarborTrialProgress[]> {
  let entries: Dirent[];
  try {
    const information = await lstat(jobDirectory);
    if (information.isSymbolicLink() || !information.isDirectory()) return [];
    entries = await readdir(jobDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const trials: DashboardHarborTrialProgress[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      trials.length >= MAXIMUM_HARBOR_TRIALS ||
      !entry.isDirectory() ||
      !SAFE_HARBOR_NAME.test(entry.name)
    ) {
      continue;
    }
    const directory = join(jobDirectory, entry.name);
    const [result, configuration] = await Promise.all([
      readLiveJson<Record<string, unknown>>(join(directory, "result.json")),
      readLiveJson<Record<string, unknown>>(join(directory, "config.json")),
    ]);
    const projected = projectHarborTrial(result, configuration, allowedTasks);
    if (projected !== null) trials.push(projected);
  }
  return trials;
}

function projectHarborTrial(
  result: Record<string, unknown> | null,
  configuration: Record<string, unknown> | null,
  allowedTasks: ReadonlySet<string>,
): DashboardHarborTrialProgress | null {
  const trialNameValue = result?.["trial_name"] ?? configuration?.["trial_name"];
  const trialName =
    typeof trialNameValue === "string" && SAFE_HARBOR_NAME.test(trialNameValue)
      ? trialNameValue
      : null;
  const resultTask = recordValue(result?.["task_id"])?.["name"] ?? result?.["task_name"];
  const configTask = recordValue(configuration?.["task"])?.["name"];
  const trialTask = trialName?.split("__", 1)[0];
  const taskName = normalizeHarborTaskName(resultTask ?? configTask ?? trialTask);
  if (taskName === null || !allowedTasks.has(taskName)) return null;
  const exception = recordValue(result?.["exception_info"]);
  const exceptionType = exception?.["exception_type"];
  const status =
    result === null
      ? "running"
      : exceptionType === "CancelledError"
        ? "cancelled"
        : exception !== null
          ? "error"
          : "completed";
  const rewards = recordValue(recordValue(result?.["verifier_result"])?.["rewards"]);
  const rewardValue = rewards?.["reward"];
  const reward =
    typeof rewardValue === "number" &&
    Number.isFinite(rewardValue) &&
    rewardValue >= 0 &&
    rewardValue <= 1
      ? rewardValue
      : null;
  const agent = recordValue(result?.["agent_result"]);
  const startedAt = timestampValue(result?.["started_at"]);
  const completedAt = timestampValue(result?.["finished_at"]);
  const durationMs =
    startedAt === null || completedAt === null
      ? null
      : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  return {
    taskName,
    trialName,
    status,
    reward,
    startedAt,
    completedAt,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    inputTokens: nonnegativeNumberOrNull(agent?.["n_input_tokens"]),
    cacheTokens: nonnegativeNumberOrNull(agent?.["n_cache_tokens"]),
    outputTokens: nonnegativeNumberOrNull(agent?.["n_output_tokens"]),
    costUsd: nonnegativeNumberOrNull(agent?.["cost_usd"]),
  };
}

function normalizeHarborTaskName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/^terminal-bench\//u, "");
  return SAFE_HARBOR_NAME.test(normalized) ? normalized : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedCounter(value: unknown, maximum: number): number | null {
  const number = nonnegativeInteger(value);
  return number !== null && number <= maximum ? number : null;
}

function nonnegativeNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampValue(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function sumTrialMetric(
  trials: readonly DashboardHarborTrialProgress[],
  key: "inputTokens" | "cacheTokens" | "outputTokens" | "costUsd",
): number | null {
  const values = trials.flatMap((trial) => {
    const value = trial[key];
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : rounded(values.reduce((total, value) => total + value, 0));
}

async function loadPanelAttempts(directory: string): Promise<readonly LocalRealPanelAttempt[]> {
  const panelDirectory = join(directory, "panel");
  let entries: Dirent[];
  try {
    entries = await readdir(panelDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const attempts: LocalRealPanelAttempt[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/^attempt-\d{3}\.json$/u.test(entry.name)) continue;
    const wrapper = await readJson<{ readonly attempt?: LocalRealPanelAttempt }>(
      join(panelDirectory, entry.name),
    );
    if (wrapper?.attempt !== undefined) attempts.push(wrapper.attempt);
  }
  return attempts;
}

async function loadOptimizerAudit(input: {
  readonly directory: string;
  readonly repositoryOrigin: string;
  readonly artifactByLabel: ReadonlyMap<string, string>;
  readonly optimizerPhaseActive: boolean;
}): Promise<DashboardOptimizerAudit> {
  const attemptsDirectory = join(input.directory, "optimizer", "attempts");
  let entries: Dirent[];
  try {
    entries = await readdir(attemptsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        latestAttemptOrdinal: null,
        credentialValuesRedacted: true,
        disclosureNotes: optimizerAuditDisclosureNotes(),
        attempts: [],
      };
    }
    throw error;
  }
  const attemptEntries = entries
    .filter((entry) => entry.isDirectory() && /^\d{3}$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const latestOrdinal =
    attemptEntries.length === 0 ? null : Number.parseInt(attemptEntries.at(-1)?.name ?? "", 10);
  const attempts: DashboardOptimizerAuditAttempt[] = [];
  for (const entry of attemptEntries) {
    const ordinal = Number.parseInt(entry.name, 10);
    const attemptDirectory = join(attemptsDirectory, entry.name);
    const [rawInput, invocation, receipt] = await Promise.all([
      readJson<Record<string, unknown>>(join(attemptDirectory, "input.json")),
      readJson<Record<string, unknown>>(join(attemptDirectory, "invocation.json")),
      readJson<Record<string, unknown>>(join(attemptDirectory, "receipt.json")),
    ]);
    if (rawInput === null && invocation === null) continue;
    const prompt = typeof rawInput?.["prompt"] === "string" ? rawInput["prompt"] : "";
    const championRevision =
      typeof rawInput?.["championRevision"] === "string"
        ? rawInput["championRevision"]
        : typeof invocation?.["championRevision"] === "string"
          ? invocation["championRevision"]
          : "";
    const labelPrefix = `optimizer${sep}attempts${sep}${entry.name}${sep}`;
    attempts.push({
      ordinal,
      status:
        receipt !== null
          ? "completed"
          : input.optimizerPhaseActive && ordinal === latestOrdinal
            ? "running"
            : "interrupted",
      startedAt: typeof invocation?.["startedAt"] === "string" ? invocation["startedAt"] : null,
      completedAt: typeof receipt?.["completedAt"] === "string" ? receipt["completedAt"] : null,
      championRevision,
      prompt,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      previousDecision: projectOptimizerPreviousDecision(rawInput?.["previousDecision"]),
      boundary: projectOptimizerBoundary(rawInput?.["boundary"]),
      executionContract: projectOptimizerExecutionContract(
        rawInput?.["executionContract"] ?? rawInput?.["execution"],
      ),
      sourceContext: projectOptimizerSourceContext({
        value: rawInput?.["sourceContext"],
        repositoryOrigin: input.repositoryOrigin,
        championRevision,
      }),
      environment: projectOptimizerEnvironment(
        rawInput?.["environment"] ?? rawInput?.["environmentVariables"],
      ),
      inputArtifactId: input.artifactByLabel.get(`${labelPrefix}input.json`) ?? null,
      invocationArtifactId: input.artifactByLabel.get(`${labelPrefix}invocation.json`) ?? null,
      transcriptArtifactId: input.artifactByLabel.get(`${labelPrefix}transcript.jsonl`) ?? null,
      stderrArtifactId: input.artifactByLabel.get(`${labelPrefix}stderr.log`) ?? null,
    });
  }
  return {
    latestAttemptOrdinal: attempts.at(-1)?.ordinal ?? null,
    credentialValuesRedacted: true,
    disclosureNotes: optimizerAuditDisclosureNotes(),
    attempts,
  };
}

function optimizerAuditDisclosureNotes(): readonly string[] {
  return [
    "Credential values are never persisted or displayed.",
    "The complete detached checkout is technically readable; prompt restrictions are not an operating-system filesystem sandbox.",
    "Web and shell tools are disabled, but provider API network access is required to run the model.",
    "Claude Code provider-managed system context is not emitted by the CLI; the dashboard records every runner-controlled input and the resulting tool transcript.",
  ];
}

function projectOptimizerBoundary(value: unknown): DashboardOptimizerAuditAttempt["boundary"] {
  const boundary = optimizerRecord(value);
  return {
    taskCatalogVisible: optimizerBoolean(boundary?.["taskCatalogVisible"]),
    panelVisible: optimizerBoolean(boundary?.["panelVisible"]),
    graderVisible: optimizerBoolean(boundary?.["graderVisible"]),
    rawEvaluationVisible: optimizerBoolean(boundary?.["rawEvaluationVisible"]),
  };
}

function projectOptimizerExecutionContract(
  value: unknown,
): DashboardOptimizerExecutionContract | null {
  const execution = optimizerRecord(value);
  if (
    execution === null ||
    typeof execution["model"] !== "string" ||
    typeof execution["effort"] !== "string" ||
    typeof execution["maximumCostUsd"] !== "number" ||
    typeof execution["maximumTurns"] !== "number" ||
    typeof execution["timeoutMs"] !== "number" ||
    typeof execution["outputFormat"] !== "string" ||
    typeof execution["permissionMode"] !== "string"
  ) {
    return null;
  }
  return {
    model: execution["model"],
    effort: execution["effort"],
    maximumCostUsd: execution["maximumCostUsd"],
    maximumTurns: execution["maximumTurns"],
    timeoutMs: execution["timeoutMs"],
    outputFormat: execution["outputFormat"],
    permissionMode: execution["permissionMode"],
    sessionPersistence: execution["sessionPersistence"] === true,
    browserEnabled: execution["browserEnabled"] === true,
    allowedTools: optimizerStringArray(execution["allowedTools"]),
    disallowedTools: optimizerStringArray(execution["disallowedTools"]),
    shellEnabled: execution["shellEnabled"] === true,
    networkToolsEnabled: execution["networkToolsEnabled"] === true,
    providerApiNetworkRequired: execution["providerApiNetworkRequired"] !== false,
  };
}

function projectOptimizerSourceContext(input: {
  readonly value: unknown;
  readonly repositoryOrigin: string;
  readonly championRevision: string;
}): DashboardOptimizerSourceContext {
  const source = optimizerRecord(input.value);
  const editableRoots = optimizerStringArray(source?.["editableRoots"]).filter(
    (path) =>
      path === "packages/agent/src/" ||
      path === "packages/ai/src/" ||
      path === "packages/coding-agent/src/",
  );
  const instructionFiles = optimizerStringArray(source?.["instructionFiles"]).filter(
    (path) => path === "AGENTS.md",
  );
  const rawInstructionHashes = optimizerRecord(source?.["instructionFileSha256"]);
  const agentsHash =
    typeof rawInstructionHashes?.["AGENTS.md"] === "string" &&
    /^[a-f0-9]{64}$/u.test(rawInstructionHashes["AGENTS.md"])
      ? rawInstructionHashes["AGENTS.md"]
      : null;
  return {
    kind: typeof source?.["kind"] === "string" ? source["kind"] : "detached-git-worktree",
    repositoryOrigin: input.repositoryOrigin,
    championRevision: input.championRevision,
    candidateTree:
      typeof source?.["candidateTree"] === "string" &&
      /^[a-f0-9]{40,64}$/u.test(source["candidateTree"])
        ? source["candidateTree"]
        : null,
    readableScope:
      typeof source?.["readableScope"] === "string"
        ? source["readableScope"]
        : "The full detached repository checkout is technically readable through Read, Grep, and Glob.",
    editableRoots:
      editableRoots.length > 0
        ? editableRoots
        : ["packages/agent/src/", "packages/ai/src/", "packages/coding-agent/src/"],
    instructionFiles: instructionFiles.length > 0 ? instructionFiles : ["AGENTS.md"],
    instructionFileSha256: agentsHash === null ? {} : { "AGENTS.md": agentsHash },
    restrictionsEnforcedBy:
      typeof source?.["restrictionsEnforcedBy"] === "string"
        ? source["restrictionsEnforcedBy"]
        : "Prompt policy during optimization; changed-file allowlist after optimization.",
    postRunChangeValidation:
      typeof source?.["postRunChangeValidation"] === "string"
        ? source["postRunChangeValidation"]
        : "The runner validates changed files after optimization before any candidate evaluation.",
  };
}

function projectOptimizerEnvironment(
  value: unknown,
): readonly DashboardOptimizerEnvironmentEntry[] {
  if (!Array.isArray(value)) return [];
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "CI",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "DISABLE_TELEMETRY",
  ]);
  const entries: DashboardOptimizerEnvironmentEntry[] = [];
  for (const item of value) {
    const entry = optimizerRecord(item);
    if (entry === null || typeof entry["name"] !== "string" || !allowedNames.has(entry["name"])) {
      continue;
    }
    const secret = entry["secret"] === true || entry["name"] === "ANTHROPIC_FOUNDRY_API_KEY";
    const hostPath =
      entry["name"] === "PATH" || entry["name"] === "HOME" || entry["name"] === "CLAUDE_CONFIG_DIR";
    entries.push({
      name: entry["name"],
      value: secret || hostPath || typeof entry["value"] !== "string" ? null : entry["value"],
      secret,
      description: typeof entry["description"] === "string" ? entry["description"] : null,
    });
  }
  return entries;
}

function projectOptimizerPreviousDecision(value: unknown): LocalRealDecision | null {
  const decision = optimizerRecord(value);
  if (
    decision === null ||
    decision["schemaVersion"] !== LOCAL_REAL_SCHEMA_VERSION ||
    typeof decision["experimentId"] !== "string" ||
    !new Set(["promote", "reject", "inconclusive"]).has(String(decision["disposition"])) ||
    !new Set([
      "candidate-superior",
      "candidate-inferior",
      "aggregate-effect-too-small",
      "insufficient-confidence",
      "infrastructure-invalid",
      "candidate-invalid",
    ]).has(String(decision["reason"])) ||
    typeof decision["championMeanReward"] !== "number" ||
    typeof decision["taskWins"] !== "number" ||
    typeof decision["taskLosses"] !== "number" ||
    typeof decision["taskTies"] !== "number" ||
    typeof decision["confidenceCandidateBetter"] !== "number" ||
    decision["minimumAggregateDelta"] !== 0.05 ||
    decision["requiredConfidence"] !== 0.95 ||
    typeof decision["decidedAt"] !== "string"
  ) {
    return null;
  }
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    experimentId: decision["experimentId"],
    disposition: decision["disposition"] as LocalRealDecision["disposition"],
    reason: decision["reason"] as LocalRealDecision["reason"],
    candidateMeanReward:
      typeof decision["candidateMeanReward"] === "number" ? decision["candidateMeanReward"] : null,
    championMeanReward: decision["championMeanReward"],
    meanRewardDelta:
      typeof decision["meanRewardDelta"] === "number" ? decision["meanRewardDelta"] : null,
    taskWins: decision["taskWins"],
    taskLosses: decision["taskLosses"],
    taskTies: decision["taskTies"],
    confidenceCandidateBetter: decision["confidenceCandidateBetter"],
    minimumAggregateDelta: 0.05,
    requiredConfidence: 0.95,
    decidedAt: decision["decidedAt"],
    containsSecrets: false,
  };
}

function optimizerRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function optimizerBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function optimizerStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, 100)
    : [];
}

function projectOptimizer(optimizer: LocalRealOptimizerReceipt): DashboardOptimizerDetail {
  return {
    model: optimizer.model,
    startedAt: optimizer.startedAt,
    completedAt: optimizer.completedAt,
    turns: optimizer.turns,
    costUsd: optimizer.costUsd,
    hypothesisId: optimizer.hypothesisId,
    hypothesisSummary: optimizer.hypothesisSummary,
    interventionSummary: optimizer.interventionSummary,
  };
}

function projectCandidate(
  candidate: LocalRealCandidateReceipt,
  artifactByLabel: ReadonlyMap<string, string>,
): DashboardExperimentDetail["candidate"] {
  const validationCommands: DashboardValidationCommand[] = candidate.validationCommands.map(
    (command) => ({
      command: command.command,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      logArtifactId: artifactByLabel.get(command.logPath) ?? null,
    }),
  );
  return {
    parentRevision: candidate.parentRevision,
    tree: candidate.tree,
    changedFiles: candidate.changedFiles,
    valid: candidate.valid,
    invalidReason: candidate.invalidReason,
    patchArtifactId: artifactByLabel.get("candidate/candidate.patch") ?? null,
    validationCommands,
  };
}

function projectPanelAttempt(attempt: LocalRealPanelAttempt): DashboardPanelAttemptDetail {
  return {
    ordinal: attempt.ordinal,
    saturationPressure: attempt.saturationPressure,
    selectedTasks: attempt.selectedTasks.map((task) => ({
      name: task.name,
      difficulty: task.difficulty,
      empiricalFailureRate: task.empiricalFailureRate,
      selections: task.selections,
    })),
    champion: projectArm(attempt.champion),
    championMeanReward: attempt.championMeanReward,
    taskMeanRewards: attempt.taskMeanRewards,
    aggregateHeadroomSatisfied: attempt.aggregateHeadroomSatisfied,
    everyTaskHasHeadroom: attempt.everyTaskHasHeadroom,
    surpassable: attempt.surpassable,
    disposition: attempt.disposition,
    recordedAt: attempt.recordedAt,
  };
}

function projectOptionalArm(value: unknown): DashboardArmDetail | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("arm" in value) ||
    !("observations" in value) ||
    !Array.isArray(value.observations)
  ) {
    return null;
  }
  return projectArm(value as LocalRealArmReceipt);
}

function projectArm(arm: LocalRealArmReceipt): DashboardArmDetail {
  return {
    arm: arm.arm,
    revision: arm.revision,
    startedAt: arm.startedAt,
    completedAt: arm.completedAt,
    costUsd: arm.costUsd,
    infrastructureValid: arm.infrastructureValid,
    observations: arm.observations.map((observation) => ({
      taskName: observation.taskName,
      repetition: observation.repetition,
      reward: observation.reward,
      infrastructureValid: observation.infrastructureValid,
      durationMs: observation.durationMs,
      inputTokens: observation.inputTokens,
      cacheTokens: observation.cacheTokens,
      outputTokens: observation.outputTokens,
      costUsd: observation.costUsd,
    })),
  };
}

function projectPublication(
  publication: {
    readonly commit?: string;
    readonly status?: string;
    readonly experimentRef?: string;
    readonly championRef?: string;
  } | null,
): DashboardPublicationDetail | null {
  if (publication === null || typeof publication.commit !== "string") return null;
  return {
    commit: publication.commit,
    status: publication.status ?? null,
    experimentRef: publication.experimentRef ?? null,
    championRef: publication.championRef ?? null,
  };
}

async function readJson<Value>(path: string): Promise<Value | null> {
  try {
    const information = await lstat(path);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error("Dashboard JSON artifact must be a regular file");
    }
    if (information.size > MAXIMUM_EXPERIMENT_JSON_BYTES) {
      throw new Error("Dashboard JSON artifact exceeds its size limit");
    }
    return JSON.parse(await readFile(path, "utf8")) as Value;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function readLiveJson<Value>(path: string): Promise<Value | null> {
  try {
    const information = await lstat(path);
    if (
      information.isSymbolicLink() ||
      !information.isFile() ||
      information.size <= 0 ||
      information.size > MAXIMUM_EXPERIMENT_JSON_BYTES
    ) {
      return null;
    }
    return JSON.parse(await readFile(path, "utf8")) as Value;
  } catch {
    // Harbor rewrites progress JSON in place. A polling read can briefly see
    // an incomplete document; the next dashboard refresh will retry it.
    return null;
  }
}

async function walkArtifactFiles(root: string): Promise<readonly string[]> {
  await assertContainedDirectory(root, root);
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && isAllowedArtifact(relative(root, path))) found.push(path);
      if (found.length > MAXIMUM_ARTIFACT_FILES) {
        throw new Error("Experiment contains too many dashboard artifacts");
      }
    }
  }
  return found;
}

async function describeArtifact(
  experimentDirectory: string,
  path: string,
): Promise<DashboardArtifactDescriptor | null> {
  const relativePath = relative(experimentDirectory, path);
  if (!isAllowedArtifact(relativePath)) return null;
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) return null;
  return {
    id: artifactId(relativePath),
    category: artifactCategory(relativePath),
    label: relativePath,
    contentType: artifactContentType(relativePath),
    sizeBytes: information.size,
    updatedAt: information.mtime.toISOString(),
    streamable: true,
  };
}

function isAllowedArtifact(path: string): boolean {
  if (path.includes("\0") || path.split(sep).includes("..")) return false;
  const extension = extname(path);
  const publicationArtifact = !path.includes(sep) && basename(path).startsWith("publication");
  const parts = path.split(sep);
  const optimizerAuditJson =
    parts.length === 4 &&
    parts[0] === "optimizer" &&
    parts[1] === "attempts" &&
    /^\d{3}$/u.test(parts[2] ?? "") &&
    (parts[3] === "input.json" || parts[3] === "invocation.json");
  if (!new Set([".json", ".jsonl", ".log", ".patch", ".txt"]).has(extension)) return false;
  if (path.includes("claude-config") || path.includes("runtime.json")) return false;
  if (
    path.startsWith(`harbor${sep}`) &&
    (basename(path).endsWith("-config.json") || basename(path).endsWith("-registry.json"))
  ) {
    return false;
  }
  if (
    extension === ".json" &&
    path !== "experiment.json" &&
    path !== "decision.json" &&
    !optimizerAuditJson &&
    !publicationArtifact
  ) {
    return false;
  }
  return (
    path === "experiment.json" ||
    path === "decision.json" ||
    path.startsWith(`panel${sep}`) ||
    path.startsWith(`optimizer${sep}`) ||
    path.startsWith(`candidate${sep}`) ||
    path.startsWith(`harbor${sep}`) ||
    publicationArtifact
  );
}

function artifactCategory(path: string): DashboardArtifactCategory {
  if (path.startsWith(`optimizer${sep}`)) return "optimizer";
  if (path.startsWith(`candidate${sep}`) && path.endsWith(".patch")) return "code";
  if (path.startsWith(`candidate${sep}`)) return "validation";
  if (path.startsWith(`harbor${sep}`) || path.startsWith(`panel${sep}`)) return "evaluation";
  if (basename(path).startsWith("publication")) return "publication";
  return "experiment";
}

function artifactContentType(path: string): DashboardArtifactDescriptor["contentType"] {
  if (path.endsWith(".jsonl")) return "application/jsonl";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".patch")) return "text/x-diff";
  return "text/plain";
}

function artifactId(relativePath: string): string {
  return createHash("sha256").update(relativePath).digest("base64url").slice(0, 24);
}

async function assertContainedDirectory(root: string, path: string): Promise<void> {
  const [rootPath, selectedPath] = await Promise.all([realpath(root), realpath(path)]);
  if (selectedPath !== rootPath && !selectedPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("Dashboard path escapes its campaign root");
  }
  const information = await lstat(selectedPath);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Dashboard path must be a real directory");
  }
}

async function assertContainedRegularFile(root: string, path: string): Promise<void> {
  const [rootPath, selectedPath] = await Promise.all([realpath(root), realpath(path)]);
  if (!selectedPath.startsWith(`${rootPath}${sep}`)) {
    throw new Error("Dashboard artifact escapes its experiment root");
  }
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile()) {
    throw new Error("Dashboard artifact must be a regular file");
  }
}

function resolveStateRoot(stateRoot: string): string {
  const resolved = resolve(stateRoot);
  if (resolved !== stateRoot) throw new Error("Dashboard state root must be absolute");
  return resolved;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
