import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerPath = fileURLToPath(
  new URL("../../scripts/trusted-git-worker.mjs", import.meta.url),
);
const secretSentinel = "github_pat_TEST_ONLY_DO_NOT_LOG_1234567890";
const cloudEnvironment = {
  DF_CLOUD_EXECUTION: "1",
  DAYTONA_SANDBOX_ID: "sandbox-worker-test",
  DF_GITHUB_TOKEN: secretSentinel,
};

function invokeWorker(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = cloudEnvironment,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [workerPath, ...arguments_],
      {
        env: { ...environment },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error !== null && "code" in error && typeof error.code === "number"
            ? error.code
            : error === null
              ? 0
              : null;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function malformedSnapshot(remote: string): readonly string[] {
  return [
    "snapshot",
    "--remote",
    remote,
    "--origin-repository-sha256",
    "1".repeat(64),
    "--ref",
    "refs/heads/main",
    "--commit",
    "2".repeat(40),
    "--tree",
    "3".repeat(40),
    "--lock-sha256",
    "4".repeat(64),
    "--baseline",
    "2".repeat(40),
    "--upstream",
    "https://github.com/earendil-works/pi.git",
    "--upstream-repository-sha256",
    "5".repeat(64),
    "--upstream-head",
    "6".repeat(40),
    "--upstream-base",
    "7".repeat(40),
    "--archive",
    "/trusted/git/source.tar",
    "--manifest",
    "/trusted/git/source.json",
    "--archive-format",
    "git-archive-tar",
    "--compression",
    "none",
  ];
}

describe("trusted Git cloud worker adversarial boundary", () => {
  it("refuses local execution even when a credential-shaped value is present", async () => {
    const result = await invokeWorker(["snapshot"], {
      DF_CLOUD_EXECUTION: "1",
      DF_GITHUB_TOKEN: secretSentinel,
    });
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Trusted Git worker failed closed.\n");
    expect(result.stderr).not.toContain(secretSentinel);
  });

  it.each([
    "https://oauth2:credential-in-url@github.com/parallaxai/df-pi-tbench.git",
    "file:///tmp/pi.git",
    "ssh://git@github.com/parallaxai/df-pi-tbench.git",
    "https://github.com/parallaxai/df-pi-tbench.git?token=credential-in-query",
  ])("rejects credential-bearing or non-HTTPS origins without disclosure", async (remote) => {
    const result = await invokeWorker(malformedSnapshot(remote));
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Trusted Git worker failed closed.\n");
    expect(result.stderr).not.toContain(secretSentinel);
    expect(result.stderr).not.toContain("credential-in");
  });

  it("rejects duplicate flags and arbitrary publication refs before Git runs", async () => {
    const duplicate = await invokeWorker([
      "snapshot",
      "--remote",
      "https://github.com/parallaxai/df-pi-tbench.git",
      "--remote",
      "https://github.com/parallaxai/df-pi-tbench.git",
    ]);
    expect(duplicate.code).toBe(78);
    expect(duplicate.stderr).toBe("Trusted Git worker failed closed.\n");

    const arbitraryRef = await invokeWorker([
      "publish",
      "--remote",
      "https://github.com/parallaxai/df-pi-tbench.git",
      "--origin-repository-sha256",
      "1".repeat(64),
      "--upstream",
      "https://github.com/earendil-works/pi.git",
      "--upstream-repository-sha256",
      "2".repeat(64),
      "--upstream-head",
      "3".repeat(40),
      "--upstream-base",
      "4".repeat(40),
      "--bundle",
      "/trusted/git/candidate.bundle",
      "--bundle-sha256",
      "5".repeat(64),
      "--baseline",
      "6".repeat(40),
      "--base-ref",
      "refs/heads/main",
      "--base",
      "7".repeat(40),
      "--commit",
      "8".repeat(40),
      "--tree",
      "9".repeat(40),
      "--lock-sha256",
      "a".repeat(64),
      "--branch-ref",
      "refs/heads/main",
      "--tag-ref",
      "refs/tags/release",
      "--tag-timestamp",
      "2026-07-01T00:00:00.000Z",
      "--experiment",
      "001-safe-change",
      "--authorization-expires-at",
      "2026-07-01T01:00:00.000Z",
      "--result",
      "/trusted/git/publication.json",
      "--mode",
      "atomic-non-force",
    ]);
    expect(arbitraryRef.code).toBe(78);
    expect(arbitraryRef.stderr).toBe("Trusted Git worker failed closed.\n");
    expect(arbitraryRef.stderr).not.toContain(secretSentinel);
  });

  it("uses fixed argv-based Git execution and never enables a shell", async () => {
    const source = await readFile(workerPath, "utf8");
    expect(source).toContain('spawnSync("/usr/bin/git", arguments_');
    expect(source).toContain("shell: false");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain("execSync(");
    expect(source).not.toContain("execFileSync(");
    expect(source).not.toContain("${token}");
    expect(source).toMatch(/"push",\s*"--atomic"/u);
    expect(source).not.toContain('"--force"');
    expect(source).not.toContain("../pi");
  });
});
