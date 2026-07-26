import { describe, expect, it } from "vitest";

import {
  inspectMvpCloudEnvironment,
  isMvpModelDeploymentAlias,
  validateEvaluationEnvironment,
} from "../../src/mvp/index.js";

const VALID_ALIASES = ["a", "claude-opus-5", "team.opus_4-blue", "a".repeat(128)] as const;

const INVALID_ALIASES = [
  "",
  "Claude-opus-5",
  "claude/opus",
  "claude@opus",
  "claude:opus",
  "claude opus",
  "claude--opus",
  "-claude",
  "claude-",
  "a".repeat(129),
] as const;

describe("MVP Foundry deployment alias grammar", () => {
  it.each(VALID_ALIASES)("accepts %s at the parser and evaluation-schema boundaries", (alias) => {
    expect(isMvpModelDeploymentAlias(alias)).toBe(true);
    const readiness = inspectMvpCloudEnvironment(cloudEnvironment(alias));
    expect(readiness.ready).toBe(true);
    expect(readiness.configuration?.foundry.optimizerDeployment).toBe(alias);
    expect(readiness.configuration?.foundry.evaluatedDeployment).toBe(alias);
    expect(() => validateEvaluationEnvironment(evaluationEnvironment(alias))).not.toThrow();
  });

  it.each(INVALID_ALIASES)("rejects %s at the parser and evaluation-schema boundaries", (alias) => {
    expect(isMvpModelDeploymentAlias(alias)).toBe(false);
    const readiness = inspectMvpCloudEnvironment(cloudEnvironment(alias));
    expect(readiness.ready).toBe(false);
    const reported = new Set([...readiness.missing, ...readiness.invalid]);
    expect(reported.has("DF_OPTIMIZER_DEPLOYMENT")).toBe(true);
    expect(reported.has("DF_EVALUATED_DEPLOYMENT")).toBe(true);
    expect(() => validateEvaluationEnvironment(evaluationEnvironment(alias))).toThrow(
      /evaluation environment/u,
    );
  });
});

function cloudEnvironment(alias: string): NodeJS.ProcessEnv {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_CAMPAIGN_ID: "mvp-001",
    DF_MVP_MAX_ITERATIONS: "1",
    DAYTONA_API_KEY: "outer-key",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "eu",
    DF_MVP_DAYTONA_IMAGE: `node@sha256:${"a".repeat(64)}`,
    DF_DAYTONA_VOLUME_ID: "df-volume",
    DF_DAYTONA_VOLUME_SUBPATH: "campaigns/mvp-001",
    DF_HARBOR_DAYTONA_SECRET_SOURCE: "DAYTONA_NESTED",
    DF_FOUNDRY_BASE_URL: "https://existing-resource.services.ai.azure.com/anthropic",
    DF_OPTIMIZER_DEPLOYMENT: alias,
    DF_EVALUATED_DEPLOYMENT: alias,
    DF_OPTIMIZER_SECRET_SOURCE: "FOUNDRY_OPTIMIZER",
    DF_EVALUATED_SECRET_SOURCE: "FOUNDRY_EVALUATOR",
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: "b".repeat(40),
    DF_PI_BASELINE_TREE: "c".repeat(40),
    DF_PI_PACKAGE_LOCK_SHA256: "d".repeat(64),
    DF_GITHUB_SECRET_SOURCE: "PI_GITHUB_BASIC_AUTH",
  };
}

function evaluationEnvironment(modelDeployment: string): Readonly<Record<string, unknown>> {
  return {
    terminalBenchVersion: "terminal-bench-2.1",
    datasetRevision: "terminal-bench-2.1",
    graderProtocolVersion: "harbor-0.20.0",
    evaluatorVersion: "mvp-1",
    modelProvider: "microsoft-foundry",
    modelDeployment,
    reasoningEffort: "high",
    samplingSettingsDigest: "1".repeat(64),
    contextSettingsDigest: "2".repeat(64),
    sandboxProvider: "daytona",
    sandboxRegion: "eu",
    imageDigest: "3".repeat(64),
    architecture: "x86_64",
    resourcesDigest: "4".repeat(64),
    networkPolicyDigest: "5".repeat(64),
    harnessConfigDigest: "6".repeat(64),
    extraConfigDigest: "7".repeat(64),
  };
}
