import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type DashboardReadinessDependencies,
  inspectDashboardReadiness,
} from "../../src/local/dashboard/readiness.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dashboard campaign readiness", () => {
  it("checks real campaign prerequisites without creating campaign state or exposing paths", async () => {
    const fixture = await readinessFixture();
    const report = await inspectDashboardReadiness(
      {
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.projectRoot,
        piRepository: fixture.piRepository,
        credentialsFile: fixture.credentialsFile,
        claudeExecutable: fixture.claudeExecutable,
      },
      passingDependencies(fixture.piRepository),
    );

    expect(report.ready).toBe(true);
    expect(report.checks).toHaveLength(15);
    expect(report.checks.every((item) => item.status === "pass")).toBe(true);
    expect(report.containsSecrets).toBe(false);
    expect(await readdir(fixture.stateRoot)).toEqual([]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.apiKey);
  });

  it("returns fixed safe failures for invalid local and network prerequisites", async () => {
    const fixture = await readinessFixture();
    await chmod(fixture.credentialsFile, 0o644);
    await rm(fixture.claudeExecutable);
    const dependencies = passingDependencies(fixture.piRepository);
    const report = await inspectDashboardReadiness(
      {
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.projectRoot,
        piRepository: fixture.piRepository,
        credentialsFile: fixture.credentialsFile,
        claudeExecutable: fixture.claudeExecutable,
      },
      {
        ...dependencies,
        invoke: async (executable, arguments_, workingDirectory) => {
          if (executable === "git" && workingDirectory === fixture.piRepository) {
            if (arguments_[0] === "remote") {
              return { ok: true, stdout: "https://github.com/example/not-pi.git\n" };
            }
            if (arguments_[0] === "status") return { ok: true, stdout: " M source.ts\n" };
            return { ok: true, stdout: "not-an-object\n" };
          }
          return { ok: true, stdout: "available\n" };
        },
        fetchImplementation: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      },
    );

    expect(report.ready).toBe(false);
    for (const id of [
      "pi-immutable",
      "pi-origin",
      "pi-clean",
      "foundry-credentials",
      "claude-code",
      "terminal-bench-catalog",
    ]) {
      expect(report.checks.find((item) => item.id === id)?.status).toBe("fail");
    }
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(fixture.root);
    expect(serialized).not.toContain(fixture.apiKey);
    expect(await readdir(fixture.stateRoot)).toEqual([]);
  });

  it.each([
    {
      name: "a missing production adapter",
      mutate: async (fixture: Awaited<ReturnType<typeof readinessFixture>>) => {
        await rm(fixture.productionAdapter);
      },
    },
    {
      name: "a symlinked local adapter",
      mutate: async (fixture: Awaited<ReturnType<typeof readinessFixture>>) => {
        const target = join(fixture.root, "adapter-target.py");
        await writeFile(target, LOCAL_ADAPTER_SOURCE, "utf8");
        await rm(fixture.localAdapter);
        await symlink(target, fixture.localAdapter);
      },
    },
    {
      name: "an oversized production adapter",
      mutate: async (fixture: Awaited<ReturnType<typeof readinessFixture>>) => {
        await writeFile(fixture.productionAdapter, "x".repeat(256 * 1024 + 1), "utf8");
      },
    },
    {
      name: "a compiled adapter without its expected markers",
      mutate: async (fixture: Awaited<ReturnType<typeof readinessFixture>>) => {
        await writeFile(fixture.localAdapter, "class DarkFactoryPi:\n    pass\n", "utf8");
      },
    },
  ])("rejects $name", async ({ mutate }) => {
    const fixture = await readinessFixture();
    await mutate(fixture);

    const report = await inspectDashboardReadiness(
      {
        stateRoot: fixture.stateRoot,
        projectRoot: fixture.projectRoot,
        piRepository: fixture.piRepository,
        credentialsFile: fixture.credentialsFile,
        claudeExecutable: fixture.claudeExecutable,
      },
      passingDependencies(fixture.piRepository),
    );

    expect(report.ready).toBe(false);
    expect(report.checks.find((item) => item.id === "model-adapter")).toMatchObject({
      status: "fail",
      detail: "A compiled Pi Harbor adapter is missing, unsafe, or invalid.",
    });
  });
});

