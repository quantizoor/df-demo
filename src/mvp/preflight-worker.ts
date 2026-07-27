#!/usr/bin/env node

import {
  asMvpPreflightDiagnosticError,
  formatMvpPreflightWorkerFailure,
  MvpPreflightDiagnosticError,
} from "./preflight-diagnostics.js";
import type {
  MvpPreflightStage,
  MvpPreflightWorkerSuccess,
  MvpSyntheticSmokeEvidence,
} from "./preflight-orchestrator.js";
import { bootstrapMvpEvaluatorRuntime } from "./runtime-bootstrap.js";
import { runMvpNoModelSyntheticSmoke } from "./synthetic-smoke.js";

const STATE_ROOT = "/workspace/df-state";

async function main(): Promise<void> {
  try {
    assertCloudBoundary();
  } catch (error) {
    throw asMvpPreflightDiagnosticError(error, "worker-boundary");
  }
  let stage: MvpPreflightStage;
  try {
    stage = preflightStage(process.argv.slice(2));
    if (requiredEnvironment("DF_MVP_PREFLIGHT_STAGE") !== stage) {
      throw new Error("Preflight stage binding changed.");
    }
    if (requiredEnvironment("DF_MVP_MAX_ITERATIONS") !== "0") {
      throw new Error("Preflight iteration count is not zero.");
    }
  } catch (error) {
    throw asMvpPreflightDiagnosticError(error, "worker-configuration");
  }

  let result: Pick<MvpPreflightWorkerSuccess, "stageEvidence" | "sandboxAccounting">;
  if (stage === "bootstrap") {
    let sourceCommit: string;
    let imageReference: string;
    try {
      requiredEnvironment("DAYTONA_API_KEY");
      sourceCommit = requiredEnvironment("DF_MVP_SOURCE_COMMIT");
      imageReference = requiredEnvironment("DF_MVP_IMAGE_REFERENCE");
    } catch (error) {
      throw asMvpPreflightDiagnosticError(error, "worker-configuration");
    }
    const bootstrap = await bootstrapMvpEvaluatorRuntime({
      stateRoot: STATE_ROOT,
      sourceCommit,
      imageReference,
    });
    result = {
      stageEvidence: bootstrap.evidence,
      sandboxAccounting: bootstrap.sandboxAccounting,
    };
  } else if (stage === "synthetic") {
    let smoke: Awaited<ReturnType<typeof runMvpNoModelSyntheticSmoke>>;
    try {
      assertSyntheticSecretBoundary();
      smoke = await runMvpNoModelSyntheticSmoke(`${STATE_ROOT}/private/preflight-synthetic`);
    } catch (error) {
      throw asMvpPreflightDiagnosticError(error, "synthetic-runtime");
    }
    const evidence: MvpSyntheticSmokeEvidence = smoke.checks;
    result = {
      stageEvidence: evidence,
      sandboxAccounting: {
        created: 0,
        destroyed: 0,
        allDestroyed: true,
      },
    };
  } else {
    // The connectivity stage is deliberately introduced only with its exact,
    // capability-specific probes and strict evidence schema.
    throw new MvpPreflightDiagnosticError("connectivity-unimplemented");
  }

  const output: MvpPreflightWorkerSuccess = {
    schemaVersion: 1,
    domain: "dark-factory.mvp-preflight-worker.v1",
    stage,
    status: "passed",
    stageEvidence: result.stageEvidence,
    sandboxAccounting: result.sandboxAccounting,
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderData: false,
    containsRawTraces: false,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function assertCloudBoundary(): void {
  if (
    process.platform !== "linux" ||
    process.env["CI"] !== "true" ||
    process.env["DF_CLOUD_EXECUTION"] !== "1" ||
    process.env["DF_MVP_ROLE"] !== "evaluator" ||
    ![process.env["DAYTONA_SANDBOX_ID"], process.env["DAYTONA_WORKSPACE_ID"]].some(
      (value) => value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value),
    )
  ) {
    throw new Error("Preflight worker is outside its evaluator sandbox.");
  }
}

function assertSyntheticSecretBoundary(): void {
  if (
    ["DAYTONA_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "DF_GITHUB_BASIC_AUTH", "GITHUB_TOKEN"].some(
      (name) => process.env[name] !== undefined,
    )
  ) {
    throw new Error("Synthetic smoke received an external credential.");
  }
}

function preflightStage(arguments_: readonly string[]): MvpPreflightStage {
  const [stage] = arguments_;
  if (
    arguments_.length !== 1 ||
    (stage !== "bootstrap" && stage !== "synthetic" && stage !== "connectivity")
  ) {
    throw new Error("Unsupported preflight stage.");
  }
  return stage;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Worker settings reject NUL and line breaks before use.
    /[\u0000\r\n]/u.test(value)
  ) {
    throw new Error("A required preflight setting is unavailable.");
  }
  return value;
}

await main().catch((error: unknown) => {
  const diagnostic = asMvpPreflightDiagnosticError(error, "unknown");
  process.stdout.write(formatMvpPreflightWorkerFailure(diagnostic.code));
  process.exitCode = 1;
});
