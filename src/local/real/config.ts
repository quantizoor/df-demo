import { constants } from "node:fs";
import { access, lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { bootstrapTerminalBenchCatalog } from "./catalog.js";
import {
  LOCAL_REAL_EVALUATION_CONCURRENCY,
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealCampaignConfig,
  type LocalRealCatalog,
} from "./contracts.js";
import { runLocalProcessChecked } from "./process.js";
import {
  initializeLocalRealCampaign,
  loadLocalRealCampaign,
  localRealCampaignPaths,
  readLocalRealArtifact,
} from "./state.js";

const EXPECTED_PI_ORIGINS = new Set([
  "git@github.com:parallaxai/df-pi-tbench.git",
  "https://github.com/parallaxai/df-pi-tbench.git",
]);

export interface LocalFoundryCredentials {
  readonly baseUrl: string;
  readonly resourceName: string;
  readonly optimizerDeployment: "claude-opus-5";
  readonly evaluatedDeployment: "claude-opus-4-8";
  readonly apiKey: string;
}

export interface InitializeLocalRealCampaignInput {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly piRepository: string;
  readonly credentialsFile: string;
  readonly claudeExecutable: string;
  readonly maximumCampaignCostUsd?: number;
  readonly allowUnboundedCost?: boolean;
  readonly now?: () => Date;
  readonly catalog?: LocalRealCatalog;
}

export interface InitializeLocalRealCampaignResult {
  readonly command: "real-init";
  readonly status: "initialized" | "already-initialized";
  readonly campaignId: string;
  readonly campaignDirectory: string;
  readonly baselineRevision: string;
  readonly taskCount: number;
  readonly maximumCampaignCostUsd: number | null;
  readonly containsSecrets: false;
}

export async function initializeLocalRealOptimization(
  input: InitializeLocalRealCampaignInput,
): Promise<InitializeLocalRealCampaignResult> {
  if (!isAbsolute(input.stateRoot)) {
    throw new Error("Local real state root must be absolute");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.campaignId) || input.campaignId.length > 64) {
    throw new Error("Real campaign ID must be lowercase kebab-case");
  }
  const piRepository = resolve(input.piRepository);
  const credentialsFile = resolve(input.credentialsFile);
  const claudeExecutable = resolve(input.claudeExecutable);
  const campaignPaths = localRealCampaignPaths(input.stateRoot, input.campaignId);
  const [hasConfig, hasCatalog, hasState] = await Promise.all([
    pathExists(campaignPaths.config),
    pathExists(campaignPaths.catalog),
    pathExists(campaignPaths.state),
  ]);
  if (hasConfig && hasCatalog && hasState) {
    const existing = await loadLocalRealCampaign(input.stateRoot, input.campaignId);
    if (
      existing.config.piRepository !== piRepository ||
      existing.config.credentialsFile !== credentialsFile ||
      existing.config.claudeExecutable !== claudeExecutable
    ) {
      throw new Error("Existing campaign paths do not match the requested initialization");
    }
    return {
      command: "real-init",
      status: "already-initialized",
      campaignId: input.campaignId,
      campaignDirectory: existing.paths.root,
      baselineRevision: existing.config.baselineRevision,
      taskCount: existing.catalog.tasks.length,
      maximumCampaignCostUsd: existing.config.budget.maximumCampaignCostUsd,
      containsSecrets: false,
    };
  }
  const now = input.now ?? (() => new Date());
  const [partialConfig, partialCatalog] = await Promise.all([
    hasConfig ? readLocalRealArtifact<unknown>(campaignPaths.config) : null,
    hasCatalog ? readLocalRealArtifact<unknown>(campaignPaths.catalog) : null,
  ]);
  const persistedInitializationTime =
    isRecord(partialConfig) && typeof partialConfig["createdAt"] === "string"
      ? partialConfig["createdAt"]
      : isRecord(partialCatalog) && typeof partialCatalog["generatedAt"] === "string"
        ? partialCatalog["generatedAt"]
        : null;
  const createdAt = persistedInitializationTime ?? now().toISOString();
  const credentials = await readLocalFoundryCredentials(credentialsFile);
  await access(claudeExecutable, constants.X_OK);
  const discoveryDirectory = join(resolve(input.stateRoot), "real", "init", input.campaignId);
  await mkdir(discoveryDirectory, { recursive: true, mode: 0o700 });
  const [revisionResult, treeResult, originResult, statusResult] = await Promise.all([
    gitDiscovery(
      piRepository,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      discoveryDirectory,
      "head",
    ),
    gitDiscovery(
      piRepository,
      ["rev-parse", "--verify", "HEAD^{tree}"],
      discoveryDirectory,
      "tree",
    ),
    gitDiscovery(piRepository, ["remote", "get-url", "origin"], discoveryDirectory, "origin"),
    gitDiscovery(
      piRepository,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      discoveryDirectory,
      "status",
    ),
  ]);
  const baselineRevision = revisionResult.stdout.trim();
  if (
    !/^[a-f0-9]{40,64}$/u.test(baselineRevision) ||
    !/^[a-f0-9]{40,64}$/u.test(treeResult.stdout.trim())
  ) {
    throw new Error("Pi checkout does not resolve to immutable Git objects");
  }
  const origin = originResult.stdout.trim();
  if (!EXPECTED_PI_ORIGINS.has(origin)) {
    throw new Error("Pi checkout origin is not parallaxai/df-pi-tbench");
  }
  if (statusResult.stdout.trim().length !== 0) {
    throw new Error("Canonical Pi checkout must be clean before campaign initialization");
  }
  const maximumCampaignCostUsd = input.maximumCampaignCostUsd ?? null;
  const explicitlyUnbounded = input.allowUnboundedCost === true;
  if (
    (maximumCampaignCostUsd === null && !explicitlyUnbounded) ||
    (maximumCampaignCostUsd !== null &&
      (!Number.isFinite(maximumCampaignCostUsd) || maximumCampaignCostUsd <= 0)) ||
    (maximumCampaignCostUsd !== null && explicitlyUnbounded)
  ) {
    throw new Error(
      "Choose either a positive campaign cost limit or explicit unbounded-cost authorization",
    );
  }
  const config: LocalRealCampaignConfig = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: input.campaignId,
    createdAt,
    piRepository,
    piOrigin: origin,
    baselineRevision,
    credentialsFile,
    claudeExecutable,
    optimizer: {
      provider: "microsoft-foundry",
      baseUrl: credentials.baseUrl,
      resourceName: credentials.resourceName,
      deployment: credentials.optimizerDeployment,
      effort: "high",
      maximumCostUsd: 12,
      maximumTurns: 40,
      timeoutMs: 90 * 60_000,
    },
    evaluatedAgent: {
      provider: "microsoft-foundry",
      deployment: credentials.evaluatedDeployment,
      thinking: "high",
    },
    evaluation: {
      harborVersion: "0.20.0",
      datasetName: "terminal-bench",
      datasetVersion: "2.0",
      concurrency: LOCAL_REAL_EVALUATION_CONCURRENCY,
      maximumPanelAttempts: 12,
      maximumInfrastructureRetries: 2,
    },
    budget: {
      maximumCampaignCostUsd,
      explicitlyUnbounded,
    },
    publication: {
      enabled: true,
      remoteName: "origin",
    },
    containsSecrets: false,
  };
  const catalog =
    input.catalog ??
    (partialCatalog as LocalRealCatalog | null) ??
    (await bootstrapTerminalBenchCatalog({ generatedAt: createdAt }));
  const initialized = await initializeLocalRealCampaign({
    stateRoot: input.stateRoot,
    config,
    catalog,
    initializedAt: createdAt,
  });
  return {
    command: "real-init",
    status: "initialized",
    campaignId: input.campaignId,
    campaignDirectory: initialized.paths.root,
    baselineRevision,
    taskCount: catalog.tasks.length,
    maximumCampaignCostUsd,
    containsSecrets: false,
  };
}

