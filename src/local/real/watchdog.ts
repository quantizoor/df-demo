import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { LocalRealCampaignStatus } from "./contracts.js";
import {
  inspectLocalRealRunnerLock,
  loadLocalRealCampaign,
  readLocalRealStopRequest,
} from "./state.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAXIMUM_BACKOFF_MS = 30_000;

export interface LocalCampaignWatchdogSnapshot {
  readonly status: LocalRealCampaignStatus;
  readonly stopRequested: boolean;
  readonly runnerLive: boolean;
  readonly runnerPid: number | null;
}

export interface LocalCampaignWatchdogRunner {
  readonly pid: number | null;
  readonly exited: Promise<void>;
  readonly isRunning: () => boolean;
}

export interface LocalCampaignWatchdogRuntime {
  readonly inspect: () => Promise<LocalCampaignWatchdogSnapshot>;
  readonly launchRunner: () => LocalCampaignWatchdogRunner;
  readonly delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface LocalCampaignWatchdogResult {
  readonly command: "real-watchdog";
  readonly campaignId: string;
  readonly status: "exited";
  readonly reason:
    | "campaign-blocked"
    | "campaign-not-running"
    | "campaign-stopped"
    | "stop-requested"
    | "watchdog-stopped";
  readonly launches: number;
  readonly containsSecrets: false;
}

export interface LocalCampaignWatchdogOptions {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly pollIntervalMs?: number;
  readonly initialBackoffMs?: number;
  readonly maximumBackoffMs?: number;
  readonly signal?: AbortSignal;
  readonly runtime?: LocalCampaignWatchdogRuntime;
}

export async function runLocalCampaignWatchdog(
  options: LocalCampaignWatchdogOptions,
): Promise<LocalCampaignWatchdogResult> {
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    "watchdog poll interval",
  );
  const initialBackoffMs = positiveInteger(
    options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    "watchdog initial backoff",
  );
  const maximumBackoffMs = positiveInteger(
    options.maximumBackoffMs ?? DEFAULT_MAXIMUM_BACKOFF_MS,
    "watchdog maximum backoff",
  );
  if (maximumBackoffMs < initialBackoffMs) {
    throw new Error("Watchdog maximum backoff must not be shorter than its initial backoff");
  }

  const projectRoot = absolutePath(options.projectRoot, "project root");
  const stateRoot = absolutePath(options.stateRoot, "state root");
  const runtime =
    options.runtime ??
    createNativeWatchdogRuntime({
      projectRoot,
      stateRoot,
      campaignId: options.campaignId,
    });
  let launches = 0;
  let failures = 0;
  let managedRunner: LocalCampaignWatchdogRunner | null = null;
  let observedLiveRunner = false;

  while (true) {
    if (options.signal?.aborted === true) {
      return result(options.campaignId, "watchdog-stopped", launches);
    }
    const snapshot = await runtime.inspect();
    const terminalReason = watchdogTerminalReason(snapshot);
    if (terminalReason !== null) {
      return result(options.campaignId, terminalReason, launches);
    }

    if (snapshot.runnerLive) {
      observedLiveRunner = true;
      await runtime.delay(pollIntervalMs, options.signal);
      continue;
    }

    if (managedRunner !== null) {
      if (managedRunner.isRunning()) {
        await runtime.delay(pollIntervalMs, options.signal);
        continue;
      }
      managedRunner = null;
      observedLiveRunner = false;
      failures += 1;
      await runtime.delay(
        localWatchdogBackoffMs(failures, initialBackoffMs, maximumBackoffMs),
        options.signal,
      );
      continue;
    }

    if (observedLiveRunner) {
      observedLiveRunner = false;
      failures += 1;
      await runtime.delay(
        localWatchdogBackoffMs(failures, initialBackoffMs, maximumBackoffMs),
        options.signal,
      );
      continue;
    }

    managedRunner = runtime.launchRunner();
    launches += 1;
    await runtime.delay(pollIntervalMs, options.signal);
  }
}

