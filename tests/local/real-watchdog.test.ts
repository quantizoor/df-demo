import { describe, expect, it, vi } from "vitest";

import {
  type LocalCampaignWatchdogRunner,
  type LocalCampaignWatchdogRuntime,
  type LocalCampaignWatchdogSnapshot,
  localCampaignRunnerArguments,
  localWatchdogBackoffMs,
  runLocalCampaignWatchdog,
} from "../../src/local/real/watchdog.js";

describe("local real campaign watchdog", () => {
  it("adopts a live runner and launches only after it dies while state remains running", async () => {
    const snapshots: LocalCampaignWatchdogSnapshot[] = [
      snapshot({ runnerLive: true, runnerPid: 41 }),
      snapshot({ runnerLive: false }),
      snapshot({ runnerLive: false }),
      snapshot({ status: "blocked", runnerLive: false }),
    ];
    const delays: number[] = [];
    const runtime = fakeRuntime({
      snapshots,
      delays,
      runners: [exitedRunner(42)],
    });

    const result = await runLocalCampaignWatchdog({
      projectRoot: "/project",
      stateRoot: "/state",
      campaignId: "campaign-1",
      pollIntervalMs: 10,
      initialBackoffMs: 100,
      maximumBackoffMs: 400,
      runtime,
    });

    expect(runtime.launchRunner).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([10, 100, 10]);
    expect(result).toEqual({
      command: "real-watchdog",
      campaignId: "campaign-1",
      status: "exited",
      reason: "campaign-blocked",
      launches: 1,
      containsSecrets: false,
    });
  });

  it.each([
    [snapshot({ status: "blocked" }), "campaign-blocked"],
    [snapshot({ status: "stopped" }), "campaign-stopped"],
    [snapshot({ status: "initialized" }), "campaign-not-running"],
    [snapshot({ stopRequested: true }), "stop-requested"],
  ] as const)("exits without launching for a terminal snapshot", async (terminal, reason) => {
    const runtime = fakeRuntime({ snapshots: [terminal] });

    const result = await runLocalCampaignWatchdog({
      projectRoot: "/project",
      stateRoot: "/state",
      campaignId: "campaign-1",
      runtime,
    });

    expect(runtime.launchRunner).not.toHaveBeenCalled();
    expect(result.reason).toBe(reason);
    expect(result.launches).toBe(0);
  });

  it("retries crashed children with exponential backoff while durable state remains running", async () => {
    const delays: number[] = [];
    const runtime = fakeRuntime({
      snapshots: [snapshot(), snapshot(), snapshot(), snapshot(), snapshot({ status: "stopped" })],
      delays,
      runners: [exitedRunner(51), exitedRunner(52)],
    });

    const result = await runLocalCampaignWatchdog({
      projectRoot: "/project",
      stateRoot: "/state",
      campaignId: "campaign-1",
      pollIntervalMs: 10,
      initialBackoffMs: 100,
      maximumBackoffMs: 400,
      runtime,
    });

    expect(runtime.launchRunner).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([10, 100, 10, 200]);
    expect(result.reason).toBe("campaign-stopped");
  });

  it("uses capped exponential retry delays", () => {
    expect([1, 2, 3, 4, 5].map((failure) => localWatchdogBackoffMs(failure, 100, 400))).toEqual([
      100, 200, 400, 400, 400,
    ]);
  });

  it("constructs a run command that never clears a durable stop request", () => {
    expect(
      localCampaignRunnerArguments({
        cliPath: "/project/dist/local/cli.js",
        stateRoot: "/state",
        campaignId: "campaign-1",
      }),
    ).toEqual([
      "/project/dist/local/cli.js",
      "--state-root",
      "/state",
      "real",
      "run",
      "--campaign",
      "campaign-1",
    ]);
  });
});

function snapshot(
  overrides: Partial<LocalCampaignWatchdogSnapshot> = {},
): LocalCampaignWatchdogSnapshot {
  return {
    status: "running",
    stopRequested: false,
    runnerLive: false,
    runnerPid: null,
    ...overrides,
  };
}

function exitedRunner(pid: number): LocalCampaignWatchdogRunner {
  return {
    pid,
    exited: Promise.resolve(),
    isRunning: () => false,
  };
}

function fakeRuntime(input: {
  readonly snapshots: readonly LocalCampaignWatchdogSnapshot[];
  readonly delays?: number[];
  readonly runners?: readonly LocalCampaignWatchdogRunner[];
}): LocalCampaignWatchdogRuntime & {
  readonly launchRunner: ReturnType<typeof vi.fn<() => LocalCampaignWatchdogRunner>>;
} {
  let snapshotIndex = 0;
  let runnerIndex = 0;
  const lastSnapshot = input.snapshots.at(-1);
  if (lastSnapshot === undefined) throw new Error("A fake watchdog snapshot is required");
  const launchRunner = vi.fn(() => input.runners?.[runnerIndex++] ?? exitedRunner(100));
  return {
    inspect: async () => input.snapshots[snapshotIndex++] ?? lastSnapshot,
    launchRunner,
    delay: async (milliseconds) => {
      input.delays?.push(milliseconds);
    },
  };
}
