import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveDashboardRunnerCliPath } from "../../src/local/dashboard/supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard campaign supervisor", () => {
  it("locates the built runner from the project root without a module URL", async () => {
    const projectRoot = await temporaryProject();
    const cliPath = resolve(projectRoot, "dist", "local", "cli.js");
    await writeFile(cliPath, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o700 });
    vi.stubGlobal(
      "URL",
      class URL {
        constructor() {
          throw new Error("Dashboard runner resolution must not use an ambient URL constructor");
        }
      },
    );

    await expect(resolveDashboardRunnerCliPath(projectRoot)).resolves.toBe(cliPath);
  });

  it("rejects a symlink in place of the built runner", async () => {
    const projectRoot = await temporaryProject();
    const target = join(projectRoot, "runner.js");
    const cliPath = resolve(projectRoot, "dist", "local", "cli.js");
    await writeFile(target, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o700 });
    await symlink(target, cliPath);

    await expect(resolveDashboardRunnerCliPath(projectRoot)).rejects.toThrow(
      "Built local runner CLI must be a regular file",
    );
  });
});

async function temporaryProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "df-dashboard-supervisor-"));
  temporaryDirectories.push(projectRoot);
  await mkdir(resolve(projectRoot, "dist", "local"), { recursive: true, mode: 0o700 });
  return projectRoot;
}
