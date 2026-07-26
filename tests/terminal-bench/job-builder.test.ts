import { describe, expect, it } from "vitest";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type { HarnessArtifactReference } from "../../src/evaluator/contracts.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  computeHarnessRuntimeResolutionHash,
  TerminalBench21TrustedJobBuilder,
  type TrustedCanonicalJsonPublisher,
  type TrustedHiddenTaskResolver,
} from "../../src/terminal-bench/job-builder.js";
import {
  HARBOR_AGENT_ISOLATION_POLICY,
  computeTrustedHarborJobHash,
} from "../../src/terminal-bench/harbor.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../../src/terminal-bench/pi-agent.js";
import type { TerminalBench21Pin } from "../../src/terminal-bench/pin.js";
import {
  createTrustedMatchedArmSchedule,
  type TrustedEvaluationStage,
  type TrustedMatchedPanel,
} from "../../src/terminal-bench/trusted.js";

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "a".repeat(64),
  datasetManifestSha256: "b".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "c".repeat(64),
  harborExecutableSha256: "d".repeat(64),
  piHarborAdapterSha256: "e".repeat(64),
};

const candidate: HarnessArtifactReference = {
  uri: "trusted://harness/candidate",
  commitSha: "1".repeat(40),
  treeSha: "1".repeat(40),
  archiveSha256: "1".repeat(64),
};
const champion: HarnessArtifactReference = {
  uri: "trusted://harness/champion",
  commitSha: "2".repeat(40),
  treeSha: "2".repeat(40),
  archiveSha256: "2".repeat(64),
};

