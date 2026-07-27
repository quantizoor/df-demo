import { createHash } from "node:crypto";
import { join } from "node:path";

import { canonicalJson } from "../../mvp/contracts.js";
import { writeJsonAtomic } from "../../mvp/mounted-files.js";
import type {
  LocalRealActiveExperiment,
  LocalRealArmReceipt,
  LocalRealCampaignState,
  LocalRealCatalog,
  LocalRealDecision,
  LocalRealPanelAttempt,
  LocalRealRunnerAdapter,
  LocalRealTask,
} from "./contracts.js";
import { decideLocalRealComparison, invalidLocalRealCandidateDecision } from "./decision.js";
import {
  advanceLocalPanelPolicyState,
  assessLocalChampionPanel,
  initialLocalPanelPolicyState,
  type LocalPanelPolicyState,
  type LocalPanelSelection,
  type LocalSelectedPanelTask,
  type LocalTaskCatalogEntry,
  localPanelDigest,
  localPanelSaturationPressure,
  selectDeterministicWeightedPanel,
} from "./panel.js";
import {
  acquireLocalRealRunnerLock,
  clearLocalRealStopRequest,
  ensureLocalRealExperimentDirectory,
  hasLocalRealStopRequest,
  type LocalRealCampaignPaths,
  loadLocalRealCampaign,
  readLocalRealArtifact,
  readLocalRealStopRequest,
  writeLocalRealArtifactOnce,
  writeLocalRealState,
} from "./state.js";

const SATURATION_HISTORY_LIMIT = 20;

interface PersistedPanelAttempt {
  readonly attempt: LocalRealPanelAttempt;
  readonly panelDigest: string;
  readonly historyBefore: readonly boolean[];
  readonly historyAfter: readonly boolean[];
  readonly catalogBefore: LocalRealCatalog;
  readonly catalogAfter: LocalRealCatalog;
}

interface AcceptedPanel {
  readonly attempt: LocalRealPanelAttempt;
  readonly panelDigest: string;
}

interface PersistedPanelReuse {
  readonly schemaVersion: LocalRealCampaignState["schemaVersion"];
  readonly experimentId: string;
  readonly sourceExperimentId: string;
  readonly championRevision: string;
  readonly panelDigest: string;
  readonly taskNames: readonly string[];
  readonly reusedAt: string;
  readonly containsSecrets: false;
}

interface PersistedExperimentReceipt {
  readonly schemaVersion: LocalRealCampaignState["schemaVersion"];
  readonly campaignId: string;
  readonly experimentId: string;
  readonly championBefore: string;
  readonly championAfter: string;
  readonly panelDigest: string;
  readonly optimizer: unknown;
  readonly candidate: unknown;
  readonly candidateEvaluation: LocalRealArmReceipt | null;
  readonly decision: LocalRealDecision;
  readonly publication: { readonly commit: string } | null;
  readonly totalExperimentCostUsd: number;
  readonly completedAt: string;
  readonly containsSecrets: false;
}

export interface LocalRealRunResult {
  readonly command: "real-run";
  readonly campaignId: string;
  readonly status: "stopped" | "blocked";
  readonly completedThisInvocation: number;
  readonly completedTotal: number;
  readonly promotions: number;
  readonly championRevision: string;
  readonly totalCostUsd: number;
  readonly nextExperimentNumber: number;
  readonly reason: string;
  readonly containsSecrets: false;
}

export interface LocalRealRunOptions {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly adapter: LocalRealRunnerAdapter;
  readonly now?: () => Date;
  readonly shouldStop?: () => boolean;
  /**
   * A bounded hook for tests and explicit one-shot operation. The normal CLI
   * omits this value and therefore continues until a stop or safety boundary.
   */
  readonly maximumCompletedExperiments?: number;
  readonly resume?: boolean;
}

export async function runLocalRealCampaign(
  options: LocalRealRunOptions,
): Promise<LocalRealRunResult> {
  const now = options.now ?? (() => new Date());
  const discovered = await loadLocalRealCampaign(options.stateRoot, options.campaignId);
  const releaseLock = await acquireLocalRealRunnerLock(discovered.paths, now().toISOString());
  try {
    const loaded = await loadLocalRealCampaign(options.stateRoot, options.campaignId);
    let state = loaded.state;
    let catalog = loaded.catalog;
    let completedThisInvocation = 0;
    if (options.resume === true) {
      await clearLocalRealStopRequest(loaded.paths);
    }
    state = await updateState(loaded.paths, state, now, {
      status: "running",
      stopReason: null,
      blockedReason: null,
    });

    while (true) {
      const stopReason = await requestedStopReason(
        loaded.paths,
        options.shouldStop,
        options.maximumCompletedExperiments,
        completedThisInvocation,
      );
      if (stopReason !== null) {
        state = await updateState(loaded.paths, state, now, {
          status: "stopped",
          stopReason,
        });
        return runResult(state, completedThisInvocation, "stopped", stopReason);
      }
      const budgetReason = budgetStopReason(loaded.config.budget, state.totalCostUsd);
      if (budgetReason !== null) {
        state = await updateState(loaded.paths, state, now, {
          status: "stopped",
          stopReason: budgetReason,
        });
        return runResult(state, completedThisInvocation, "stopped", budgetReason);
      }

      try {
        const outcome = await runOneExperiment({
          paths: loaded.paths,
          config: loaded.config,
          state,
          catalog,
          adapter: options.adapter,
          now,
          ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
        });
        state = outcome.state;
        catalog = outcome.catalog;
        if (outcome.completed) completedThisInvocation += 1;
        if (outcome.stopped) {
          return runResult(
            state,
            completedThisInvocation,
            "stopped",
            state.stopReason ?? "operator-requested",
          );
        }
      } catch (error) {
        const durable = await loadLocalRealCampaign(options.stateRoot, options.campaignId);
        state = durable.state;
        catalog = durable.catalog;
        const reason =
          error instanceof LocalRealRunnerPhaseError ? error.code : "unexpected-runner-failure";
        if (error instanceof LocalRealOperatorCancelledError) {
          state = await updateState(loaded.paths, state, now, {
            status: "stopped",
            stopReason: "operator-cancelled-active-phase",
            blockedReason: null,
          });
          return runResult(
            state,
            completedThisInvocation,
            "stopped",
            "operator-cancelled-active-phase",
          );
        }
        if (
          reason === "campaign-cost-limit-reached" ||
          reason === "campaign-budget-configuration-invalid"
        ) {
          state = await updateState(loaded.paths, state, now, {
            status: "stopped",
            stopReason: reason,
          });
          return runResult(state, completedThisInvocation, "stopped", reason);
        }
        state = await updateState(loaded.paths, state, now, {
          status: "blocked",
          blockedReason: reason,
        });
        return runResult(state, completedThisInvocation, "blocked", reason);
      }
    }
  } finally {
    await releaseLock();
  }
}

