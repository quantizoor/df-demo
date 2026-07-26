import { describe, expect, it } from "vitest";

import {
  CloudControlBootstrapError,
  launchDaytonaControlPlane,
  parseCloudControlBootstrapEnvironment,
  type DaytonaControlClient,
  type DaytonaControlClientFactory,
  type DaytonaControlCreateParameters,
  type DaytonaControlSandbox,
} from "../../src/cloud/control-bootstrap.js";

function completeEnvironment(): NodeJS.ProcessEnv {
  const imageDigest = `sha256:${"a".repeat(64)}`;
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    DF_CLOUD_PROVIDER: "daytona",
    DAYTONA_API_KEY: "github-bootstrap-only-secret",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "trusted-eu",
    DF_CLOUD_REGION_CLASS: "trusted-eu",
    DF_TRUSTED_CONTROL_PLANE: "1",
    DF_TRUSTED_VOLUME_ROOT: "/not-mounted-on-ci",
    DF_CONTROL_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-control@${imageDigest}`,
    DF_CONTROL_IMAGE_DIGEST: imageDigest,
    DF_OPTIMIZER_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-optimizer@${imageDigest}`,
    DF_OPTIMIZER_IMAGE_DIGEST: imageDigest,
    DF_BUILD_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-build@${imageDigest}`,
    DF_BUILD_IMAGE_DIGEST: imageDigest,
    DF_EVALUATOR_IMAGE_REFERENCE: `ghcr.io/parallaxai/df-evaluator@${imageDigest}`,
    DF_EVALUATOR_IMAGE_DIGEST: imageDigest,
    DF_OPTIMIZER_MODEL: "claude-model-chosen-by-operator",
    DF_OPTIMIZER_EFFORT: "high",
    DF_CLAUDE_CODE_VERSION: "2.1.217",
    DF_OPTIMIZER_SECRET_SOURCE: "DF_ANTHROPIC_OPTIMIZER_SECRET",
    DF_OPTIMIZER_SECRET_TARGET: "ANTHROPIC_API_KEY",
    DF_EVALUATED_PROVIDER: "operator-provider",
    DF_EVALUATED_MODEL: "operator-model",
    DF_EVALUATED_REASONING: "operator-reasoning",
    DF_EVALUATED_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_EVALUATED_MODEL_SECRET",
        targetEnvironmentName: "MODEL_API_KEY",
      },
    ]),
    DF_GITHUB_SECRET_SOURCE: "DF_GITHUB_PRIVATE_REPO_SECRET",
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: "5bc1c2c0a6f07e00e8c240304182f213ab8d311f",
    DF_PI_BASELINE_TREE: "73898c76210cc8b48f4ac07cc76397b6b5c00758",
    DF_PI_PACKAGE_LOCK_SHA256:
      "472f0726dc79f3b38df58d8a8bce96bf56fbf993a134b49aabc54947b8461e59",
    DF_PI_CODING_AGENT_VERSION: "0.82.1",
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
    DF_DAYTONA_VOLUME_ID: "dark-factory-state",
    DF_DAYTONA_VOLUME_SUBPATH: "campaigns/campaign-one",
    DF_CONTROL_DAYTONA_SECRET_SOURCE: "DF_CONTROL_DAYTONA",
    DF_CONTROL_SECRET_BINDINGS_JSON: JSON.stringify([
      {
        sourceEnvironmentName: "DF_KMS_SIGNER",
        targetEnvironmentName: "DF_KMS_CREDENTIAL",
      },
    ]),
    DF_CONTROL_TTL_MINUTES: "60",
    DF_CONTROL_NETWORK_ALLOW_DOMAINS:
      "app.daytona.io,api.github.com,github.com",
    DF_CONTROL_CPU: "4",
    DF_CONTROL_MEMORY_GIB: "8",
    DF_CONTROL_DISK_GIB: "20",
  };
}

class Sandbox implements DaytonaControlSandbox {
  readonly id = "control-sandbox-1";
  readonly target = "trusted-eu";
  readonly cpu = 4;
  readonly memory = 8;
  readonly disk = 20;
  readonly public = false;
  readonly autoDeleteInterval = 0;
  readonly autoPauseInterval = 0;
  readonly autoStopInterval = 0;
  readonly autoDestroyAt = "2026-07-26T11:00:00.000Z";
  readonly env: Readonly<Record<string, string>>;
  readonly volumes: DaytonaControlSandbox["volumes"];
  readonly domainAllowList: string;
  readonly networkBlockAll = false;
  command = "";
  deleted = false;
  failDelete = false;

  constructor(parameters: DaytonaControlCreateParameters) {
    this.env = {
      ...parameters.envVars,
      DAYTONA_WORKSPACE_ID: this.id,
    };
    this.volumes = parameters.volumes;
    this.domainAllowList = parameters.domainAllowList ?? "";
  }

  readonly process = {
    executeCommand: (
      command: string,
    ): Promise<{
      readonly result: string;
      readonly exitCode: number;
    }> => {
      this.command = command;
      return Promise.resolve({
        result: JSON.stringify({ ok: true, releaseSafe: true }),
        exitCode: 0,
      });
    },
  };

  refreshData(): Promise<void> {
    return Promise.resolve();
  }

  delete(): Promise<void> {
    this.deleted = true;
    return this.failDelete
      ? Promise.reject(new Error("provider detail"))
      : Promise.resolve();
  }
}

class Factory implements DaytonaControlClientFactory {
  parameters?: DaytonaControlCreateParameters;
  sandbox?: Sandbox;

  create(): Promise<DaytonaControlClient> {
    return Promise.resolve({
      create: (
        parameters: DaytonaControlCreateParameters,
      ): Promise<DaytonaControlSandbox> => {
        this.parameters = parameters;
        this.sandbox = new Sandbox(parameters);
        return Promise.resolve(this.sandbox);
      },
    });
  }
}

describe("trusted cloud control bootstrap", () => {
  it("rejects workstation and self-hosted execution before resolving a provider", () => {
    expect(() =>
      parseCloudControlBootstrapEnvironment(
        { ...completeEnvironment(), GITHUB_ACTIONS: undefined },
        "probe",
        "campaign-one",
      ),
    ).toThrow(/GitHub-hosted/u);
    expect(() =>
      parseCloudControlBootstrapEnvironment(
        {
          ...completeEnvironment(),
          RUNNER_ENVIRONMENT: "self-hosted",
        },
        "probe",
        "campaign-one",
      ),
    ).toThrow(/GitHub-hosted/u);
  });

  it("requires an exact image-bound authorization before a paid optimize launch", () => {
    expect(() =>
      parseCloudControlBootstrapEnvironment(
        completeEnvironment(),
        "optimize",
        "campaign-one",
      ),
    ).toThrow(/authorization/u);

    const environment = completeEnvironment();
    environment["DF_PAID_RUN_AUTHORIZATION"] =
      `RUN:campaign-one:${environment["DF_CONTROL_IMAGE_DIGEST"]}`;
    expect(
      parseCloudControlBootstrapEnvironment(
        environment,
        "optimize",
        "campaign-one",
      ).command,
    ).toBe("optimize");
  });

  it("mounts only the campaign subpath, passes organization-secret names, and confirms teardown", async () => {
    const environment = completeEnvironment();
    const request = parseCloudControlBootstrapEnvironment(
      environment,
      "synthetic",
      "campaign-one",
    );
    const factory = new Factory();
    let call = 0;
    const receipt = await launchDaytonaControlPlane(
      request,
      factory,
      environment,
      () =>
        new Date(
          call++ === 0
            ? "2026-07-26T10:00:00.000Z"
            : "2026-07-26T10:05:00.000Z",
        ),
    );

    expect(factory.parameters).toMatchObject({
      image: request.configuration.images.control.reference,
      ephemeral: true,
      autoDeleteInterval: 0,
      public: false,
      volumes: [
        {
          volumeId: "dark-factory-state",
          mountPath: "/trusted/dark-factory",
          subpath: "campaigns/campaign-one",
        },
      ],
      secrets: {
        DAYTONA_API_KEY: "DF_CONTROL_DAYTONA",
        DF_KMS_CREDENTIAL: "DF_KMS_SIGNER",
      },
    });
    expect(factory.parameters?.envVars["DF_TRUSTED_VOLUME_ROOT"]).toBe(
      "/trusted/dark-factory",
    );
    expect(JSON.stringify(factory.parameters)).not.toContain(
      "github-bootstrap-only-secret",
    );
    expect(factory.sandbox?.command).toContain(
      "'/app/dist/cloud/control-plane.js' 'synthetic' '--campaign' 'campaign-one'",
    );
    expect(factory.sandbox?.deleted).toBe(true);
    expect(receipt).toMatchObject({
      command: "synthetic",
      campaignId: "campaign-one",
      teardownConfirmed: true,
      exitCode: 0,
    });
  });

  it("invalidates a successful command if provider teardown is not confirmed", async () => {
    const environment = completeEnvironment();
    const request = parseCloudControlBootstrapEnvironment(
      environment,
      "probe",
      "campaign-one",
    );
    const factory = new Factory();
    const launch = launchDaytonaControlPlane(
      request,
      {
        create: async () => ({
          create: async (parameters) => {
            const sandbox = new Sandbox(parameters);
            sandbox.failDelete = true;
            return sandbox;
          },
        }),
      },
      environment,
      (() => {
        let call = 0;
        return () =>
          new Date(
            call++ === 0
              ? "2026-07-26T10:00:00.000Z"
              : "2026-07-26T10:05:00.000Z",
          );
      })(),
    );

    await expect(launch).rejects.toBeInstanceOf(
      CloudControlBootstrapError,
    );
    expect(factory.parameters).toBeUndefined();
  });
});
