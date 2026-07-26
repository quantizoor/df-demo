#!/usr/bin/env node

import { createHash } from "node:crypto";
import { join } from "node:path";
import { type BootstrapConfiguration, inspectBootstrapEnvironment } from "../config/environment.js";
import { inspectPiHarnessSourceEnvironment } from "../config/harness-source.js";
import { canonicalJson } from "../schemas/canonical.js";
import { runSyntheticWalkForwardCampaign } from "../synthetic/campaign.js";
import { createOfficialDaytonaProvider } from "./adapters/daytona.js";
import {
  CloudMarkerTrustedArtifactRuntimeGuard,
  VerifyingTrustedArtifactBridge,
} from "./artifact-bridge.js";
import {
  inspectStagedControlEnvironment,
  type StagedControlConfiguration,
} from "./control-stage-configuration.js";
import { MountedVolumeTrustedArtifactBackend } from "./mounted-volume-backend.js";
import {
  AttestedMountedVolumeStateSemanticsGuard,
  type MountedVolumeRuntimeIdentity,
  runMountedVolumeSemanticsCanary,
} from "./mounted-volume-canary.js";
import {
  inspectProductionOptimizeBindingReadiness,
  releaseSafeProductionOptimizeBindingReport,
} from "./production-optimize-binding-readiness.js";
import { runProductionProviderReadiness } from "./production-readiness.js";
import { assertCloudExecutionEnvironment } from "./runtime-marker.js";
import type { TrustedCloudArtifactRef } from "./types.js";

const SAFE_CAMPAIGN_ID = /^[a-z0-9](?:[a-z0-9._-]{0,94}[a-z0-9])?$/u;
const CONTROL_COMMANDS = ["probe", "synthetic", "optimize", "status", "stop", "resume"] as const;
type ControlCommand = (typeof CONTROL_COMMANDS)[number];

class TrustedControlPlaneError extends Error {
  override readonly name = "TrustedControlPlaneError";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(arguments_: readonly string[]): {
  readonly command: ControlCommand;
  readonly campaignId: string;
} {
  const [command, campaignFlag, campaignId, ...rest] = arguments_;
  if (
    command === undefined ||
    !CONTROL_COMMANDS.includes(command as ControlCommand) ||
    campaignFlag !== "--campaign" ||
    campaignId === undefined ||
    !SAFE_CAMPAIGN_ID.test(campaignId) ||
    rest.length !== 0
  ) {
    throw new TrustedControlPlaneError("Trusted control-plane invocation is malformed.");
  }
  return { command: command as ControlCommand, campaignId };
}

function configuration(
  command: ControlCommand,
): BootstrapConfiguration | StagedControlConfiguration {
  if (command === "optimize") {
    const readiness = inspectBootstrapEnvironment(process.env);
    if (!readiness.ready || readiness.configuration === null) {
      throw new TrustedControlPlaneError("Trusted paid-optimize configuration is incomplete.");
    }
    if (readiness.configuration.cloudProvider !== "daytona") {
      throw new TrustedControlPlaneError("The MVP trusted control plane supports Daytona only.");
    }
    return readiness.configuration;
  }
  const readiness = inspectStagedControlEnvironment(
    process.env,
    command === "probe" ? "probe" : "offline",
  );
  if (!readiness.ready || readiness.configuration === null) {
    throw new TrustedControlPlaneError("Trusted control-stage configuration is incomplete.");
  }
  if (readiness.configuration.cloudProvider !== "daytona") {
    throw new TrustedControlPlaneError("The MVP trusted control plane supports Daytona only.");
  }
  return readiness.configuration;
}

async function* oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

async function consume(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of source) {
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength > 64 * 1024 * 1024) {
      throw new TrustedControlPlaneError("Trusted control artifact exceeds its read limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteLength);
}

async function persistControlReceipt(
  bridge: VerifyingTrustedArtifactBridge,
  campaignId: string,
  kind: string,
  value: unknown,
): Promise<TrustedCloudArtifactRef> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TrustedControlPlaneError("Trusted control receipt must be a JSON object.");
  }
  const serialized = canonicalJson(value);
  const bytes = Buffer.from(`${serialized}\n`, "utf8");
  const artifact = await bridge.persistVerified({
    uri: `trusted://control/${campaignId}/${kind}/${sha256(bytes)}`,
    mediaType: "application/json",
    chunks: oneChunk(bytes),
  });
  const verified = await consume(await bridge.openVerified(artifact));
  if (verified.byteLength !== bytes.byteLength || sha256(verified) !== sha256(bytes)) {
    throw new TrustedControlPlaneError(
      "Trusted control receipt did not round-trip through the mounted volume.",
    );
  }
  return artifact;
}