const LOCAL_ADAPTER_SOURCE = [
  "from dark_factory_pi import DarkFactoryPi as _ProductionDarkFactoryPi",
  "class DarkFactoryPi(_ProductionDarkFactoryPi):",
  "    pass",
  "",
].join("\n");

const PRODUCTION_ADAPTER_SOURCE = [
  "from harbor.agents.installed.base import BaseInstalledAgent",
  "class DarkFactoryPi(BaseInstalledAgent):",
  "    pass",
  "",
].join("\n");

function passingDependencies(piRepository: string): DashboardReadinessDependencies {
  return {
    nodeVersion: "24.0.0",
    invoke: async (executable, arguments_, workingDirectory) => {
      if (executable === "git" && workingDirectory === piRepository) {
        if (arguments_[0] === "remote") {
          return { ok: true, stdout: "git@github.com:parallaxai/df-pi-tbench.git\n" };
        }
        if (arguments_[0] === "status") return { ok: true, stdout: "" };
        return {
          ok: true,
          stdout: `${arguments_.join(" ").includes("HEAD^{tree}") ? "b" : "a"}${"0".repeat(39)}\n`,
        };
      }
      return { ok: true, stdout: "available\n" };
    },
    fetchImplementation: terminalBenchFetch(),
  };
}

function terminalBenchFetch(): typeof fetch {
  const tasks = Array.from({ length: 5 }, (_, index) => {
    const name = `task-${index + 1}`;
    return {
      name,
      git_url: "https://github.com/example/terminal-bench-tasks.git",
      git_commit_id: "c".repeat(40),
      path: name,
    };
  });
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/registry.json")) {
      return new Response(JSON.stringify([{ name: "terminal-bench", version: "2.0", tasks }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response('difficulty = "hard"\n', {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }) as typeof fetch;
}

async function readinessFixture(): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly projectRoot: string;
  readonly piRepository: string;
  readonly credentialsFile: string;
  readonly claudeExecutable: string;
  readonly localAdapter: string;
  readonly productionAdapter: string;
  readonly apiKey: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-dashboard-readiness-"));
  temporaryDirectories.push(root);
  const stateRoot = join(root, "state");
  const projectRoot = join(root, "project");
  const piRepository = join(root, "df-pi-tbench");
  const credentialsFile = join(root, "foundry.env");
  const claudeExecutable = join(root, "claude");
  const localAdapter = join(projectRoot, "dist", "local", "assets", "dark_factory_pi_local.py");
  const productionAdapter = join(
    projectRoot,
    "dist",
    "terminal-bench",
    "assets",
    "dark_factory_pi.py",
  );
  const apiKey = "secret-readiness-key-value";
  await Promise.all([
    mkdir(stateRoot, { recursive: true, mode: 0o700 }),
    mkdir(piRepository, { recursive: true, mode: 0o700 }),
    mkdir(join(projectRoot, "dist", "local", "assets"), { recursive: true, mode: 0o700 }),
    mkdir(join(projectRoot, "dist", "terminal-bench", "assets"), {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  await Promise.all([
    writeFile(
      credentialsFile,
      [
        "DF_FOUNDRY_BASE_URL=https://example.services.ai.azure.com/anthropic",
        "DF_OPTIMIZER_DEPLOYMENT=claude-opus-5",
        "DF_EVALUATED_DEPLOYMENT=claude-opus-4-8",
        `ANTHROPIC_FOUNDRY_API_KEY=${apiKey}`,
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    ),
    writeFile(claudeExecutable, "#!/bin/sh\nexit 0\n", {
      encoding: "utf8",
      mode: 0o700,
    }),
    writeFile(localAdapter, LOCAL_ADAPTER_SOURCE, { encoding: "utf8", mode: 0o600 }),
    writeFile(productionAdapter, PRODUCTION_ADAPTER_SOURCE, { encoding: "utf8", mode: 0o600 }),
  ]);
  return {
    root,
    stateRoot,
    projectRoot,
    piRepository,
    credentialsFile,
    claudeExecutable,
    localAdapter,
    productionAdapter,
    apiKey,
  };
}
