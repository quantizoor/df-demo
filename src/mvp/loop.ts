import {
  type CachedChampionObservation,
  type ChampionCacheKey,
  championCacheKey,
  evaluationEnvironmentDigest,
  type HiddenEvaluationCell,
  type HiddenTaskOutcomeUpdate,
  MVP_CACHE_POLICY,
  MVP_SCHEMA_VERSION,
  MVP_SELECTION_POLICY,
  type MvpExperimentArtifacts,
  type MvpIterationInput,
  type MvpIterationResult,
  type MvpLoopPorts,
  type OptimizerInput,
  type PrivateEvaluationObservation,
  type PrivateEvaluationRequest,
} from "./contracts.js";
import { decideMatchedComparison } from "./decision.js";
import { assertTaskFreeDiagnosticBrief } from "./privacy.js";
import {
  validateCandidateProposal,
  validateEvaluationEnvironment,
  validateMvpArtifact,
  validatePrivateObservation,
} from "./schemas.js";
import {
  buildMatchedCells,
  retainHiddenTaskPanel,
  selectFailureWeightedTasks,
} from "./selection.js";

export async function runMvpIteration(
  ports: MvpLoopPorts,
  input: MvpIterationInput,
): Promise<MvpIterationResult> {
  validateIterationInput(input);
  validateEvaluationEnvironment(input.environment);
  if (input.previousDiagnosticBrief !== null) {
    assertTaskFreeDiagnosticBrief(input.previousDiagnosticBrief, []);
  }
  const now = ports.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const experimentId = `${String(input.experimentNumber).padStart(3, "0")}-${input.slug}`;
  const optimizerInput = buildTaskFreeMvpOptimizerInput(input);

  // This call deliberately precedes catalog access. The optimizer cannot react
  // to the panel chosen for the same iteration.
  const proposal = await ports.optimizer.propose(optimizerInput);
  validateCandidateProposal(proposal);
  if (proposal.candidateRevision === input.championRevision) {
    throw new Error("Optimizer candidate must differ from the current champion");
  }

  const profiles = await ports.taskCatalog.list();
  const selectedTasks =
    input.retainedTaskHandles === undefined || input.retainedTaskHandles === null
      ? selectFailureWeightedTasks(profiles)
      : retainHiddenTaskPanel(profiles, input.retainedTaskHandles);
  const cells = buildMatchedCells(experimentId, selectedTasks);
  const environmentDigest = evaluationEnvironmentDigest(input.environment);

  const candidateRequests = cells.map((cell) => ({
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentId,
    cell,
    arm: "candidate" as const,
    harnessRevision: proposal.candidateRevision,
    environment: input.environment,
    environmentDigest,
  }));
  const championScreen = await Promise.all(
    cells.map(async (cell) => {
      const key = championCacheKey({
        task: cell.task,
        championRevision: input.championRevision,
        repetition: cell.repetition,
        environment: input.environment,
      });
      const cached = await ports.championCache.get(key);
      if (cached !== null && cached.infrastructureValid) {
        assertCacheHit(key, cached);
        return {
          cell,
          key,
          cacheStatus: "hit" as const,
          cached,
          request: null,
        };
      }
      return {
        cell,
        key,
        cacheStatus: "miss" as const,
        cached: null,
        request: {
          schemaVersion: MVP_SCHEMA_VERSION,
          experimentId,
          cell,
          arm: "champion" as const,
          harnessRevision: input.championRevision,
          environment: input.environment,
          environmentDigest,
        },
      };
    }),
  );
  const championMissRequests = championScreen.flatMap((item) =>
    item.request === null ? [] : [item.request],
  );
  const screeningFresh = await evaluateFreshBatch(ports, [
    ...candidateRequests,
    ...championMissRequests,
  ]);
  const screeningFreshByKey = observationMap(screeningFresh);
  const candidate = candidateRequests.map((request) =>
    requiredFreshObservation(screeningFreshByKey, request),
  );
  const screenedChampion = await Promise.all(
    championScreen.map(async (item) => {
      if (item.cached !== null) {
        return {
          cacheStatus: item.cacheStatus,
          observation: cachedToObservation(experimentId, item.cell, item.cached),
        };
      }
      if (item.request === null) {
        throw new Error("Champion cache miss has no evaluation request");
      }
      const observation = requiredFreshObservation(screeningFreshByKey, item.request);
      await ports.championCache.put(item.key, observationToCache(item.key, observation));
      return {
        cacheStatus: item.cacheStatus,
        observation,
      };
    }),
  );
  const screenChampion = screenedChampion.map((item) => item.observation);
  const cacheHits = cells
    .filter((_, index) => screenedChampion[index]?.cacheStatus === "hit")
    .map((cell) => cell.cellId);
  const cacheMisses = cells
    .filter((_, index) => screenedChampion[index]?.cacheStatus === "miss")
    .map((cell) => cell.cellId);

  const screenDecision = decideMatchedComparison({
    cells,
    candidate,
    champion: screenChampion,
    ...(input.requiredConfidence === undefined
      ? {}
      : { requiredConfidence: input.requiredConfidence }),
    ...(input.minimumAggregateDelta === undefined
      ? {}
      : { minimumAggregateDelta: input.minimumAggregateDelta }),
  });

  let finalChampion = screenChampion;
  if (screenDecision.reason === "fresh-evidence-required") {
    const refreshEntries = championScreen.filter(
      (_, index) => screenChampion[index]?.source === "champion-cache",
    );
    const refreshRequests = refreshEntries.map(
      ({ cell }): PrivateEvaluationRequest => ({
        schemaVersion: MVP_SCHEMA_VERSION,
        experimentId,
        cell,
        arm: "champion",
        harnessRevision: input.championRevision,
        environment: input.environment,
        environmentDigest,
      }),
    );
    const refreshed = await evaluateFreshBatch(ports, refreshRequests);
    const refreshedByKey = observationMap(refreshed);
    const refreshKeysByCell = new Map(refreshEntries.map((item) => [item.cell.cellId, item.key]));
    finalChampion = await Promise.all(
      cells.map(async (cell, index) => {
        const screened = screenChampion[index];
        if (screened === undefined) {
          throw new Error("Champion screening evidence is incomplete");
        }
        if (screened.source === "fresh") {
          return screened;
        }
        const request = refreshRequests.find(
          (candidateRequest) => candidateRequest.cell.cellId === cell.cellId,
        );
        const key = refreshKeysByCell.get(cell.cellId);
        if (request === undefined || key === undefined) {
          throw new Error("Champion refresh request is incomplete");
        }
        const observation = requiredFreshObservation(refreshedByKey, request);
        await ports.championCache.put(key, observationToCache(key, observation));
        return observation;
      }),
    );
  }
  const refreshedCellIds = cells
    .filter(
      (_, index) =>
        screenChampion[index]?.source === "champion-cache" &&
        finalChampion[index]?.source === "fresh",
    )
    .map((cell) => cell.cellId);

  const finalDecision = decideMatchedComparison({
    cells,
    candidate,
    champion: finalChampion,
    ...(input.requiredConfidence === undefined
      ? {}
      : { requiredConfidence: input.requiredConfidence }),
    ...(input.minimumAggregateDelta === undefined
      ? {}
      : { minimumAggregateDelta: input.minimumAggregateDelta }),
  });
  if (finalDecision.disposition === "promote" && !finalDecision.evidenceFresh) {
    throw new Error("Cached evidence cannot promote a candidate");
  }
  const seededFromPromotedCandidateCellIds =
    finalDecision.disposition === "promote"
      ? await Promise.all(
          cells.map(async (cell, index) => {
            const observation = candidate[index];
            if (observation === undefined) {
              throw new Error("Promoted candidate evidence is incomplete");
            }
            const key = championCacheKey({
              task: cell.task,
              championRevision: proposal.candidateRevision,
              repetition: cell.repetition,
              environment: input.environment,
            });
            await ports.championCache.put(key, observationToCache(key, observation));
            return cell.cellId;
          }),
        )
      : [];

  const diagnosticBrief = await ports.sanitizer.sanitize({
    candidate,
    champion: finalChampion,
  });
  const forbiddenLiterals = selectedTasks.flatMap((task) => [
    task.handle,
    task.revisionDigest,
    ...task.sensitiveLiterals,
  ]);
  assertTaskFreeDiagnosticBrief(diagnosticBrief, forbiddenLiterals);

  const completedAt = now().toISOString();
  const championAfter =
    finalDecision.disposition === "promote" ? proposal.candidateRevision : input.championRevision;
  const artifacts: MvpExperimentArtifacts = {
    manifest: {
      schemaVersion: MVP_SCHEMA_VERSION,
      experimentId,
      experimentNumber: input.experimentNumber,
      slug: input.slug,
      status: "completed",
      startedAt,
      completedAt,
      championBefore: input.championRevision,
      candidateRevision: proposal.candidateRevision,
      championAfter,
    },
    optimizerInput,
    hypothesis: {
      schemaVersion: MVP_SCHEMA_VERSION,
      experimentNumber: input.experimentNumber,
      ...proposal,
    },
    diagnostics: diagnosticBrief,
    decision: finalDecision,
    state: {
      schemaVersion: MVP_SCHEMA_VERSION,
      experimentNumber: input.experimentNumber,
      championBefore: input.championRevision,
      candidateRevision: proposal.candidateRevision,
      championAfter,
      finalDisposition: finalDecision.disposition,
      nextExperimentNumber: input.experimentNumber + 1,
      diagnosticFeedbackAvailable: diagnosticBrief.cards.length > 0,
      taskCatalogExposedToOptimizer: false,
      graderExposedToOptimizer: false,
    },
    privateSelection: {
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_SELECTION_POLICY,
      tasks: selectedTasks,
      cells,
    },
    privateEvaluations: {
      schemaVersion: MVP_SCHEMA_VERSION,
      screening: [...candidate, ...screenChampion],
      final: [...candidate, ...finalChampion],
    },
    privateCache: {
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: MVP_CACHE_POLICY,
      hitCellIds: cacheHits,
      missCellIds: cacheMisses,
      refreshedCellIds,
      seededFromPromotedCandidateCellIds,
    },
  };
  const artifactDirectory = await ports.artifacts.persist(artifacts);
  const outcomeEvidenceIsInfrastructureValid = [...candidate, ...finalChampion].every(
    (observation) => observation.infrastructureValid,
  );
  if (outcomeEvidenceIsInfrastructureValid) {
    await ports.taskCatalog.recordOutcomes(
      experimentId,
      outcomeUpdates(cells, candidate, finalChampion),
    );
  }

  return {
    experimentId,
    candidateRevision: proposal.candidateRevision,
    championRevision: championAfter,
    decision: finalDecision,
    diagnosticBrief,
    artifactDirectory,
    cache: {
      hits: cacheHits.length,
      misses: cacheMisses.length,
      refreshedForPromotion: refreshedCellIds.length,
      seededFromPromotion: seededFromPromotedCandidateCellIds.length,
    },
  };
}

