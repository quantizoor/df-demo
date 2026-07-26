import { describe, expect, it } from "vitest";
import {
  fingerprintRemoteUrl,
  GitCommandError,
  redactSensitiveText,
  SafeGit,
} from "../../src/harness/git.js";
import type {
  ProcessInvocation,
  ProcessResult,
  ProcessRunner,
} from "../../src/harness/process.js";
import { CloudGitProcessRunner } from "../../src/harness/process.js";
import {
  createImmutableBaselineTag,
  doctorRepository,
  registerRepository,
  type RemoteVerifier,
  type RemoteVerification,
  type UpstreamLineageVerification,
} from "../../src/harness/repository.js";

const REPOSITORY_PATH = "/workspace/pi";
const HEAD = "a".repeat(40);
const UPSTREAM_BASE = "b".repeat(40);
const TREE = "e".repeat(40);
const ORIGIN_URL = "https://oauth2:top-secret@github.example.test/operator/pi.git";

describe("cloud-only Git runner", () => {
  it("cannot be constructed from a local opt-in flag alone", () => {
    expect(
      () =>
        new CloudGitProcessRunner("daytona", {
          DF_CLOUD_EXECUTION: "1",
        }),
    ).toThrow(/runtime marker/u);
  });
});

class FakeRunner implements ProcessRunner {
  readonly invocations: ProcessInvocation[] = [];
  readonly responses = new Map<string, ProcessResult>();

  constructor(remotes = "origin\n") {
    const success = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
    this.responses.set("rev-parse --is-inside-work-tree", success("true\n"));
    this.responses.set("rev-parse --show-toplevel", success(`${REPOSITORY_PATH}\n`));
    this.responses.set("status --porcelain=v1 --untracked-files=normal", success(""));
    this.responses.set("symbolic-ref --quiet --short HEAD", success("main\n"));
    this.responses.set(
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
      success("origin/main\n"),
    );
    this.responses.set("rev-parse HEAD", success(`${HEAD}\n`));
    this.responses.set("rev-parse HEAD^{tree}", success(`${TREE}\n`));
    this.responses.set("remote", success(remotes));
    this.responses.set("config --get remote.origin.url", success(`${ORIGIN_URL}\n`));
    this.responses.set(
      "show HEAD:packages/coding-agent/package.json",
      success('{"name":"@earendil-works/pi-coding-agent"}\n'),
    );
    this.responses.set("show HEAD:package-lock.json", success('{"lockfileVersion":3}\n'));
  }

  run(invocation: ProcessInvocation): Promise<ProcessResult> {
    this.invocations.push(invocation);
    return Promise.resolve(
      this.responses.get(invocation.arguments.join(" ")) ?? {
        exitCode: 99,
        stdout: "",
        stderr: "unexpected fake command",
      },
    );
  }
}

class FakeRemoteVerifier implements RemoteVerifier {
  verification: RemoteVerification = {
    private: true,
    fetchable: true,
    writable: true,
    checkedAt: "2026-07-01T00:00:00.000Z",
    providerAttestationHash: "f".repeat(64),
  };
  upstreamVerification: UpstreamLineageVerification = {
    fetchable: true,
    upstreamHeadCommit: "c".repeat(40),
    mergeBaseCommit: UPSTREAM_BASE,
    checkedAt: "2026-07-01T00:00:01.000Z",
    providerAttestationHash: "d".repeat(64),
  };
  seenUrl: string | undefined;
  seenUpstreamUrl: string | undefined;

  verifyOrigin(
    _workingDirectory: string,
    reference: { readonly remoteName: string; readonly url: string },
  ): Promise<RemoteVerification> {
    this.seenUrl = reference.url;
    return Promise.resolve(this.verification);
  }

  verifyUpstreamLineage(input: {
    readonly origin: { readonly remoteName: string; readonly url: string };
    readonly upstream: { readonly remoteName: string; readonly url: string };
    readonly forkHeadCommit: string;
  }): Promise<UpstreamLineageVerification> {
    this.seenUpstreamUrl = input.upstream.url;
    return Promise.resolve(this.upstreamVerification);
  }
}

