import { describe, expect, it } from "vitest";

import {
  type MvpCloudConfiguration,
  inspectMvpCloudEnvironment,
} from "../../src/mvp/cloud-config.js";
import {
  launchMvpCloudShell,
  roleSpecification,
} from "../../src/mvp/cloud-orchestrator.js";
import {
  MVP_SCHEMA_VERSION,
  type OptimizerInput,
} from "../../src/mvp/contracts.js";
import type {
  MvpCloudRuntime,
  MvpControllerBundle,
  MvpRoleExecutionReceipt,
  MvpRoleSandboxLease,
  MvpRoleSandboxSpec,
  MvpRoleWorkerCommand,
  MvpStagedBundleReceipt,
} from "../../src/mvp/daytona-runtime.js";

const candidateRevision = "d".repeat(40);
const championRevision = "b".repeat(40);
const digest = "e".repeat(64);

function configuration(): MvpCloudConfiguration {
  const readiness = inspectMvpCloudEnvironment({
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_CAMPAIGN_ID: "mvp-001",
    DF_MVP_MAX_ITERATIONS: "1",
    DAYTONA_API_KEY: "not-returned",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "eu",
    DF_MVP_DAYTONA_IMAGE: `node@sha256:${"a".repeat(64)}`,
    DF_DAYTONA_VOLUME_ID: "df-volume",
    DF_DAYTONA_VOLUME_SUBPATH: "campaigns/mvp-001",
    DF_HARBOR_DAYTONA_SECRET_SOURCE: "DAYTONA_NESTED",
    DF_FOUNDRY_BASE_URL:
      "https://existing-resource.services.ai.azure.com/anthropic",
    DF_OPTIMIZER_DEPLOYMENT: "optimizer-existing",
    DF_EVALUATED_DEPLOYMENT: "evaluated-existing",
    DF_OPTIMIZER_SECRET_SOURCE: "FOUNDRY_OPTIMIZER",
    DF_EVALUATED_SECRET_SOURCE: "FOUNDRY_EVALUATOR",
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: championRevision,
    DF_PI_BASELINE_TREE: "c".repeat(40),
    DF_PI_PACKAGE_LOCK_SHA256: digest,
    DF_GITHUB_SECRET_SOURCE: "PI_GITHUB_BASIC_AUTH",
  });
  if (readiness.configuration === null) {
    throw new Error("test configuration must be ready");
  }
  return readiness.configuration;
}

function optimizerInput(): OptimizerInput {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentNumber: 1,
    championRevision,
    previousOutcome: null,
    diagnosticBrief: null,
    boundary: {
      taskCatalogVisible: false,
      taskIdentifiersVisible: false,
      taskPromptsVisible: false,
      graderVisible: false,
      rawTracesVisible: false,
      taskSpecificFeedbackVisible: false,
    },
  };
}

function iterationRelease(): unknown {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "task-free-campaign-receipt-v1",
    campaignId: "mvp-001",
    experimentNumber: 1,
    experimentId: "001-harness-improvement",
    disposition: "promote",
    championChanged: true,
    evidenceFresh: true,
    meanRewardDelta: 0.6,
    confidenceCandidateBetter: 0.96875,
    nextExperimentNumber: 2,
    panelAction: "cleared-after-promotion",
    cache: {
      hits: 0,
      misses: 15,
      refreshedForPromotion: 0,
      seededFromPromotion: 15,
    },
    diagnosticCardCount: 0,
    containsTaskIdentifiers: false,
    containsTaskNames: false,
    containsPerTaskOutcomes: false,
    containsGraderMaterial: false,
  };
}

class FakeRuntime implements MvpCloudRuntime {
  readonly specifications: MvpRoleSandboxSpec[] = [];
  readonly operations: string[] = [];
  readonly destroyed: string[] = [];

  async create(
    specification: MvpRoleSandboxSpec,
  ): Promise<MvpRoleSandboxLease> {
    this.specifications.push(specification);
    return {
      role: specification.role,
      sandboxId: `${specification.role}-sandbox`,
    };
  }

  async stage(
    lease: MvpRoleSandboxLease,
    bundle: MvpControllerBundle,
  ): Promise<MvpStagedBundleReceipt> {
    this.operations.push(`stage:${lease.role}`);
    return { role: lease.role, sha256: bundle.sha256 };
  }

