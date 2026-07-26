import { createHash } from "node:crypto";
import type { CloudProviderName, ProviderConfiguration } from "./types.js";

const PROVIDER_DEFAULT_ENDPOINTS: Readonly<Record<CloudProviderName, string>> = {
  daytona: "https://app.daytona.io/api",
  e2b: "https://api.e2b.dev",
  modal: "https://api.modal.com",
};

const PROVIDER_CREDENTIALS: Readonly<Record<CloudProviderName, readonly string[]>> = {
  daytona: ["DAYTONA_API_KEY"],
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
};

const ENDPOINT_VARIABLES: Readonly<Record<CloudProviderName, string>> = {
  daytona: "DAYTONA_API_URL",
  e2b: "E2B_API_URL",
  modal: "MODAL_API_URL",
};

const SAFE_TARGET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
}

function requireCredentials(
  provider: CloudProviderName,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const names = PROVIDER_CREDENTIALS[provider];
  const missing = names.filter((name) => {
    const value = environment[name];
    return value === undefined || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new ProviderConfigurationError(
      `Missing credential environment variable(s) for ${provider}: ${missing.join(", ")}.`,
    );
  }
  return names;
}

function normalizeEndpoint(rawEndpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    throw new ProviderConfigurationError("Cloud provider endpoint must be an absolute URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ProviderConfigurationError(
      "Cloud provider endpoint must use HTTPS and cannot contain credentials, a query, or a fragment.",
    );
  }
  return parsed.toString().replace(/\/$/u, "");
}

function fingerprintConfiguration(
  provider: CloudProviderName,
  endpoint: string,
  credentialEnvironmentNames: readonly string[],
  target: string | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provider,
        endpoint,
        credentialEnvironmentNames: [...credentialEnvironmentNames].sort(),
        target: target ?? null,
      }),
    )
    .digest("hex");
}

export function loadProviderConfiguration(
  provider: CloudProviderName,
  environment: NodeJS.ProcessEnv,
): ProviderConfiguration {
  const credentialEnvironmentNames = requireCredentials(provider, environment);
  const endpointVariable = ENDPOINT_VARIABLES[provider];
  const endpoint = normalizeEndpoint(
    environment[endpointVariable] ?? PROVIDER_DEFAULT_ENDPOINTS[provider],
  );
  const target = provider === "daytona" ? environment.DAYTONA_TARGET?.trim() : undefined;
  if (target !== undefined && !SAFE_TARGET.test(target)) {
    throw new ProviderConfigurationError("DAYTONA_TARGET contains unsupported characters.");
  }

  const base = {
    provider,
    endpoint,
    credentialEnvironmentNames,
    configFingerprint: fingerprintConfiguration(
      provider,
      endpoint,
      credentialEnvironmentNames,
      target,
    ),
  };
  return target === undefined ? base : { ...base, target };
}

export function providerCredentialValues(
  configuration: ProviderConfiguration,
  environment: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of configuration.credentialEnvironmentNames) {
    const value = environment[name];
    if (value === undefined || value.length === 0) {
      throw new ProviderConfigurationError(`Credential ${name} is no longer available.`);
    }
    values[name] = value;
  }
  return values;
}