describe("safe Git boundary", () => {
  it("always invokes a fixed executable without a shell or open stdin", async () => {
    const runner = new FakeRunner();
    const git = new SafeGit(runner);
    await git.text(REPOSITORY_PATH, ["rev-parse", "HEAD"]);
    expect(runner.invocations[0]).toEqual({
      executable: "git",
      arguments: ["rev-parse", "HEAD"],
      workingDirectory: REPOSITORY_PATH,
      environment: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      timeoutMs: 30_000,
      stdin: "closed",
    });
  });

  it.each([
    ["-c", "credential.helper=!steal"],
    ["rev-parse", "HEAD\nremote"],
    ["--config-env=credential.helper=SECRET"],
  ])("rejects dangerous Git arguments", async (...arguments_) => {
    const git = new SafeGit(new FakeRunner());
    await expect(git.run(REPOSITORY_PATH, arguments_)).rejects.toThrow();
  });

  it("redacts credentials from errors and diagnostic text", async () => {
    const runner = new FakeRunner();
    runner.responses.set("fetch origin", {
      exitCode: 1,
      stdout: "",
      stderr: `fatal: could not read ${ORIGIN_URL}?token=ghp_abcdefghijklmnopqrstuvwxyz`,
    });
    const git = new SafeGit(runner);
    let caught: unknown;
    try {
      await git.run(REPOSITORY_PATH, ["fetch", "origin"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitCommandError);
    expect(String(caught)).not.toContain("top-secret");
    expect(String(caught)).not.toContain("ghp_");
    expect(redactSensitiveText(ORIGIN_URL)).not.toContain("top-secret");
  });

  it("creates stable fingerprints without retaining remote paths", () => {
    const first = fingerprintRemoteUrl(ORIGIN_URL);
    const second = fingerprintRemoteUrl("git@github.example.test:operator/pi.git");
    expect(first.repositoryHash).toBe(second.repositoryHash);
    expect(JSON.stringify(first)).not.toContain("operator");
    expect(JSON.stringify(first)).not.toContain("pi.git");
  });
});

describe("repository doctor and registration", () => {
  it("proves the canonical Pi worktree is clean, tracked, and recognizable", async () => {
    const report = await doctorRepository(new SafeGit(new FakeRunner()), {
      canonicalPath: REPOSITORY_PATH,
      expectedBranch: "main",
      expectedTrackingRemote: "origin",
    });
    expect(report).toMatchObject({
      canonicalPath: REPOSITORY_PATH,
      branch: "main",
      trackingRef: "origin/main",
      headCommit: HEAD,
      treeSha: TREE,
      clean: true,
      piMonorepo: true,
    });
    expect(JSON.stringify(report)).not.toContain("top-secret");
  });

  it("fails closed on a dirty canonical worktree", async () => {
    const runner = new FakeRunner();
    runner.responses.set("status --porcelain=v1 --untracked-files=normal", {
      exitCode: 0,
      stdout: " M package.json\n",
      stderr: "",
    });
    await expect(
      doctorRepository(new SafeGit(runner), {
        canonicalPath: REPOSITORY_PATH,
        expectedBranch: "main",
        expectedTrackingRemote: "origin",
      }),
    ).rejects.toThrow(/dirty/u);
  });

  it("verifies fork lineage in an isolated cloud clone without mutating the checkout", async () => {
    const runner = new FakeRunner();
    const verifier = new FakeRemoteVerifier();
    const registration = await registerRepository(new SafeGit(runner), verifier, {
      canonicalPath: REPOSITORY_PATH,
      expectedBranch: "main",
      expectedTrackingRemote: "origin",
    });
    expect(registration).toMatchObject({
      canonicalPath: REPOSITORY_PATH,
      headCommit: HEAD,
      treeSha: TREE,
      upstreamBaseCommit: UPSTREAM_BASE,
    });
    expect(verifier.seenUrl).toBe(ORIGIN_URL);
    expect(verifier.seenUpstreamUrl).toBe(
      "https://github.com/earendil-works/pi.git",
    );
    expect(
      runner.invocations.some(
        (invocation) =>
          invocation.arguments[0] === "fetch" ||
          invocation.arguments[0] === "tag" ||
          (invocation.arguments[0] === "remote" &&
            invocation.arguments[1] === "add"),
      ),
    ).toBe(false);
    expect(JSON.stringify(registration)).not.toContain("top-secret");
  });

  it("does not mutate remotes when origin privacy cannot be proven", async () => {
    const runner = new FakeRunner();
    const verifier = new FakeRemoteVerifier();
    verifier.verification = { ...verifier.verification, private: false };
    await expect(
      registerRepository(new SafeGit(runner), verifier, {
        canonicalPath: REPOSITORY_PATH,
        expectedBranch: "main",
        expectedTrackingRemote: "origin",
      }),
    ).rejects.toThrow(/private/u);
    expect(
      runner.invocations.some((invocation) => invocation.arguments[1] === "add"),
    ).toBe(false);
  });

  it("refuses to create any baseline tag in the canonical local checkout", async () => {
    const runner = new FakeRunner();
    const git = new SafeGit(runner);
    const registration = await registerRepository(git, new FakeRemoteVerifier(), {
      canonicalPath: REPOSITORY_PATH,
      expectedBranch: "main",
      expectedTrackingRemote: "origin",
    });
    const invocationCount = runner.invocations.length;
    await expect(
      createImmutableBaselineTag(git, registration, "df/baseline/000"),
    ).rejects.toThrow(/cloud Git publication/u);
    expect(runner.invocations).toHaveLength(invocationCount);
    expect(
      runner.invocations.some(
        (invocation) => invocation.arguments[0] === "tag",
      ),
    ).toBe(false);
  });
});
