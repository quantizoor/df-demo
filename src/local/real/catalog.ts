import { createHash } from "node:crypto";

import {
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealCatalog,
  type LocalRealDifficulty,
  type LocalRealTask,
} from "./contracts.js";

export const DEFAULT_HARBOR_REGISTRY_URL =
  "https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json";

interface LegacyRegistryTask {
  readonly name: string;
  readonly git_url: string;
  readonly git_commit_id: string;
  readonly path: string;
}

interface LegacyRegistryDataset {
  readonly name: string;
  readonly version: string;
  readonly tasks: readonly LegacyRegistryTask[];
}

export async function bootstrapTerminalBenchCatalog(input: {
  readonly generatedAt: string;
  readonly registryUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}): Promise<LocalRealCatalog> {
  const registryUrl = input.registryUrl ?? DEFAULT_HARBOR_REGISTRY_URL;
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const response = await fetchImplementation(registryUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Harbor registry request failed with status ${response.status}`);
  }
  const registryText = await response.text();
  if (Buffer.byteLength(registryText, "utf8") > 16 * 1024 * 1024) {
    throw new Error("Harbor registry response is oversized");
  }
  const parsed = JSON.parse(registryText) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Harbor registry response is not a dataset list");
  }
  const dataset = parsed.find(
    (item) => isRecord(item) && item["name"] === "terminal-bench" && item["version"] === "2.0",
  ) as LegacyRegistryDataset | undefined;
  if (dataset === undefined || !Array.isArray(dataset.tasks) || dataset.tasks.length < 5) {
    throw new Error("Harbor registry does not contain Terminal-Bench 2.0");
  }
  const registryTasks = dataset.tasks.map(parseRegistryTask);
  if (new Set(registryTasks.map((task) => task.name)).size !== registryTasks.length) {
    throw new Error("Terminal-Bench registry contains duplicate task names");
  }

  const tasks: LocalRealTask[] = [];
  for (let offset = 0; offset < registryTasks.length; offset += 8) {
    const batch = registryTasks.slice(offset, offset + 8);
    tasks.push(
      ...(await Promise.all(
        batch.map(async (task) => ({
          name: task.name,
          difficulty: await fetchTaskDifficulty(fetchImplementation, task),
          sourceRepository: task.git_url,
          sourceRevision: task.git_commit_id,
          sourcePath: task.path,
          empiricalFailureRate: 0,
          selections: 0,
        })),
      )),
    );
  }
  tasks.sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    dataset: {
      name: "terminal-bench",
      version: "2.0",
      registryUrl,
      registrySha256: sha256(registryText),
    },
    generatedAt: input.generatedAt,
    tasks,
    containsTaskPrompts: false,
    containsSolutions: false,
  };
}

async function fetchTaskDifficulty(
  fetchImplementation: typeof fetch,
  task: LegacyRegistryTask,
): Promise<LocalRealDifficulty> {
  const repository = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(task.git_url);
  if (repository === null) {
    throw new Error("Terminal-Bench task repository is not an expected GitHub URL");
  }
  const owner = repository[1];
  const name = repository[2];
  if (owner === undefined || name === undefined) {
    throw new Error("Terminal-Bench task repository identity is missing");
  }
  const url = `https://raw.githubusercontent.com/${owner}/${name}/${task.git_commit_id}/${task.path}/task.toml`;
  const response = await fetchImplementation(url, {
    headers: { accept: "text/plain" },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `Terminal-Bench metadata request for ${task.name} failed with status ${response.status}`,
    );
  }
  const metadata = await response.text();
  if (Buffer.byteLength(metadata, "utf8") > 256 * 1024) {
    throw new Error("Terminal-Bench task metadata is oversized");
  }
  const match = /^\s*difficulty\s*=\s*"(easy|medium|hard)"\s*$/mu.exec(metadata);
  if (match?.[1] !== "easy" && match?.[1] !== "medium" && match?.[1] !== "hard") {
    throw new Error(`Terminal-Bench task ${task.name} has no supported difficulty`);
  }
  return match[1];
}

function parseRegistryTask(value: unknown): LegacyRegistryTask {
  if (
    !isRecord(value) ||
    typeof value["name"] !== "string" ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(value["name"]) ||
    typeof value["git_url"] !== "string" ||
    typeof value["git_commit_id"] !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value["git_commit_id"]) ||
    typeof value["path"] !== "string" ||
    value["path"] !== value["name"]
  ) {
    throw new Error("Terminal-Bench registry task is malformed");
  }
  return {
    name: value["name"],
    git_url: value["git_url"],
    git_commit_id: value["git_commit_id"],
    path: value["path"],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
