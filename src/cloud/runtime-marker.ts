import type { CloudExecutionMarker, CloudProviderName, SandboxLease } from "./types.js";

export const CLOUD_PROVIDER_MARKER_NAMES: Readonly<Record<CloudProviderName, readonly string[]>> = {
  daytona: ["DAYTONA_WORKSPACE_ID", "DAYTONA_SANDBOX_ID"],
  e2b: ["E2B_SANDBOX_ID"],
  modal: ["MODAL_TASK_ID"],
};

const SAFE_MARKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export class CloudExecutionPolicyError extends Error {
  override readonly name = "CloudExecutionPolicyError";
}

export function assertCloudExecutionEnvironment(
  provider: CloudProviderName,
  environment: NodeJS.ProcessEnv,
): CloudExecutionMarker {
  if (environment.DF_CLOUD_EXECUTION !== "1") {
    throw new CloudExecutionPolicyError(
      "Executable workloads require DF_CLOUD_EXECUTION=1 inside an approved cloud sandbox.",
    );
  }

  for (const environmentName of CLOUD_PROVIDER_MARKER_NAMES[provider]) {
    const sandboxId = environment[environmentName];
    if (sandboxId !== undefined && SAFE_MARKER.test(sandboxId)) {
      return {
        provider,
        sandboxId,
        markerEnvironmentName: environmentName,
      };
    }
  }

  throw new CloudExecutionPolicyError(
    `The ${provider} runtime marker is absent or malformed; local execution is forbidden.`,
  );
}

export function isCloudExecutionEnvironment(
  provider: CloudProviderName,
  environment: NodeJS.ProcessEnv,
): boolean {
  try {
    assertCloudExecutionEnvironment(provider, environment);
    return true;
  } catch {
    return false;
  }
}

export function assertLeaseMatchesRuntime(
  lease: SandboxLease,
  environment: NodeJS.ProcessEnv,
): CloudExecutionMarker {
  const marker = assertCloudExecutionEnvironment(lease.provider, environment);
  if (
    marker.sandboxId !== lease.sandboxId ||
    marker.provider !== lease.marker.provider ||
    marker.sandboxId !== lease.marker.sandboxId
  ) {
    throw new CloudExecutionPolicyError(
      "The cloud runtime marker does not match the provisioned sandbox lease.",
    );
  }
  return marker;
}
