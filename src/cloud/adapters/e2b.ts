import { loadProviderConfiguration } from "../config.js";
import {
  ConfiguredCloudSandboxProvider,
  type ConfiguredCloudSandboxProviderOptions,
} from "../provider.js";
import type { CloudProviderTransport } from "../types.js";

export function createE2bProvider(
  environment: NodeJS.ProcessEnv,
  transport: CloudProviderTransport,
  options: ConfiguredCloudSandboxProviderOptions = {},
): ConfiguredCloudSandboxProvider {
  return new ConfiguredCloudSandboxProvider(
    "e2b",
    loadProviderConfiguration("e2b", environment),
    transport,
    options,
  );
}
