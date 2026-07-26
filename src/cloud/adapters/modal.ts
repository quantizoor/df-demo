import { loadProviderConfiguration } from "../config.js";
import {
  ConfiguredCloudSandboxProvider,
  type ConfiguredCloudSandboxProviderOptions,
} from "../provider.js";
import type { CloudProviderTransport } from "../types.js";

export function createModalProvider(
  environment: NodeJS.ProcessEnv,
  transport: CloudProviderTransport,
  options: ConfiguredCloudSandboxProviderOptions = {},
): ConfiguredCloudSandboxProvider {
  return new ConfiguredCloudSandboxProvider(
    "modal",
    loadProviderConfiguration("modal", environment),
    transport,
    options,
  );
}
