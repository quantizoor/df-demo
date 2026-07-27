import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MVP_MAX_STATE_BYTES, writeJsonAtomic } from "../mvp/mounted-files.js";
import {
  type MvpNoModelSyntheticSmokeReceipt,
  parseMvpNoModelSyntheticSmokeReceipt,
} from "../mvp/synthetic-smoke.js";

export const LOCAL_STATE_SCHEMA_VERSION = "local-1.0.0" as const;
export const LOCAL_RUN_MODE = "synthetic-no-model" as const;
export const LOCAL_LATEST_RUN_FILE = "latest-run.json" as const;

const SAFE_RUN_ID = /^run-\d{8}T\d{6}\d{3}Z-[a-f0-9-]+$/u;
const RUN_SUMMARY_DOMAIN = "dark-factory.local-run-summary.v1" as const;
const LATEST_RUN_DOMAIN = "dark-factory.local-latest-run.v1" as const;

export interface LocalRunSummary {
  readonly domain: typeof RUN_SUMMARY_DOMAIN;
  readonly schemaVersion: typeof LOCAL_STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly mode: typeof LOCAL_RUN_MODE;
  readonly status: "passed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly artifacts: {
    readonly runDirectory: string;
    readonly campaignDirectory: string;
    readonly experimentDirectory: string;
    readonly campaignStateDirectory: string;
    readonly infrastructureInvalidDirectory: string;
    readonly receipt: string;
  };
  readonly receipt: MvpNoModelSyntheticSmokeReceipt;
  readonly containsSecrets: false;
  readonly realOptimizationPerformed: false;
}

export interface LocalLatestRun {
  readonly domain: typeof LATEST_RUN_DOMAIN;
  readonly schemaVersion: typeof LOCAL_STATE_SCHEMA_VERSION;
  readonly runId: string;
  readonly relativeRunDirectory: string;
  readonly relativeSummaryPath: string;
  readonly mode: typeof LOCAL_RUN_MODE;
  readonly status: "passed";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly receiptStatus: "passed";
  readonly containsSecrets: false;
  readonly realOptimizationPerformed: false;
}

export interface LocalNoRunsStatus {
  readonly command: "status";
  readonly status: "no-runs";
  readonly message: "No local runs have been recorded.";
}

export interface LocalLatestStatus {
  readonly command: "status";
  readonly status: "passed";
  readonly latest: LocalLatestRun;
  readonly summary: LocalRunSummary;
}

export type LocalStatus = LocalNoRunsStatus | LocalLatestStatus;

interface LocalStateDirectory {
  readonly path: string;
  readonly realPath: string;
}

export function resolveLocalStateRoot(cwd: string, override?: string): string {
  const root = override ?? resolve(cwd, ".df/local");
  assertLocalStateRoot(root);
  return resolve(root);
}

export function assertLocalStateRoot(root: string): void {
  if (
    root.length === 0 ||
    root.includes("\0") ||
    !isAbsolute(root) ||
    resolve(root) === parse(resolve(root)).root
  ) {
    throw new Error("Local state root must be an explicit absolute non-root path");
  }
}

export async function prepareLocalRunStorage(stateRoot: string): Promise<string> {
  const root = await inspectLocalStateRoot(stateRoot, true);
  if (root === null) throw new Error("Local state root could not be created");
  const runsRoot = await inspectDirectChildDirectory(root, "runs", true);
  return runsRoot.path;
}

export async function createLocalRunDirectory(
  stateRoot: string,
  now: Date,
): Promise<{ readonly runId: string; readonly runDirectory: string }> {
  assertValidDate(now);
  const root = await inspectLocalStateRoot(stateRoot, true);
  if (root === null) throw new Error("Local state root could not be created");
  const runsRoot = await inspectDirectChildDirectory(root, "runs", true);
  const timestamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const runId = `run-${timestamp}-${randomUUID()}`;
    assertSafeRunId(runId);
    const runDirectory = join(runsRoot.path, runId);
    try {
      await mkdir(runDirectory, { mode: 0o700 });
      await inspectDirectChildDirectory(runsRoot, runId, false);
      return { runId, runDirectory };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await lstat(runDirectory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error("Local run storage must not contain symbolic links");
      }
    }
  }
  throw new Error("Unable to allocate a unique local run directory");
}

