import { describe, expect, it } from "vitest";

import {
  inspectMvpCloudEnvironment,
  type MvpCloudConfiguration,
} from "../../src/mvp/cloud-config.js";
import { roleSpecification, roleWorkerCommand } from "../../src/mvp/cloud-orchestrator.js";
import {
  DaytonaMvpCloudRuntime,
  MVP_PREFLIGHT_WORKER_PATH,
  MVP_PROCESS_ENTRYPOINT,
  type MvpDaytonaRuntimeConfiguration,
  type MvpDaytonaSdkClient,
  type MvpDaytonaSdkFactory,
} from "../../src/mvp/daytona-runtime.js";
import { formatMvpPreflightWorkerFailure } from "../../src/mvp/preflight-diagnostics.js";

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
    DF_FOUNDRY_BASE_URL: "https://existing.services.ai.azure.com/anthropic",
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

function daytonaConfiguration(
  configuration: MvpCloudConfiguration,
): MvpDaytonaRuntimeConfiguration {
  return {
    campaignId: configuration.campaignId,
    configurationHash: configuration.configurationHash,
    daytona: {
      apiUrl: configuration.daytona.apiUrl,
      target: configuration.daytona.target,
      image: configuration.daytona.image,
      volumeId: configuration.daytona.volumeId,
      apiKeyEnvironmentName: configuration.daytona.apiKeyEnvironmentName,
      outerSandboxResources: configuration.daytona.outerSandboxResources,
    },
  };
}

function attestingFactory(
  options: {
    readonly attestNetworkBlockAll?: boolean;
    readonly commands?: string[];
    readonly deleteError?: Error;
    readonly onDelete?: () => void;
    readonly workerResponse?: {
      readonly result: string;
      readonly exitCode: number;
    };
  } = {},
): MvpDaytonaSdkFactory {
  return {
    createClient: async () => ({
      create: async (parameters) => {
        let environment: Readonly<Record<string, string>> = parameters.envVars;
        return {
          id: `sandbox-${parameters.labels["df-role"]}`,
          ...(parameters.user === undefined ? {} : { user: parameters.user }),
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
          networkBlockAll: options.attestNetworkBlockAll ?? parameters.networkBlockAll,
          ...(parameters.domainAllowList === undefined
            ? {}
            : { domainAllowList: parameters.domainAllowList }),
          volumes: parameters.volumes,
          fs: {
            uploadFile: async () => undefined,
          },
          process: {
            executeCommand: async (command) => {
              options.commands?.push(command);
              if (command.includes("sha256sum")) {
                return {
                  result: `${bundleDigest}  /tmp/df-mvp-controller.tar.gz`,
                  exitCode: 0,
                };
              }
              return command.includes(MVP_PREFLIGHT_WORKER_PATH) &&
                options.workerResponse !== undefined
                ? options.workerResponse
                : { result: "{}", exitCode: 0 };
            },
          },
          updateEnv: async (next) => {
            environment = { ...environment, ...next };
          },
          refreshData: async () => undefined,
          delete: async () => {
            options.onDelete?.();
            if (options.deleteError !== undefined) throw options.deleteError;
          },
        };
      },
    }),
  };
}

