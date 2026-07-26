import { describe, expect, it } from "vitest";
import {
  inspectBootstrapEnvironment,
  redactEnvironmentForDiagnostics,
} from "../../src/config/environment.js";

function completeEnvironment(): NodeJS.ProcessEnv {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  return {
    DF_CLOUD_PROVIDER: "daytona",
    DAYTONA_API_KEY: "secret-never-returned",
    DF_CLOUD_REGION_CLASS: "trusted-eu",
    DF_TRUSTED_CONTROL_PLANE: "1",
    DF_TRUSTED_VOLUME_ROOT: "/mnt/dark-factory",
    DF_CONTROL_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-control@${imageDigest}`,
    DF_CONTROL_IMAGE_DIGEST: imageDigest,
    DF_OPTIMIZER_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-optimizer@${imageDigest}`,
    DF_OPTIMIZER_IMAGE_DIGEST: imageDigest,
    DF_BUILD_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-build@${imageDigest}`,
    DF_BUILD_IMAGE_DIGEST: imageDigest,
    DF_EVALUATOR_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-evaluator@${imageDigest}`,
    DF_EVALUATOR_IMAGE_DIGEST: imageDigest,
    DF_OPTIMIZER_MODEL: "claude-opus-exact",
    DF_OPTIMIZER_EFFORT: "high",
    DF_CLAUDE_CODE_VERSION: "2.1.217",
    DF_OPTIMIZER_SECRET_SOURCE: "DF_ANTHROPIC_OPTIMIZER_SECRET",
    DF_OPTIMIZER_SECRET_TARGET: "ANTHROPIC_API_KEY",
    DF_EVALUATED_PROVIDER: "openai",
    DF_EVALUATED_MODEL: "gpt-5.6",
    DF_EVALUATED_REASONING: "high",
    DF_EVALUATED_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_OPENAI_MODEL_SECRET",
        targetEnvironmentName: "OPENAI_API_KEY",
      },
    ]),
    DF_GITHUB_SECRET_SOURCE: "DF_GITHUB_PRIVATE_REPO_SECRET",
    DF_HARBOR_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_DAYTONA_NESTED_SECRET",
        targetEnvironmentName: "DAYTONA_API_KEY",
      },
    ]),
    DF_MODE: "research",
    DF_LEADERBOARD_ELIGIBILITY: "unverified",
    DF_TRUSTED_ZONE: "trusted-zone",
    DF_SIGNING_KEY_ID: "signer",
    DF_HARBOR_VERSION: "0.20.0",
    DF_TBENCH_REGISTRY_REVISION: "6",
    DF_TBENCH_DATASET_CONTENT_SHA256: "b".repeat(64),
    DF_TBENCH_DATASET_MANIFEST_SHA256: "c".repeat(64),
    DF_HARBOR_PACKAGE_SHA256: "d".repeat(64),
    DF_HARBOR_EXECUTABLE_SHA256: "e".repeat(64),
    DF_PI_HARBOR_ADAPTER_SHA256: "f".repeat(64),
    DF_BUDGET_USD: "100",
    DF_BUDGET_TOKENS: "1000000",
    DF_BUDGET_WALL_TIME_MINUTES: "240",
    DF_BUDGET_ATTEMPTS: "380",
    DF_BUDGET_PRIVACY_RELEASES: "5",
    DF_BUDGET_PROMOTION_LOOKS: "5",
  };
}

describe("bootstrap environment", () => {
  it("requires explicit provider, models, benchmark pins, trust zone, and budgets", () => {
    const readiness = inspectBootstrapEnvironment({});
    expect(readiness.ready).toBe(false);
    expect(readiness.missing).toContain("DF_CLOUD_PROVIDER");
    expect(readiness.missing).toContain("DF_EVALUATED_MODEL");
    expect(readiness.missing).toContain("DF_BUDGET_USD");
  });

  it("loads a complete configuration without copying the credential value", () => {
    const readiness = inspectBootstrapEnvironment(completeEnvironment());
    expect(readiness.ready).toBe(true);
    expect(readiness.configuration).toMatchObject({
      cloudProvider: "daytona",
      cloudCredentialVariable: "DAYTONA_API_KEY",
      optimizer: {
        model: "claude-opus-exact",
        effort: "high",
      },
      evaluated: {
        provider: "openai",
        model: "gpt-5.6",
      },
      terminalBench: {
        benchmark: "terminal-bench-2.1",
        registryRevision: 6,
        taskCount: 89,
      },
      budget: {
        maximumWallTimeMs: 14_400_000,
        maximumAttempts: 380,
      },
    });
    expect(JSON.stringify(readiness)).not.toContain("secret-never-returned");
  });

  it("reports secret presence but never the value", () => {
    const diagnostics = redactEnvironmentForDiagnostics(completeEnvironment());
    expect(diagnostics.DAYTONA_API_KEY).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("secret-never-returned");
  });

  it("rejects invalid provider and non-positive budget values", () => {
    const readiness = inspectBootstrapEnvironment({
      ...completeEnvironment(),
      DF_CLOUD_PROVIDER: "local",
      DF_BUDGET_USD: "0",
    });
    expect(readiness.invalid).toEqual(
      expect.arrayContaining(["DF_CLOUD_PROVIDER", "DF_BUDGET_USD"]),
    );
  });

  it("rejects mutable images and overlapping evaluator credential targets", () => {
    const readiness = inspectBootstrapEnvironment({
      ...completeEnvironment(),
      DF_EVALUATOR_IMAGE_REFERENCE: "ghcr.io/parallaxai/df-evaluator:latest",
      DF_HARBOR_SECRET_BINDINGS_JSON: JSON.stringify([
        {
          sourceEnvironmentName: "DF_WRONG_SECRET",
          targetEnvironmentName: "OPENAI_API_KEY",
        },
      ]),
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.invalid).toEqual(
      expect.arrayContaining([
        "DF_EVALUATOR_IMAGE_REFERENCE",
        "DF_SECRET_TARGET_PLAN",
      ]),
    );
  });
});
