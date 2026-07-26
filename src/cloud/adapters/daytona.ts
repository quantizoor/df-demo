import type { TrustedArtifactBridge } from "../artifact-bridge.js";
import { loadProviderConfiguration } from "../config.js";
import {
  ConfiguredCloudSandboxProvider,
  type ConfiguredCloudSandboxProviderOptions,
} from "../provider.js";
import type { CloudProviderTransport } from "../types.js";
import {
  DaytonaCloudProviderTransport,
  type DaytonaSdkFactory,
  OfficialDaytonaSdkFactory,
} from "./daytona-transport.js";

export function createDaytonaProvider(
  environment: NodeJS.ProcessEnv,
  transport: CloudProviderTransport,
  options: ConfiguredCloudSandboxProviderOptions = {},
): ConfiguredCloudSandboxProvider {
  return new ConfiguredCloudSandboxProvider(
    "daytona",
    loadProviderConfiguration("daytona", environment),
    transport,
    options,
  );
}

export interface CreateOfficialDaytonaProviderOptions
  extends ConfiguredCloudSandboxProviderOptions {
  readonly artifactBridge: TrustedArtifactBridge;
  readonly sdkFactory?: DaytonaSdkFactory;
}

/**
 * Production Daytona composition. The lower-level injected-transport factory
 * remains available for contract tests and alternate trusted cloud workers.
 */
export function createOfficialDaytonaProvider(
  environment: NodeJS.ProcessEnv,
  options: CreateOfficialDaytonaProviderOptions,
): ConfiguredCloudSandboxProvider {
  const sdkFactory =
    options.sdkFactory ?? new OfficialDaytonaSdkFactory({ environment: () => environment });
  const transport = new DaytonaCloudProviderTransport({
    artifactBridge: options.artifactBridge,
    sdkFactory,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return createDaytonaProvider(environment, transport, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maximumClockSkewMs === undefined
      ? {}
      : { maximumClockSkewMs: options.maximumClockSkewMs }),
  });
}

export * from "./daytona-transport.js";
