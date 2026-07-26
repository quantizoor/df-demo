import { isAbsolute, join } from "node:path";

import type {
  CandidateProposal,
  OptimizerInput,
} from "./contracts.js";
import {
  validateCandidateProposal,
  validateMvpArtifact,
} from "./schemas.js";

export const MVP_OPTIMIZER_WORKER_SOURCE =
  "scripts/mvp-optimizer-worker.mjs" as const;
export const MVP_OPTIMIZER_BUNDLE_ROOT =
  "/tmp/df-mvp-controller" as const;
export const MVP_OPTIMIZER_WORKER_EXECUTABLE =
  "/usr/bin/node" as const;
export const MVP_OPTIMIZER_WORKER_INSTALLED_SCRIPT =
  "/tmp/df-mvp-controller/scripts/mvp-optimizer-worker.mjs" as const;
export const MVP_OPTIMIZER_PLUGIN_SOURCE =
  "/tmp/df-mvp-controller/claude-plugin" as const;
export const MVP_OPTIMIZER_CLAUDE_EXECUTABLE =
  "/usr/local/bin/claude" as const;
export const MVP_OPTIMIZER_CLAUDE_CODE_VERSION =
  "2.1.217" as const;
export const MVP_OPTIMIZER_MODEL_FAMILY =
  "claude-opus-5" as const;
export const MVP_OPTIMIZER_REASONING_EFFORT = "high" as const;
export const MVP_OPTIMIZER_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Skill",
] as const;
export const MVP_OPTIMIZER_DENIED_TOOLS = [
  "Bash",
  "Shell",
  "WebSearch",
  "WebFetch",
  "Agent",
  "Task",
  "NotebookEdit",
] as const;
export const MVP_OPTIMIZER_SKILLS = [
  "benchmark-integrity",
  "form-falsifiable-hypothesis",
  "modify-pi-harness",
  "analyze-diagnostic-brief",
] as const;
export const MVP_OPTIMIZER_ALLOWED_SOURCE_ROOTS = [
  "packages/agent/src/",
  "packages/ai/src/",
  "packages/coding-agent/src/",
] as const;

export const MVP_OPTIMIZER_WORKER_DELIVERY = {
  sourceRelativePath: MVP_OPTIMIZER_WORKER_SOURCE,
  bundleRoot: MVP_OPTIMIZER_BUNDLE_ROOT,
  installedScriptPath: MVP_OPTIMIZER_WORKER_INSTALLED_SCRIPT,
  nodeExecutablePath: MVP_OPTIMIZER_WORKER_EXECUTABLE,
  pluginSourcePath: MVP_OPTIMIZER_PLUGIN_SOURCE,
  requiredExecutablePaths: [
    "/usr/bin/git",
    "/usr/bin/node",
    MVP_OPTIMIZER_CLAUDE_EXECUTABLE,
  ],
  exactClaudeCodeVersion: MVP_OPTIMIZER_CLAUDE_CODE_VERSION,
  requiredNodeMajor: 24,
  requiredSecretTargets: [
    "ANTHROPIC_FOUNDRY_API_KEY",
    "DF_GITHUB_BASIC_AUTH",
  ],
  secretValueTransport:
    "daytona-opaque-outbound-header-placeholder-v1",
  defaultInputRelativePath: "inbox/optimizer-input.json",
  defaultOutputRelativePath: "outbox/candidate-proposal.json",
} as const;

export type MvpOptimizerReadinessCode =
  | "ready"
  | "invalid-cloud-role"
  | "invalid-configuration"
  | "input-unavailable"
  | "runtime-unavailable"
  | "claude-version-mismatch"
  | "credential-unavailable"
  | "candidate-rejected"
  | "publication-failed";

export interface MvpOptimizerWorkerInvocation {
  readonly executable: typeof MVP_OPTIMIZER_WORKER_EXECUTABLE;
  readonly arguments: readonly string[];
  readonly environment: {
    readonly CI: "true";
    readonly DF_CLOUD_EXECUTION: "1";
    readonly DF_MVP_ROLE: "optimizer";
  };
  readonly inputPath: string;
  readonly outputPath: string;
}

