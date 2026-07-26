#!/usr/bin/env node

import { DaytonaMvpCloudRuntime } from "./daytona-runtime.js";
import {
  launchMvpPreflight,
  type MvpPreflightConfiguration,
  type MvpPreflightStage,
  mvpPreflightDaytonaConfiguration,
  preflightConfigurationBindingHash,
} from "./preflight-orchestrator.js";

const SHA256_WITH_PREFIX = /^sha256:[a-f0-9]{64}$/u;

async function main(): Promise<void> {
  const stage = preflightStage(process.argv.slice(2));
  if (requiredEnvironment("DF_MVP_PREFLIGHT_STAGE") !== stage) {
    throw new Error("MVP_PREFLIGHT_STAGE_MISMATCH");
  }
  const imageReference = requiredEnvironment("DF_MVP_DAYTONA_IMAGE");
  const expectedImageDigest = requiredEnvironment("DF_MVP_EXPECTED_IMAGE_DIGEST");
  if (
    !SHA256_WITH_PREFIX.test(expectedImageDigest) ||
    imageReference.slice(imageReference.lastIndexOf("@") + 1) !== expectedImageDigest
  ) {
    throw new Error("MVP_PREFLIGHT_IMAGE_MISMATCH");
  }
  const priorRaw = requiredEnvironment("DF_MVP_PRIOR_RECEIPT_SHA256");
  const base: Omit<MvpPreflightConfiguration, "configurationBindingHash"> = {
    stage,
    campaignId: requiredEnvironment("DF_MVP_CAMPAIGN_ID"),
    sourceCommit: requiredEnvironment("DF_MVP_SOURCE_COMMIT"),
    workflowRunId: requiredEnvironment("GITHUB_RUN_ID"),
    workflowRunAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
    imageReference,
    priorReceiptSha256: priorRaw === "none" ? null : priorRaw,
    controllerBundle: {
      localPath: requiredEnvironment("DF_MVP_CONTROLLER_BUNDLE_PATH"),
      sha256: requiredEnvironment("DF_MVP_CONTROLLER_BUNDLE_SHA256"),
    },
    daytona: {
      apiUrl: requiredEnvironment("DAYTONA_API_URL"),
      target: requiredEnvironment("DAYTONA_TARGET"),
      volumeId: requiredEnvironment("DF_DAYTONA_VOLUME_ID"),
      volumeSubpath: requiredEnvironment("DF_DAYTONA_VOLUME_SUBPATH"),
      nestedSecretSource: requiredEnvironment("DF_HARBOR_DAYTONA_SECRET_SOURCE"),
    },
  };
  const configuration: MvpPreflightConfiguration = {
    ...base,
    configurationBindingHash: preflightConfigurationBindingHash(base),
  };
  const receipt = await launchMvpPreflight({
    configuration,
    runtime: new DaytonaMvpCloudRuntime(mvpPreflightDaytonaConfiguration(configuration)),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

function preflightStage(arguments_: readonly string[]): MvpPreflightStage {
  const [stage] = arguments_;
  if (
    arguments_.length !== 1 ||
    (stage !== "bootstrap" && stage !== "synthetic" && stage !== "connectivity")
  ) {
    throw new Error("MVP_PREFLIGHT_STAGE_INVALID");
  }
  return stage;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Workflow inputs reject NUL and line breaks before provider use.
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error("MVP_PREFLIGHT_CONFIGURATION_MISSING");
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("MVP_PREFLIGHT_IDENTITY_INVALID");
  }
  return value;
}

await main().catch(() => {
  process.stderr.write("MVP_PREFLIGHT_FAILED_CLOSED\n");
  process.exitCode = 1;
});
