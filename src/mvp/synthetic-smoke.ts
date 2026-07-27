import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import { runMvpCampaignIterations } from "./campaign-driver.js";
import { MountedMvpCampaignStateStore } from "./campaign-state.js";
import {
  canonicalJson,
  type EvaluationEnvironment,
  MVP_SCHEMA_VERSION,
  type MvpExperimentArtifacts,
  type OptimizerInput,
  type PrivateEvaluationRequest,
  type SanitizedDiagnosticBrief,
  sha256,
} from "./contracts.js";
import { runMvpIteration } from "./loop.js";
import { MountedChampionCache } from "./mounted-champion-cache.js";
import { assertMountedRoot, readBoundedJson, withMountedLock } from "./mounted-files.js";
import { MountedHiddenTaskCatalog } from "./mounted-hidden-task-catalog.js";
import { validateMvpArtifact } from "./schemas.js";
import { selectFailureWeightedTasks } from "./selection.js";
import { FileExperimentArtifactStore } from "./store.js";

const SYNTHETIC_SMOKE_POLICY = "deterministic-no-model-smoke-v1" as const;
const SYNTHETIC_SMOKE_DOMAIN = "dark-factory.mvp-synthetic-smoke-receipt.v1" as const;
const SYNTHETIC_DATASET_REVISION = "synthetic-mvp-v1";
const BASELINE_REVISION = "a".repeat(40);
const FIRST_CANDIDATE_REVISION = "b".repeat(40);
const PROMOTED_CANDIDATE_REVISION = "c".repeat(40);
const INVALID_CANDIDATE_REVISION = "d".repeat(40);
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

