import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "../../mvp/contracts.js";
import {
  readBoundedJson,
  readOptionalBoundedJson,
  writeJsonAtomic,
} from "../../mvp/mounted-files.js";
import {
  LOCAL_REAL_OBSERVATIONS_PER_ARM,
  LOCAL_REAL_SCHEMA_VERSION,
  type LocalRealCampaignConfig,
  type LocalRealCampaignState,
  type LocalRealCatalog,
} from "./contracts.js";

const SAFE_CAMPAIGN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
const SAFE_EXPERIMENT_ID = /^\d{6}-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAXIMUM_CAMPAIGN_FILE_BYTES = 32 * 1024 * 1024;

export interface LocalRealCampaignPaths {
  readonly root: string;
  readonly config: string;
  readonly state: string;
  readonly catalog: string;
  readonly experiments: string;
  readonly worktrees: string;
  readonly runtimes: string;
  readonly harbor: string;
  readonly lock: string;
  readonly stopRequest: string;
}

export type LocalRealStopMode = "after-phase" | "cancel-active";

export interface LocalRealStopRequest {
  readonly schemaVersion: typeof LOCAL_REAL_SCHEMA_VERSION;
  readonly requestedAt: string;
  readonly reason: string;
  readonly mode: LocalRealStopMode;
  readonly containsSecrets: false;
}

export interface LocalRealRunnerLockStatus {
  readonly exists: boolean;
  readonly live: boolean;
  readonly pid: number | null;
  readonly acquiredAt: string | null;
}

export function localRealCampaignPaths(
  stateRoot: string,
  campaignId: string,
): LocalRealCampaignPaths {
  assertCampaignId(campaignId);
  if (!isAbsolute(stateRoot)) {
    throw new Error("Local real state root must be absolute");
  }
  const root = join(resolve(stateRoot), "real", "campaigns", campaignId);
  return {
    root,
    config: join(root, "config.json"),
    state: join(root, "runner-state.json"),
    catalog: join(root, "catalog.json"),
    experiments: join(root, "experiments"),
    worktrees: join(root, "worktrees"),
    runtimes: join(root, "runtimes"),
    harbor: join(root, "harbor"),
    lock: join(root, ".runner.lock"),
    stopRequest: join(root, "stop-request.json"),
  };
}

export function localRealExperimentDirectory(
  paths: LocalRealCampaignPaths,
  experimentId: string,
): string {
  if (!SAFE_EXPERIMENT_ID.test(experimentId)) {
    throw new Error("Local real experiment ID is malformed");
  }
  return join(paths.experiments, experimentId);
}

export async function initializeLocalRealCampaign(input: {
  readonly stateRoot: string;
  readonly config: LocalRealCampaignConfig;
  readonly catalog: LocalRealCatalog;
  readonly initializedAt: string;
}): Promise<{
  readonly paths: LocalRealCampaignPaths;
  readonly state: LocalRealCampaignState;
}> {
  validateConfig(input.config);
  validateCatalog(input.catalog);
  const paths = localRealCampaignPaths(input.stateRoot, input.config.campaignId);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await assertRealDirectory(paths.root);
  for (const directory of [paths.experiments, paths.worktrees, paths.runtimes, paths.harbor]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertRealDirectory(directory);
  }
  const initial: LocalRealCampaignState = {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    campaignId: input.config.campaignId,
    revision: 0,
    status: "initialized",
    championRevision: input.config.baselineRevision,
    nextExperimentNumber: 1,
    activeExperiment: null,
    retainedPanel: null,
    saturationHistory: [],
    completedExperiments: 0,
    promotions: 0,
    totalCostUsd: 0,
    costLedger: [],
    consecutiveInfrastructureFailures: 0,
    stopReason: null,
    blockedReason: null,
    updatedAt: input.initializedAt,
    containsSecrets: false,
  };
  validateState(initial);

  const [existingConfig, existingCatalog, existingState] = await Promise.all([
    readOptionalBoundedJson(paths.config),
    readOptionalBoundedJson(paths.catalog),
    readOptionalBoundedJson(paths.state),
  ]);
  if (existingConfig !== null || existingCatalog !== null || existingState !== null) {
    if (
      (existingConfig !== null && canonicalJson(existingConfig) !== canonicalJson(input.config)) ||
      (existingCatalog !== null && canonicalJson(existingCatalog) !== canonicalJson(input.catalog))
    ) {
      throw new Error("Existing local real campaign does not match the requested configuration");
    }
    if (existingState !== null) {
      validateState(existingState);
      if (
        (existingConfig === null || existingCatalog === null) &&
        canonicalJson(existingState) !== canonicalJson(initial)
      ) {
        throw new Error("A progressed local real campaign is missing initialization files");
      }
    }
    if (existingConfig === null) await writeJsonAtomic(paths.config, input.config);
    if (existingCatalog === null) await writeJsonAtomic(paths.catalog, input.catalog);
    if (existingState === null) await writeJsonAtomic(paths.state, initial);
    const state = existingState ?? initial;
    return { paths, state };
  }

  await writeJsonAtomic(paths.config, input.config);
  await writeJsonAtomic(paths.catalog, input.catalog);
  await writeJsonAtomic(paths.state, initial);
  return { paths, state: initial };
}