export async function persistSuccessfulLocalRun(
  stateRoot: string,
  runId: string,
  runDirectory: string,
  startedAt: string,
  completedAt: string,
  receipt: MvpNoModelSyntheticSmokeReceipt,
): Promise<{ readonly latest: LocalLatestRun; readonly summary: LocalRunSummary }> {
  assertSafeRunId(runId);
  const root = await inspectLocalStateRoot(stateRoot, false);
  if (root === null) throw new Error("Local state root is missing");
  const runsRoot = await inspectDirectChildDirectory(root, "runs", false);
  const inspectedRunDirectory = await inspectDirectChildDirectory(runsRoot, runId, false);
  if (resolve(runDirectory) !== inspectedRunDirectory.path) {
    throw new Error("Local run directory does not match its run identifier");
  }
  const relativeRunDirectory = portableRelativePath(root.path, inspectedRunDirectory.path);
  if (relativeRunDirectory !== `runs/${runId}`) {
    throw new Error("Local run directory does not match its run identifier");
  }
  assertIsoTimestamp(startedAt);
  assertIsoTimestamp(completedAt);
  const validatedReceipt = parseMvpNoModelSyntheticSmokeReceipt(receipt);

  const summary: LocalRunSummary = {
    domain: RUN_SUMMARY_DOMAIN,
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    runId,
    mode: LOCAL_RUN_MODE,
    status: "passed",
    startedAt,
    completedAt,
    artifacts: {
      runDirectory: relativeRunDirectory,
      campaignDirectory: `${relativeRunDirectory}/campaign`,
      experimentDirectory: `${relativeRunDirectory}/campaign/experiments`,
      campaignStateDirectory: `${relativeRunDirectory}/campaign/state`,
      infrastructureInvalidDirectory: `${relativeRunDirectory}/infrastructure-invalid`,
      receipt: `${relativeRunDirectory}/receipt.json`,
    },
    receipt: validatedReceipt,
    containsSecrets: false,
    realOptimizationPerformed: false,
  };
  const latest: LocalLatestRun = {
    domain: LATEST_RUN_DOMAIN,
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    runId,
    relativeRunDirectory,
    relativeSummaryPath: `${relativeRunDirectory}/run.json`,
    mode: LOCAL_RUN_MODE,
    status: "passed",
    startedAt,
    completedAt,
    receiptStatus: validatedReceipt.status,
    containsSecrets: false,
    realOptimizationPerformed: false,
  };

  await writeJsonAtomic(join(inspectedRunDirectory.path, "receipt.json"), validatedReceipt);
  await writeJsonAtomic(join(inspectedRunDirectory.path, "run.json"), summary);
  await writeJsonAtomic(join(root.path, LOCAL_LATEST_RUN_FILE), latest);
  return { latest, summary };
}

export async function readLocalStatus(stateRoot: string): Promise<LocalStatus> {
  const root = await inspectLocalStateRoot(stateRoot, false);
  if (root === null) {
    return noRunsStatus();
  }
  const value = await readOptionalLocalJson(join(root.path, LOCAL_LATEST_RUN_FILE));
  if (value === null) {
    return noRunsStatus();
  }
  const latest = parseLatestRun(value);
  const runsRoot = await inspectDirectChildDirectory(root, "runs", false);
  const runDirectory = await inspectDirectChildDirectory(runsRoot, latest.runId, false);
  const summaryPath = join(runDirectory.path, "run.json");
  const summaryValue = await readOptionalLocalJson(summaryPath);
  if (summaryValue === null) {
    throw new Error("Latest local run summary is missing");
  }
  const summary = parseRunSummary(summaryValue);
  const receiptValue = await readOptionalLocalJson(join(runDirectory.path, "receipt.json"));
  if (receiptValue === null) {
    throw new Error("Latest local run receipt is missing");
  }
  const receipt = parseMvpNoModelSyntheticSmokeReceipt(receiptValue);
  if (
    summary.runId !== latest.runId ||
    summary.startedAt !== latest.startedAt ||
    summary.completedAt !== latest.completedAt ||
    summary.artifacts.runDirectory !== latest.relativeRunDirectory ||
    !isDeepStrictEqual(receipt, summary.receipt)
  ) {
    throw new Error("Latest local run pointer does not match its summary");
  }
  return {
    command: "status",
    status: "passed",
    latest,
    summary,
  };
}

function parseLatestRun(value: unknown): LocalLatestRun {
  if (!isRecord(value)) {
    throw new Error("Latest local run pointer is invalid");
  }
  assertExactKeys(value, [
    "domain",
    "schemaVersion",
    "runId",
    "relativeRunDirectory",
    "relativeSummaryPath",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "receiptStatus",
    "containsSecrets",
    "realOptimizationPerformed",
  ]);
  const runId = value["runId"];
  assertSafeRunId(runId);
  if (
    value["domain"] !== LATEST_RUN_DOMAIN ||
    value["schemaVersion"] !== LOCAL_STATE_SCHEMA_VERSION ||
    value["relativeRunDirectory"] !== `runs/${runId}` ||
    value["relativeSummaryPath"] !== `runs/${runId}/run.json` ||
    value["mode"] !== LOCAL_RUN_MODE ||
    value["status"] !== "passed" ||
    value["receiptStatus"] !== "passed" ||
    value["containsSecrets"] !== false ||
    value["realOptimizationPerformed"] !== false
  ) {
    throw new Error("Latest local run pointer is invalid");
  }
  assertIsoTimestamp(value["startedAt"]);
  assertIsoTimestamp(value["completedAt"]);
  return value as unknown as LocalLatestRun;
}

