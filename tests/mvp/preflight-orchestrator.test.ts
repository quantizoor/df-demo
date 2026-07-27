import { describe, expect, it } from "vitest";

import type {
  MvpCloudRuntime,
  MvpControllerBundle,
  MvpRoleExecutionReceipt,
  MvpRoleSandboxLease,
  MvpRoleSandboxSpec,
  MvpRoleWorkerCommand,
  MvpStagedBundleReceipt,
} from "../../src/mvp/daytona-runtime.js";
import { MvpPreflightDiagnosticError } from "../../src/mvp/preflight-diagnostics.js";
import {
  launchMvpPreflight,
  type MvpPreflightConfiguration,
  type MvpPreflightStage,
  mvpPreflightDaytonaConfiguration,
  mvpPreflightSandboxSpecification,
  preflightConfigurationBindingHash,
} from "../../src/mvp/preflight-orchestrator.js";

const digest = "d".repeat(64);

function configuration(stage: MvpPreflightStage): MvpPreflightConfiguration {
  const base: Omit<MvpPreflightConfiguration, "configurationBindingHash"> = {
    stage,
    campaignId: "mvp-001",
    sourceCommit: "a".repeat(40),
    workflowRunId: "12345",
    workflowRunAttempt: 1,
    imageReference: `ghcr.io/parallaxai/dark-factory@sha256:${"b".repeat(64)}`,
    priorReceiptSha256: stage === "bootstrap" ? null : "c".repeat(64),
    controllerBundle: {
      localPath: "/runner/df-mvp-controller.tar.gz",
      sha256: digest,
    },
    daytona: {
      apiUrl: "https://app.daytona.io/api",
      target: "eu",
      volumeId: "b5a3ef4b-f71d-4064-b859-b327285523b9",
      volumeSubpath: "campaigns/mvp-001",
      nestedSecretSource: "DAYTONA_NESTED",
    },
  };
  return {
    ...base,
    configurationBindingHash: preflightConfigurationBindingHash(base),
  };
}

function bootstrapWorkerOutput(): string {
  return JSON.stringify({
    schemaVersion: 1,
    domain: "dark-factory.mvp-preflight-worker.v1",
    stage: "bootstrap",
    status: "passed",
    stageEvidence: {
      runtimePinSha256: "1".repeat(64),
      catalogSha256: "2".repeat(64),
      inventoryDigest: "3".repeat(64),
      compatibleTaskCount: 7,
      sourceTaskCount: 89,
      allStepVerifierEnvironmentModesSeparate: true,
      runtimeCompatibilityProven: true,
      officialResourcesFit: true,
    },
    sandboxAccounting: {
      created: 7,
      destroyed: 7,
      allDestroyed: true,
    },
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderData: false,
    containsRawTraces: false,
  });
}

class FakeRuntime implements MvpCloudRuntime {
  specification: MvpRoleSandboxSpec | null = null;
  destroyed = false;

  constructor(
    private readonly output: string,
    private readonly executeError: Error | null = null,
    private readonly destroyError: Error | null = null,
    private readonly stageError: Error | null = null,
  ) {}

  async create(specification: MvpRoleSandboxSpec): Promise<MvpRoleSandboxLease> {
    this.specification = specification;
    return { role: "evaluator", sandboxId: "preflight-sandbox" };
  }

  async stage(
    _lease: MvpRoleSandboxLease,
    bundle: MvpControllerBundle,
  ): Promise<MvpStagedBundleReceipt> {
    if (this.stageError !== null) throw this.stageError;
    return { role: "evaluator", sha256: bundle.sha256 };
  }

  async execute(
    _lease: MvpRoleSandboxLease,
    command: MvpRoleWorkerCommand,
  ): Promise<MvpRoleExecutionReceipt> {
    expect(command.arguments).toEqual([
      "node",
      "/tmp/df-mvp-controller/dist/mvp/preflight-worker.js",
      "bootstrap",
    ]);
    if (this.executeError !== null) throw this.executeError;
    return {
      role: "evaluator",
      startedAt: "2026-07-27T00:00:00.000Z",
      finishedAt: "2026-07-27T00:01:00.000Z",
      exitCode: 0,
      outputSha256: digest,
      outputByteLength: Buffer.byteLength(this.output),
      privateWorkerOutput: this.output,
    };
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.destroyError !== null) throw this.destroyError;
  }
}