export function buildTaskFreeMvpOptimizerInput(
  input: Pick<
    MvpIterationInput,
    "experimentNumber" | "championRevision" | "previousOutcome" | "previousDiagnosticBrief"
  >,
): OptimizerInput {
  if (!Number.isSafeInteger(input.experimentNumber) || input.experimentNumber < 1) {
    throw new Error("MVP experiment number must be a positive safe integer");
  }
  if (!/^[a-f0-9]{40,64}$/u.test(input.championRevision)) {
    throw new Error("Champion revision must be an immutable Git revision");
  }
  if (input.previousDiagnosticBrief !== null) {
    assertTaskFreeDiagnosticBrief(input.previousDiagnosticBrief, []);
  }
  const optimizerInput: OptimizerInput = {
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentNumber: input.experimentNumber,
    championRevision: input.championRevision,
    previousOutcome: input.previousOutcome,
    diagnosticBrief: input.previousDiagnosticBrief,
    boundary: {
      taskCatalogVisible: false,
      taskIdentifiersVisible: false,
      taskPromptsVisible: false,
      graderVisible: false,
      rawTracesVisible: false,
      taskSpecificFeedbackVisible: false,
    },
  };
  validateMvpArtifact("optimizerInput", optimizerInput);
  return optimizerInput;
}