export async function loadLocalRealCampaign(
  stateRoot: string,
  campaignId: string,
): Promise<{
  readonly paths: LocalRealCampaignPaths;
  readonly config: LocalRealCampaignConfig;
  readonly catalog: LocalRealCatalog;
  readonly state: LocalRealCampaignState;
}> {
  const paths = localRealCampaignPaths(stateRoot, campaignId);
  const [config, catalog, state] = await Promise.all([
    readBoundedJson(paths.config, MAXIMUM_CAMPAIGN_FILE_BYTES),
    readBoundedJson(paths.catalog, MAXIMUM_CAMPAIGN_FILE_BYTES),
    readBoundedJson(paths.state, MAXIMUM_CAMPAIGN_FILE_BYTES),
  ]);
  validateConfig(config);
  validateCatalog(catalog);
  validateState(state);
  if (
    config.campaignId !== campaignId ||
    state.campaignId !== campaignId ||
    state.championRevision.length < 40
  ) {
    throw new Error("Local real campaign files disagree about their identity");
  }
  return { paths, config, catalog, state };
}

export async function writeLocalRealState(
  paths: LocalRealCampaignPaths,
  state: LocalRealCampaignState,
): Promise<void> {
  validateState(state);
  await writeJsonAtomic(paths.state, state);
}

