import { describe, expect, it } from "vitest";

import { inspectMvpCloudEnvironment } from "../../src/mvp/cloud-config.js";

function environment(): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_CAMPAIGN_ID: "mvp-001",
    DF_MVP_MAX_ITERATIONS: "2",
    DAYTONA_API_KEY: "present-but-never-returned",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "eu",
    DF_MVP_DAYTONA_IMAGE:
      `ubuntu@sha256:${"a".repeat(64)}`,
    DF_DAYTONA_VOLUME_ID: "df-volume",
    DF_DAYTONA_VOLUME_SUBPATH: "mvp/state",
    DF_HARBOR_DAYTONA_SECRET_SOURCE: "DF_DAYTONA_NESTED",
    DF_FOUNDRY_BASE_URL:
      "https://existing-resource.services.ai.azure.com/anthropic",
    DF_OPTIMIZER_DEPLOYMENT: "optimizer-opus-5-deployment",
    DF_EVALUATED_DEPLOYMENT:
      "evaluated-opus-4-8-deployment",
    DF_OPTIMIZER_SECRET_SOURCE: "DF_FOUNDRY_OPTIMIZER",
    DF_EVALUATED_SECRET_SOURCE: "DF_FOUNDRY_EVALUATED",
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: "b".repeat(40),
    DF_PI_BASELINE_TREE: "c".repeat(40),
    DF_PI_PACKAGE_LOCK_SHA256: "d".repeat(64),
    DF_GITHUB_SECRET_SOURCE: "DF_PI_GITHUB_SSH_KEY",
  };
}

describe("MVP cloud configuration", () => {
  it("accepts references to existing deployments without returning secrets", () => {
    const readiness = inspectMvpCloudEnvironment(environment());
    expect(readiness.ready).toBe(true);
    expect(readiness.configuration).toMatchObject({
      daytona: {
        harborApiSecretSource: "DF_DAYTONA_NESTED",
        outerSandboxResources: {
          optimizer: {
            cpu: 4,
            memoryGiB: 8,
            diskGiB: 10,
          },
          evaluator: {
            cpu: 4,
            memoryGiB: 8,
            diskGiB: 10,
          },
        },
      },
      foundry: {
        optimizerDeployment: "optimizer-opus-5-deployment",
        evaluatedDeployment: "evaluated-opus-4-8-deployment",
        optimizerModelFamily: "claude-opus-5",
        evaluatedModelFamily: "claude-opus-4-8",
        evaluatedReasoningEffort: "high",
      },
      protocol: {
        taskCount: 5,
        repetitions: 3,
        matchedTrialCount: 30,
      },
    });
    expect(
      JSON.stringify(readiness.configuration),
    ).not.toContain("present-but-never-returned");
  });

  it("rejects local execution, non-EU targets, and non-Foundry endpoints", () => {
    const readiness = inspectMvpCloudEnvironment({
      ...environment(),
      GITHUB_ACTIONS: "false",
      DAYTONA_TARGET: "us",
      DF_FOUNDRY_BASE_URL: "https://api.anthropic.com",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.invalid).toEqual(
      expect.arrayContaining([
        "DF_CLOUD_EXECUTION",
        "DAYTONA_TARGET",
        "DF_FOUNDRY_BASE_URL",
      ]),
    );
  });

  it("rejects a non-Daytona control endpoint and malformed nested secret reference", () => {
    const readiness = inspectMvpCloudEnvironment({
      ...environment(),
      DAYTONA_API_URL: "https://example.com/api",
      DF_HARBOR_DAYTONA_SECRET_SOURCE: "not-valid",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.invalid).toEqual(
      expect.arrayContaining([
        "DAYTONA_API_URL",
        "DF_HARBOR_DAYTONA_SECRET_SOURCE",
      ]),
    );
  });

  it("keeps public model family separate from deployment aliases", () => {
    const readiness = inspectMvpCloudEnvironment({
      ...environment(),
      DF_OPTIMIZER_DEPLOYMENT: "my-existing-blue",
      DF_EVALUATED_DEPLOYMENT: "my-existing-green",
    });
    expect(readiness.configuration?.foundry).toMatchObject({
      optimizerDeployment: "my-existing-blue",
      evaluatedDeployment: "my-existing-green",
      optimizerModelFamily: "claude-opus-5",
      evaluatedModelFamily: "claude-opus-4-8",
    });
  });
});
