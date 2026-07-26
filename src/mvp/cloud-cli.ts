#!/usr/bin/env node

import { inspectMvpCloudEnvironment } from "./cloud-config.js";
import { launchMvpCloudShell } from "./cloud-orchestrator.js";
import { DaytonaMvpCloudRuntime } from "./daytona-runtime.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;

async function main(): Promise<void> {
  const readiness = inspectMvpCloudEnvironment(process.env);
  if (!readiness.ready || readiness.configuration === null) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        domain: "dark-factory.mvp-configuration-readiness.v1",
        status: "blocked",
        actualIterationsCompleted: 0,
        missingPrerequisites: readiness.missing,
        invalidConfiguration: readiness.invalid,
        containsTaskIdentifiers: false,
        containsTaskLiterals: false,
        containsGraderData: false,
        containsRawTraces: false,
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const sourceCommit = requiredEnvironment("DF_MVP_SOURCE_COMMIT");
  const workflowRunId = requiredEnvironment("GITHUB_RUN_ID");
  const workflowRunAttempt = Number(
    requiredEnvironment("GITHUB_RUN_ATTEMPT"),
  );
  const bundlePath = requiredEnvironment(
    "DF_MVP_CONTROLLER_BUNDLE_PATH",
  );
  const bundleSha256 = requiredEnvironment(
    "DF_MVP_CONTROLLER_BUNDLE_SHA256",
  );
  if (
    !SHA1.test(sourceCommit) ||
    !bundlePath.startsWith("/") ||
    bundlePath === "/" ||
    bundlePath.includes("/../") ||
    !SHA256.test(bundleSha256)
  ) {
    throw new Error("MVP_LAUNCH_IDENTITY_NOT_READY");
  }

  const receipt = await launchMvpCloudShell({
    configuration: readiness.configuration,
    identity: {
      sourceCommit,
      workflowRunId,
      workflowRunAttempt,
    },
    controllerBundle: {
      localPath: bundlePath,
      sha256: bundleSha256,
    },
    runtime: new DaytonaMvpCloudRuntime(readiness.configuration),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status === "blocked") {
    process.exitCode = 2;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`MVP_MISSING_${name}`);
  }
  return value;
}

await main().catch((error: unknown) => {
  const message =
    error instanceof Error &&
    /^(?:MVP_[A-Z0-9_]+|MVP_CONFIG_NOT_READY)/u.test(
      error.message,
    )
      ? error.message
      : "MVP_CLOUD_LAUNCH_FAILED_CLOSED";
  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      domain: "dark-factory.mvp-launch-failure.v1",
      status: "failed-closed",
      actualIterationsCompleted: 0,
      failureCode: message,
      containsTaskIdentifiers: false,
      containsTaskLiterals: false,
      containsGraderData: false,
      containsRawTraces: false,
    })}\n`,
  );
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
