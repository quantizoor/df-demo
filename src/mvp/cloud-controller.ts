import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  type PreparedMvpOptimization,
  prepareNextMvpOptimization,
  type ReleaseSafeMvpCampaignReceipt,
  runPreparedMvpCampaignIteration,
} from "./campaign-driver.js";
import { MountedMvpCampaignStateStore } from "./campaign-state.js";
import {
  type CandidateProposal,
  canonicalJson,
  type EvaluationEnvironment,
  type MvpLoopPorts,
  type OptimizerInput,
  sha256,
} from "./contracts.js";
import { MountedChampionCache } from "./mounted-champion-cache.js";
import { validateCandidateProposal, validateEvaluationEnvironment } from "./schemas.js";
import { FileExperimentArtifactStore } from "./store.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40,64}$/u;
const SAFE_CAMPAIGN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export class MvpCloudControllerError extends Error {
  override readonly name = "MvpCloudControllerError";
}

export interface MvpEvaluatorRuntimeBinding {
  readonly environment: EvaluationEnvironment;
  readonly taskCatalog: MvpLoopPorts["taskCatalog"];
  readonly evaluator: MvpLoopPorts["evaluator"];
  readonly sanitizer: MvpLoopPorts["sanitizer"];
}

export interface MvpCloudControllerInput {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly baselineChampionRevision: string;
  readonly slug: string;
  readonly proposal: CandidateProposal;
  readonly expectedOptimizerInputSha256: string;
  readonly runtime: MvpEvaluatorRuntimeBinding;
  readonly now?: () => Date;
}

/**
 * Initializes the evaluator-private campaign if needed and releases only the
 * task-free optimizer input. Hidden catalog, cache, artifacts, and retained
 * panel state never leave the evaluator volume.
 */
export async function prepareMvpOptimizerInput(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly baselineChampionRevision: string;
  readonly now?: () => Date;
}): Promise<OptimizerInput> {
  assertIdentity(input);
  const roots = await mountedRoots(input.stateRoot);
  const now = input.now ?? (() => new Date());
  const stateStore = new MountedMvpCampaignStateStore(roots.campaign);
  await stateStore.initialize({
    campaignId: input.campaignId,
    frozenBaselineRevision: input.baselineChampionRevision,
    initializedAt: now().toISOString(),
  });
  return (await prepareNextMvpOptimization(stateStore)).optimizerInput;
}

/**
 * Executes exactly one matched MVP iteration against the evaluator-private
 * state. A success value is the shared release-safe campaign receipt produced
 * only after Harbor evidence, cache, artifacts, catalog outcomes, and campaign
 * continuity have all been committed.
 */
export async function runMvpCloudControllerIteration(
  input: MvpCloudControllerInput,
): Promise<ReleaseSafeMvpCampaignReceipt> {
  assertIdentity(input);
  if (!SAFE_SLUG.test(input.slug) || !SHA256.test(input.expectedOptimizerInputSha256)) {
    throw new MvpCloudControllerError("The MVP iteration identity is invalid.");
  }
  validateCandidateProposal(input.proposal);
  validateEvaluationEnvironment(input.runtime.environment);

  const roots = await mountedRoots(input.stateRoot);
  const now = input.now ?? (() => new Date());
  const stateStore = new MountedMvpCampaignStateStore(roots.campaign);
  await stateStore.initialize({
    campaignId: input.campaignId,
    frozenBaselineRevision: input.baselineChampionRevision,
    initializedAt: now().toISOString(),
  });
  const prepared = await prepareNextMvpOptimization(stateStore);
  assertPreparedInputBinding(prepared, input.expectedOptimizerInputSha256);

  return runPreparedMvpCampaignIteration({
    stateStore,
    prepared,
    proposal: input.proposal,
    slug: input.slug,
    environment: input.runtime.environment,
    loopPorts: {
      taskCatalog: input.runtime.taskCatalog,
      evaluator: input.runtime.evaluator,
      sanitizer: input.runtime.sanitizer,
      championCache: new MountedChampionCache(roots.championCache),
      artifacts: new FileExperimentArtifactStore(roots.experiments),
      now,
    },
    now,
  });
}

function assertIdentity(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly baselineChampionRevision: string;
}): void {
  if (
    input.stateRoot !== "/workspace/df-state" ||
    !SAFE_CAMPAIGN.test(input.campaignId) ||
    !REVISION.test(input.baselineChampionRevision)
  ) {
    throw new MvpCloudControllerError("The MVP campaign identity is invalid.");
  }
}

async function mountedRoots(stateRoot: string): Promise<{
  readonly campaign: string;
  readonly championCache: string;
  readonly experiments: string;
}> {
  const privateRoot = join(stateRoot, "private");
  const roots = {
    campaign: join(privateRoot, "campaign"),
    championCache: join(privateRoot, "champion-cache"),
    experiments: join(stateRoot, "experiments"),
  };
  await Promise.all([
    mkdir(roots.campaign, { recursive: true, mode: 0o700 }),
    mkdir(roots.championCache, {
      recursive: true,
      mode: 0o700,
    }),
    mkdir(roots.experiments, { recursive: true, mode: 0o700 }),
  ]);
  return roots;
}

function assertPreparedInputBinding(
  prepared: PreparedMvpOptimization,
  expectedSha256: string,
): void {
  if (sha256(canonicalJson(prepared.optimizerInput)) !== expectedSha256) {
    throw new MvpCloudControllerError("The prepared optimizer input changed before evaluation.");
  }
}