async function main(): Promise<void> {
  const { command, campaignId } = parseArguments(process.argv.slice(2));
  const marker = assertCloudExecutionEnvironment("daytona", process.env);
  if (process.env["DF_TRUSTED_CONTROL_PLANE"] !== "1") {
    throw new TrustedControlPlaneError("Trusted control-plane marker is absent.");
  }
  const config = configuration(command);
  const volumeRoot = process.env["DF_TRUSTED_VOLUME_ROOT"];
  if (volumeRoot === undefined || volumeRoot !== "/trusted/dark-factory") {
    throw new TrustedControlPlaneError("Trusted control-plane volume mount is not exact.");
  }
  const guard = new CloudMarkerTrustedArtifactRuntimeGuard({
    provider: "daytona",
    environment: () => process.env,
  });
  const backend = new MountedVolumeTrustedArtifactBackend({
    volumeRoot: join(volumeRoot, "artifacts"),
    runtimeGuard: guard,
  });
  const bridge = new VerifyingTrustedArtifactBridge(backend, guard);

  if (command === "probe") {
    const buildImage = config.images.build;
    const evaluatorImage = config.images.evaluator;
    if (buildImage === null || evaluatorImage === null) {
      throw new TrustedControlPlaneError(
        "Trusted provider-probe image configuration is incomplete.",
      );
    }
    const stateVolumeRoot = process.env["DF_CAMPAIGN_STATE_ROOT"];
    const volumeId = process.env["DF_DAYTONA_VOLUME_ID"];
    const volumeSubpath = process.env["DF_DAYTONA_VOLUME_SUBPATH"];
    if (
      stateVolumeRoot !== join(volumeRoot, "campaign-state") ||
      volumeId === undefined ||
      volumeSubpath === undefined
    ) {
      throw new TrustedControlPlaneError("Trusted control-plane volume binding is incomplete.");
    }
    const runtimeIdentity: MountedVolumeRuntimeIdentity = {
      marker,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
    };
    const volumeSemantics = await runMountedVolumeSemanticsCanary({
      provider: "daytona",
      volumeRoot: stateVolumeRoot,
      volumeId,
      volumeSubpath,
      controlImageDigest: config.images.control.digest,
      runtimeIdentity,
      runtimeGuard: guard,
    });
    const semanticsGuard = new AttestedMountedVolumeStateSemanticsGuard({
      receipt: volumeSemantics,
      provider: "daytona",
      volumeRoot: stateVolumeRoot,
      volumeId,
      volumeSubpath,
      controlImageDigest: config.images.control.digest,
      runtimeIdentity,
      runtimeGuard: guard,
    });
    semanticsGuard.assertLinearizableStateVolume({
      volumeRoot: stateVolumeRoot,
      namespace: `control-probe-${campaignId}`,
    });
    const volumeSemanticsArtifact = await persistControlReceipt(
      bridge,
      campaignId,
      "volume-semantics",
      volumeSemantics,
    );
    const provider = createOfficialDaytonaProvider(process.env, {
      artifactBridge: bridge,
    });
    const receipt = await runProductionProviderReadiness({
      provider,
      campaignId,
      regionClass: config.cloudRegionClass,
      buildImage,
      evaluatorImage,
      volumeSemanticsReceiptHash: volumeSemantics.contentHash,
      volumeSemanticsArtifactSha256: volumeSemanticsArtifact.sha256,
    });
    const artifact = await persistControlReceipt(bridge, campaignId, "probe", receipt);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        receiptHash: receipt["receiptHash"],
        artifactSha256: artifact.sha256,
      })}\n`,
    );
    return;
  }

  if (command === "synthetic") {
    const synthetic = await runSyntheticWalkForwardCampaign();
    const artifact = await persistControlReceipt(bridge, campaignId, "synthetic", synthetic);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        receiptHash: synthetic.receiptHash,
        artifactSha256: artifact.sha256,
      })}\n`,
    );
    return;
  }

  if (command === "status") {
    const readiness = inspectProductionOptimizeBindingReadiness({
      bindings: {},
      piSourceConfiguration: inspectPiHarnessSourceEnvironment(process.env),
    });
    const report = releaseSafeProductionOptimizeBindingReport(readiness);
    const status = {
      schemaVersion: 1 as const,
      domain: "dark-factory.cloud-control-precomposition-status.v1" as const,
      campaignId,
      state: "awaiting-production-composition" as const,
      controlImageDigest: config.images.control.digest,
      ...report,
    };
    const artifact = await persistControlReceipt(bridge, campaignId, "status", status);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        command,
        state: status.state,
        readinessReceiptHash: status.readinessReceiptHash,
        artifactSha256: artifact.sha256,
      })}\n`,
    );
    return;
  }

  if (command === "optimize") {
    const sourceReadiness = inspectPiHarnessSourceEnvironment(process.env);
    /*
     * No production objects are bound at this entry point yet. Report the
     * exact public composition surface rather than accepting an environment
     * declaration as proof that executable ports exist.
     */
    const readiness = inspectProductionOptimizeBindingReadiness({
      bindings: {},
      piSourceConfiguration: sourceReadiness,
    });
    const artifact = await persistControlReceipt(
      bridge,
      campaignId,
      "optimize-binding-readiness",
      readiness,
    );
    const report = releaseSafeProductionOptimizeBindingReport(readiness);
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        command,
        ...report,
        artifactSha256: artifact.sha256,
      })}\n`,
    );
    process.exitCode = 1;
    return;
  }

  throw new TrustedControlPlaneError(
    "This control command is locked until its signed production composition is available.",
  );
}

try {
  await main();
} catch {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "DF_TRUSTED_CONTROL_FAILED",
      message: "Trusted control-plane command failed closed. Inspect protected cloud logs.",
    })}\n`,
  );
  process.exitCode = 1;
}
