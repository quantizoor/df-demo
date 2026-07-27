import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isDirectExecution, type LocalCliOutput, runLocalCli } from "../../src/local/cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local CLI", () => {
  it("runs the native deterministic campaign by default and retains inspectable artifacts", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();
    const times = [new Date("2026-07-27T10:00:00.000Z"), new Date("2026-07-27T10:00:01.000Z")];

    const exitCode = await runLocalCli([], {
      cwd,
      output: capture.output,
      now: () => times.shift() ?? new Date("2026-07-27T10:00:01.000Z"),
    });

    expect(exitCode).toBe(0);
    expect(capture.stderr).toEqual([]);
    const result = JSON.parse(capture.stdout.join("")) as {
      readonly command: string;
      readonly status: string;
      readonly latest: {
        readonly runId: string;
        readonly relativeRunDirectory: string;
        readonly containsSecrets: boolean;
        readonly realOptimizationPerformed: boolean;
      };
    };
    expect(result.command).toBe("run");
    expect(result.status).toBe("passed");
    expect(result.latest.runId).toMatch(/^run-20260727T100000000Z-[a-f0-9]{8}-[a-f0-9-]{27}$/u);
    expect(result.latest.relativeRunDirectory).toBe(`runs/${result.latest.runId}`);
    expect(result.latest.containsSecrets).toBe(false);
    expect(result.latest.realOptimizationPerformed).toBe(false);

    const stateRoot = resolve(cwd, ".df/local");
    const runRoot = join(stateRoot, result.latest.relativeRunDirectory);
    await expect(readJson(join(stateRoot, "latest-run.json"))).resolves.toMatchObject({
      runId: result.latest.runId,
      relativeSummaryPath: `runs/${result.latest.runId}/run.json`,
      status: "passed",
      containsSecrets: false,
    });
    await expect(readJson(join(runRoot, "run.json"))).resolves.toMatchObject({
      runId: result.latest.runId,
      status: "passed",
      realOptimizationPerformed: false,
    });
    await expect(readJson(join(runRoot, "receipt.json"))).resolves.toMatchObject({
      status: "passed",
      containsTaskIdentifiers: false,
      containsGraderMaterial: false,
    });
    expect(await readdir(join(runRoot, "campaign/experiments"))).toEqual([
      "001-synthetic-screen",
      "002-synthetic-promotion",
    ]);
    expect(await readdir(join(runRoot, "campaign/state"))).toContain("campaign-state.json");
    expect(await readdir(join(runRoot, "infrastructure-invalid/experiments"))).toEqual([
      "001-synthetic-infrastructure",
    ]);
  });

  it("supports the explicit run command and status reads its atomic latest pointer", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "operator-state");
    const runCapture = captureOutput();

    expect(
      await runLocalCli(["run", "--state-root", stateRoot], {
        cwd,
        output: runCapture.output,
      }),
    ).toBe(0);
    const runResult = JSON.parse(runCapture.stdout.join("")) as {
      readonly latest: { readonly runId: string };
    };

    const statusCapture = captureOutput();
    expect(
      await runLocalCli(["status", "--state-root", stateRoot], {
        cwd,
        output: statusCapture.output,
      }),
    ).toBe(0);
    expect(JSON.parse(statusCapture.stdout.join(""))).toMatchObject({
      command: "status",
      status: "passed",
      latest: {
        runId: runResult.latest.runId,
        status: "passed",
        receiptStatus: "passed",
      },
      summary: {
        runId: runResult.latest.runId,
        status: "passed",
      },
    });
  });

  it("returns a clear no-runs status without creating the state root", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "not-created");
    const capture = captureOutput();

    expect(
      await runLocalCli(["status", "--state-root", stateRoot], {
        cwd,
        output: capture.output,
      }),
    ).toBe(0);
    expect(JSON.parse(capture.stdout.join(""))).toEqual({
      command: "status",
      status: "no-runs",
      message: "No local runs have been recorded.",
    });
    await expect(readdir(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("doctors synthetic readiness independently of optional Docker and reports real gaps", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "state");
    const capture = captureOutput();
    const probeDocker = vi.fn(async () => ({
      required: false as const,
      cli: { available: false, version: null },
      daemon: { available: false, version: null },
    }));

    expect(
      await runLocalCli(["doctor", "--state-root", stateRoot], {
        cwd,
        output: capture.output,
        nodeVersion: "24.10.1",
        platform: "linux",
        architecture: "arm64",
        probeDocker,
      }),
    ).toBe(0);
    const report = JSON.parse(capture.stdout.join("")) as {
      readonly ok: boolean;
      readonly runtime: {
        readonly node: { readonly compatible: boolean };
        readonly platform: string;
        readonly architecture: string;
      };
      readonly docker: { readonly required: boolean };
      readonly synthetic: { readonly ready: boolean; readonly requiresDocker: boolean };
      readonly realOptimization: {
        readonly ready: boolean;
        readonly missing: readonly string[];
      };
    };
    expect(probeDocker).toHaveBeenCalledOnce();
    expect(report.ok).toBe(true);
    expect(report.runtime).toMatchObject({
      node: { compatible: true },
      platform: "linux",
      architecture: "arm64",
    });
    expect(report.docker.required).toBe(false);
    expect(report.synthetic).toMatchObject({ ready: true, requiresDocker: false });
    expect(report.realOptimization.ready).toBe(false);
    expect(report.realOptimization.missing).toEqual(
      expect.arrayContaining(["Pi checkout", "task catalog", "model adapter"]),
    );
  });

  it("does not report ready when the runs directory violates local storage constraints", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "state");
    const outside = join(cwd, "outside");
    const capture = captureOutput();
    await mkdir(stateRoot);
    await mkdir(outside);
    await symlink(outside, join(stateRoot, "runs"));

    expect(
      await runLocalCli(["doctor", "--state-root", stateRoot], {
        cwd,
        output: capture.output,
        nodeVersion: "24.10.1",
        probeDocker: async () => ({
          required: false,
          cli: { available: false, version: null },
          daemon: { available: false, version: null },
        }),
      }),
    ).toBe(1);
    expect(capture.stderr).toEqual([]);
    expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
      command: "doctor",
      ok: false,
      state: { writable: false },
      synthetic: { ready: false },
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "probes writeability in runs rather than only in its writable parent",
    async () => {
      const cwd = await temporaryRoot();
      const stateRoot = join(cwd, "state");
      const runsRoot = join(stateRoot, "runs");
      const capture = captureOutput();
      await mkdir(runsRoot, { recursive: true });
      await chmod(runsRoot, 0o500);
      try {
        expect(
          await runLocalCli(["doctor", "--state-root", stateRoot], {
            cwd,
            output: capture.output,
            nodeVersion: "24.10.1",
            probeDocker: async () => ({
              required: false,
              cli: { available: false, version: null },
              daemon: { available: false, version: null },
            }),
          }),
        ).toBe(1);
        expect(JSON.parse(capture.stdout.join(""))).toMatchObject({
          command: "doctor",
          ok: false,
          state: { writable: false },
          synthetic: { ready: false },
        });
      } finally {
        await chmod(runsRoot, 0o700);
      }
    },
  );

  it("rejects relative state roots before starting work", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();

    expect(
      await runLocalCli(["run", "--state-root", ".df/local"], {
        cwd,
        output: capture.output,
      }),
    ).toBe(64);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr.join("")).toContain("DF_LOCAL_USAGE");
    expect(capture.stderr.join("")).toContain("explicit absolute non-root path");
    expect(await readdir(cwd)).toEqual([]);
  });

  it("rejects symlinked state roots without writing through them", async () => {
    const cwd = await temporaryRoot();
    const outside = join(cwd, "outside");
    const stateRoot = join(cwd, "linked-state");
    const capture = captureOutput();
    await mkdir(outside);
    await symlink(outside, stateRoot);

    expect(
      await runLocalCli(["run", "--state-root", stateRoot], {
        cwd,
        output: capture.output,
      }),
    ).toBe(70);
    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr.join(""))).toMatchObject({
      command: "error",
      code: "DF_LOCAL_COMMAND_FAILED",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects a symlinked runs directory without writing outside the state root", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "state");
    const outside = join(cwd, "outside");
    const capture = captureOutput();
    await mkdir(stateRoot);
    await mkdir(outside);
    await symlink(outside, join(stateRoot, "runs"));

    expect(
      await runLocalCli(["run", "--state-root", stateRoot], {
        cwd,
        output: capture.output,
      }),
    ).toBe(70);
    expect(capture.stdout).toEqual([]);
    expect(JSON.parse(capture.stderr.join(""))).toMatchObject({
      command: "error",
      code: "DF_LOCAL_COMMAND_FAILED",
    });
    expect(await readdir(outside)).toEqual([]);
  });

  it("rejects incomplete or extended receipts when reading status", async () => {
    const cwd = await temporaryRoot();
    const stateRoot = join(cwd, "state");
    const runCapture = captureOutput();
    expect(
      await runLocalCli(["run", "--state-root", stateRoot], {
        cwd,
        output: runCapture.output,
      }),
    ).toBe(0);
    const run = JSON.parse(runCapture.stdout.join("")) as {
      readonly latest: { readonly relativeRunDirectory: string };
    };
    const runDirectory = join(stateRoot, run.latest.relativeRunDirectory);
    const summaryPath = join(runDirectory, "run.json");
    const receiptPath = join(runDirectory, "receipt.json");
    const validSummary = (await readJson(summaryPath)) as Record<string, unknown>;
    const validReceipt = (await readJson(receiptPath)) as Record<string, unknown>;

    const missingChecks = structuredClone(validSummary);
    delete (missingChecks["receipt"] as Record<string, unknown>)["checks"];
    await writeFile(summaryPath, `${JSON.stringify(missingChecks)}\n`, "utf8");
    await expectStatusFailure(cwd, stateRoot);

    const extendedChecks = structuredClone(validSummary);
    const receiptWithExtendedChecks = extendedChecks["receipt"] as Record<string, unknown>;
    (receiptWithExtendedChecks["checks"] as Record<string, unknown>)["unexpected"] = true;
    await writeFile(summaryPath, `${JSON.stringify(extendedChecks)}\n`, "utf8");
    await expectStatusFailure(cwd, stateRoot);

    await writeFile(summaryPath, `${JSON.stringify(validSummary)}\n`, "utf8");
    const extendedReceipt = structuredClone(validReceipt);
    extendedReceipt["unexpected"] = true;
    await writeFile(receiptPath, `${JSON.stringify(extendedReceipt)}\n`, "utf8");
    await expectStatusFailure(cwd, stateRoot);
  });

  it("emits one parseable JSON document for Commander usage errors", async () => {
    const cwd = await temporaryRoot();
    const capture = captureOutput();

    expect(await runLocalCli(["--bogus"], { cwd, output: capture.output })).toBe(64);
    expect(capture.stdout).toEqual([]);
    expect(capture.stderr).toHaveLength(1);
    expect(JSON.parse(capture.stderr[0] ?? "")).toEqual({
      command: "error",
      code: "DF_LOCAL_USAGE",
      message: "unknown option '--bogus'",
    });
  });

  it("recognizes an installed bin symlink as direct execution", async () => {
    const root = await temporaryRoot();
    const modulePath = join(root, "dist/local/cli.js");
    const linkedBin = join(root, "bin/df-local");
    await mkdir(join(root, "dist/local"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(modulePath, "#!/usr/bin/env node\n", "utf8");
    await symlink(modulePath, linkedBin);

    expect(isDirectExecution(linkedBin, pathToFileURL(modulePath).href)).toBe(true);
  });
});

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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "df-local-cli-"));
  temporaryDirectories.push(root);
  return root;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function expectStatusFailure(cwd: string, stateRoot: string): Promise<void> {
  const capture = captureOutput();
  expect(
    await runLocalCli(["status", "--state-root", stateRoot], {
      cwd,
      output: capture.output,
    }),
  ).toBe(70);
  expect(capture.stdout).toEqual([]);
  expect(capture.stderr).toHaveLength(1);
  expect(JSON.parse(capture.stderr[0] ?? "")).toMatchObject({
    command: "error",
    code: "DF_LOCAL_COMMAND_FAILED",
  });
}
