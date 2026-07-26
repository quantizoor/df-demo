import { describe, expect, it } from "vitest";

import {
  assertPiHarnessDoctorMatchesConfiguration,
  inspectPiHarnessSourceEnvironment,
  PI_CODING_AGENT_PACKAGE,
} from "../../src/config/harness-source.js";

const COMMIT = "5bc1c2c0a6f07e00e8c240304182f213ab8d311f";
const TREE = "73898c76210cc8b48f4ac07cc76397b6b5c00758";
const LOCK = "472f0726dc79f3b38df58d8a8bce96bf56fbf993a134b49aabc54947b8461e59";

function environment(): NodeJS.ProcessEnv {
  return {
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: COMMIT,
    DF_PI_BASELINE_TREE: TREE,
    DF_PI_PACKAGE_LOCK_SHA256: LOCK,
    DF_PI_CODING_AGENT_VERSION: "0.82.1",
    DF_GITHUB_SECRET_SOURCE: "DF_GITHUB_PRIVATE_PI",
  };
}

describe("Pi harness source environment", () => {
  it("parses the exact private fork identity without a credential value", () => {
    const readiness = inspectPiHarnessSourceEnvironment(environment());
    expect(readiness).toEqual({
      ready: true,
      missing: [],
      invalid: [],
      configuration: {
        origin: {
          host: "github.com",
          owner: "parallaxai",
          repository: "df-pi-tbench",
          credential: {
            sourceEnvironmentName: "DF_GITHUB_PRIVATE_PI",
            targetEnvironmentName: "DF_GITHUB_TOKEN",
          },
        },
        expectedBranch: "main",
        expectedCommit: COMMIT,
        expectedTree: TREE,
        expectedLockSha256: LOCK,
        expectedPackageName: PI_CODING_AGENT_PACKAGE,
        expectedPackageVersion: "0.82.1",
        upstreamUrl: "https://github.com/earendil-works/pi.git",
      },
    });
  });

  it("fails closed on a mutable ref, short object id, or credential-like source", () => {
    const input = environment();
    input.DF_PI_BRANCH = "feature/../main";
    input.DF_PI_BASELINE_COMMIT = "5bc1c2c";
    input.DF_GITHUB_SECRET_SOURCE = "ghp_plaintext";
    const readiness = inspectPiHarnessSourceEnvironment(input);
    expect(readiness.ready).toBe(false);
    expect(readiness.configuration).toBeNull();
    expect(readiness.invalid).toEqual([
      "DF_GITHUB_SECRET_SOURCE",
      "DF_PI_BASELINE_COMMIT",
      "DF_PI_BRANCH",
    ]);
  });

  it("binds a read-only doctor observation to the authorized source identity", () => {
    const readiness = inspectPiHarnessSourceEnvironment(environment());
    if (readiness.configuration === null) throw new Error("fixture");
    const report = {
      canonicalPath: "/workspace/pi",
      branch: "main",
      trackingRef: "origin/main",
      headCommit: COMMIT,
      treeSha: TREE,
      lockSha256: LOCK,
      originFingerprint: {
        transport: "ssh" as const,
        hostHash: "0".repeat(64),
        repositoryHash: "1".repeat(64),
      },
      remotes: ["origin"],
      clean: true as const,
      piMonorepo: true as const,
    };
    expect(() =>
      assertPiHarnessDoctorMatchesConfiguration(
        report,
        readiness.configuration!,
      ),
    ).not.toThrow();
    expect(() =>
      assertPiHarnessDoctorMatchesConfiguration(
        { ...report, treeSha: "0".repeat(40) },
        readiness.configuration!,
      ),
    ).toThrow(/does not match/u);
  });
});
