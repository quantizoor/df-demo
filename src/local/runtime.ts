import type { MvpNoModelSyntheticSmokeReceipt } from "../mvp/synthetic-smoke.js";
import { runMvpNoModelSyntheticSmokePersistent } from "../mvp/synthetic-smoke.js";
import {
  createLocalRunDirectory,
  type LocalLatestRun,
  type LocalRunSummary,
  persistSuccessfulLocalRun,
} from "./state.js";

export interface LocalRunResult {
  readonly command: "run";
  readonly status: "passed";
  readonly latest: LocalLatestRun;
  readonly summary: LocalRunSummary;
}

export interface LocalRunDependencies {
  readonly now?: () => Date;
  readonly runSynthetic?: (runDirectory: string) => Promise<MvpNoModelSyntheticSmokeReceipt>;
}

export async function runLocalSyntheticCampaign(
  stateRoot: string,
  dependencies: LocalRunDependencies = {},
): Promise<LocalRunResult> {
  const now = dependencies.now ?? (() => new Date());
  const runSynthetic = dependencies.runSynthetic ?? runMvpNoModelSyntheticSmokePersistent;
  const started = now();
  const { runId, runDirectory } = await createLocalRunDirectory(stateRoot, started);
  const receipt = await runSynthetic(runDirectory);
  const completed = now();
  const { latest, summary } = await persistSuccessfulLocalRun(
    stateRoot,
    runId,
    runDirectory,
    started.toISOString(),
    completed.toISOString(),
    receipt,
  );
  return {
    command: "run",
    status: "passed",
    latest,
    summary,
  };
}