export async function acquireLocalRealRunnerLock(
  paths: LocalRealCampaignPaths,
  acquiredAt: string,
): Promise<() => Promise<void>> {
  const ownerId = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (!(await localRealRunnerLockIsStale(paths.lock))) {
        throw new Error("Local real campaign is already owned by another runner");
      }
      const quarantine = `${paths.lock}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(paths.lock, quarantine);
      } catch (renameError) {
        if (isNodeError(renameError, "ENOENT")) continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true, force: true });
    }
  }
  if (!acquired) throw new Error("Unable to reclaim the stale local real runner lock");
  await assertRealDirectory(paths.lock);
  try {
    await writeFile(
      join(paths.lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
        ownerId,
        pid: process.pid,
        acquiredAt,
        lockAcquiredAt: new Date().toISOString(),
        containsSecrets: false,
      })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await rm(paths.lock, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let owner: unknown;
    try {
      owner = await readOptionalBoundedJson(join(paths.lock, "owner.json"), 16 * 1024);
    } catch {
      return;
    }
    if (!isRecord(owner) || owner["ownerId"] !== ownerId) return;
    await rm(paths.lock, { recursive: true, force: true });
  };
}

async function localRealRunnerLockIsStale(lock: string): Promise<boolean> {
  const information = await lstat(lock);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Local real campaign runner lock is not a real directory");
  }
  let owner: unknown;
  try {
    const ownerPath = join(lock, "owner.json");
    const ownerInformation = await lstat(ownerPath);
    if (ownerInformation.isSymbolicLink() || !ownerInformation.isFile()) {
      throw new Error("Local real campaign runner lock owner is invalid");
    }
    try {
      owner = await readOptionalBoundedJson(ownerPath, 16 * 1024);
    } catch {
      return Date.now() - information.mtimeMs > 30_000;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    return Date.now() - information.mtimeMs > 30_000;
  }
  if (!isRecord(owner) || !Number.isSafeInteger(owner["pid"]) || (owner["pid"] as number) < 1) {
    return Date.now() - information.mtimeMs > 30_000;
  }
  const timestampValue =
    typeof owner["lockAcquiredAt"] === "string"
      ? owner["lockAcquiredAt"]
      : typeof owner["acquiredAt"] === "string"
        ? owner["acquiredAt"]
        : null;
  const acquiredMilliseconds = timestampValue === null ? Number.NaN : Date.parse(timestampValue);
  const bootMilliseconds = Date.now() - uptime() * 1_000;
  if (Number.isFinite(acquiredMilliseconds) && acquiredMilliseconds < bootMilliseconds - 5_000) {
    return true;
  }
  try {
    process.kill(owner["pid"] as number, 0);
    return false;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return true;
    if (isNodeError(error, "EPERM")) return false;
    throw error;
  }
}

export async function requestLocalRealStop(
  paths: LocalRealCampaignPaths,
  requestedAt: string,
  reason = "operator-requested",
  mode: LocalRealStopMode = "after-phase",
): Promise<void> {
  await writeJsonAtomic(paths.stopRequest, {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    requestedAt,
    reason,
    mode,
    containsSecrets: false,
  });
}

export async function readLocalRealStopRequest(
  paths: LocalRealCampaignPaths,
): Promise<LocalRealStopRequest | null> {
  const value = await readOptionalBoundedJson(paths.stopRequest, 16 * 1024);
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== LOCAL_REAL_SCHEMA_VERSION ||
    typeof value["requestedAt"] !== "string" ||
    typeof value["reason"] !== "string" ||
    value["containsSecrets"] !== false
  ) {
    throw new Error("Local real stop request is invalid");
  }
  const mode =
    value["mode"] === undefined
      ? "after-phase"
      : value["mode"] === "after-phase" || value["mode"] === "cancel-active"
        ? value["mode"]
        : null;
  if (mode === null) throw new Error("Local real stop request mode is invalid");
  return {
    schemaVersion: LOCAL_REAL_SCHEMA_VERSION,
    requestedAt: value["requestedAt"],
    reason: value["reason"],
    mode,
    containsSecrets: false,
  };
}

export async function inspectLocalRealRunnerLock(
  paths: LocalRealCampaignPaths,
): Promise<LocalRealRunnerLockStatus> {
  let information: Stats;
  try {
    information = await lstat(paths.lock);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { exists: false, live: false, pid: null, acquiredAt: null };
    }
    throw error;
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Local real campaign runner lock is not a real directory");
  }
  const owner = await readOptionalBoundedJson(join(paths.lock, "owner.json"), 16 * 1024);
  if (!isRecord(owner) || !Number.isSafeInteger(owner["pid"]) || (owner["pid"] as number) < 1) {
    return { exists: true, live: false, pid: null, acquiredAt: null };
  }
  const pid = owner["pid"] as number;
  let live = false;
  try {
    process.kill(pid, 0);
    live = true;
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) {
      if (isNodeError(error, "EPERM")) live = true;
      else throw error;
    }
  }
  const acquiredAt =
    typeof owner["lockAcquiredAt"] === "string"
      ? owner["lockAcquiredAt"]
      : typeof owner["acquiredAt"] === "string"
        ? owner["acquiredAt"]
        : null;
  return { exists: true, live, pid, acquiredAt };
}

export async function clearLocalRealStopRequest(paths: LocalRealCampaignPaths): Promise<void> {
  await rm(paths.stopRequest, { force: true });
}

export async function hasLocalRealStopRequest(paths: LocalRealCampaignPaths): Promise<boolean> {
  try {
    await access(paths.stopRequest, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

export async function ensureLocalRealExperimentDirectory(
  paths: LocalRealCampaignPaths,
  experimentId: string,
): Promise<string> {
  const directory = localRealExperimentDirectory(paths, experimentId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(directory);
  return directory;
}

export async function readLocalRealArtifact<Value>(path: string): Promise<Value | null> {
  const value = await readOptionalBoundedJson(path, MAXIMUM_CAMPAIGN_FILE_BYTES);
  return value as Value | null;
}

export async function writeLocalRealArtifactOnce(path: string, value: unknown): Promise<void> {
  const existing = await readOptionalBoundedJson(path, MAXIMUM_CAMPAIGN_FILE_BYTES);
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(`Local real artifact replay disagrees with ${path}`);
    }
    return;
  }
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(path, value);
}

export async function appendLocalRealJsonLine(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function listLocalRealExperimentIds(
  paths: LocalRealCampaignPaths,
): Promise<readonly string[]> {
  const entries = await readdir(paths.experiments, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && SAFE_EXPERIMENT_ID.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function assertRealDirectory(path: string): Promise<void> {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Local real campaign storage must not contain symbolic links");
  }
}

function assertCampaignId(campaignId: string): void {
  if (!SAFE_CAMPAIGN_ID.test(campaignId) || campaignId.length < 3 || campaignId.length > 80) {
    throw new Error("Local real campaign ID must be short lowercase text");
  }
}

function validateConfig(value: unknown): asserts value is LocalRealCampaignConfig {
  const evaluation = isRecord(value) ? value["evaluation"] : null;
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== LOCAL_REAL_SCHEMA_VERSION ||
    typeof value["campaignId"] !== "string" ||
    typeof value["piRepository"] !== "string" ||
    typeof value["piOrigin"] !== "string" ||
    typeof value["baselineRevision"] !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(value["baselineRevision"]) ||
    typeof value["credentialsFile"] !== "string" ||
    typeof value["claudeExecutable"] !== "string" ||
    !isRecord(evaluation) ||
    !Number.isSafeInteger(evaluation["concurrency"]) ||
    (evaluation["concurrency"] as number) < 1 ||
    (evaluation["concurrency"] as number) > LOCAL_REAL_OBSERVATIONS_PER_ARM ||
    value["containsSecrets"] !== false
  ) {
    throw new Error("Local real campaign configuration is invalid");
  }
  assertCampaignId(value["campaignId"]);
}

function validateCatalog(value: unknown): asserts value is LocalRealCatalog {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== LOCAL_REAL_SCHEMA_VERSION ||
    !Array.isArray(value["tasks"]) ||
    value["tasks"].length < 5 ||
    value["containsTaskPrompts"] !== false ||
    value["containsSolutions"] !== false
  ) {
    throw new Error("Local real task catalog is invalid");
  }
  const names = new Set<string>();
  for (const task of value["tasks"]) {
    if (
      !isRecord(task) ||
      typeof task["name"] !== "string" ||
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(task["name"]) ||
      !new Set(["easy", "medium", "hard"]).has(task["difficulty"] as string) ||
      typeof task["sourceRepository"] !== "string" ||
      !/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?$/u.test(task["sourceRepository"]) ||
      typeof task["sourceRevision"] !== "string" ||
      !/^[a-f0-9]{40}$/u.test(task["sourceRevision"]) ||
      typeof task["sourcePath"] !== "string" ||
      task["sourcePath"] !== task["name"] ||
      typeof task["empiricalFailureRate"] !== "number" ||
      !Number.isFinite(task["empiricalFailureRate"]) ||
      task["empiricalFailureRate"] < 0 ||
      task["empiricalFailureRate"] > 1 ||
      typeof task["selections"] !== "number" ||
      !Number.isSafeInteger(task["selections"]) ||
      task["selections"] < 0 ||
      names.has(task["name"])
    ) {
      throw new Error("Local real task catalog contains an invalid task");
    }
    names.add(task["name"]);
  }
}

function validateState(value: unknown): asserts value is LocalRealCampaignState {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== LOCAL_REAL_SCHEMA_VERSION ||
    typeof value["campaignId"] !== "string" ||
    !Number.isSafeInteger(value["revision"]) ||
    typeof value["championRevision"] !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(value["championRevision"]) ||
    !Number.isSafeInteger(value["nextExperimentNumber"]) ||
    !Array.isArray(value["saturationHistory"]) ||
    value["saturationHistory"].some((item) => typeof item !== "boolean") ||
    !Array.isArray(value["costLedger"]) ||
    value["containsSecrets"] !== false
  ) {
    throw new Error("Local real campaign state is invalid");
  }
  const ledger = value["costLedger"];
  const ledgerIds = new Set<string>();
  let ledgerTotal = 0;
  for (const entry of ledger) {
    if (
      !isRecord(entry) ||
      typeof entry["id"] !== "string" ||
      !/^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/u.test(entry["id"]) ||
      ledgerIds.has(entry["id"]) ||
      typeof entry["amountUsd"] !== "number" ||
      !Number.isFinite(entry["amountUsd"]) ||
      entry["amountUsd"] < 0
    ) {
      throw new Error("Local real campaign cost ledger is invalid");
    }
    ledgerIds.add(entry["id"]);
    ledgerTotal += entry["amountUsd"];
  }
  if (
    typeof value["totalCostUsd"] !== "number" ||
    !Number.isFinite(value["totalCostUsd"]) ||
    value["totalCostUsd"] < 0 ||
    Math.round(ledgerTotal * 1_000_000) / 1_000_000 !== value["totalCostUsd"]
  ) {
    throw new Error("Local real campaign cost total does not match its ledger");
  }
  assertCampaignId(value["campaignId"]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