async function runOneExperiment(input: {
  readonly paths: LocalRealCampaignPaths;
  readonly config: Awaited<ReturnType<typeof loadLocalRealCampaign>>["config"];
  readonly state: LocalRealCampaignState;
  readonly catalog: LocalRealCatalog;
  readonly adapter: LocalRealRunnerAdapter;
  readonly now: () => Date;
  readonly shouldStop?: () => boolean;
}): Promise<{
  readonly state: LocalRealCampaignState;
  readonly catalog: LocalRealCatalog;
  readonly completed: boolean;
  readonly stopped: boolean;
}> {
  let state = input.state;
  let catalog = input.catalog;
  const active =
    state.activeExperiment ??
    activeExperiment(state.nextExperimentNumber, input.now().toISOString());
  if (state.activeExperiment === null) {
    state = await updateState(input.paths, state, input.now, {
      activeExperiment: active,
    });
  }
  const experimentDirectory = await ensureLocalRealExperimentDirectory(
    input.paths,
    active.experimentId,
  );
  await writeLocalRealArtifactOnce(join(experimentDirectory, "experiment.json"), {
    schemaVersion: state.schemaVersion,
    campaignId: state.campaignId,
    experimentNumber: active.experimentNumber,
    experimentId: active.experimentId,
    championBefore: state.championRevision,
    startedAt: active.startedAt,
    containsSecrets: false,
  });
  const completedReceipt = await readLocalRealArtifact<PersistedExperimentReceipt>(
    join(experimentDirectory, "receipt.json"),
  );
  if (completedReceipt !== null) {
    const accepted = await readLocalRealArtifact<AcceptedPanel>(
      join(experimentDirectory, "panel", "accepted.json"),
    );
    if (accepted === null) {
      throw new LocalRealRunnerPhaseError("completed-experiment-panel-missing");
    }
    state = await finalizePersistedExperiment(
      input.paths,
      state,
      input.now,
      active,
      accepted,
      completedReceipt,
    );
    return { state, catalog, completed: true, stopped: false };
  }

  const panelResult = await preparePanel({
    ...input,
    state,
    catalog,
    active,
    experimentDirectory,
  });
  state = panelResult.state;
  catalog = panelResult.catalog;
  if (await shouldStopNow(input.paths, input.shouldStop)) {
    state = await updateState(input.paths, state, input.now, {
      status: "stopped",
      stopReason: "operator-requested",
    });
    return { state, catalog, completed: false, stopped: true };
  }
  assertBudgetAvailable(input.config.budget, state.totalCostUsd);

  state = await setPhase(input.paths, state, input.now, "optimizer");
  const optimizerPath = join(experimentDirectory, "optimizer", "receipt.json");
  let optimizer =
    await readLocalRealArtifact<Awaited<ReturnType<LocalRealRunnerAdapter["optimize"]>>>(
      optimizerPath,
    );
  if (optimizer === null) {
    const previousDecision = await previousDecisionFor(input.paths, active.experimentNumber);
    try {
      optimizer = await withActiveCancellation(input.paths, (signal) =>
        input.adapter.optimize({
          config: input.config,
          state,
          experimentId: active.experimentId,
          experimentDirectory,
          previousDecision,
          signal,
        }),
      );
    } catch (error) {
      rethrowOperatorCancellation(error);
      throw new LocalRealRunnerPhaseError("optimizer-failed", { cause: error });
    }
    await writeLocalRealArtifactOnce(optimizerPath, optimizer);
  }
  state = await accountCost(
    input.paths,
    state,
    input.now,
    `${active.experimentId}:optimizer`,
    optimizer.costUsd,
  );
  if (await shouldStopNow(input.paths, input.shouldStop)) {
    state = await updateState(input.paths, state, input.now, {
      status: "stopped",
      stopReason: "operator-requested",
    });
    return { state, catalog, completed: false, stopped: true };
  }

  state = await setPhase(input.paths, state, input.now, "candidate-validation");
  const candidatePath = join(experimentDirectory, "candidate", "receipt.json");
  const runtimePath = join(experimentDirectory, "candidate", "runtime.json");
  let candidate =
    await readLocalRealArtifact<
      Awaited<ReturnType<LocalRealRunnerAdapter["validateAndBuild"]>>["candidate"]
    >(candidatePath);
  let candidateRuntime =
    await readLocalRealArtifact<
      NonNullable<Awaited<ReturnType<LocalRealRunnerAdapter["validateAndBuild"]>>["runtime"]>
    >(runtimePath);
  if (candidate === null) {
    let built: Awaited<ReturnType<LocalRealRunnerAdapter["validateAndBuild"]>>;
    try {
      built = await withActiveCancellation(input.paths, (signal) =>
        input.adapter.validateAndBuild({
          config: input.config,
          experimentId: active.experimentId,
          experimentDirectory,
          optimizer,
          signal,
        }),
      );
    } catch (error) {
      rethrowOperatorCancellation(error);
      throw new LocalRealRunnerPhaseError("candidate-validation-failed", { cause: error });
    }
    candidate = built.candidate;
    candidateRuntime = built.runtime;
    if (candidateRuntime !== null) {
      await writeLocalRealArtifactOnce(runtimePath, candidateRuntime);
    }
    await writeLocalRealArtifactOnce(candidatePath, candidate);
  }

  let decision = await readLocalRealArtifact<LocalRealDecision>(
    join(experimentDirectory, "decision.json"),
  );
  if (decision === null && !candidate.valid) {
    state = await setPhase(input.paths, state, input.now, "decision");
    decision = invalidLocalRealCandidateDecision({
      experimentId: active.experimentId,
      champion: panelResult.accepted.attempt.champion,
      decidedAt: input.now().toISOString(),
    });
    await writeLocalRealArtifactOnce(join(experimentDirectory, "decision.json"), decision);
  }

  let candidateArm: LocalRealArmReceipt | null = null;
  if (candidate.valid) {
    if (candidateRuntime === null) {
      throw new LocalRealRunnerPhaseError("candidate-runtime-missing");
    }
    if (await shouldStopNow(input.paths, input.shouldStop)) {
      state = await updateState(input.paths, state, input.now, {
        status: "stopped",
        stopReason: "operator-requested",
      });
      return { state, catalog, completed: false, stopped: true };
    }
    assertBudgetAvailable(input.config.budget, state.totalCostUsd);
    state = await setPhase(input.paths, state, input.now, "candidate-evaluation");
    const candidateArmPath = join(experimentDirectory, "candidate", "evaluation.json");
    candidateArm = await readLocalRealArtifact<LocalRealArmReceipt>(candidateArmPath);
    if (candidateArm === null) {
      try {
        candidateArm = await withActiveCancellation(input.paths, (signal) =>
          input.adapter.evaluateArm({
            config: input.config,
            experimentId: active.experimentId,
            experimentDirectory,
            arm: "candidate",
            revision: candidate.tree,
            runtime: candidateRuntime,
            tasks: panelResult.accepted.attempt.selectedTasks,
            attemptOrdinal: panelResult.accepted.attempt.ordinal,
            signal,
          }),
        );
      } catch (error) {
        rethrowOperatorCancellation(error);
        throw new LocalRealRunnerPhaseError("candidate-evaluation-failed", { cause: error });
      }
      await writeLocalRealArtifactOnce(candidateArmPath, candidateArm);
    }
    state = await accountCost(
      input.paths,
      state,
      input.now,
      `${active.experimentId}:candidate`,
      candidateArm.costUsd,
    );
    if (decision === null) {
      state = await setPhase(input.paths, state, input.now, "decision");
      decision = decideLocalRealComparison({
        experimentId: active.experimentId,
        champion: panelResult.accepted.attempt.champion,
        candidate: candidateArm,
        decidedAt: input.now().toISOString(),
      });
      await writeLocalRealArtifactOnce(join(experimentDirectory, "decision.json"), decision);
    }
  }
  if (decision === null) {
    throw new LocalRealRunnerPhaseError("decision-missing");
  }

  let championAfter = state.championRevision;
  let publication: Awaited<ReturnType<LocalRealRunnerAdapter["publish"]>> | null = null;
  if (decision.disposition === "promote") {
    if (!input.config.publication.enabled) {
      throw new LocalRealRunnerPhaseError("promotion-publication-disabled");
    }
    state = await setPhase(input.paths, state, input.now, "publication");
    const publicationPath = join(experimentDirectory, "publication.json");
    publication =
      await readLocalRealArtifact<Awaited<ReturnType<LocalRealRunnerAdapter["publish"]>>>(
        publicationPath,
      );
    if (publication === null) {
      try {
        publication = await input.adapter.publish({
          config: input.config,
          experimentId: active.experimentId,
          experimentDirectory,
          worktree: optimizer.worktree,
          parentRevision: state.championRevision,
          candidateTree: candidate.tree,
          changedFiles: candidate.changedFiles,
          timestamp: decision.decidedAt,
        });
      } catch (error) {
        throw new LocalRealRunnerPhaseError("promotion-publication-pending", {
          cause: error,
        });
      }
      await writeLocalRealArtifactOnce(publicationPath, publication);
    }
    championAfter = publication.commit;
  }

  state = await setPhase(input.paths, state, input.now, "advance");
  const completedAt = input.now().toISOString();
  const receipt: PersistedExperimentReceipt = {
    schemaVersion: state.schemaVersion,
    campaignId: state.campaignId,
    experimentId: active.experimentId,
    championBefore: state.championRevision,
    championAfter,
    panelDigest: panelResult.accepted.panelDigest,
    optimizer,
    candidate,
    candidateEvaluation: candidateArm,
    decision,
    publication,
    totalExperimentCostUsd: rounded(
      state.costLedger
        .filter((entry) => entry.id.startsWith(`${active.experimentId}:`))
        .reduce((total, entry) => total + entry.amountUsd, 0),
    ),
    completedAt,
    containsSecrets: false,
  };
  await writeLocalRealArtifactOnce(join(experimentDirectory, "receipt.json"), receipt);
  state = await finalizePersistedExperiment(
    input.paths,
    state,
    input.now,
    active,
    panelResult.accepted,
    receipt,
  );
  return { state, catalog, completed: true, stopped: false };
}

