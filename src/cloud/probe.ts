import type {
  CloudSandboxProvider,
  MatchedExecutionProfile,
  ProviderCapabilities,
  ProviderProbeReport,
  ProviderProbeRequest,
} from "./types.js";

const BASELINE_CAPABILITIES = [
  "lifecycle",
  "cancellation",
  "fileTransfer",
  "hardTimeout",
  "resourceReporting",
  "networkDenyAll",
  "kernelIsolation",
] as const satisfies readonly (keyof ProviderCapabilities)[];

export class CloudCompatibilityError extends Error {
  override readonly name = "CloudCompatibilityError";
}

export async function requireCompatibleProvider(
  provider: CloudSandboxProvider,
  request: ProviderProbeRequest,
): Promise<ProviderProbeReport> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(request.imageDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.regionClass) ||
    !new Set(["arm64", "x86_64"]).has(request.resources.architecture) ||
    !Number.isSafeInteger(request.resources.cpuCores) ||
    request.resources.cpuCores <= 0 ||
    !Number.isSafeInteger(request.resources.memoryMiB) ||
    request.resources.memoryMiB <= 0 ||
    !Number.isSafeInteger(request.resources.diskMiB) ||
    request.resources.diskMiB <= 0
  ) {
    throw new CloudCompatibilityError("Provider probe request is malformed or unpinned.");
  }
  const report = await provider.probe(request);
  if (
    report.provider !== provider.name ||
    report.requestId !== request.requestId ||
    report.configFingerprint !== provider.configuration.configFingerprint
  ) {
    throw new CloudCompatibilityError("Provider probe attestation does not match its request.");
  }

  const missing: string[] = BASELINE_CAPABILITIES.filter(
    (name) => !report.capabilities[name],
  );
  if (request.requireDockerInDocker && !report.capabilities.dockerInDocker) {
    missing.push("dockerInDocker");
  }
  if (request.requireGpu && !report.capabilities.gpu) {
    missing.push("gpu");
  }
  if (!report.compatible || missing.length > 0 || report.reasons.length > 0) {
    throw new CloudCompatibilityError(
      `Cloud provider ${provider.name} is incompatible: ${[
        ...new Set([...missing, ...report.reasons]),
      ].join(", ")}`,
    );
  }
  return report;
}

function canonicalResources(profile: MatchedExecutionProfile): string {
  const resources = profile.resources;
  return JSON.stringify({
    architecture: resources.architecture,
    cpuCores: resources.cpuCores,
    memoryMiB: resources.memoryMiB,
    diskMiB: resources.diskMiB,
    gpuClass: resources.gpuClass ?? null,
  });
}

export function assertMatchedExecutionProfiles(
  candidate: MatchedExecutionProfile,
  champion: MatchedExecutionProfile,
): void {
  for (const profile of [candidate, champion]) {
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(profile.imageDigest) ||
      !/^[a-f0-9]{64}$/u.test(profile.networkPolicyHash) ||
      !/^[a-f0-9]{64}$/u.test(profile.protocolHash)
    ) {
      throw new CloudCompatibilityError("Matched execution profile is not immutable.");
    }
  }
  const equal =
    candidate.provider === champion.provider &&
    candidate.imageDigest === champion.imageDigest &&
    candidate.regionClass === champion.regionClass &&
    candidate.networkPolicyHash === champion.networkPolicyHash &&
    candidate.protocolHash === champion.protocolHash &&
    canonicalResources(candidate) === canonicalResources(champion);
  if (!equal) {
    throw new CloudCompatibilityError(
      "Candidate and champion must use an identical cloud execution profile.",
    );
  }
}