describe("MVP Daytona runtime", () => {
  it("uses the official SDK shape to mount one isolated subpath and preserve the volume", async () => {
    const created: Parameters<MvpDaytonaSdkClient["create"]>[0][] = [];
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
              ...(parameters.user === undefined ? {} : { user: parameters.user }),
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
              networkBlockAll: parameters.networkBlockAll,
              ...(parameters.domainAllowList === undefined
                ? {}
                : { domainAllowList: parameters.domainAllowList }),
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
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: factory,
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
      now: () => new Date("2026-07-26T10:00:00.000Z"),
    });
    const lease = await runtime.create(roleSpecification(config, "optimizer"));
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
      resources: {
        cpu: 4,
        memory: 8,
        disk: 10,
      },
      ephemeral: true,
      autoDeleteInterval: 0,
      public: false,
      networkBlockAll: false,
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
    expect(uploaded).toEqual([["/cloud/controller.tar.gz", "/tmp/df-mvp-controller.tar.gz"]]);
    expect(deleted).toBe(true);
  });

  it("requests and attests root only for the trusted evaluator controller", async () => {
    const created: Parameters<MvpDaytonaSdkClient["create"]>[0][] = [];
    const factory: MvpDaytonaSdkFactory = {
      createClient: async () => ({
        create: async (parameters) => {
          created.push(parameters);
          return {
            id: "evaluator-sandbox",
            ...(parameters.user === undefined ? {} : { user: parameters.user }),
            target: "eu",
            cpu: parameters.resources.cpu,
            memory: parameters.resources.memory,
            disk: parameters.resources.disk,
            public: false,
            autoDeleteInterval: 0,
            env: parameters.envVars,
            labels: parameters.labels,
            networkBlockAll: parameters.networkBlockAll,
            ...(parameters.domainAllowList === undefined
              ? {}
              : { domainAllowList: parameters.domainAllowList }),
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

    expect(created[0]).toMatchObject({
      user: "root",
      resources: {
        cpu: 4,
        memory: 8,
        disk: 10,
      },
    });
    expect(roleSpecification(config, "optimizer").user).toBeUndefined();
  });

  it.each([
    ["cpu", { cpu: 3, memoryGiB: 8, diskGiB: 10 }],
    ["memory", { cpu: 4, memoryGiB: 7, diskGiB: 10 }],
    ["disk", { cpu: 4, memoryGiB: 8, diskGiB: 11 }],
  ] as const)(
    "rejects a role specification outside the configuration-bound %s profile",
    async (_resource, resources) => {
      const config = configuration();
      const runtime = new DaytonaMvpCloudRuntime(config, {
        sdkFactory: {
          createClient: async () => {
            throw new Error("invalid resources reached the provider");
          },
        },
        environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
      });
      const specification = roleSpecification(config, "evaluator");

      await expect(
        runtime.create({
          ...specification,
          resources,
        }),
      ).rejects.toThrow("The Daytona role specification is invalid.");
    },
  );

  it("creates and attests an exact network-block-all evaluator preflight", async () => {
    const config = configuration();
    const created: Parameters<MvpDaytonaSdkClient["create"]>[0][] = [];
    const baseFactory = attestingFactory();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: {
        createClient: async (input) => {
          const client = await baseFactory.createClient(input);
          return {
            create: async (parameters, options) => {
              created.push(parameters);
              return client.create(parameters, options);
            },
          };
        },
      },
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });
    const specification = {
      ...roleSpecification(config, "evaluator"),
      networkBlockAll: true,
      networkAllowDomains: [],
      secretReferences: [],
    } as const;

    await runtime.create(specification);

    expect(created[0]).toMatchObject({
      networkBlockAll: true,
    });
    expect(created[0]?.domainAllowList).toBeUndefined();
  });

  it.each([
    ["blocked networking with an allow list", true, ["app.daytona.io"]],
    ["unblocked networking without an allow list", false, []],
  ] as const)("rejects %s", async (_case, networkBlockAll, networkAllowDomains) => {
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: {
        createClient: async () => {
          throw new Error("invalid networking reached the provider");
        },
      },
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });

    await expect(
      runtime.create({
        ...roleSpecification(config, "evaluator"),
        networkBlockAll,
        networkAllowDomains,
      }),
    ).rejects.toThrow("The Daytona role specification is invalid.");
  });

  it("fails closed when the provider does not attest network blocking", async () => {
    const config = configuration();
    let deleted = false;
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: attestingFactory({
        attestNetworkBlockAll: false,
        onDelete: () => {
          deleted = true;
        },
      }),
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });

    await expect(
      runtime.create({
        ...roleSpecification(config, "evaluator"),
        networkBlockAll: true,
        networkAllowDomains: [],
      }),
    ).rejects.toThrow("Daytona sandbox creation failed closed.");
    expect(deleted).toBe(true);
  });

  it("reports unproven cleanup when creation attestation and compensating delete fail", async () => {
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: attestingFactory({
        attestNetworkBlockAll: false,
        deleteError: new Error("private provider failure"),
      }),
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });

    await expect(
      runtime.create({
        ...roleSpecification(config, "evaluator"),
        networkBlockAll: true,
        networkAllowDomains: [],
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "outer-cleanup",
    });
  });

  it.each(["bootstrap", "synthetic", "connectivity"] as const)(
    "permits the exact evaluator-only %s preflight command",
    async (stage) => {
      const config = configuration();
      const commands: string[] = [];
      const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
        sdkFactory: attestingFactory({ commands }),
        environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
      });
      const lease = await runtime.create({
        ...roleSpecification(config, "evaluator"),
        networkBlockAll: true,
        networkAllowDomains: [],
      });
      await runtime.stage(lease, {
        localPath: "/cloud/controller.tar.gz",
        sha256: bundleDigest,
      });

      await runtime.execute(lease, {
        executable: MVP_PROCESS_ENTRYPOINT,
        arguments: ["node", MVP_PREFLIGHT_WORKER_PATH, stage],
        timeoutMs: 60_000,
        environment: {
          CI: "true",
          DF_CLOUD_EXECUTION: "1",
          DF_MVP_ROLE: "evaluator",
        },
      });

      expect(commands.at(-1)).toBe(
        `'/usr/bin/env' 'node' '${MVP_PREFLIGHT_WORKER_PATH}' '${stage}'`,
      );
    },
  );

  it("preserves an allowlisted worker failure code without releasing private output", async () => {
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: attestingFactory({
        workerResponse: {
          result: formatMvpPreflightWorkerFailure("bootstrap-discovery-download"),
          exitCode: 1,
        },
      }),
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });
    const lease = await runtime.create({
      ...roleSpecification(config, "evaluator"),
      networkBlockAll: true,
      networkAllowDomains: [],
    });
    await runtime.stage(lease, {
      localPath: "/cloud/controller.tar.gz",
      sha256: bundleDigest,
    });

    await expect(
      runtime.execute(lease, {
        executable: MVP_PROCESS_ENTRYPOINT,
        arguments: ["node", MVP_PREFLIGHT_WORKER_PATH, "bootstrap"],
        timeoutMs: 60_000,
        environment: {
          CI: "true",
          DF_CLOUD_EXECUTION: "1",
          DF_MVP_ROLE: "evaluator",
        },
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-discovery-download",
    });
  });

  it("does not relay arbitrary failed-worker output", async () => {
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: attestingFactory({
        workerResponse: {
          result: "private-task-or-secret-material",
          exitCode: 1,
        },
      }),
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });
    const lease = await runtime.create({
      ...roleSpecification(config, "evaluator"),
      networkBlockAll: true,
      networkAllowDomains: [],
    });
    await runtime.stage(lease, {
      localPath: "/cloud/controller.tar.gz",
      sha256: bundleDigest,
    });

    const failure = runtime.execute(lease, {
      executable: MVP_PROCESS_ENTRYPOINT,
      arguments: ["node", MVP_PREFLIGHT_WORKER_PATH, "bootstrap"],
      timeoutMs: 60_000,
      environment: {
        CI: "true",
        DF_CLOUD_EXECUTION: "1",
        DF_MVP_ROLE: "evaluator",
      },
    });
    await expect(failure).rejects.toThrow("The Daytona role worker failed closed.");
    await expect(failure).rejects.not.toThrow("private-task-or-secret-material");
  });

  it.each([
    ["optimizer role", "optimizer", ["node", MVP_PREFLIGHT_WORKER_PATH, "bootstrap"]],
    ["unknown stage", "evaluator", ["node", MVP_PREFLIGHT_WORKER_PATH, "paid"]],
    ["extra argument", "evaluator", ["node", MVP_PREFLIGHT_WORKER_PATH, "bootstrap", "unexpected"]],
  ] as const)("rejects a preflight command with an %s", async (_case, role, arguments_) => {
    const config = configuration();
    const runtime = new DaytonaMvpCloudRuntime(daytonaConfiguration(config), {
      sdkFactory: attestingFactory(),
      environment: () => ({ DAYTONA_API_KEY: "sdk-api-key" }),
    });
    const lease = await runtime.create(roleSpecification(config, role));
    await runtime.stage(lease, {
      localPath: "/cloud/controller.tar.gz",
      sha256: bundleDigest,
    });

    await expect(
      runtime.execute(lease, {
        executable: MVP_PROCESS_ENTRYPOINT,
        arguments: arguments_,
        timeoutMs: 60_000,
        environment: {
          CI: "true",
          DF_CLOUD_EXECUTION: "1",
          DF_MVP_ROLE: role,
        },
      }),
    ).rejects.toThrow("The Daytona role worker command is invalid.");
  });
});