async function finalizePersistedExperiment(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
  now: () => Date,
  active: LocalRealActiveExperiment,
  accepted: AcceptedPanel,
  receipt: PersistedExperimentReceipt,
): Promise<LocalRealCampaignState> {
  const promoted = receipt.decision.disposition === "promote";
  const ledgerTotal = rounded(
    state.costLedger
      .filter((entry) => entry.id.startsWith(`${active.experimentId}:`))
      .reduce((total, entry) => total + entry.amountUsd, 0),
  );
  if (
    state.activeExperiment?.experimentId !== active.experimentId ||
    state.nextExperimentNumber !== active.experimentNumber ||
    receipt.schemaVersion !== state.schemaVersion ||
    receipt.campaignId !== state.campaignId ||
    receipt.experimentId !== active.experimentId ||
    receipt.championBefore !== state.championRevision ||
    !/^[a-f0-9]{40,64}$/u.test(receipt.championAfter) ||
    receipt.panelDigest !== accepted.panelDigest ||
    receipt.decision.experimentId !== active.experimentId ||
    receipt.totalExperimentCostUsd !== ledgerTotal ||
    receipt.containsSecrets !== false ||
    (promoted
      ? receipt.publication?.commit !== receipt.championAfter
      : receipt.publication !== null || receipt.championAfter !== state.championRevision)
  ) {
    throw new LocalRealRunnerPhaseError("completed-experiment-receipt-invalid");
  }
  return updateState(paths, state, now, {
    status: "running",
    championRevision: receipt.championAfter,
    nextExperimentNumber: state.nextExperimentNumber + 1,
    activeExperiment: null,
    retainedPanel: promoted
      ? null
      : {
          taskNames: accepted.attempt.selectedTasks.map((task) => task.name),
          championRevision: state.championRevision,
        },
    completedExperiments: state.completedExperiments + 1,
    promotions: state.promotions + (promoted ? 1 : 0),
    consecutiveInfrastructureFailures: 0,
  });
}

