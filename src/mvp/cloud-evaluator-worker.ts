#!/usr/bin/env node

import type { CandidateProposal } from "./contracts.js";
import {
  type MvpEvaluatorRuntimeBinding,
  prepareMvpOptimizerInput,
  runMvpCloudControllerIteration,
} from "./cloud-controller.js";
import {
  MvpEvaluatorReadinessError,
  createMvpEvaluatorRuntime,
} from "./evaluator-runtime.js";
import {
  ClosedVocabularyLlmSanitizer,
  FoundryMessagesDiagnosticClassifier,
} from "./sanitizer.js";
import { validateCandidateProposal } from "./schemas.js";

const STATE_ROOT = "/workspace/df-state";
const REVISION = /^[a-f0-9]{40,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

interface BlockedReadiness {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-worker-readiness.v1";
  readonly status: "blocked";
  readonly role: "evaluator";
  readonly missingPrerequisites: readonly string[];
  readonly containsTaskIdentifiers: false;
  readonly containsTaskLiterals: false;
  readonly containsGraderData: false;
  readonly containsRawTraces: false;
}

async function main(): Promise<void> {
  assertCloudRole();
  const [operation] = process.argv.slice(2);
  if (operation !== "prepare" && operation !== "evaluate") {
    throw new Error("Unsupported evaluator worker operation.");
  }

  try {
    const proposal =
      operation === "evaluate"
        ? decodeProposal(
            requiredEnvironment(
              "DF_MVP_CANDIDATE_PROPOSAL_BASE64",
            ),
          )
        : undefined;
    const runtime = await createMvpEvaluatorRuntime({
      stateRoot: STATE_ROOT,
      evaluatedDeployment: requiredEnvironment(
        "DF_EVALUATED_DEPLOYMENT",
      ),
      modelFamily: "claude-opus-4-8",
      reasoningEffort: "high",
      foundryBaseUrl: requiredEnvironment(
        "DF_FOUNDRY_BASE_URL",
      ),
      ...(proposal === undefined
        ? {}
        : { candidateProposal: proposal }),
    });
    if (operation === "prepare") {
      const optimizerInput = await prepareMvpOptimizerInput({
        stateRoot: STATE_ROOT,
        campaignId: requiredEnvironment("DF_MVP_CAMPAIGN_ID"),
        baselineChampionRevision: requiredRevision(
          "DF_PI_BASELINE_COMMIT",
        ),
      });
      process.stdout.write(`${JSON.stringify(optimizerInput)}\n`);
      return;
    }
    if (proposal === undefined) {
      throw new Error(
        "The evaluator candidate proposal is unavailable.",
      );
    }

    const foundryBaseUrl = requiredEnvironment(
      "DF_FOUNDRY_BASE_URL",
    );
    const binding: MvpEvaluatorRuntimeBinding = {
      environment: runtime.environment,
      taskCatalog: runtime.taskCatalog,
      evaluator: runtime.evaluator,
      sanitizer: new ClosedVocabularyLlmSanitizer(
        new FoundryMessagesDiagnosticClassifier({
          baseUrl: foundryBaseUrl,
          deployment: requiredEnvironment(
            "DF_EVALUATED_DEPLOYMENT",
          ),
          apiKey: requiredEnvironment(
            "ANTHROPIC_FOUNDRY_API_KEY",
          ),
        }),
      ),
    };
    const release = await runMvpCloudControllerIteration({
      stateRoot: STATE_ROOT,
      campaignId: requiredEnvironment("DF_MVP_CAMPAIGN_ID"),
      baselineChampionRevision: requiredRevision(
        "DF_PI_BASELINE_COMMIT",
      ),
      slug: "harness-improvement",
      proposal,
      expectedOptimizerInputSha256: requiredDigest(
        "DF_MVP_PREPARED_INPUT_SHA256",
      ),
      runtime: binding,
    });
    process.stdout.write(`${JSON.stringify(release)}\n`);
  } catch (error) {
    if (error instanceof MvpEvaluatorReadinessError) {
      writeBlocked([error.code]);
      return;
    }
    throw error;
  }
}

function assertCloudRole(): void {
  if (
    process.platform !== "linux" ||
    process.env["CI"] !== "true" ||
    process.env["DF_CLOUD_EXECUTION"] !== "1" ||
    process.env["DF_MVP_ROLE"] !== "evaluator" ||
    !hasDaytonaIdentity()
  ) {
    throw new Error(
      "The evaluator controller is restricted to its Daytona role.",
    );
  }
}

function hasDaytonaIdentity(): boolean {
  return [
    process.env["DAYTONA_SANDBOX_ID"],
    process.env["DAYTONA_WORKSPACE_ID"],
  ].some(
    (value) =>
      value !== undefined &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value),
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing evaluator worker setting ${name}.`);
  }
  return value;
}

function requiredRevision(name: string): string {
  const value = requiredEnvironment(name);
  if (!REVISION.test(value)) {
    throw new Error(`Evaluator worker setting ${name} is invalid.`);
  }
  return value;
}

function requiredDigest(name: string): string {
  const value = requiredEnvironment(name);
  if (!SHA256.test(value)) {
    throw new Error(`Evaluator worker setting ${name} is invalid.`);
  }
  return value;
}

function decodeProposal(value: string): CandidateProposal {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error(
      "The evaluator candidate proposal channel is malformed.",
    );
  }
  validateCandidateProposal(decoded);
  return decoded as CandidateProposal;
}

function writeBlocked(
  missingPrerequisites: readonly string[],
): void {
  const result: BlockedReadiness = {
    schemaVersion: 1,
    domain: "dark-factory.mvp-worker-readiness.v1",
    status: "blocked",
    role: "evaluator",
    missingPrerequisites,
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderData: false,
    containsRawTraces: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

await main().catch(() => {
  process.stderr.write(
    "Dark Factory evaluator worker failed closed.\n",
  );
  process.exitCode = 1;
});
