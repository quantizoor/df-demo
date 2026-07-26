import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalHash,
  computeContentHash,
} from "../../src/schemas/canonical.js";

const WORKER = resolve(
  "scripts/candidate-integrity-worker.mjs",
);
const PATH =
  "packages/coding-agent/src/core/system-prompt.ts";
const GIT_ENVIRONMENT = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Dark Factory",
  GIT_AUTHOR_EMAIL: "dark-factory@invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:01.000Z",
  GIT_COMMITTER_NAME: "Dark Factory",
  GIT_COMMITTER_EMAIL: "dark-factory@invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:01.000Z",
};

function runGit(
  repository: string,
  arguments_: readonly string[],
  input?: string,
): string {
  const result = spawnSync("git", arguments_, {
    cwd: repository,
    env: GIT_ENVIRONMENT,
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error("Git fixture construction failed.");
  }
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "df-integrity-worker-test-"),
  );
  const repository = join(root, "repository");
  const bundle = join(root, "candidate.bundle");
  const diff = join(root, "candidate.diff");
  const manifest = join(root, "manifest.json");
  await mkdir(repository);
  runGit(repository, ["init", "--quiet"]);
  const sourcePath = join(repository, PATH);
  await mkdir(dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, "old generic prompt\n", "utf8");
  runGit(repository, ["add", "--all", "--"]);
  const sourceTree = runGit(repository, ["write-tree"]);
  const sourceCommit = runGit(
    repository,
    ["commit-tree", sourceTree],
    "source\n",
  );
  runGit(repository, [
    "update-ref",
    "refs/heads/main",
    sourceCommit,
  ]);
  await writeFile(sourcePath, "new generic prompt\n", "utf8");
  runGit(repository, ["add", "--all", "--"]);
  const candidateTree = runGit(repository, ["write-tree"]);
  const candidateCommit = runGit(
    repository,
    ["commit-tree", candidateTree, "-p", sourceCommit],
    "candidate\n",
  );
  const bundleRef =
    "refs/heads/df/bundle/001-generic-recovery";
  runGit(repository, [
    "update-ref",
    bundleRef,
    candidateCommit,
  ]);
  runGit(repository, ["bundle", "create", bundle, bundleRef]);
  const bundleBytes = await readFile(bundle);
  return {
    root,
    bundle,
    diff,
    manifest,
    bundleRef,
    bundleSha256: createHash("sha256")
      .update(bundleBytes)
      .digest("hex"),
    bundleByteLength: bundleBytes.byteLength,
    sourceCommit,
    sourceTree,
    candidateCommit,
    candidateTree,
  };
}

function workerArguments(
  item: Awaited<ReturnType<typeof fixture>>,
  overrides: {
    readonly candidateTree?: string;
    readonly diff?: string;
    readonly manifest?: string;
  } = {},
): readonly string[] {
  return [
    WORKER,
    "--experiment",
    "001-generic-recovery",
    "--bundle",
    item.bundle,
    "--bundle-sha256",
    item.bundleSha256,
    "--bundle-byte-length",
    String(item.bundleByteLength),
    "--bundle-ref",
    item.bundleRef,
    "--source-commit",
    item.sourceCommit,
    "--source-tree",
    item.sourceTree,
    "--candidate-commit",
    item.candidateCommit,
    "--candidate-tree",
    overrides.candidateTree ?? item.candidateTree,
    "--diff",
    overrides.diff ?? item.diff,
    "--manifest",
    overrides.manifest ?? item.manifest,
  ];
}

function runWorker(arguments_: readonly string[]) {
  return spawnSync(process.execPath, arguments_, {
    cwd: resolve("."),
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      DF_CLOUD_EXECUTION: "1",
      DAYTONA_SANDBOX_ID: "integrity-worker-test",
    },
    encoding: "utf8",
  });
}

describe("candidate-integrity Git evidence worker", () => {
  it("derives canonical paths, line counts, modes, and diff from exact commits", async () => {
    const item = await fixture();
    try {
      const result = runWorker(workerArguments(item));
      expect(result.status).toBe(0);
      const manifest = JSON.parse(
        await readFile(item.manifest, "utf8"),
      ) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        domain: "dark-factory.candidate-git-evidence.v1",
        sourceCommit: item.sourceCommit,
        sourceTree: item.sourceTree,
        candidateCommit: item.candidateCommit,
        candidateTree: item.candidateTree,
        changedFiles: [PATH],
        changedFilesHash: canonicalHash([PATH]),
        addedLines: 1,
        deletedLines: 1,
        modes: [
          {
            path: PATH,
            beforeMode: "100644",
            afterMode: "100644",
          },
        ],
      });
      expect(manifest["contentHash"]).toBe(
        computeContentHash(manifest),
      );
      const diff = await readFile(item.diff, "utf8");
      expect(manifest["diffSha256"]).toBe(
        createHash("sha256").update(diff).digest("hex"),
      );
      expect(manifest["diffByteLength"]).toBe(
        (await stat(item.diff)).size,
      );
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });

  it("rejects a candidate-tree substitution before producing evidence", async () => {
    const item = await fixture();
    try {
      const result = runWorker(
        workerArguments(item, {
          candidateTree: "0".repeat(40),
          diff: join(item.root, "rejected.diff"),
          manifest: join(item.root, "rejected.json"),
        }),
      );
      expect(result.status).toBe(78);
      expect(result.stderr).toBe(
        "Candidate-integrity worker failed closed.\n",
      );
    } finally {
      await rm(item.root, { recursive: true, force: true });
    }
  });
});