async function preparePanel(input: {
  readonly paths: LocalRealCampaignPaths;
  readonly config: Awaited<ReturnType<typeof loadLocalRealCampaign>>["config"];
  readonly state: LocalRealCampaignState;
  readonly catalog: LocalRealCatalog;
  readonly adapter: LocalRealRunnerAdapter;
  readonly now: () => Date;
  readonly active: LocalRealActiveExperiment;
  readonly experimentDirectory: string;
}): Promise<{
  readonly state: LocalRealCampaignState;
  readonly catalog: LocalRealCatalog;
  readonly accepted: AcceptedPanel;
}> {
  const acceptedPath = join(input.experimentDirectory, "panel", "accepted.json");
  const reusePath = join(input.experimentDirectory, "panel", "reused.json");
  const existingAccepted = await readLocalRealArtifact<AcceptedPanel>(acceptedPath);
  const existingReuse = await readLocalRealArtifact<PersistedPanelReuse>(reusePath);
  if (existingReuse !== null) {
    const sourceAccepted = await validatedReusedPanel(input, existingReuse);
    if (
      existingAccepted !== null &&
      canonicalJson(existingAccepted) !== canonicalJson(sourceAccepted)
    ) {
      throw new LocalRealRunnerPhaseError("retained-panel-reuse-diverged");
    }
    if (existingAccepted === null) {
      await writeLocalRealArtifactOnce(acceptedPath, sourceAccepted);
    }
    return { state: input.state, catalog: input.catalog, accepted: sourceAccepted };
  }
  if (existingAccepted !== null) {
    if (existingAccepted.attempt.experimentId !== input.active.experimentId) {
      throw new LocalRealRunnerPhaseError("retained-panel-reuse-evidence-missing");
    }
    const state = await accountCost(
      input.paths,
      input.state,
      input.now,
      `${input.active.experimentId}:panel:${existingAccepted.attempt.ordinal}`,
      existingAccepted.attempt.champion.costUsd,
    );
    return { state, catalog: input.catalog, accepted: existingAccepted };
  }

  if (
    input.state.retainedPanel !== null &&
    input.state.retainedPanel.championRevision === input.state.championRevision
  ) {
    const sourceExperimentId = previousExperimentId(input.active.experimentNumber);
    const sourceAccepted = await readLocalRealArtifact<AcceptedPanel>(
      join(input.paths.experiments, sourceExperimentId, "panel", "accepted.json"),
    );
    if (sourceAccepted === null) {
      throw new LocalRealRunnerPhaseError("retained-panel-source-missing");
    }
    const reuse: PersistedPanelReuse = {
      schemaVersion: input.state.schemaVersion,
      experimentId: input.active.experimentId,
      sourceExperimentId,
      championRevision: input.state.championRevision,
      panelDigest: sourceAccepted.panelDigest,
      taskNames: [...input.state.retainedPanel.taskNames],
      reusedAt: input.now().toISOString(),
      containsSecrets: false,
    };
    await validatedReusedPanel(input, reuse);
    // Write provenance first so a crash can never leave a copied accepted panel
    // that would be mistaken for a newly billed champion evaluation.
    await writeLocalRealArtifactOnce(reusePath, reuse);
    await writeLocalRealArtifactOnce(acceptedPath, sourceAccepted);
    return { state: input.state, catalog: input.catalog, accepted: sourceAccepted };
  }

  let state = await setPhase(input.paths, input.state, input.now, "panel-screening");
  let catalog = input.catalog;
  let policyState = policyStateFromHistory(state.saturationHistory);
  const excludedTaskIds = new Set<string>();
  const excludedPanelDigests = new Set<string>();
  let infrastructureFailures = 0;
  const persistedAttempts = await readPersistedPanelAttemptChain(
    input.experimentDirectory,
    input.active.experimentId,
    input.config.evaluation.maximumPanelAttempts,
  );
  const championRuntime = await withActiveCancellation(input.paths, (signal) =>
    input.adapter.ensureChampionRuntime(input.config, state, input.experimentDirectory, signal),
  );

  for (let ordinal = 1; ordinal <= input.config.evaluation.maximumPanelAttempts; ordinal += 1) {
    const attemptPath = join(
      input.experimentDirectory,
      "panel",
      `attempt-${String(ordinal).padStart(3, "0")}.json`,
    );
    const persisted = persistedAttempts[ordinal - 1] ?? null;
    if (persisted !== null) {
      state = await accountCost(
        input.paths,
        state,
        input.now,
        `${input.active.experimentId}:panel:${persisted.attempt.ordinal}`,
        persisted.attempt.champion.costUsd,
      );
      const futureAttempts = persistedAttempts.slice(ordinal);
      state = await reconcileHistory(input.paths, state, input.now, persisted, futureAttempts);
      catalog = await reconcileCatalog(input.paths, catalog, persisted, futureAttempts);
      policyState = policyStateFromHistory(state.saturationHistory);
      if (persisted.attempt.disposition === "saturated") {
        excludedPanelDigests.add(persisted.panelDigest);
        persisted.attempt.selectedTasks.forEach((task) => {
          excludedTaskIds.add(`terminal-bench/${task.name}`);
        });
        continue;
      }
      if (persisted.attempt.disposition === "accepted") {
        const accepted = {
          attempt: persisted.attempt,
          panelDigest: persisted.panelDigest,
        } satisfies AcceptedPanel;
        await writeLocalRealArtifactOnce(acceptedPath, accepted);
        return { state, catalog, accepted };
      }
      infrastructureFailures += 1;
      if (infrastructureFailures > input.config.evaluation.maximumInfrastructureRetries) {
        throw new LocalRealRunnerPhaseError("champion-panel-infrastructure-circuit-open");
      }
      continue;
    }

    const selection =
      ordinal === 1 &&
      state.retainedPanel !== null &&
      state.retainedPanel.championRevision === state.championRevision
        ? retainedPanelSelection(
            catalog.tasks,
            state.retainedPanel.taskNames,
            state.campaignId,
            input.active.experimentNumber,
            policyState,
          )
        : selectDeterministicWeightedPanel(catalogEntries(catalog), {
            seed: `${state.campaignId}:${input.active.experimentNumber}`,
            screenOrdinal: ordinal,
            state: policyState,
            excludedTaskIds: [...excludedTaskIds],
            excludedPanelDigests: [...excludedPanelDigests],
          });
    const selectedTasks = selection.tasks.map((selected) =>
      requiredCatalogTask(catalog, selected.taskId),
    );
    assertBudgetAvailable(input.config.budget, state.totalCostUsd);
    let champion: LocalRealArmReceipt;
    try {
      champion = await withActiveCancellation(input.paths, (signal) =>
        input.adapter.evaluateArm({
          config: input.config,
          experimentId: input.active.experimentId,
          experimentDirectory: input.experimentDirectory,
          arm: "champion",
          revision: state.championRevision,
          runtime: championRuntime,
          tasks: selectedTasks,
          attemptOrdinal: ordinal,
          signal,
        }),
      );
    } catch (error) {
      rethrowOperatorCancellation(error);
      throw new LocalRealRunnerPhaseError("champion-panel-evaluation-failed", {
        cause: error,
      });
    }
    const assessment = assessLocalChampionPanel(
      selection,
      champion.observations.map((observation) => ({
        taskId: `terminal-bench/${observation.taskName}`,
        repetition: observation.repetition,
        reward: observation.reward,
        infrastructureValid: observation.infrastructureValid,
      })),
    );
    const historyBefore = [...state.saturationHistory];
    const historyAfter =
      assessment.status === "infrastructure-invalid"
        ? historyBefore
        : [...historyBefore, assessment.status === "saturated"].slice(-SATURATION_HISTORY_LIMIT);
    const attempt: LocalRealPanelAttempt = {
      schemaVersion: state.schemaVersion,
      experimentId: input.active.experimentId,
      ordinal,
      saturationPressure: localPanelSaturationPressure(policyState),
      selectedTasks,
      champion,
      championMeanReward: assessment.championMeanReward,
      taskMeanRewards: Object.fromEntries(
        assessment.taskAssessments.map((task) => [
          task.taskId.replace(/^terminal-bench\//u, ""),
          task.championMeanReward,
        ]),
      ),
      aggregateHeadroomSatisfied: assessment.aggregateThresholdSatisfied,
      everyTaskHasHeadroom: assessment.everyTaskCanProduceWin,
      surpassable: assessment.status === "accepted",
      disposition:
        assessment.status === "accepted"
          ? "accepted"
          : assessment.status === "saturated"
            ? "saturated"
            : "infrastructure-invalid",
      recordedAt: input.now().toISOString(),
      containsSecrets: false,
    };
    const catalogAfter =
      assessment.status === "infrastructure-invalid"
        ? catalog
        : updateCatalogFromChampion(catalog, attempt);
    const wrapper: PersistedPanelAttempt = {
      attempt,
      panelDigest: selection.panelDigest,
      historyBefore,
      historyAfter,
      catalogBefore: catalog,
      catalogAfter,
    };
    await writeLocalRealArtifactOnce(attemptPath, wrapper);
    state = await accountCost(
      input.paths,
      state,
      input.now,
      `${input.active.experimentId}:panel:${ordinal}`,
      champion.costUsd,
    );
    state = await reconcileHistory(input.paths, state, input.now, wrapper, []);
    catalog = await reconcileCatalog(input.paths, catalog, wrapper, []);
    if (assessment.status === "infrastructure-invalid") {
      infrastructureFailures += 1;
      if (infrastructureFailures > input.config.evaluation.maximumInfrastructureRetries) {
        throw new LocalRealRunnerPhaseError("champion-panel-infrastructure-circuit-open");
      }
      continue;
    }
    policyState = advanceLocalPanelPolicyState(policyState, assessment.status === "saturated");
    if (assessment.status === "accepted") {
      const accepted = { attempt, panelDigest: selection.panelDigest } satisfies AcceptedPanel;
      await writeLocalRealArtifactOnce(acceptedPath, accepted);
      return { state, catalog, accepted };
    }
    excludedPanelDigests.add(selection.panelDigest);
    selection.tasks.forEach((task) => {
      excludedTaskIds.add(task.taskId);
    });
  }
  throw new LocalRealRunnerPhaseError("surpassable-panel-not-found");
}

async function validatedReusedPanel(
  input: {
    readonly paths: LocalRealCampaignPaths;
    readonly state: LocalRealCampaignState;
    readonly active: LocalRealActiveExperiment;
  },
  reuse: PersistedPanelReuse,
): Promise<AcceptedPanel> {
  const retained = input.state.retainedPanel;
  const expectedSourceExperimentId = previousExperimentId(input.active.experimentNumber);
  const sourceAccepted = await readLocalRealArtifact<AcceptedPanel>(
    join(input.paths.experiments, reuse.sourceExperimentId, "panel", "accepted.json"),
  );
  const sourceReceipt = await readLocalRealArtifact<PersistedExperimentReceipt>(
    join(input.paths.experiments, reuse.sourceExperimentId, "receipt.json"),
  );
  if (
    retained === null ||
    reuse.schemaVersion !== input.state.schemaVersion ||
    reuse.experimentId !== input.active.experimentId ||
    reuse.sourceExperimentId !== expectedSourceExperimentId ||
    reuse.championRevision !== input.state.championRevision ||
    reuse.championRevision !== retained.championRevision ||
    reuse.containsSecrets !== false ||
    canonicalJson(reuse.taskNames) !== canonicalJson(retained.taskNames) ||
    sourceAccepted === null ||
    sourceReceipt === null ||
    sourceAccepted.attempt.experimentId !== reuse.sourceExperimentId ||
    sourceAccepted.attempt.disposition !== "accepted" ||
    sourceAccepted.attempt.champion.arm !== "champion" ||
    sourceAccepted.attempt.champion.revision !== reuse.championRevision ||
    sourceAccepted.panelDigest !== reuse.panelDigest ||
    canonicalJson(sourceAccepted.attempt.selectedTasks.map((task) => task.name)) !==
      canonicalJson(reuse.taskNames) ||
    sourceReceipt.experimentId !== reuse.sourceExperimentId ||
    sourceReceipt.championAfter !== reuse.championRevision ||
    sourceReceipt.panelDigest !== reuse.panelDigest ||
    sourceReceipt.decision.disposition === "promote"
  ) {
    throw new LocalRealRunnerPhaseError("retained-panel-reuse-invalid");
  }
  return sourceAccepted;
}

function previousExperimentId(experimentNumber: number): string {
  if (!Number.isSafeInteger(experimentNumber) || experimentNumber <= 1) {
    throw new LocalRealRunnerPhaseError("retained-panel-source-invalid");
  }
  return `${String(experimentNumber - 1).padStart(6, "0")}-optimization`;
}

async function readPersistedPanelAttemptChain(
  experimentDirectory: string,
  experimentId: string,
  maximumAttempts: number,
): Promise<readonly PersistedPanelAttempt[]> {
  const attempts: PersistedPanelAttempt[] = [];
  let foundGap = false;
  for (let ordinal = 1; ordinal <= maximumAttempts; ordinal += 1) {
    const path = join(
      experimentDirectory,
      "panel",
      `attempt-${String(ordinal).padStart(3, "0")}.json`,
    );
    const persisted = await readLocalRealArtifact<PersistedPanelAttempt>(path);
    if (persisted === null) {
      foundGap = true;
      continue;
    }
    if (foundGap) {
      throw new LocalRealRunnerPhaseError("panel-attempt-chain-has-gap");
    }
    const previous = attempts.at(-1);
    const expectedHistory =
      persisted.attempt.disposition === "infrastructure-invalid"
        ? persisted.historyBefore
        : [...persisted.historyBefore, persisted.attempt.disposition === "saturated"].slice(
            -SATURATION_HISTORY_LIMIT,
          );
    const expectedCatalog =
      persisted.attempt.disposition === "infrastructure-invalid"
        ? persisted.catalogBefore
        : updateCatalogFromChampion(persisted.catalogBefore, persisted.attempt);
    if (
      persisted.attempt.experimentId !== experimentId ||
      persisted.attempt.ordinal !== ordinal ||
      persisted.panelDigest !==
        localPanelDigest(
          persisted.attempt.selectedTasks.map((task) => ({
            taskId: `terminal-bench/${task.name}`,
            revision: task.sourceRevision,
          })),
        ) ||
      !sameBooleanArray(persisted.historyAfter, expectedHistory) ||
      canonicalJson(persisted.catalogAfter) !== canonicalJson(expectedCatalog) ||
      (previous !== undefined &&
        (!sameBooleanArray(previous.historyAfter, persisted.historyBefore) ||
          canonicalJson(previous.catalogAfter) !== canonicalJson(persisted.catalogBefore) ||
          previous.attempt.disposition === "accepted"))
    ) {
      throw new LocalRealRunnerPhaseError("panel-attempt-chain-invalid");
    }
    attempts.push(persisted);
  }
  return attempts;
}

async function reconcileCatalog(
  paths: LocalRealCampaignPaths,
  catalog: LocalRealCatalog,
  persisted: PersistedPanelAttempt,
  futureAttempts: readonly PersistedPanelAttempt[],
): Promise<LocalRealCatalog> {
  if (canonicalJson(catalog) === canonicalJson(persisted.catalogAfter)) return catalog;
  if (canonicalJson(catalog) === canonicalJson(persisted.catalogBefore)) {
    await writeCatalog(paths, persisted.catalogAfter);
    return persisted.catalogAfter;
  }
  if (
    futureAttempts.some(
      (future) =>
        canonicalJson(catalog) === canonicalJson(future.catalogBefore) ||
        canonicalJson(catalog) === canonicalJson(future.catalogAfter),
    )
  ) {
    return catalog;
  }
  throw new LocalRealRunnerPhaseError("panel-catalog-replay-diverged");
}

async function reconcileHistory(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
  now: () => Date,
  persisted: PersistedPanelAttempt,
  futureAttempts: readonly PersistedPanelAttempt[],
): Promise<LocalRealCampaignState> {
  if (sameBooleanArray(state.saturationHistory, persisted.historyAfter)) return state;
  if (sameBooleanArray(state.saturationHistory, persisted.historyBefore)) {
    return updateState(paths, state, now, {
      saturationHistory: persisted.historyAfter,
    });
  }
  if (
    futureAttempts.some(
      (future) =>
        sameBooleanArray(state.saturationHistory, future.historyBefore) ||
        sameBooleanArray(state.saturationHistory, future.historyAfter),
    )
  ) {
    return state;
  }
  throw new LocalRealRunnerPhaseError("panel-history-replay-diverged");
}

function retainedPanelSelection(
  tasks: readonly LocalRealTask[],
  retainedTaskNames: readonly string[],
  campaignId: string,
  experimentNumber: number,
  policyState: LocalPanelPolicyState,
): LocalPanelSelection {
  if (retainedTaskNames.length !== 5 || new Set(retainedTaskNames).size !== 5) {
    throw new LocalRealRunnerPhaseError("retained-panel-invalid");
  }
  const selected = retainedTaskNames.map((name): LocalSelectedPanelTask => {
    const task = tasks.find((candidate) => candidate.name === name);
    if (task === undefined) {
      throw new LocalRealRunnerPhaseError("retained-panel-task-missing");
    }
    return {
      taskId: `terminal-bench/${task.name}`,
      revision: task.sourceRevision,
      difficulty: task.difficulty,
      baseWeight: baseTaskWeight(task),
      effectiveWeight: baseTaskWeight(task),
      samplingScore: 0,
    };
  });
  return {
    policyVersion: "local-deterministic-adaptive-panel-v1",
    seedDigest: createHash("sha256")
      .update(`${campaignId}:${experimentNumber}:retained`)
      .digest("hex"),
    screenOrdinal: 1,
    redrawOrdinal: 0,
    saturationPressure: localPanelSaturationPressure(policyState),
    panelDigest: localPanelDigest(selected),
    tasks: selected,
  };
}

function catalogEntries(catalog: LocalRealCatalog): readonly LocalTaskCatalogEntry[] {
  return catalog.tasks.map((task) => ({
    taskId: `terminal-bench/${task.name}`,
    revision: task.sourceRevision,
    difficulty: task.difficulty,
    baseWeight: baseTaskWeight(task),
  }));
}

function baseTaskWeight(task: LocalRealTask): number {
  return 1 + 2 * task.empiricalFailureRate + 1 / Math.sqrt(task.selections + 1);
}

function requiredCatalogTask(catalog: LocalRealCatalog, taskId: string): LocalRealTask {
  const name = taskId.replace(/^terminal-bench\//u, "");
  const task = catalog.tasks.find((candidate) => candidate.name === name);
  if (task === undefined) {
    throw new LocalRealRunnerPhaseError("selected-task-missing-from-catalog");
  }
  return task;
}

function updateCatalogFromChampion(
  catalog: LocalRealCatalog,
  attempt: LocalRealPanelAttempt,
): LocalRealCatalog {
  const means = attempt.taskMeanRewards;
  return {
    ...catalog,
    tasks: catalog.tasks.map((task) => {
      const meanReward = means[task.name];
      if (meanReward === undefined) return task;
      const failureRate = 1 - meanReward;
      return {
        ...task,
        empiricalFailureRate: rounded(
          (task.empiricalFailureRate * task.selections + failureRate) / (task.selections + 1),
        ),
        selections: task.selections + 1,
      };
    }),
  };
}

async function writeCatalog(
  paths: LocalRealCampaignPaths,
  catalog: LocalRealCatalog,
): Promise<void> {
  await writeJsonAtomic(paths.catalog, catalog);
}

async function previousDecisionFor(
  paths: LocalRealCampaignPaths,
  experimentNumber: number,
): Promise<LocalRealDecision | null> {
  if (experimentNumber <= 1) return null;
  const previousId = `${String(experimentNumber - 1).padStart(6, "0")}-optimization`;
  return readLocalRealArtifact<LocalRealDecision>(
    join(paths.experiments, previousId, "decision.json"),
  );
}

function policyStateFromHistory(history: readonly boolean[]): LocalPanelPolicyState {
  let state = initialLocalPanelPolicyState();
  for (const saturated of history.slice(-SATURATION_HISTORY_LIMIT)) {
    state = advanceLocalPanelPolicyState(state, saturated);
  }
  return state;
}

function activeExperiment(number: number, startedAt: string): LocalRealActiveExperiment {
  return {
    experimentNumber: number,
    experimentId: `${String(number).padStart(6, "0")}-optimization`,
    phase: "panel-screening",
    startedAt,
  };
}

async function setPhase(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
  now: () => Date,
  phase: LocalRealActiveExperiment["phase"],
): Promise<LocalRealCampaignState> {
  if (state.activeExperiment === null) {
    throw new LocalRealRunnerPhaseError("active-experiment-missing");
  }
  if (state.activeExperiment.phase === phase) return state;
  return updateState(paths, state, now, {
    activeExperiment: { ...state.activeExperiment, phase },
  });
}

async function accountCost(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
  now: () => Date,
  id: string,
  amount: number,
): Promise<LocalRealCampaignState> {
  if (!/^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/u.test(id) || !Number.isFinite(amount) || amount < 0) {
    throw new LocalRealRunnerPhaseError("invalid-model-cost");
  }
  const existing = state.costLedger.find((entry) => entry.id === id);
  if (existing !== undefined) {
    if (existing.amountUsd !== rounded(amount)) {
      throw new LocalRealRunnerPhaseError("model-cost-replay-diverged");
    }
    return state;
  }
  const costLedger = [...state.costLedger, { id, amountUsd: rounded(amount) }];
  return updateState(paths, state, now, {
    costLedger,
    totalCostUsd: rounded(costLedger.reduce((total, entry) => total + entry.amountUsd, 0)),
  });
}

async function updateState(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
  now: () => Date,
  patch: Partial<Omit<LocalRealCampaignState, "revision" | "updatedAt">>,
): Promise<LocalRealCampaignState> {
  const next: LocalRealCampaignState = {
    ...state,
    ...patch,
    revision: state.revision + 1,
    updatedAt: now().toISOString(),
  };
  await writeLocalRealState(paths, next);
  return next;
}

async function requestedStopReason(
  paths: LocalRealCampaignPaths,
  shouldStop: (() => boolean) | undefined,
  maximumCompletedExperiments: number | undefined,
  completedThisInvocation: number,
): Promise<string | null> {
  if (maximumCompletedExperiments !== undefined) {
    if (!Number.isSafeInteger(maximumCompletedExperiments) || maximumCompletedExperiments < 1) {
      throw new Error("Maximum completed experiments must be a positive integer");
    }
    if (completedThisInvocation >= maximumCompletedExperiments) {
      return "requested-experiment-limit-reached";
    }
  }
  if (shouldStop?.() === true || (await hasLocalRealStopRequest(paths))) {
    return "operator-requested";
  }
  return null;
}

async function shouldStopNow(
  paths: LocalRealCampaignPaths,
  shouldStop: (() => boolean) | undefined,
): Promise<boolean> {
  return shouldStop?.() === true || (await hasLocalRealStopRequest(paths));
}

async function withActiveCancellation<Value>(
  paths: LocalRealCampaignPaths,
  operation: (signal: AbortSignal) => Promise<Value>,
): Promise<Value> {
  const controller = new AbortController();
  let checking = false;
  let finished = false;
  const check = async (): Promise<void> => {
    if (checking || finished || controller.signal.aborted) return;
    checking = true;
    try {
      const request = await readLocalRealStopRequest(paths);
      if (request?.mode === "cancel-active") controller.abort();
    } finally {
      checking = false;
    }
  };
  await check();
  const timer = setInterval(() => {
    void check();
  }, 500);
  timer.unref();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new LocalRealOperatorCancelledError({ cause: error });
    }
    throw error;
  } finally {
    finished = true;
    clearInterval(timer);
  }
}

