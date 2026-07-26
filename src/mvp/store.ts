import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ExperimentArtifactStorePort,
  MvpExperimentArtifacts,
} from "./contracts.js";
import { validateMvpExperimentArtifacts } from "./schemas.js";

const PUBLIC_FILES = {
  manifest: "experiment.json",
  optimizerInput: "optimizer-input.json",
  hypothesis: "hypothesis.json",
  diagnostics: "diagnostics.json",
  decision: "decision.json",
  state: "state.json",
} as const;

const PRIVATE_FILES = {
  privateSelection: "selection.json",
  privateEvaluations: "evaluations.json",
  privateCache: "cache.json",
} as const;

/**
 * Writes one immutable, atomically-published experiment directory. The caller
 * must mount `rootDirectory` only into trusted controller/evaluator sandboxes;
 * optimizer sandboxes receive optimizer-input.json by value, never this path.
 */
export class FileExperimentArtifactStore implements ExperimentArtifactStorePort {
  public constructor(private readonly rootDirectory: string) {
    if (!isAbsolute(rootDirectory)) {
      throw new Error("MVP experiment root must be an absolute mounted path");
    }
  }

  public async persist(artifacts: MvpExperimentArtifacts): Promise<string> {
    validateMvpExperimentArtifacts(artifacts);
    const finalDirectory = join(this.rootDirectory, artifacts.manifest.experimentId);
    const temporaryDirectory = join(
      this.rootDirectory,
      `.tmp-${artifacts.manifest.experimentId}-${randomUUID()}`,
    );
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await mkdir(join(temporaryDirectory, "private"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await Promise.all([
        ...Object.entries(PUBLIC_FILES).map(([key, filename]) =>
          writeJson(
            join(temporaryDirectory, filename),
            artifacts[key as keyof typeof PUBLIC_FILES],
            0o640,
          ),
        ),
        ...Object.entries(PRIVATE_FILES).map(([key, filename]) =>
          writeJson(
            join(temporaryDirectory, "private", filename),
            artifacts[key as keyof typeof PRIVATE_FILES],
            0o600,
          ),
        ),
      ]);
      await rename(temporaryDirectory, finalDirectory);
      return finalDirectory;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }
}

async function writeJson(path: string, value: unknown, mode: number): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode,
  });
}