export async function readLocalFoundryCredentials(path: string): Promise<LocalFoundryCredentials> {
  if (!isAbsolute(path)) {
    throw new Error("Foundry credential file must be absolute");
  }
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile() || (information.mode & 0o077) !== 0) {
    throw new Error("Foundry credential file must be a mode-0600 regular file");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024 || text.includes("\0")) {
    throw new Error("Foundry credential file is malformed");
  }
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Foundry credential file contains an invalid line");
    const name = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !new Set([
        "DF_FOUNDRY_BASE_URL",
        "DF_OPTIMIZER_DEPLOYMENT",
        "DF_EVALUATED_DEPLOYMENT",
        "ANTHROPIC_FOUNDRY_API_KEY",
      ]).has(name) ||
      values.has(name) ||
      value.length === 0
    ) {
      throw new Error("Foundry credential file contains unsupported or duplicate fields");
    }
    values.set(name, value);
  }
  const baseUrl = values.get("DF_FOUNDRY_BASE_URL");
  const optimizerDeployment = values.get("DF_OPTIMIZER_DEPLOYMENT");
  const evaluatedDeployment = values.get("DF_EVALUATED_DEPLOYMENT");
  const apiKey = values.get("ANTHROPIC_FOUNDRY_API_KEY");
  if (
    baseUrl === undefined ||
    optimizerDeployment !== "claude-opus-5" ||
    evaluatedDeployment !== "claude-opus-4-8" ||
    apiKey === undefined ||
    apiKey.length < 20
  ) {
    throw new Error("Foundry credential file is missing the pinned model bindings");
  }
  const url = new URL(baseUrl);
  const match = /^([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.services\.ai\.azure\.com$/u.exec(
    url.hostname,
  );
  if (
    url.protocol !== "https:" ||
    url.pathname.replace(/\/+$/u, "") !== "/anthropic" ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    match?.[1] === undefined
  ) {
    throw new Error("Foundry base URL is not a supported Microsoft Foundry Anthropic endpoint");
  }
  return {
    baseUrl: `${url.origin}/anthropic`,
    resourceName: match[1],
    optimizerDeployment,
    evaluatedDeployment,
    apiKey,
  };
}

async function gitDiscovery(
  repository: string,
  arguments_: readonly string[],
  logDirectory: string,
  name: string,
) {
  return runLocalProcessChecked({
    executable: "git",
    arguments: arguments_,
    workingDirectory: repository,
    timeoutMs: 30_000,
    stdoutPath: join(logDirectory, `${name}.stdout.log`),
    stderrPath: join(logDirectory, `${name}.stderr.log`),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
