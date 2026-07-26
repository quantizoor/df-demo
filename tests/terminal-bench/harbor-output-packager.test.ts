import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../scripts/package-harbor-output.mjs", import.meta.url),
);
const JOB_SHA256 = "a".repeat(64);
const PIN_SHA256 = "b".repeat(64);
const CONFIG_SHA256 = "c".repeat(64);
const roots: string[] = [];

interface Fixture {
  readonly root: string;
  readonly source: string;
  readonly output: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "df-harbor-output-test-"));
  roots.push(root);
  const source = join(root, "request-test-repair");
  const output = join(root, "request-test-repair.harbor-output.tar");
  await mkdir(source);
  await writeFile(join(source, "config.json"), '{"job_name":"fixture"}\n');
  await writeFile(join(source, "result.json"), '{"stats":{}}\n');
  for (const trial of [
    "trial-a",
    "trial-b",
    "trial-c",
    "trial-d",
    "trial-e",
  ]) {
    await mkdir(join(source, trial, "agent"), { recursive: true });
    await writeFile(join(source, trial, "result.json"), '{"reward":1}\n');
    await writeFile(
      join(source, trial, "agent", "trajectory.json"),
      '{"schema_version":"ATIF-v1.7"}\n',
    );
    await writeFile(
      join(source, trial, "agent", "dark-factory-pi.jsonl"),
      '{"type":"agent_end"}\n',
    );
  }
  return { root, source, output };
}

function invoke(value: Fixture) {
  return spawnSync(
    process.execPath,
    [
      scriptPath,
      "--source-directory",
      value.source,
      "--output",
      value.output,
      "--request-id",
      "request-test",
      "--job-sha256",
      JOB_SHA256,
      "--pin-sha256",
      PIN_SHA256,
      "--invocation-id",
      "request-test-repair",
      "--order",
      "repair",
      "--config-sha256",
      CONFIG_SHA256,
      "--execution-id",
      "execution-test-001",
      "--expected-trials",
      "5",
    ],
    {
      encoding: "utf8",
      env: {
        DF_CLOUD_EXECUTION: "1",
        DF_HARBOR_JOB_SHA256: JOB_SHA256,
        DF_TERMINAL_BENCH_PIN_SHA256: PIN_SHA256,
        DAYTONA_SANDBOX_ID: "synthetic-cloud-test",
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      },
      timeout: 30_000,
    },
  );
}

function tarManifest(archive: Buffer): Readonly<Record<string, unknown>> {
  expect(archive.subarray(0, 13).toString("utf8")).toBe("manifest.json");
  const rawSize = archive
    .subarray(124, 136)
    .toString("ascii")
    .replace(/\0.*$/u, "")
    .trim();
  const byteLength = Number.parseInt(rawSize, 8);
  return JSON.parse(
    archive.subarray(512, 512 + byteLength).toString("utf8"),
  ) as Readonly<Record<string, unknown>>;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("cloud Harbor output packager", () => {
  it("creates byte-identical, invocation-bound archives from identical outputs", async () => {
    const first = await fixture();
    const second = await fixture();
    const firstRun = invoke(first);
    const secondRun = invoke(second);

    expect(firstRun.status).toBe(0);
    expect(firstRun.stderr).toBe("");
    expect(secondRun.status).toBe(0);
    expect(secondRun.stderr).toBe("");

    const firstArchive = await readFile(first.output);
    const secondArchive = await readFile(second.output);
    expect(firstArchive.equals(secondArchive)).toBe(true);
    const manifest = tarManifest(firstArchive);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      domain: "dark-factory.harbor-output-bundle.v1",
      requestId: "request-test",
      jobSha256: JOB_SHA256,
      pinHash: PIN_SHA256,
      invocationId: "request-test-repair",
      order: "repair",
      configSha256: CONFIG_SHA256,
      executionId: "execution-test-001",
      expectedTrialCount: 5,
      fileCount: 17,
    });
    const files = manifest["files"] as Array<{ path: string }>;
    expect(files.map((entry) => entry.path)).toEqual([
      "config.json",
      "result.json",
      "trial-a/agent/dark-factory-pi.jsonl",
      "trial-a/agent/trajectory.json",
      "trial-a/result.json",
      "trial-b/agent/dark-factory-pi.jsonl",
      "trial-b/agent/trajectory.json",
      "trial-b/result.json",
      "trial-c/agent/dark-factory-pi.jsonl",
      "trial-c/agent/trajectory.json",
      "trial-c/result.json",
      "trial-d/agent/dark-factory-pi.jsonl",
      "trial-d/agent/trajectory.json",
      "trial-d/result.json",
      "trial-e/agent/dark-factory-pi.jsonl",
      "trial-e/agent/trajectory.json",
      "trial-e/result.json",
    ]);
    expect(
      createHash("sha256").update(firstArchive).digest("hex"),
    ).toBe(
      (
        JSON.parse(firstRun.stdout) as {
          archiveSha256: string;
        }
      ).archiveSha256,
    );
  });

  it("rejects links before creating a downloadable bundle", async () => {
    const value = await fixture();
    await symlink(
      join(value.source, "config.json"),
      join(value.source, "linked-config.json"),
    );

    const run = invoke(value);
    expect(run.status).not.toBe(0);
    await expect(readFile(value.output)).rejects.toThrow();
  });

  it("rejects special files before creating a downloadable bundle", async () => {
    const value = await fixture();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(value.source, "local.socket"), resolve);
    });
    try {
      const run = invoke(value);
      expect(run.status).not.toBe(0);
      await expect(readFile(value.output)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });

  it.each([
    ["nested archive", "trial-a/agent/raw.zip"],
    ["unexpected nested result", "trial-a/agent/result.json"],
    ["unexpected trajectory", "trial-a/trajectory.json"],
  ])("rejects a %s location", async (_label, path) => {
    const value = await fixture();
    const target = join(value.source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "forbidden");

    const run = invoke(value);
    expect(run.status).not.toBe(0);
    await expect(readFile(value.output)).rejects.toThrow();
  });
});