async function evaluateFreshBatch(
  ports: MvpLoopPorts,
  requests: readonly PrivateEvaluationRequest[],
): Promise<readonly PrivateEvaluationObservation[]> {
  if (requests.length < 1 || requests.length > 30) {
    throw new Error("A trusted evaluation batch must contain between one and thirty requests");
  }
  const requestedKeys = new Set(requests.map((request) => evaluationRequestKey(request)));
  if (requestedKeys.size !== requests.length) {
    throw new Error("A trusted evaluation batch contains duplicate requests");
  }
  const observations = await ports.evaluator.evaluateBatch(requests);
  if (observations.length !== requests.length) {
    throw new Error("Trusted evaluator returned an incomplete or expanded batch");
  }
  const observationsByKey = observationMap(observations);
  if (observationsByKey.size !== requests.length) {
    throw new Error("Trusted evaluator returned duplicate observations");
  }
  for (const request of requests) {
    requiredFreshObservation(observationsByKey, request);
  }
  return observations;
}

function observationMap(
  observations: readonly PrivateEvaluationObservation[],
): ReadonlyMap<string, PrivateEvaluationObservation> {
  return new Map(
    observations.map((observation) => [`${observation.arm}:${observation.cellId}`, observation]),
  );
}

function evaluationRequestKey(request: PrivateEvaluationRequest): string {
  return `${request.arm}:${request.cell.cellId}`;
}

function requiredFreshObservation(
  observations: ReadonlyMap<string, PrivateEvaluationObservation>,
  request: PrivateEvaluationRequest,
): PrivateEvaluationObservation {
  const observation = observations.get(evaluationRequestKey(request));
  if (observation === undefined) {
    throw new Error("Trusted evaluator omitted a requested observation");
  }
  validatePrivateObservation(observation);
  if (
    observation.experimentId !== request.experimentId ||
    observation.cellId !== request.cell.cellId ||
    observation.taskHandle !== request.cell.task.handle ||
    observation.taskRevisionDigest !== request.cell.task.revisionDigest ||
    observation.repetition !== request.cell.repetition ||
    observation.arm !== request.arm ||
    observation.harnessRevision !== request.harnessRevision ||
    observation.environmentDigest !== request.environmentDigest ||
    observation.source !== "fresh"
  ) {
    throw new Error("Trusted evaluator returned evidence detached from its request");
  }
  return observation;
}