export function localWatchdogBackoffMs(
  consecutiveFailures: number,
  initialBackoffMs = DEFAULT_INITIAL_BACKOFF_MS,
  maximumBackoffMs = DEFAULT_MAXIMUM_BACKOFF_MS,
): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1) {
    throw new Error("Watchdog failure count must be a positive integer");
  }
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(maximumBackoffMs, initialBackoffMs * 2 ** exponent);
}

export function localCampaignRunnerArguments(input: {
  readonly cliPath: string;
  readonly stateRoot: string;
  readonly campaignId: string;
}): readonly string[] {
  return [
    input.cliPath,
    "--state-root",
    input.stateRoot,
    "real",
    "run",
    "--campaign",
    input.campaignId,
  ];
}

function watchdogTerminalReason(
  snapshot: LocalCampaignWatchdogSnapshot,
): LocalCampaignWatchdogResult["reason"] | null {
  if (snapshot.stopRequested) return "stop-requested";
  if (snapshot.status === "blocked") return "campaign-blocked";
  if (snapshot.status === "stopped" || snapshot.status === "stop-requested") {
    return "campaign-stopped";
  }
  return snapshot.status === "running" ? null : "campaign-not-running";
}

function createNativeWatchdogRuntime(input: {
  readonly projectRoot: string;
  readonly stateRoot: string;
  readonly campaignId: string;
}): LocalCampaignWatchdogRuntime {
  const cliPath = resolve(input.projectRoot, "dist", "local", "cli.js");
  return {
    inspect: async () => {
      const campaign = await loadLocalRealCampaign(input.stateRoot, input.campaignId);
      const [lock, stopRequest] = await Promise.all([
        inspectLocalRealRunnerLock(campaign.paths),
        readLocalRealStopRequest(campaign.paths),
      ]);
      return {
        status: campaign.state.status,
        stopRequested: stopRequest !== null,
        runnerLive: lock.live,
        runnerPid: lock.pid,
      };
    },
    launchRunner: () => {
      const information = lstatSync(cliPath);
      if (information.isSymbolicLink() || !information.isFile()) {
        throw new Error("Built local runner CLI must be a regular file");
      }
      return launchLocalCampaignRunner({
        projectRoot: input.projectRoot,
        cliPath,
        stateRoot: input.stateRoot,
        campaignId: input.campaignId,
      });
    },
    delay: abortableDelay,
  };
}

function launchLocalCampaignRunner(input: {
  readonly projectRoot: string;
  readonly cliPath: string;
  readonly stateRoot: string;
  readonly campaignId: string;
}): LocalCampaignWatchdogRunner {
  const child = spawn(
    process.execPath,
    localCampaignRunnerArguments({
      cliPath: input.cliPath,
      stateRoot: input.stateRoot,
      campaignId: input.campaignId,
    }),
    {
      cwd: input.projectRoot,
      env: watchdogRunnerEnvironment(),
      stdio: "inherit",
      windowsHide: true,
    },
  );
  let running = true;
  const exited = new Promise<void>((resolveExit) => {
    const settle = (): void => {
      if (!running) return;
      running = false;
      resolveExit();
    };
    child.once("error", settle);
    child.once("exit", settle);
  });
  return {
    pid: child.pid ?? null,
    exited,
    isRunning: () => running,
  };
}

function watchdogRunnerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C",
    LC_ALL: "C",
    ...(process.env.SSH_AUTH_SOCK === undefined
      ? {}
      : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
  };
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return;
  await new Promise<void>((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

function result(
  campaignId: string,
  reason: LocalCampaignWatchdogResult["reason"],
  launches: number,
): LocalCampaignWatchdogResult {
  return {
    command: "real-watchdog",
    campaignId,
    status: "exited",
    reason,
    launches,
    containsSecrets: false,
  };
}

function absolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`Watchdog ${label} must be absolute`);
  return resolve(path);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}