const SyntheticSmokeReceiptSchema = Type.Object(
  {
    domain: Type.Literal(SYNTHETIC_SMOKE_DOMAIN),
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(SYNTHETIC_SMOKE_POLICY),
    status: Type.Literal("passed"),
    checks: Type.Object(
      {
        deterministicSelection: Type.Literal(true),
        matchedTaskCount: Type.Literal(5),
        repetitionsPerTask: Type.Literal(3),
        matchedCellCount: Type.Literal(15),
        retainedPanel: Type.Literal(true),
        initialCacheMisses: Type.Literal(15),
        retainedPanelCacheHits: Type.Literal(15),
        promotionRefreshes: Type.Literal(15),
        promotionSeededEntries: Type.Literal(15),
        promotionEvidenceFresh: Type.Literal(true),
        persistedExperimentCount: Type.Literal(3),
        persistedCampaignRevision: Type.Literal(2),
        infrastructureInvalidWeightingIgnored: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    containsTaskIdentifiers: Type.Literal(false),
    containsTaskNames: Type.Literal(false),
    containsTaskLiterals: Type.Literal(false),
    containsPerTaskOutcomes: Type.Literal(false),
    containsGraderMaterial: Type.Literal(false),
  },
  { additionalProperties: false },
);

const validateSyntheticSmokeReceipt = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile(SyntheticSmokeReceiptSchema);

export interface MvpNoModelSyntheticSmokeReceipt {
  readonly domain: typeof SYNTHETIC_SMOKE_DOMAIN;
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof SYNTHETIC_SMOKE_POLICY;
  readonly status: "passed";
  readonly checks: {
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
  };
  readonly containsTaskIdentifiers: false;
  readonly containsTaskNames: false;
  readonly containsTaskLiterals: false;
  readonly containsPerTaskOutcomes: false;
  readonly containsGraderMaterial: false;
}

export function parseMvpNoModelSyntheticSmokeReceipt(
  value: unknown,
): MvpNoModelSyntheticSmokeReceipt {
  if (!validateSyntheticSmokeReceipt(value)) {
    const details = (validateSyntheticSmokeReceipt.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    throw new Error(`MVP no-model synthetic smoke receipt is invalid: ${details}`);
  }
  return value as MvpNoModelSyntheticSmokeReceipt;
}

/**
 * Runs the MVP control loop entirely against deterministic, source-owned
 * fixtures. The only side effects are temporary files below the supplied
 * mounted root; they are removed before this function returns.
 *
 * This smoke deliberately has no provider, model, Git, benchmark, or Harbor
 * process adapter. Any failed invariant rejects instead of returning a
 * partially successful receipt.
 */
export async function runMvpNoModelSyntheticSmoke(
  mountedRoot: string,
): Promise<MvpNoModelSyntheticSmokeReceipt> {
  assertMountedRoot(mountedRoot);
  return withMountedLock(mountedRoot, "no-model-synthetic-smoke", async () => {
    await mkdir(mountedRoot, { recursive: true, mode: 0o700 });
    const workingRoot = await mkdtemp(join(mountedRoot, ".no-model-synthetic-smoke-"));
    try {
      return await executeSyntheticSmoke(workingRoot);
    } finally {
      await rm(workingRoot, { recursive: true, force: true });
    }
  });
}

/**
 * Runs the same deterministic smoke while retaining its campaign, experiment,
 * cache, catalog, and state artifacts below an operator-owned run directory.
 *
 * Unlike {@link runMvpNoModelSyntheticSmoke}, this function deliberately does
 * not remove the working tree after completion. Callers must therefore supply
 * a unique absolute directory and own its retention policy.
 */
export async function runMvpNoModelSyntheticSmokePersistent(
  workingRoot: string,
): Promise<MvpNoModelSyntheticSmokeReceipt> {
  assertMountedRoot(workingRoot);
  return withMountedLock(workingRoot, "no-model-synthetic-smoke", async () => {
    await mkdir(workingRoot, { recursive: true, mode: 0o700 });
    return executeSyntheticSmoke(workingRoot);
  });
}

async function executeSyntheticSmoke(
  workingRoot: string,
): Promise<MvpNoModelSyntheticSmokeReceipt> {
  const definitions = syntheticTaskDefinitions();
  const campaignRoot = join(workingRoot, "campaign");
  const campaignCatalog = new MountedHiddenTaskCatalog(
    join(campaignRoot, "catalog"),
    sha256("synthetic-smoke-campaign-namespace"),
  );
  await campaignCatalog.initialize({
    datasetRevision: SYNTHETIC_DATASET_REVISION,
    definitions,
  });

  const initialProfiles = await campaignCatalog.list();
  const forwardSelection = selectFailureWeightedTasks(initialProfiles);
  const reverseSelection = selectFailureWeightedTasks([...initialProfiles].reverse());
  assertSmoke(
    canonicalJson(forwardSelection.map((task) => task.handle)) ===
      canonicalJson(reverseSelection.map((task) => task.handle)),
    "selection replay changed with catalog order",
  );

  const privateMaterial = [
    ...initialProfiles.flatMap((profile) => [
      profile.handle,
      profile.revisionDigest,
      ...profile.sensitiveLiterals,
    ]),
    ...definitions.flatMap((definition) => [
      definition.harborTaskLocator,
      definition.revisionDigest,
      ...definition.sensitiveLiterals,
    ]),
  ];
  const capturedCampaignArtifacts: MvpExperimentArtifacts[] = [];
  const campaignBatchSizes: number[] = [];
  const campaignArtifactStore = new FileExperimentArtifactStore(join(campaignRoot, "experiments"));
  const campaignStateStore = new MountedMvpCampaignStateStore(join(campaignRoot, "state"));
  const campaignReceipts = await runMvpCampaignIterations({
    stateStore: campaignStateStore,
    campaignId: "synthetic-smoke",
    frozenBaselineRevision: BASELINE_REVISION,
    slugs: ["synthetic-screen", "synthetic-promotion"],
    environment: syntheticEnvironment(),
    loopPorts: {
      optimizer: {
        propose: async (input) => {
          assertOptimizerInputTaskFree(input, privateMaterial);
          const candidateRevision =
            input.experimentNumber === 1
              ? FIRST_CANDIDATE_REVISION
              : input.experimentNumber === 2
                ? PROMOTED_CANDIDATE_REVISION
                : null;
          assertSmoke(candidateRevision !== null, "optimizer received an unexpected iteration");
          return {
            hypothesisId: `synthetic-change-${input.experimentNumber}`,
            hypothesisSummary: "Exercise deterministic control-plane behavior.",
            interventionSummary: "Use a source-owned synthetic candidate.",
            candidateRevision,
            changedFiles: ["synthetic/control-plane-policy.txt"],
          };
        },
      },
      taskCatalog: campaignCatalog,
      evaluator: {
        evaluateBatch: async (requests) => {
          campaignBatchSizes.push(requests.length);
          return requests.map((request) =>
            freshSyntheticObservation(request, campaignReward(request), true),
          );
        },
      },
      sanitizer: {
        sanitize: async () => emptyDiagnosticBrief(),
      },
      championCache: new MountedChampionCache(join(campaignRoot, "cache")),
      artifacts: {
        persist: async (artifacts) => {
          capturedCampaignArtifacts.push(artifacts);
          return campaignArtifactStore.persist(artifacts);
        },
      },
      now: fixedNow,
    },
    now: fixedNow,
  });

  assertSmoke(campaignReceipts.length === 2, "campaign did not complete two iterations");
  const screenReceipt = campaignReceipts[0];
  const promotionReceipt = campaignReceipts[1];
  assertSmoke(
    screenReceipt?.disposition === "inconclusive" &&
      screenReceipt.cache.hits === 0 &&
      screenReceipt.cache.misses === 15,
    "initial cache screen did not produce fifteen misses",
  );
  assertSmoke(
    promotionReceipt?.disposition === "promote" &&
      promotionReceipt.cache.hits === 15 &&
      promotionReceipt.cache.misses === 0 &&
      promotionReceipt.cache.refreshedForPromotion === 15 &&
      promotionReceipt.cache.seededFromPromotion === 15 &&
      promotionReceipt.evidenceFresh,
    "cached promotion did not refresh and seed fifteen fresh cells",
  );
  assertSmoke(
    canonicalJson(campaignBatchSizes) === canonicalJson([30, 15, 15]),
    "campaign evaluation batches did not follow miss, hit, and refresh behavior",
  );

  const firstArtifacts = capturedCampaignArtifacts[0];
  const secondArtifacts = capturedCampaignArtifacts[1];
  assertSmoke(
    firstArtifacts !== undefined && secondArtifacts !== undefined,
    "campaign artifacts were not captured",
  );
  assertMatchedPanel(firstArtifacts);
  assertMatchedPanel(secondArtifacts);
  assertSmoke(
    canonicalJson(firstArtifacts.privateSelection.tasks.map((task) => task.handle)) ===
      canonicalJson(secondArtifacts.privateSelection.tasks.map((task) => task.handle)),
    "nonpromotion did not retain the exact hidden panel",
  );
  assertSmoke(
    canonicalJson(firstArtifacts.privateSelection.tasks.map((task) => task.handle)) ===
      canonicalJson(forwardSelection.map((task) => task.handle)),
    "loop selection differed from the deterministic selector",
  );

  await validatePersistedArtifacts(join(campaignRoot, "experiments"), "001-synthetic-screen");
  await validatePersistedArtifacts(join(campaignRoot, "experiments"), "002-synthetic-promotion");
  const persistedCampaignState = await campaignStateStore.load();
  assertSmoke(
    persistedCampaignState.revision === 2 &&
      persistedCampaignState.previousOutcome === "promote" &&
      persistedCampaignState.championRevision === PROMOTED_CANDIDATE_REVISION &&
      persistedCampaignState.retainedTaskHandles === null,
    "persisted campaign state did not record the fresh promotion",
  );

  const invalidRoot = join(workingRoot, "infrastructure-invalid");
  const invalidCatalog = new MountedHiddenTaskCatalog(
    join(invalidRoot, "catalog"),
    sha256("synthetic-smoke-invalid-namespace"),
  );
  await invalidCatalog.initialize({
    datasetRevision: SYNTHETIC_DATASET_REVISION,
    definitions,
  });
  const profilesBeforeInvalidEvidence = await invalidCatalog.list();
  const selectionBeforeInvalidEvidence = selectFailureWeightedTasks(profilesBeforeInvalidEvidence);
  const invalidBatchSizes: number[] = [];
  const invalidArtifactStore = new FileExperimentArtifactStore(join(invalidRoot, "experiments"));
  const invalidResult = await runMvpIteration(
    {
      optimizer: {
        propose: async (input) => {
          assertOptimizerInputTaskFree(input, privateMaterial);
          return {
            hypothesisId: "synthetic-invalid-infrastructure",
            hypothesisSummary: "Exercise infrastructure-invalid evidence handling.",
            interventionSummary: "Keep task weighting unchanged when infrastructure is invalid.",
            candidateRevision: INVALID_CANDIDATE_REVISION,
            changedFiles: ["synthetic/control-plane-policy.txt"],
          };
        },
      },
      taskCatalog: invalidCatalog,
      evaluator: {
        evaluateBatch: async (requests) => {
          invalidBatchSizes.push(requests.length);
          return requests.map((request, index) =>
            freshSyntheticObservation(request, 0.5, index !== 0),
          );
        },
      },
      sanitizer: {
        sanitize: async () => emptyDiagnosticBrief(),
      },
      championCache: new MountedChampionCache(join(invalidRoot, "cache")),
      artifacts: invalidArtifactStore,
      now: fixedNow,
    },
    {
      experimentNumber: 1,
      slug: "synthetic-infrastructure",
      championRevision: BASELINE_REVISION,
      environment: syntheticEnvironment(),
      previousOutcome: null,
      previousDiagnosticBrief: null,
    },
  );
  assertSmoke(
    invalidResult.decision.disposition === "inconclusive" &&
      invalidResult.decision.reason === "incomplete-or-invalid-evidence" &&
      canonicalJson(invalidBatchSizes) === canonicalJson([30]),
    "infrastructure-invalid evidence was not quarantined",
  );
  const profilesAfterInvalidEvidence = await invalidCatalog.list();
  const selectionAfterInvalidEvidence = selectFailureWeightedTasks(profilesAfterInvalidEvidence);
  assertSmoke(
    canonicalJson(profilesBeforeInvalidEvidence) === canonicalJson(profilesAfterInvalidEvidence) &&
      canonicalJson(selectionBeforeInvalidEvidence) ===
        canonicalJson(selectionAfterInvalidEvidence),
    "infrastructure-invalid evidence changed task weighting",
  );
  await validatePersistedArtifacts(
    join(invalidRoot, "experiments"),
    "001-synthetic-infrastructure",
  );

  const receipt: MvpNoModelSyntheticSmokeReceipt = {
    domain: SYNTHETIC_SMOKE_DOMAIN,
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: SYNTHETIC_SMOKE_POLICY,
    status: "passed",
    checks: {
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
    },
    containsTaskIdentifiers: false,
    containsTaskNames: false,
    containsTaskLiterals: false,
    containsPerTaskOutcomes: false,
    containsGraderMaterial: false,
  };
  parseMvpNoModelSyntheticSmokeReceipt(receipt);
  assertNoPrivateMaterial(JSON.stringify(receipt), privateMaterial);
  assertSmoke(
    !/[a-f0-9]{64}/u.test(JSON.stringify(receipt)),
    "receipt contains a digest-shaped identifier",
  );
  return receipt;
}

function assertMatchedPanel(artifacts: MvpExperimentArtifacts): void {
  const tasks = artifacts.privateSelection.tasks;
  const cells = artifacts.privateSelection.cells;
  assertSmoke(
    tasks.length === 5 && new Set(tasks.map((task) => task.handle)).size === 5,
    "selection did not contain five distinct hidden tasks",
  );
  assertSmoke(
    cells.length === 15 && new Set(cells.map((cell) => cell.cellId)).size === 15,
    "selection did not contain fifteen distinct matched cells",
  );
  assertSmoke(
    tasks.every(
      (task) =>
        cells.filter((cell) => cell.task.handle === task.handle).length === 3 &&
        [1, 2, 3].every((repetition) =>
          cells.some((cell) => cell.task.handle === task.handle && cell.repetition === repetition),
        ),
    ),
    "selection did not contain three repetitions per hidden task",
  );
}

async function validatePersistedArtifacts(root: string, experimentId: string): Promise<void> {
  const directory = join(root, experimentId);
  const manifest = await readBoundedJson(join(directory, "experiment.json"));
  const selection = await readBoundedJson(join(directory, "private", "selection.json"));
  validateMvpArtifact("manifest", manifest);
  validateMvpArtifact("privateSelection", selection);
}

function assertOptimizerInputTaskFree(
  input: OptimizerInput,
  privateMaterial: readonly string[],
): void {
  assertNoPrivateMaterial(JSON.stringify(input), privateMaterial);
  assertSmoke(
    !input.boundary.taskCatalogVisible &&
      !input.boundary.taskIdentifiersVisible &&
      !input.boundary.taskPromptsVisible &&
      !input.boundary.graderVisible &&
      !input.boundary.rawTracesVisible &&
      !input.boundary.taskSpecificFeedbackVisible,
    "optimizer boundary exposed private evaluation material",
  );
}

function assertNoPrivateMaterial(value: string, privateMaterial: readonly string[]): void {
  assertSmoke(
    privateMaterial.every((literal) => !value.includes(literal)),
    "task-private material crossed a task-free boundary",
  );
}

function campaignReward(request: PrivateEvaluationRequest): number {
  if (request.arm === "champion" || request.harnessRevision === FIRST_CANDIDATE_REVISION) {
    return 0.5;
  }
  if (request.harnessRevision === PROMOTED_CANDIDATE_REVISION) {
    return 1;
  }
  throw new Error("Synthetic evaluator received an unexpected harness revision");
}

function freshSyntheticObservation(
  request: PrivateEvaluationRequest,
  reward: number,
  infrastructureValid: boolean,
) {
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
    source: "fresh" as const,
    passed: reward > 0.5,
    reward,
    infrastructureValid,
    durationMs: 1,
    evaluatedAt: FIXED_TIME,
    traceArtifactRefs: ["private/synthetic-trace.json"],
    rawDiagnostics: [],
  };
}

function syntheticEnvironment(): EvaluationEnvironment {
  return {
    terminalBenchVersion: "synthetic-v1",
    datasetRevision: SYNTHETIC_DATASET_REVISION,
    graderProtocolVersion: "synthetic-v1",
    evaluatorVersion: "synthetic-v1",
    modelProvider: "synthetic",
    modelDeployment: "no-model",
    reasoningEffort: "none",
    samplingSettingsDigest: sha256("synthetic-sampling-settings"),
    contextSettingsDigest: sha256("synthetic-context-settings"),
    sandboxProvider: "mounted-state",
    sandboxRegion: "isolated",
    imageDigest: sha256("synthetic-image"),
    architecture: "x86_64",
    resourcesDigest: sha256("synthetic-resources"),
    networkPolicyDigest: sha256("synthetic-no-network"),
    harnessConfigDigest: sha256("synthetic-harness"),
    extraConfigDigest: sha256("synthetic-extra-config"),
  };
}

function syntheticTaskDefinitions() {
  return Array.from({ length: 8 }, (_, index) => ({
    harborTaskLocator: `synthetic/private-case-${index}`,
    revisionDigest: sha256(`synthetic-task-revision-${index}`),
    difficulty:
      index === 7 ? ("easy" as const) : index < 4 ? ("hard" as const) : ("medium" as const),
    easyCanary: index === 7,
    baselineFailureRate: Math.max(0.2, 0.9 - index * 0.08),
    baselineProvenance: {
      kind: "trusted-measurement" as const,
      sourceDigest: sha256("synthetic-baseline-provenance"),
      datasetRevision: SYNTHETIC_DATASET_REVISION,
    },
    graderIsolation: {
      verifierEnvironmentMode: "separate" as const,
      allStepVerifierEnvironmentModesSeparate: true as const,
      sourceDigest: sha256("synthetic-grader-isolation"),
    },
    leaderboard: {
      kind: "comparable-measurement" as const,
      failureRate: Math.max(0.2, 0.85 - index * 0.07),
      sourceDigest: sha256("synthetic-leaderboard-provenance"),
      datasetRevision: SYNTHETIC_DATASET_REVISION,
    },
    initialFailureRate: Math.max(0.2, 0.88 - index * 0.075),
    uncertainty: index === 7 ? 0.4 : 0.55,
    normalizedCost: Math.min(0.9, 0.2 + index * 0.05),
    sensitiveLiterals: [`synthetic-private-literal-${index}`],
  }));
}

function emptyDiagnosticBrief(): SanitizedDiagnosticBrief {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "closed-vocabulary-task-free-v1",
    cards: [],
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderSecrets: false,
    containsPerTaskOutcomes: false,
  };
}

function fixedNow(): Date {
  return new Date(FIXED_TIME);
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`MVP no-model synthetic smoke failed: ${message}`);
  }
}