const SAFE_CAMPAIGN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN_SUMMARY_CONTENT =
  /\b(?:terminal[-_ ]?bench|tbench|harbor|grader|verifier|reference solution|task id|task name|benchmark answer)\b|https?:\/\//iu;

export function createMvpOptimizerWorkerInvocation(input: {
  readonly campaignId: string;
  readonly maximumIterations: number;
  readonly stateRoot: string;
  readonly configurationHash: string;
}): MvpOptimizerWorkerInvocation {
  if (
    !SAFE_CAMPAIGN.test(input.campaignId) ||
    !Number.isSafeInteger(input.maximumIterations) ||
    input.maximumIterations < 1 ||
    input.maximumIterations > 10 ||
    input.stateRoot !== "/workspace/df-state" ||
    !isAbsolute(input.stateRoot) ||
    input.stateRoot === "/" ||
    input.stateRoot.includes("/../") ||
    !SHA256.test(input.configurationHash)
  ) {
    throw new Error("MVP optimizer worker invocation is invalid");
  }
  const inputPath = join(
    input.stateRoot,
    MVP_OPTIMIZER_WORKER_DELIVERY.defaultInputRelativePath,
  );
  const outputPath = join(
    input.stateRoot,
    MVP_OPTIMIZER_WORKER_DELIVERY.defaultOutputRelativePath,
  );
  return {
    executable: MVP_OPTIMIZER_WORKER_EXECUTABLE,
    arguments: [
      MVP_OPTIMIZER_WORKER_INSTALLED_SCRIPT,
      "run",
      "--campaign",
      input.campaignId,
      "--maximum-iterations",
      input.maximumIterations.toString(),
      "--state-root",
      input.stateRoot,
      "--configuration-hash",
      input.configurationHash,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ],
    environment: {
      CI: "true",
      DF_CLOUD_EXECUTION: "1",
      DF_MVP_ROLE: "optimizer",
    },
    inputPath,
    outputPath,
  };
}

export function assertTaskFreeMvpOptimizerInput(
  value: unknown,
): asserts value is OptimizerInput {
  validateMvpArtifact("optimizerInput", value);
}

export function assertMvpCandidateProposal(
  value: unknown,
): asserts value is CandidateProposal {
  validateCandidateProposal(value);
  const proposal = value as CandidateProposal;
  assertMvpCandidateChangedFiles(proposal.changedFiles);
  if (
    FORBIDDEN_SUMMARY_CONTENT.test(proposal.hypothesisSummary) ||
    FORBIDDEN_SUMMARY_CONTENT.test(proposal.interventionSummary)
  ) {
    throw new Error(
      "MVP candidate proposal contains benchmark-specific content",
    );
  }
}

export function assertMvpCandidateChangedFiles(
  changedFiles: readonly string[],
): void {
  if (
    changedFiles.length < 1 ||
    changedFiles.length > 12 ||
    new Set(changedFiles).size !== changedFiles.length ||
    changedFiles.some(
      (path) =>
        path.startsWith("/") ||
        path === ".." ||
        path.startsWith("../") ||
        path.includes("/../") ||
        !MVP_OPTIMIZER_ALLOWED_SOURCE_ROOTS.some((root) =>
          path.startsWith(root),
        ) ||
        !/\.(?:cjs|css|js|json|jsx|mjs|ts|tsx|txt|yaml|yml)$/u.test(
          path,
        ) ||
        /(^|\/)(?:test|tests|grader|graders|verifier|verifiers|solution|solutions|reference|benchmarks?|evals?|fixtures?)(\/|$)/iu.test(
          path,
        ),
    )
  ) {
    throw new Error(
      "MVP candidate changed paths are outside the general Pi harness",
    );
  }
}
