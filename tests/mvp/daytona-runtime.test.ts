import { describe, expect, it } from "vitest";

import {
  inspectMvpCloudEnvironment,
  type MvpCloudConfiguration,
} from "../../src/mvp/cloud-config.js";
import {
  roleSpecification,
  roleWorkerCommand,
} from "../../src/mvp/cloud-orchestrator.js";
import {
  DaytonaMvpCloudRuntime,
  type MvpDaytonaSdkClient,
  type MvpDaytonaSdkFactory,
} from "../../src/mvp/daytona-runtime.js";

const bundleDigest = "e".repeat(64);

function configuration(): MvpCloudConfiguration {
  const readiness = inspectMvpCloudEnvironment({
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_CAMPAIGN_ID: "mvp-001",
    DF_MVP_MAX_ITERATIONS: "1",
    DAYTONA_API_KEY: "sdk-api-key",
    DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "eu",
    DF_MVP_DAYTONA_IMAGE: `node@sha256:${"a".repeat(64)}`,
    DF_DAYTONA_VOLUME_ID: "existing-volume",
    DF_DAYTONA_VOLUME_SUBPATH: "campaigns/mvp-001",
    DF_HARBOR_DAYTONA_SECRET_SOURCE: "DAYTONA_NESTED",
    DF_FOUNDRY_BASE_URL:
      "https://existing.services.ai.azure.com/anthropic",
    DF_OPTIMIZER_DEPLOYMENT: "optimizer-deployment",
    DF_EVALUATED_DEPLOYMENT: "evaluated-deployment",
    DF_OPTIMIZER_SECRET_SOURCE: "FOUNDRY_OPTIMIZER",
    DF_EVALUATED_SECRET_SOURCE: "FOUNDRY_EVALUATOR",
    DF_PI_GITHUB_OWNER: "parallaxai",
    DF_PI_GITHUB_REPOSITORY: "df-pi-tbench",
    DF_PI_BRANCH: "main",
    DF_PI_BASELINE_COMMIT: "b".repeat(40),
    DF_PI_BASELINE_TREE: "c".repeat(40),
    DF_PI_PACKAGE_LOCK_SHA256: "d".repeat(64),
    DF_GITHUB_SECRET_SOURCE: "PI_GITHUB_BASIC_AUTH",
  });
  if (readiness.configuration === null) throw new Error("not ready");
  return readiness.configuration;
}

describe("MVP Daytona runtime", () => {
  it("uses the official SDK shape to mount one isolated subpath and preserve the volume", async () => {
    const created: Parameters<MvpDaytonaSdkClient["create"]>[0][] =
      [];
    const uploaded: [string, string][] = [];
    let deleted = false;
    let environment: Readonly<Record<string, string>> = {};
    const factory: MvpDaytonaSdkFactory = {
      createClient: async (input) => {
        expect(input).toMatchObject({
          apiKey: "sdk-api-key",
          target: "eu",
        });
        return {
          create: async (parameters) => {
            created.push(parameters);
            environment = parameters.envVars;
            return {
              id: "optimizer-sandbox",
              ...(parameters.user === undefined
                ? {}
                : { user: parameters.user }),
              target: "eu",
              cpu: parameters.resources.cpu,
              memory: parameters.resources.memory,
              disk: parameters.resources.disk,
              public: false,
              autoDeleteInterval: 0,
              get env() {
                return environment;
              },
              labels: parameters.labels,
              domainAllowList: parameters.domainAllowList,
              volumes: parameters.volumes,
              fs: {
                uploadFile: async (localPath, remotePath) => {
                  uploaded.push([localPath, remotePath]);
                },
              },
              process: {
                executeCommand: async (command) => {
                  if (command.includes("sha256sum")) {
                    return {
                      result: `${bundleDigest}  /tmp/df-mvp-controller.tar.gz`,
                      exitCode: 0,
                    };
                  }
                  return { result: "{}", exitCode: 0 };
                },
              },
              updateEnv: async (next) => {
                environment = { ...environment, ...next };
              },
              refreshData: async () => undefined,
              delete: async () => {
                deleted = true;
              },
            };
          },
        };
      },
    };
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(config, {
      sdkFactory: factory,
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
      now: () => new Date("2026-07-26T10:00:00.000Z"),
    });
    const lease = await runtime.create(
      roleSpecification(config, "optimizer"),
    );
    await runtime.stage(lease, {
      localPath: "/cloud/controller.tar.gz",
      sha256: bundleDigest,
    });
    await runtime.execute(
      lease,
      roleWorkerCommand("optimizer", "optimize", {
        DF_MVP_OPTIMIZER_INPUT_BASE64: "e30",
      }),
    );
    await runtime.destroy(lease);

    expect(created[0]).toMatchObject({
      image: config.daytona.image,
      ephemeral: true,
      autoDeleteInterval: 0,
      public: false,
      volumes: [
        {
          volumeId: "existing-volume",
          mountPath: "/workspace/df-state",
          subpath: "campaigns/mvp-001/optimizer",
        },
      ],
      secrets: {
        ANTHROPIC_FOUNDRY_API_KEY: "FOUNDRY_OPTIMIZER",
        DF_GITHUB_BASIC_AUTH: "PI_GITHUB_BASIC_AUTH",
      },
    });
    expect(uploaded).toEqual([
      [
        "/cloud/controller.tar.gz",
        "/tmp/df-mvp-controller.tar.gz",
      ],
    ]);
    expect(deleted).toBe(true);
  });

  it("requests and attests root only for the trusted evaluator controller", async () => {
    const created: Parameters<MvpDaytonaSdkClient["create"]>[0][] =
      [];
    const factory: MvpDaytonaSdkFactory = {
      createClient: async () => ({
        create: async (parameters) => {
          created.push(parameters);
          return {
            id: "evaluator-sandbox",
            ...(parameters.user === undefined
              ? {}
              : { user: parameters.user }),
            target: "eu",
            cpu: parameters.resources.cpu,
            memory: parameters.resources.memory,
            disk: parameters.resources.disk,
            public: false,
            autoDeleteInterval: 0,
            env: parameters.envVars,
            labels: parameters.labels,
            domainAllowList: parameters.domainAllowList,
            volumes: parameters.volumes,
            fs: {
              uploadFile: async () => undefined,
            },
            process: {
              executeCommand: async () => ({
                result: "{}",
                exitCode: 0,
              }),
            },
            updateEnv: async () => undefined,
            refreshData: async () => undefined,
            delete: async () => undefined,
          };
        },
      }),
    };
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(config, {
      sdkFactory: factory,
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });

    await runtime.create(roleSpecification(config, "evaluator"));

    expect(created[0]?.user).toBe("root");
    expect(roleSpecification(config, "optimizer").user).toBeUndefined();
  });
});