function parseRunSummary(value: unknown): LocalRunSummary {
  if (!isRecord(value)) {
    throw new Error("Local run summary is invalid");
  }
  assertExactKeys(value, [
    "domain",
    "schemaVersion",
    "runId",
    "mode",
    "status",
    "startedAt",
    "completedAt",
    "artifacts",
    "receipt",
    "containsSecrets",
    "realOptimizationPerformed",
  ]);
  const runId = value["runId"];
  assertSafeRunId(runId);
  if (
    value["domain"] !== RUN_SUMMARY_DOMAIN ||
    value["schemaVersion"] !== LOCAL_STATE_SCHEMA_VERSION ||
    value["mode"] !== LOCAL_RUN_MODE ||
    value["status"] !== "passed" ||
    value["containsSecrets"] !== false ||
    value["realOptimizationPerformed"] !== false ||
    !isRecord(value["artifacts"])
  ) {
    throw new Error("Local run summary is invalid");
  }
  parseMvpNoModelSyntheticSmokeReceipt(value["receipt"]);
  assertIsoTimestamp(value["startedAt"]);
  assertIsoTimestamp(value["completedAt"]);
  const artifacts = value["artifacts"];
  assertExactKeys(artifacts, [
    "runDirectory",
    "campaignDirectory",
    "experimentDirectory",
    "campaignStateDirectory",
    "infrastructureInvalidDirectory",
    "receipt",
  ]);
  const expectedRunDirectory = `runs/${runId}`;
  if (
    artifacts["runDirectory"] !== expectedRunDirectory ||
    artifacts["campaignDirectory"] !== `${expectedRunDirectory}/campaign` ||
    artifacts["experimentDirectory"] !== `${expectedRunDirectory}/campaign/experiments` ||
    artifacts["campaignStateDirectory"] !== `${expectedRunDirectory}/campaign/state` ||
    artifacts["infrastructureInvalidDirectory"] !==
      `${expectedRunDirectory}/infrastructure-invalid` ||
    artifacts["receipt"] !== `${expectedRunDirectory}/receipt.json`
  ) {
    throw new Error("Local run summary contains invalid artifact paths");
  }
  return value as unknown as LocalRunSummary;
}

function portableRelativePath(root: string, target: string): string {
  return relative(root, target).split(sep).join("/");
}

function noRunsStatus(): LocalNoRunsStatus {
  return {
    command: "status",
    status: "no-runs",
    message: "No local runs have been recorded.",
  };
}

function assertSafeRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_RUN_ID.test(value) || value.includes("..")) {
    throw new Error("Local run identifier is invalid");
  }
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error("Local run timestamp is invalid");
  }
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Local run clock returned an invalid date");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("Local state document contains unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function inspectLocalStateRoot(
  stateRoot: string,
  create: boolean,
): Promise<LocalStateDirectory | null> {
  assertLocalStateRoot(stateRoot);
  const path = resolve(stateRoot);
  if (create) {
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const information = await lstat(path).catch((error: unknown) => {
    if (!create && isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  });
  if (information === null) return null;
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Local state root must be a real directory, not a symbolic link");
  }
  return { path, realPath: await realpath(path) };
}

async function inspectDirectChildDirectory(
  parent: LocalStateDirectory,
  name: string,
  create: boolean,
): Promise<LocalStateDirectory> {
  const path = join(parent.path, name);
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  }
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error("Local state storage must contain only real directories");
  }
  const realPath = await realpath(path);
  if (realPath !== join(parent.realPath, name)) {
    throw new Error("Local state storage must not traverse symbolic links");
  }
  return { path, realPath };
}

async function readOptionalLocalJson(path: string): Promise<unknown | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) => {
      if (isNodeError(error, "ENOENT")) return null;
      if (isNodeError(error, "ELOOP")) {
        throw new Error("Local state files must not be symbolic links", { cause: error });
      }
      throw error;
    },
  );
  if (handle === null) return null;
  try {
    const information = await handle.stat();
    if (!information.isFile() || information.size < 2 || information.size > MVP_MAX_STATE_BYTES) {
      throw new Error("Local state JSON file has an invalid size or type");
    }
    return JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