function cachedToObservation(
  experimentId: string,
  cell: HiddenEvaluationCell,
  cached: CachedChampionObservation,
): PrivateEvaluationObservation {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentId,
    cellId: cell.cellId,
    taskHandle: cell.task.handle,
    taskRevisionDigest: cell.task.revisionDigest,
    repetition: cell.repetition,
    arm: "champion",
    harnessRevision: cached.championRevision,
    environmentDigest: cached.environmentDigest,
    source: "champion-cache",
    passed: cached.passed,
    reward: cached.reward,
    infrastructureValid: cached.infrastructureValid,
    durationMs: cached.durationMs,
    evaluatedAt: cached.evaluatedAt,
    traceArtifactRefs: cached.traceArtifactRefs,
    rawDiagnostics: cached.rawDiagnostics,
  };
}

function observationToCache(
  key: ChampionCacheKey,
  observation: PrivateEvaluationObservation,
): CachedChampionObservation {
  return {
    keyDigest: key.keyDigest,
    taskHandle: key.taskHandle,
    taskRevisionDigest: key.taskRevisionDigest,
    championRevision: key.championRevision,
    repetition: key.repetition,
    environmentDigest: key.environmentDigest,
    passed: observation.passed,
    reward: observation.reward,
    infrastructureValid: observation.infrastructureValid,
    durationMs: observation.durationMs,
    evaluatedAt: observation.evaluatedAt,
    traceArtifactRefs: observation.traceArtifactRefs,
    rawDiagnostics: observation.rawDiagnostics,
  };
}

function assertCacheHit(key: ChampionCacheKey, cached: CachedChampionObservation): void {
  if (
    cached.keyDigest !== key.keyDigest ||
    cached.taskHandle !== key.taskHandle ||
    cached.taskRevisionDigest !== key.taskRevisionDigest ||
    cached.championRevision !== key.championRevision ||
    cached.repetition !== key.repetition ||
    cached.environmentDigest !== key.environmentDigest
  ) {
    throw new Error("Champion cache returned evidence for a different full environment");
  }
}

function outcomeUpdates(
  cells: readonly HiddenEvaluationCell[],
  candidate: readonly PrivateEvaluationObservation[],
  champion: readonly PrivateEvaluationObservation[],
): readonly HiddenTaskOutcomeUpdate[] {
  return cells
    .filter((cell) => cell.repetition === 1)
    .map((cell) => {
      const candidateTask = candidate.filter(
        (observation) => observation.taskHandle === cell.task.handle,
      );
      const championTask = champion.filter(
        (observation) => observation.taskHandle === cell.task.handle,
      );
      return {
        taskHandle: cell.task.handle,
        experimentId: candidateTask[0]?.experimentId ?? "",
        candidatePasses: candidateTask.filter((observation) => observation.passed).length,
        championPasses: championTask.filter((observation) => observation.passed).length,
        candidateMeanReward: mean(candidateTask.map((observation) => observation.reward)),
        championMeanReward: mean(championTask.map((observation) => observation.reward)),
        selected: true,
      };
    });
}

function validateIterationInput(input: MvpIterationInput): void {
  if (!Number.isSafeInteger(input.experimentNumber) || input.experimentNumber < 1) {
    throw new Error("MVP experiment number must be a positive safe integer");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.slug) || input.slug.length > 64) {
    throw new Error("MVP experiment slug must be short kebab-case");
  }
  if (!/^[a-f0-9]{40,64}$/u.test(input.championRevision)) {
    throw new Error("Champion revision must be an immutable Git revision");
  }
  const retainedTaskHandles = input.retainedTaskHandles ?? null;
  const requiresRetainedPanel =
    input.previousOutcome === "reject" || input.previousOutcome === "inconclusive";
  if (requiresRetainedPanel !== (retainedTaskHandles !== null)) {
    throw new Error(
      requiresRetainedPanel
        ? "Rejected or inconclusive iterations must retain the preceding hidden panel"
        : "First and post-promotion iterations must select a newly weighted hidden panel",
    );
  }
  if (
    retainedTaskHandles !== null &&
    (retainedTaskHandles.length !== 5 || new Set(retainedTaskHandles).size !== 5)
  ) {
    throw new Error("A retained hidden panel requires exactly five distinct opaque handles");
  }
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot aggregate an empty task outcome");
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}
