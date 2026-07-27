import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type LocalCliOutput, runLocalCli } from "../../src/local/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("real local CLI", () => {
  it("passes pinned local paths and an explicit cost ceiling to campaign initialization", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();
    const initializeReal = vi.fn(async () => ({
      command: "real-init" as const,
      status: "initialized" as const,
      campaignId: "pi-local",
      campaignDirectory: resolve(cwd, ".df/local/real/campaigns/pi-local"),
      baselineRevision: "1".repeat(40),
      taskCount: 89,
      maximumCampaignCostUsd: 250,
      containsSecrets: false as const,
    }));

    const exitCode = await runLocalCli(
      ["real", "init", "--campaign", "pi-local", "--max-campaign-cost-usd", "250"],
      { cwd, output: capture.output, initializeReal },
    );

    expect(exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    expect(initializeReal).toHaveBeenCalledWith(
      expect.objectContaining({
        stateRoot: resolve(cwd, ".df/local"),
        campaignId: "pi-local",
        piRepository: resolve(cwd, "../df-pi-tbench"),
        credentialsFile: resolve(cwd, ".df/local/config/foundry.env"),
        claudeExecutable: resolve(cwd, ".df/local/tools/claude/node_modules/.bin/claude"),
        maximumCampaignCostUsd: 250,
      }),
    );
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "real-init",
      status: "initialized",
      taskCount: 89,
    });
  });

  it("runs one resumable real experiment when explicitly bounded with --once", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();
    const runReal = vi.fn(async () => ({
      command: "real-run" as const,
      campaignId: "pi-local",
      status: "stopped" as const,
      completedThisInvocation: 1,
      completedTotal: 1,
      promotions: 0,
      championRevision: "1".repeat(40),
      totalCostUsd: 3,
      nextExperimentNumber: 2,
      reason: "requested-experiment-limit-reached",
      containsSecrets: false as const,
    }));

    const exitCode = await runLocalCli(["real", "run", "--campaign", "pi-local", "--once"], {
      cwd,
      output: capture.output,
      runReal,
    });

    expect(exitCode).toBe(0);
    expect(runReal).toHaveBeenCalledWith(
      expect.objectContaining({
        stateRoot: resolve(cwd, ".df/local"),
        campaignId: "pi-local",
        maximumCompletedExperiments: 1,
      }),
    );
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "real-run",
      completedThisInvocation: 1,
      status: "stopped",
    });
  });

  it("rejects an invalid campaign cost before initialization", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();
    const initializeReal = vi.fn();

    const exitCode = await runLocalCli(
      ["real", "init", "--campaign", "pi-local", "--max-campaign-cost-usd", "zero"],
      { cwd, output: capture.output, initializeReal },
    );

    expect(exitCode).toBe(64);
    expect(initializeReal).not.toHaveBeenCalled();
    expect(JSON.parse(capture.stderr.join(""))).toMatchObject({
      command: "error",
      code: "DF_LOCAL_USAGE",
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "df-real-cli-"));
  temporaryDirectories.push(path);
  return path;
}

function captureOutput(): {
  readonly output: LocalCliOutput;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    output: {
      writeOut: (value) => stdout.push(value),
      writeErr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
}