describe("MVP protected preflight orchestration", () => {
  it("runs only the evaluator-private bootstrap and accounts for nested cleanup", async () => {
    const runtime = new FakeRuntime(bootstrapWorkerOutput());
    const receipt = await launchMvpPreflight({
      configuration: configuration("bootstrap"),
      runtime,
    });

    expect(receipt).toMatchObject({
      domain: "dark-factory.mvp-preflight.receipt.v1",
      stage: "bootstrap",
      status: "passed",
      actualIterationsCompleted: 0,
      counters: {
        optimizerInvocations: 0,
        modelRequests: 0,
        harborTrials: 0,
      },
      sandboxes: {
        created: 8,
        destroyed: 8,
        allDestroyed: true,
      },
    });
    expect(runtime.destroyed).toBe(true);
    expect(runtime.specification?.networkBlockAll).toBe(false);
    expect(runtime.specification?.networkAllowDomains).toEqual([
      "app.daytona.io",
      "ofhuhcpkvzjlejydnvyd.storage.supabase.co",
      "ofhuhcpkvzjlejydnvyd.supabase.co",
    ]);
    expect(runtime.specification?.secretReferences).toEqual([
      {
        sourceEnvironmentName: "DAYTONA_NESTED",
        targetEnvironmentName: "DAYTONA_API_KEY",
      },
    ]);
    expect(JSON.stringify(runtime.specification)).not.toMatch(/FOUNDRY|GITHUB_BASIC_AUTH/u);
  });

  it("builds a credential-free, network-blocked synthetic specification", () => {
    const specification = mvpPreflightSandboxSpecification(configuration("synthetic"));

    expect(specification.networkBlockAll).toBe(true);
    expect(specification.networkAllowDomains).toEqual([]);
    expect(specification.secretReferences).toEqual([]);
    expect(specification.environment.DF_MVP_MAX_ITERATIONS).toBe("0");
  });

  it("binds only the evaluator image into the preflight transport", () => {
    const input = configuration("bootstrap");
    const runtimeConfiguration = mvpPreflightDaytonaConfiguration(input);

    expect(runtimeConfiguration.daytona.images).toEqual({
      evaluator: input.imageReference,
    });
    expect(runtimeConfiguration.daytona.images).not.toHaveProperty("optimizer");
  });

  it("destroys the outer sandbox and fails closed for malformed worker evidence", async () => {
    const runtime = new FakeRuntime("{}");

    await expect(
      launchMvpPreflight({
        configuration: configuration("bootstrap"),
        runtime,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "worker-output-invalid",
    });
    expect(runtime.destroyed).toBe(true);
  });

  it("preserves a safe worker diagnostic after proving outer sandbox cleanup", async () => {
    const runtime = new FakeRuntime(
      "",
      new MvpPreflightDiagnosticError("bootstrap-discovery-eligibility"),
    );

    await expect(
      launchMvpPreflight({
        configuration: configuration("bootstrap"),
        runtime,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-discovery-eligibility",
    });
    expect(runtime.destroyed).toBe(true);
  });

  it("preserves a safe outer-stage subphase after proving sandbox cleanup", async () => {
    const runtime = new FakeRuntime(
      "",
      null,
      null,
      new MvpPreflightDiagnosticError("outer-stage-adapter-ownership"),
    );

    await expect(
      launchMvpPreflight({
        configuration: configuration("bootstrap"),
        runtime,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "outer-stage-adapter-ownership",
    });
    expect(runtime.destroyed).toBe(true);
  });

  it("reports outer cleanup failure in preference to an earlier worker failure", async () => {
    const runtime = new FakeRuntime(
      "",
      new MvpPreflightDiagnosticError("bootstrap-discovery-download"),
      new Error("provider cleanup details"),
    );

    await expect(
      launchMvpPreflight({
        configuration: configuration("bootstrap"),
        runtime,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "outer-cleanup",
    });
  });

  it("rejects any drift from the source-bound configuration hash", () => {
    const valid = configuration("bootstrap");
    expect(() =>
      mvpPreflightSandboxSpecification({
        ...valid,
        sourceCommit: "f".repeat(40),
      }),
    ).toThrow("source-bound preflight configuration is invalid");
  });
});