function panel(stage: TrustedEvaluationStage): TrustedMatchedPanel {
  const count = stage === "repair" ? 5 : 12;
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: `lease-${stage}`,
    requestId: `request-${stage}`,
    stage,
    sealedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T06:00:00.000Z",
    dispositionAttestationHash: "8".repeat(64),
    cells: Array.from({ length: count }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
      taskRevisionDigest: (index + 20).toString(16).padStart(64, "0"),
      capabilityStratum: `stratum-${(index % 3) + 1}`,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

function runtime(harness: HarnessArtifactReference) {
  const artifact: TrustedCloudArtifactRef = {
    uri:
      harness.commitSha === candidate.commitSha
        ? "trusted://runtimes/candidate"
        : "trusted://runtimes/champion",
    sha256: harness.archiveSha256,
    mediaType: "application/x-tar",
    byteLength: 65_536,
  };
  const provisional = {
    sensitivity: "trusted-harness-runtime-resolution" as const,
    harness,
    artifact,
    validationLevel: "release" as const,
    buildReceiptHash: "f".repeat(64),
    verifiedAt: "2026-07-01T00:00:00.000Z",
    resolutionHash: "0".repeat(64),
  };
  return {
    ...provisional,
    resolutionHash: computeHarnessRuntimeResolutionHash(provisional),
  };
}

function agent() {
  return createPiHarborAgentSpec({
    adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
    adapterSha256: pin.piHarborAdapterSha256,
    provider: "openai",
    modelId: "gpt-5.6",
    thinkingLevel: "high",
    enabledTools: ["write", "read", "bash", "edit"],
    credentialEnvironmentNames: ["OPENAI_API_KEY"],
    timeoutMs: 3_600_000,
  });
}

function setup(
  taskResolver?: TrustedHiddenTaskResolver,
  modelApiAllowedHosts: readonly string[] = ["api.openai.com"],
) {
  const published = new Map<string, Readonly<Record<string, unknown>>>();
  const publisher: TrustedCanonicalJsonPublisher = {
    publish: (input) => {
      published.set(
        input.logicalName,
        JSON.parse(input.canonicalJson) as Readonly<Record<string, unknown>>,
      );
      return Promise.resolve({
        uri: `trusted://configs/${input.logicalName}`,
        sha256: input.sha256,
        mediaType: "application/json",
        byteLength: Buffer.byteLength(input.canonicalJson, "utf8"),
      });
    },
  };
  const resolver: TrustedHiddenTaskResolver =
    taskResolver ??
    {
      resolve: (taskId, taskRevisionDigest) =>
        Promise.resolve({
          sensitivity: "trusted-hidden-task-resolution",
          taskId,
          taskRevisionDigest,
          packageTaskName: `synthetic/task-${taskId.slice(-8)}`,
        }),
    };
  return {
    published,
    builder: new TerminalBench21TrustedJobBuilder({
      pin,
      taskResolver: resolver,
      runtimeResolver: {
        resolve: (harness) => Promise.resolve(runtime(harness)),
      },
      publisher,
      adapterArtifact: {
        uri: "trusted://adapters/dark-factory-pi",
        sha256: pin.piHarborAdapterSha256,
        mediaType: "text/x-python",
        byteLength: 10_000,
      },
      outputPackagerArtifact: {
        uri: "trusted://evaluator/package-harbor-output",
        sha256: "9".repeat(64),
        mediaType: "text/javascript",
        byteLength: 20_000,
      },
      remoteUploadRoot: "/workspace/evaluator/",
      remoteOutputRoot: "/trusted/results/",
      environmentType: "daytona",
      modelApiAllowedHosts,
      piEntrypoint: "packages/coding-agent/dist/pi",
    }),
  };
}

describe("trusted Harbor job builder", () => {
  it("derives the sole evaluated-model host from the Foundry resource", async () => {
    const hiddenPanel = panel("repair");
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    );
    const foundryAgent = createPiHarborAgentSpec({
      adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
      adapterSha256: pin.piHarborAdapterSha256,
      provider: "microsoft-foundry",
      modelId: "df-opus48-eval",
      modelFamily: "claude-opus-4-8",
      foundryResourceName: "df-eu-prod",
      thinkingLevel: "high",
      enabledTools: ["write", "read", "bash", "edit"],
      credentialEnvironmentNames: ["ANTHROPIC_FOUNDRY_API_KEY"],
      timeoutMs: 3_600_000,
    });
    const { builder, published } = setup(
      undefined,
      ["df-eu-prod.services.ai.azure.com"],
    );
    await builder.build({
      sensitivity: "hidden-harbor-build-request",
      pin,
      panel: hiddenPanel,
      schedule,
      agent: foundryAgent,
      isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
    });
    const config = [...published.values()][0]!;
    const configuredAgent = (
      config["agents"] as Array<Record<string, unknown>>
    )[0]!;
    expect(configuredAgent["extra_allowed_hosts"]).toEqual([
      "df-eu-prod.services.ai.azure.com",
    ]);
    expect(configuredAgent["kwargs"]).toMatchObject({
      foundry_resource_name: "df-eu-prod",
      model_family: "claude-opus-4-8",
      credential_environment_names: [
        "ANTHROPIC_FOUNDRY_API_KEY",
      ],
    });
  });

  it("rejects a Foundry job with an unrelated model host", async () => {
    const hiddenPanel = panel("repair");
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    );
    const { builder } = setup(undefined, ["api.anthropic.com"]);
    await expect(
      builder.build({
        sensitivity: "hidden-harbor-build-request",
        pin,
        panel: hiddenPanel,
        schedule,
        agent: createPiHarborAgentSpec({
          adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
          adapterSha256: pin.piHarborAdapterSha256,
          provider: "microsoft-foundry",
          modelId: "df-opus48-eval",
          modelFamily: "claude-opus-4-8",
          foundryResourceName: "df-eu-prod",
          thinkingLevel: "high",
          enabledTools: ["read", "write", "bash"],
          credentialEnvironmentNames: [
            "ANTHROPIC_FOUNDRY_API_KEY",
          ],
          timeoutMs: 3_600_000,
        }),
        isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
      }),
    ).rejects.toThrow("exact derived API host");
  });

  it("builds two serial, retry-free AB/BA jobs without returning hidden task names", async () => {
    const hiddenPanel = panel("validation");
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    );
    const { builder, published } = setup();
    const job = await builder.build({
      sensitivity: "hidden-harbor-build-request",
      pin,
      panel: hiddenPanel,
      schedule,
      agent: agent(),
      isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
    });

    expect(job.invocations.map((entry) => entry.order)).toEqual(["AB", "BA"]);
    expect(job.invocations.map((entry) => entry.agentOrder)).toEqual([
      ["candidate", "champion"],
      ["champion", "candidate"],
    ]);
    expect(job.uploads).toHaveLength(6);
    expect(job.jobSha256).toBe(computeTrustedHarborJobHash(job));
    expect(JSON.stringify(job)).not.toContain("synthetic/task-");
    expect(job.invocations.map((entry) => entry.remoteHarborJobPath)).toEqual([
      "/trusted/results/request-validation-ab",
      "/trusted/results/request-validation-ba",
    ]);
    expect(job.invocations.map((entry) => entry.remoteOutputPath)).toEqual([
      "/trusted/results/request-validation-ab.harbor-output.tar",
      "/trusted/results/request-validation-ba.harbor-output.tar",
    ]);

    for (const config of published.values()) {
      expect(config).toMatchObject({
        n_attempts: 1,
        n_concurrent_trials: 1,
        environment: {
          type: "daytona",
          delete: true,
        },
        retry: { max_retries: 0 },
        datasets: [
          {
            name: pin.dataset,
            ref: "6",
            overwrite: false,
          },
        ],
      });
      expect(
        (config["datasets"] as Array<{ task_names: string[] }>)[0]?.task_names,
      ).toHaveLength(6);
    }
  });

  it("builds one five-task candidate-only repair job", async () => {
    const hiddenPanel = panel("repair");
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    );
    const { builder, published } = setup();
    const job = await builder.build({
      sensitivity: "hidden-harbor-build-request",
      pin,
      panel: hiddenPanel,
      schedule,
      agent: agent(),
      isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
    });
    expect(job).toMatchObject({
      stage: "repair",
      cellCount: 5,
      armCount: 5,
      invocations: [
        {
          order: "repair",
          cellCount: 5,
          armCount: 5,
          agentOrder: ["candidate"],
        },
      ],
    });
    expect(job.uploads.map((upload) => upload.role)).toEqual([
      "config-repair",
      "output-packager",
      "pi-adapter",
      "candidate-runtime",
    ]);
    const config = [...published.values()][0]!;
    expect((config["agents"] as unknown[])).toHaveLength(1);
  });

  it("fails without releasing a task name when hidden resolution is invalid", async () => {
    const hiddenPanel = panel("repair");
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      candidate,
      champion,
    );
    const { builder } = setup({
      resolve: () => Promise.reject(new Error("synthetic/secret-task-name")),
    });
    let message = "";
    try {
      await builder.build({
        sensitivity: "hidden-harbor-build-request",
        pin,
        panel: hiddenPanel,
        schedule,
        agent: agent(),
        isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/without releasing task material/u);
    expect(message).not.toContain("secret-task-name");
  });
});