function rethrowOperatorCancellation(error: unknown): void {
  if (error instanceof LocalRealOperatorCancelledError) throw error;
}

function budgetStopReason(
  budget: { readonly maximumCampaignCostUsd: number | null; readonly explicitlyUnbounded: boolean },
  totalCostUsd: number,
): string | null {
  if (budget.maximumCampaignCostUsd === null) {
    return budget.explicitlyUnbounded ? null : "campaign-budget-configuration-invalid";
  }
  return totalCostUsd >= budget.maximumCampaignCostUsd ? "campaign-cost-limit-reached" : null;
}

function assertBudgetAvailable(
  budget: { readonly maximumCampaignCostUsd: number | null; readonly explicitlyUnbounded: boolean },
  totalCostUsd: number,
): void {
  const reason = budgetStopReason(budget, totalCostUsd);
  if (reason !== null) throw new LocalRealRunnerPhaseError(reason);
}

function runResult(
  state: LocalRealCampaignState,
  completedThisInvocation: number,
  status: LocalRealRunResult["status"],
  reason: string,
): LocalRealRunResult {
  return {
    command: "real-run",
    campaignId: state.campaignId,
    status,
    completedThisInvocation,
    completedTotal: state.completedExperiments,
    promotions: state.promotions,
    championRevision: state.championRevision,
    totalCostUsd: state.totalCostUsd,
    nextExperimentNumber: state.nextExperimentNumber,
    reason,
    containsSecrets: false,
  };
}

function sameBooleanArray(left: readonly boolean[], right: readonly boolean[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

class LocalRealRunnerPhaseError extends Error {
  public readonly code: string;

  public constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "LocalRealRunnerPhaseError";
    this.code = code;
  }
}

class LocalRealOperatorCancelledError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Local real active phase was cancelled by the operator", options);
    this.name = "LocalRealOperatorCancelledError";
  }
}
