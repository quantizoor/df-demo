import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  clearLocalRealStopRequest,
  inspectLocalRealRunnerLock,
  loadLocalRealCampaign,
  requestLocalRealStop,
} from "../real/state.js";
import type { DashboardCampaignControlResult } from "./contracts.js";
import { getDashboardCampaignSummary, listDashboardCampaigns } from "./repository.js";

export async function startDashboardCampaign(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly mode?: "continuous" | "once";
  readonly projectRoot?: string;
}): Promise<DashboardCampaignControlResult> {
  const stateRoot = resolve(input.stateRoot);
  const campaign = await loadLocalRealCampaign(stateRoot, input.campaignId);
  const currentLock = await inspectLocalRealRunnerLock(campaign.paths);
  if (currentLock.live) {
    return {
      accepted: false,
      campaign: await getDashboardCampaignSummary(stateRoot, input.campaignId),
      message: "Campaign is already running",
    };
  }
  const running = (await listDashboardCampaigns(stateRoot)).find(
    (candidate) => candidate.runnerLive && candidate.campaignId !== input.campaignId,
  );
  if (running !== undefined) {
    throw new Error(`Campaign ${running.campaignId} is already running`);
  }
  const dashboardRoot = join(stateRoot, "dashboard");
  const launchLock = join(dashboardRoot, ".launch.lock");
  await mkdir(dashboardRoot, { recursive: true, mode: 0o700 });
  await acquireDashboardLaunchLock(launchLock);
  try {
    await clearLocalRealStopRequest(campaign.paths);
    const launchId = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
    const launchDirectory = join(dashboardRoot, "launches", launchId);
    await mkdir(launchDirectory, { recursive: true, mode: 0o700 });
    const projectRoot = resolve(input.projectRoot ?? resolve(stateRoot, "..", ".."));
    const cliPath = await resolveDashboardRunnerCliPath(projectRoot);
    const stdout = await open(join(launchDirectory, "stdout.log"), "w", 0o600);
    const stderr = await open(join(launchDirectory, "stderr.log"), "w", 0o600);
    const arguments_ = [
      cliPath,
      "--state-root",
      stateRoot,
      "real",
      "run",
      "--campaign",
      input.campaignId,
      ...(input.mode === "once" ? ["--once"] : []),
    ];
    const child = spawn(process.execPath, arguments_, {
      cwd: projectRoot,
      env: {
        PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        LANG: "C",
        LC_ALL: "C",
        ...(process.env.SSH_AUTH_SOCK === undefined
          ? {}
          : { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }),
      },
      detached: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
      windowsHide: true,
    });
    child.unref();
    await Promise.all([stdout.close(), stderr.close()]);
    await writeFile(
      join(launchDirectory, "launch.json"),
      `${JSON.stringify(
        {
          launchId,
          campaignId: input.campaignId,
          pid: child.pid ?? null,
          mode: input.mode ?? "continuous",
          startedAt: new Date().toISOString(),
          containsSecrets: false,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const lock = await inspectLocalRealRunnerLock(campaign.paths);
      if (lock.live) {
        return {
          accepted: true,
          campaign: await getDashboardCampaignSummary(stateRoot, input.campaignId),
          message: "Campaign started",
        };
      }
      if (child.exitCode !== null) break;
      await delay(100);
    }
    const output = await readSmallFile(join(launchDirectory, "stderr.log"));
    throw new Error(
      output.length > 0
        ? `Campaign runner exited before acquiring its lock: ${output}`
        : "Campaign runner did not acquire its lock within five seconds",
    );
  } finally {
    await rm(launchLock, { recursive: true, force: true });
  }
}

export async function resolveDashboardRunnerCliPath(projectRoot: string): Promise<string> {
  const cliPath = resolve(projectRoot, "dist", "local", "cli.js");
  try {
    const information = await lstat(cliPath);
    if (information.isSymbolicLink() || !information.isFile()) {
      throw new Error("Built local runner CLI must be a regular file");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(
        "Built local runner CLI is missing; run pnpm build before starting a campaign",
      );
    }
    throw error;
  }
  return cliPath;
}

async function acquireDashboardLaunchLock(path: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      await writeFile(
        join(path, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
          containsSecrets: false,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      return;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const information = await lstat(path);
      if (
        information.isSymbolicLink() ||
        !information.isDirectory() ||
        Date.now() - information.mtimeMs <= 30_000
      ) {
        throw new Error("Another dashboard campaign launch is in progress");
      }
      await rm(path, { recursive: true, force: true });
    }
  }
  throw new Error("Unable to acquire the dashboard campaign launch lock");
}

export async function stopDashboardCampaign(input: {
  readonly stateRoot: string;
  readonly campaignId: string;
  readonly mode: "after-phase" | "cancel-active";
  readonly requestedAt?: string;
}): Promise<DashboardCampaignControlResult> {
  const stateRoot = resolve(input.stateRoot);
  const campaign = await loadLocalRealCampaign(stateRoot, input.campaignId);
  await requestLocalRealStop(
    campaign.paths,
    input.requestedAt ?? new Date().toISOString(),
    "operator-requested-from-dashboard",
    input.mode,
  );
  const live = (await inspectLocalRealRunnerLock(campaign.paths)).live;
  return {
    accepted: live,
    campaign: await getDashboardCampaignSummary(stateRoot, input.campaignId),
    message: live
      ? input.mode === "cancel-active"
        ? "Immediate cancellation requested"
        : "Graceful stop requested"
      : "Stop request recorded; no live runner was found",
  };
}

async function readSmallFile(path: string): Promise<string> {
  try {
    const value = await readFile(path, "utf8");
    return value.slice(-4_096).trim();
  } catch {
    return "";
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}
