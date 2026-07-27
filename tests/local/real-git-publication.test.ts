import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  executeLocalGitCommand,
  type LocalGitCommand,
  type LocalGitExecutor,
  type LocalGitPublicationInput,
  publishLocalGitChampion,
} from "../../src/local/real/git-publication.js";

const temporaryDirectories: string[] = [];
const GIT_ENVIRONMENT = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LC_ALL: "C",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@invalid",
  GIT_AUTHOR_DATE: "2026-07-27T08:00:00.000Z",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@invalid",
  GIT_COMMITTER_DATE: "2026-07-27T08:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(workingDirectory: string, arguments_: readonly string[], stdin?: string): string {
  const result = spawnSync("git", arguments_, {
    cwd: workingDirectory,
    env: GIT_ENVIRONMENT,
    encoding: "utf8",
    input: stdin,
  });
  if (result.status !== 0) {
    throw new Error(`Git fixture command failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function fixture(): Promise<{
  readonly root: string;
  readonly canonicalRepository: string;
  readonly candidateWorktree: string;
  readonly remote: string;
  readonly parentCommit: string;
  readonly evaluatedTree: string;
  readonly input: LocalGitPublicationInput;
}> {
  const root = await mkdtemp(join(tmpdir(), "df-local-git-publication-"));
  temporaryDirectories.push(root);
  const canonicalRepository = join(root, "canonical");
  const candidateWorktree = join(root, "candidate");
  const remote = join(root, "origin.git");
  await mkdir(canonicalRepository);
  git(canonicalRepository, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(canonicalRepository, "candidate.txt"), "champion\n", "utf8");
  git(canonicalRepository, ["add", "--", "candidate.txt"]);
  git(canonicalRepository, ["commit", "--quiet", "-m", "fixture champion"]);
  const parentCommit = git(canonicalRepository, ["rev-parse", "HEAD"]);

  git(root, ["init", "--bare", "--quiet", remote]);
  git(canonicalRepository, ["remote", "add", "origin", remote]);
  git(canonicalRepository, ["push", "--quiet", "--set-upstream", "origin", "main"]);
  git(canonicalRepository, [
    "worktree",
    "add",
    "--quiet",
    "--detach",
    candidateWorktree,
    parentCommit,
  ]);
  await writeFile(join(candidateWorktree, "candidate.txt"), "candidate\n", "utf8");
  git(candidateWorktree, ["add", "--", "candidate.txt"]);
  const evaluatedTree = git(candidateWorktree, ["write-tree"]);
  const input: LocalGitPublicationInput = {
    decision: "promoted",
    campaignId: "campaign-001",
    experimentId: "001-edit-recovery",
    candidateWorktree,
    remoteName: "origin",
    parentCommit,
    evaluatedTree,
    commitMessage: "fix(coding-agent): improve edit recovery",
    commitTimestamp: "2026-07-27T08:01:00.000Z",
    decisionHash: "a".repeat(64),
  };
  return {
    root,
    canonicalRepository,
    candidateWorktree,
    remote,
    parentCommit,
    evaluatedTree,
    input,
  };
}

function remoteRef(repository: string, ref: string): string {
  return git(repository, ["rev-parse", "--verify", ref]);
}

describe("promotion-only local Git publication", () => {
  it.each(["rejected", "inconclusive"] as const)(
    "does not run Git or persist an intent for a %s decision",
    async (decision) => {
      const executeGit = vi.fn<LocalGitExecutor>();
      const persistIntent = vi.fn(async () => undefined);
      const result = await publishLocalGitChampion(
        {
          decision,
          campaignId: "campaign-001",
          experimentId: "001-no-promotion",
          candidateWorktree: "/runner/candidate",
          remoteName: "origin",
          parentCommit: "1".repeat(40),
          evaluatedTree: "2".repeat(40),
          commitMessage: "fix(coding-agent): unused candidate",
          commitTimestamp: "2026-07-27T08:01:00.000Z",
          decisionHash: "3".repeat(64),
        },
        { executeGit, persistIntent },
      );

      expect(result).toEqual({
        status: "not-promoted",
        decision,
        campaignId: "campaign-001",
        experimentId: "001-no-promotion",
      });
      expect(executeGit).not.toHaveBeenCalled();
      expect(persistIntent).not.toHaveBeenCalled();
    },
  );

  it("persists a deterministic intent before an atomic non-force push and leaves main untouched", async () => {
    const item = await fixture();
    const commands: LocalGitCommand[] = [];
    let intentPersisted = false;
    const executeGit: LocalGitExecutor = async (command) => {
      commands.push(command);
      if (command.arguments[0] === "push") expect(intentPersisted).toBe(true);
      return executeLocalGitCommand(command);
    };
    const persistIntent = vi.fn(async () => {
      intentPersisted = true;
    });
    const canonicalHeadBefore = git(item.canonicalRepository, ["rev-parse", "HEAD"]);

    const first = await publishLocalGitChampion(item.input, {
      executeGit,
      persistIntent,
    });

    expect(first.status).toBe("published");
    if (first.status !== "published") throw new Error("Expected a publication result.");
    expect(first.disposition).toBe("published");
    expect(first.recoveredAfterPushError).toBe(false);
    expect(first.intent).toMatchObject({
      parentCommit: item.parentCommit,
      evaluatedTree: item.evaluatedTree,
      experimentRef: "refs/heads/df/experiment/campaign-001/001-edit-recovery",
      championRef: "refs/heads/df/champion/campaign-001",
      publicationMode: "atomic-non-force",
      containsSecrets: false,
    });
    expect(persistIntent).toHaveBeenCalledOnce();
    const push = commands.find((command) => command.arguments[0] === "push");
    expect(push?.arguments).toEqual([
      "push",
      "--atomic",
      "--porcelain",
      "origin",
      `${first.intent.candidateCommit}:${first.intent.experimentRef}`,
      `${first.intent.candidateCommit}:${first.intent.championRef}`,
    ]);
    expect(push?.arguments.join(" ")).not.toContain("force");
    expect(push?.arguments.some((argument) => argument.startsWith("+"))).toBe(false);
    expect(remoteRef(item.remote, "refs/heads/main")).toBe(item.parentCommit);
    expect(remoteRef(item.remote, first.intent.experimentRef)).toBe(first.intent.candidateCommit);
    expect(remoteRef(item.remote, first.intent.championRef)).toBe(first.intent.candidateCommit);
    expect(git(item.candidateWorktree, ["rev-parse", "HEAD"])).toBe(item.parentCommit);
    expect(git(item.canonicalRepository, ["rev-parse", "HEAD"])).toBe(canonicalHeadBefore);
    expect(
      git(item.candidateWorktree, [
        "rev-list",
        "--parents",
        "--max-count=1",
        first.intent.candidateCommit,
      ]),
    ).toBe(`${first.intent.candidateCommit} ${item.parentCommit}`);
    expect(
      git(item.candidateWorktree, ["rev-parse", `${first.intent.candidateCommit}^{tree}`]),
    ).toBe(item.evaluatedTree);

    const pushCount = commands.filter((command) => command.arguments[0] === "push").length;
    const second = await publishLocalGitChampion(item.input, {
      executeGit,
      persistIntent,
    });
    expect(second.status).toBe("published");
    if (second.status !== "published") throw new Error("Expected a publication result.");
    expect(second.disposition).toBe("already-published");
    expect(second.intent.candidateCommit).toBe(first.intent.candidateCommit);
    expect(commands.filter((command) => command.arguments[0] === "push")).toHaveLength(pushCount);
  });

  it("does not push when durable intent persistence fails", async () => {
    const item = await fixture();
    const commands: LocalGitCommand[] = [];
    const executeGit: LocalGitExecutor = async (command) => {
      commands.push(command);
      return executeLocalGitCommand(command);
    };

    await expect(
      publishLocalGitChampion(item.input, {
        executeGit,
        persistIntent: async () => {
          throw new Error("durable store unavailable");
        },
      }),
    ).rejects.toThrow("durable store unavailable");
    expect(commands.some((command) => command.arguments[0] === "push")).toBe(false);
    expect(git(item.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/df"])).toBe("");
    expect(remoteRef(item.remote, "refs/heads/main")).toBe(item.parentCommit);
  });

  it("refuses to publish from the canonical branch instead of a detached candidate worktree", async () => {
    const item = await fixture();
    const commands: LocalGitCommand[] = [];
    const executeGit: LocalGitExecutor = async (command) => {
      commands.push(command);
      return executeLocalGitCommand(command);
    };

    await expect(
      publishLocalGitChampion(
        {
          ...item.input,
          candidateWorktree: item.canonicalRepository,
          evaluatedTree: git(item.canonicalRepository, [
            "rev-parse",
            `${item.parentCommit}^{tree}`,
          ]),
        },
        {
          executeGit,
          persistIntent: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: "RUNNER_WORKTREE_INVALID" });
    expect(commands.some((command) => command.arguments[0] === "commit-tree")).toBe(false);
    expect(commands.some((command) => command.arguments[0] === "push")).toBe(false);
    expect(git(item.canonicalRepository, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(remoteRef(item.remote, "refs/heads/main")).toBe(item.parentCommit);
  });

  it("recovers idempotently when Git reports a push failure after both refs landed", async () => {
    const item = await fixture();
    let replacedPushResult = false;
    const executeGit: LocalGitExecutor = async (command) => {
      const result = await executeLocalGitCommand(command);
      if (command.arguments[0] === "push") {
        replacedPushResult = true;
        return {
          exitCode: 1,
          stdout: result.stdout,
          stderr: "simulated lost push response",
        };
      }
      return result;
    };

    const result = await publishLocalGitChampion(item.input, {
      executeGit,
      persistIntent: async () => undefined,
    });

    expect(replacedPushResult).toBe(true);
    expect(result).toMatchObject({
      status: "published",
      disposition: "published",
      recoveredAfterPushError: true,
    });
  });

  it("fails closed when an immutable experiment ref already has different content", async () => {
    const item = await fixture();
    git(item.canonicalRepository, [
      "push",
      "--quiet",
      "origin",
      `${item.parentCommit}:refs/heads/df/experiment/${item.input.campaignId}/${item.input.experimentId}`,
    ]);
    const commands: LocalGitCommand[] = [];
    const executeGit: LocalGitExecutor = async (command) => {
      commands.push(command);
      return executeLocalGitCommand(command);
    };

    await expect(
      publishLocalGitChampion(item.input, {
        executeGit,
        persistIntent: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_CONFLICT" });
    expect(commands.some((command) => command.arguments[0] === "push")).toBe(false);
    expect(
      remoteRef(
        item.remote,
        `refs/heads/df/experiment/${item.input.campaignId}/${item.input.experimentId}`,
      ),
    ).toBe(item.parentCommit);
    expect(remoteRef(item.remote, "refs/heads/main")).toBe(item.parentCommit);
  });
});
