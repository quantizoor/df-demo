import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const script = resolve(
  "scripts/discover-terminal-bench-pin.mjs",
);
const sourceCommit = "a".repeat(40);
const temporaryRoots: string[] = [];

async function fixture(taskCount = 89): Promise<{
  readonly root: string;
  readonly dataset: string;
  readonly harborPackage: string;
  readonly harborExecutable: string;
  readonly harborVersionOutput: string;
  readonly piAdapter: string;
  readonly output: string;
}> {
  const root = await mkdtemp(
    join(tmpdir(), "df-pin-discovery-test-"),
  );
  temporaryRoots.push(root);
  const dataset = join(root, "dataset");
  await mkdir(dataset);
  await writeFile(
    join(dataset, "dataset.toml"),
    'name = "synthetic-dataset"\n',
  );
  for (let index = 0; index < taskCount; index += 1) {
    const task = join(
      dataset,
      `synthetic-private-task-${String(index).padStart(3, "0")}`,
    );
    await mkdir(task);
    await writeFile(
      join(task, "task.toml"),
      `name = "private-${index}"\n`,
    );
    await writeFile(
      join(task, "instruction.md"),
      `Synthetic instruction ${index}.\n`,
    );
  }
  const harborPackage = join(root, "harbor.whl");
  const harborExecutable = join(root, "harbor");
  const harborVersionOutput = join(root, "harbor-version.txt");
  const piAdapter = join(root, "dark_factory_pi.py");
  await writeFile(harborPackage, "synthetic wheel bytes");
  await writeFile(harborExecutable, "#!/bin/sh\n");
  await chmod(harborExecutable, 0o755);
  await writeFile(harborVersionOutput, "harbor 0.20.0\n");
  await writeFile(piAdapter, "# synthetic adapter\n");
  return {
    root,
    dataset,
    harborPackage,
    harborExecutable,
    harborVersionOutput,
    piAdapter,
    output: join(root, "terminal-bench-2.1.pin.json"),
  };
}

function argumentsFor(
  value: Awaited<ReturnType<typeof fixture>>,
): readonly string[] {
  return [
    "--dataset-root",
    value.dataset,
    "--harbor-package",
    value.harborPackage,
    "--harbor-executable",
    value.harborExecutable,
    "--harbor-version-output",
    value.harborVersionOutput,
    "--pi-adapter",
    value.piAdapter,
    "--source-commit",
    sourceCommit,
    "--registry-revision",
    "6",
    "--harbor-version",
    "0.20.0",
    "--output",
    value.output,
  ];
}

const cloudEnvironment = {
  ...process.env,
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_SHA: sourceCommit,
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("cloud-only Terminal-Bench pin discovery", () => {
  it("emits only a content-addressed task-free pin receipt", async () => {
    const value = await fixture();
    const execution = await execute(
      process.execPath,
      [script, ...argumentsFor(value)],
      { env: cloudEnvironment },
    );
    const receiptText = await readFile(value.output, "utf8");
    const receipt = JSON.parse(receiptText) as {
      readonly domain: string;
      readonly receiptHash: string;
      readonly taskNames?: unknown;
      readonly pin: {
        readonly taskCount: number;
        readonly harborVersion: string;
        readonly datasetContentSha256: string;
      };
    };

    expect(receipt).toMatchObject({
      domain:
        "dark-factory.terminal-bench-pin-discovery-receipt.v1",
      pin: {
        taskCount: 89,
        harborVersion: "0.20.0",
      },
    });
    expect(receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.pin.datasetContentSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(receipt.taskNames).toBeUndefined();
    expect(receiptText).not.toContain("synthetic-private-task");
    expect(execution.stdout).not.toContain("synthetic-private-task");
  });

  it("fails closed without releasing inventory when task count is wrong", async () => {
    const value = await fixture(88);
    await expect(
      execute(
        process.execPath,
        [script, ...argumentsFor(value)],
        { env: cloudEnvironment },
      ),
    ).rejects.toMatchObject({
      stderr: expect.not.stringContaining(
        "synthetic-private-task",
      ),
    });
    await expect(readFile(value.output, "utf8")).rejects.toThrow();
  });

  it("rejects a symlink anywhere in the downloaded dataset", async () => {
    const value = await fixture();
    await symlink(
      join(value.dataset, "dataset.toml"),
      join(value.dataset, "private-link"),
    );
    await expect(
      execute(
        process.execPath,
        [script, ...argumentsFor(value)],
        { env: cloudEnvironment },
      ),
    ).rejects.toBeDefined();
    await expect(readFile(value.output, "utf8")).rejects.toThrow();
  });

  it("rejects workstation execution before inspecting the dataset", async () => {
    const value = await fixture();
    await expect(
      execute(
        process.execPath,
        [script, ...argumentsFor(value)],
        {
          env: {
            ...cloudEnvironment,
            GITHUB_ACTIONS: "false",
          },
        },
      ),
    ).rejects.toBeDefined();
    await expect(readFile(value.output, "utf8")).rejects.toThrow();
  });
});