  async execute(
    lease: MvpRoleSandboxLease,
    command: MvpRoleWorkerCommand,
  ): Promise<MvpRoleExecutionReceipt> {
    const operation = command.arguments[2];
    if (operation === undefined) throw new Error("missing operation");
    this.operations.push(operation);
    let output: unknown;
    if (operation === "prepare") {
      output = optimizerInput();
    } else if (operation === "optimize") {
      expect(
        JSON.parse(
          Buffer.from(
            command.environment["DF_MVP_OPTIMIZER_INPUT_BASE64"] ?? "",
            "base64url",
          ).toString("utf8"),
        ),
      ).toEqual(optimizerInput());
      output = {
        hypothesisId: "improve-recovery",
        hypothesisSummary: "Improve generic recovery behavior.",
        interventionSummary: "Add bounded recovery and verification.",
        candidateRevision,
        changedFiles: ["packages/coding-agent/src/agent.ts"],
      };
    } else {
      const proposal = JSON.parse(
        Buffer.from(
          command.environment[
            "DF_MVP_CANDIDATE_PROPOSAL_BASE64"
          ] ?? "",
          "base64url",
        ).toString("utf8"),
      ) as { candidateRevision?: string };
      expect(proposal.candidateRevision).toBe(candidateRevision);
      output = iterationRelease();
    }
    const serialized = JSON.stringify(output);
    return {
      role: lease.role,
      startedAt: "2026-07-26T10:00:00.000Z",
      finishedAt: "2026-07-26T10:01:00.000Z",
      exitCode: 0,
      outputSha256: digest,
      outputByteLength: Buffer.byteLength(serialized),
      privateWorkerOutput: serialized,
    };
  }

  async destroy(lease: MvpRoleSandboxLease): Promise<void> {
    this.destroyed.push(lease.role);
  }
}

describe("MVP cloud orchestration", () => {
  it("relays only strict public objects across isolated roles", async () => {
    const runtime = new FakeRuntime();
    const receipt = await launchMvpCloudShell({
      configuration: configuration(),
      identity: {
        sourceCommit: "f".repeat(40),
        workflowRunId: "1234",
        workflowRunAttempt: 1,
      },
      controllerBundle: {
        localPath: "/cloud/df-mvp-controller.tar.gz",
        sha256: digest,
      },
      runtime,
      now: () => new Date("2026-07-26T10:00:00.000Z"),
    });

    expect(receipt.status).toBe("actual-iteration-completed");
    expect(runtime.operations).toEqual([
      "stage:optimizer",
      "stage:evaluator",
      "prepare",
      "optimize",
      "evaluate",
    ]);
    expect(runtime.destroyed).toEqual(["evaluator", "optimizer"]);
    expect(runtime.specifications[0]?.volume.subpath).not.toBe(
      runtime.specifications[1]?.volume.subpath,
    );
    expect(
      roleSpecification(configuration(), "optimizer").secretReferences,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetEnvironmentName: "DF_GITHUB_BASIC_AUTH",
        }),
      ]),
    );
    expect(
      roleSpecification(configuration(), "evaluator").secretReferences,
    ).toEqual(
      expect.arrayContaining([
        {
          sourceEnvironmentName: "DAYTONA_NESTED",
          targetEnvironmentName: "DAYTONA_API_KEY",
        },
      ]),
    );
    expect(
      roleSpecification(configuration(), "evaluator").environment,
    ).toMatchObject({
      DAYTONA_API_URL: "https://app.daytona.io/api",
      DAYTONA_TARGET: "eu",
      DF_EVALUATED_SECRET_SOURCE: "FOUNDRY_EVALUATOR",
    });
    expect(
      roleSpecification(configuration(), "optimizer").environment,
    ).not.toHaveProperty("DF_EVALUATED_SECRET_SOURCE");
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain("campaigns/mvp-001");
    expect(serialized).not.toContain("PI_GITHUB_BASIC_AUTH");
  });

  it("returns blocked readiness and never claims an iteration", async () => {
    const runtime = new FakeRuntime();
    runtime.execute = async (lease, command) => {
      const output = JSON.stringify({
        schemaVersion: 1,
        domain: "dark-factory.mvp-worker-readiness.v1",
        status: "blocked",
        role: lease.role,
        missingPrerequisites: ["MVP_EVALUATOR_RUNTIME_PIN"],
        containsTaskIdentifiers: false,
        containsTaskLiterals: false,
        containsGraderData: false,
        containsRawTraces: false,
      });
      return {
        role: lease.role,
        startedAt: "2026-07-26T10:00:00.000Z",
        finishedAt: "2026-07-26T10:00:01.000Z",
        exitCode: 0,
        outputSha256: digest,
        outputByteLength: Buffer.byteLength(output),
        privateWorkerOutput: output,
      };
    };
    const receipt = await launchMvpCloudShell({
      configuration: configuration(),
      identity: {
        sourceCommit: "f".repeat(40),
        workflowRunId: "1234",
        workflowRunAttempt: 1,
      },
      controllerBundle: {
        localPath: "/cloud/df-mvp-controller.tar.gz",
        sha256: digest,
      },
      runtime,
    });
    expect(receipt).toMatchObject({
      status: "blocked",
      actualIterationsCompleted: 0,
      missingPrerequisites: ["MVP_EVALUATOR_RUNTIME_PIN"],
    });
  });
});
