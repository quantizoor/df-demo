import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  hiddenTaskHandle,
  type EvaluationEnvironment,
  type PrivateEvaluationRequest,
  MVP_SCHEMA_VERSION,
} from "../../src/mvp/contracts.js";
import {
  MvpTrustedBatchEvaluator,
  type MvpEvaluatorRuntimePin,
  type MvpPiRuntimeSourcePort,
} from "../../src/mvp/evaluator-runtime.js";
import type { MountedHiddenTaskCatalog } from "../../src/mvp/mounted-hidden-task-catalog.js";
import type {
  MvpHarborExecutionPort,
  MvpPiRuntimeMaterialization,
} from "../../src/mvp/evaluator-runtime.js";

const digest = (value: string): string =>
  value.repeat(64).slice(0, 64);
const revision = (value: string): string =>
  value.repeat(40).slice(0, 40);

describe("MVP trusted evaluator runtime", () => {
  it("materializes the trusted campaign champion for an all-cache-hit screen", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-mvp-evaluator-"));
    const adapterPath = join(root, "dark_factory_pi.py");
    await writeFile(adapterPath, "class DarkFactoryPi: pass\n");
    const adapterSha256 = createHash("sha256")
      .update("class DarkFactoryPi: pass\n")
      .digest("hex");
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      handle: hiddenTaskHandle(digest(String(index + 1))),
      revisionDigest: digest(String(index + 6)),
      harborTaskName: `terminal-bench/hidden-${index + 1}`,
    }));
    const cells = tasks.flatMap((task, taskIndex) =>
      ([1, 2, 3] as const).map((repetition) => ({
        cellId: digest(`${taskIndex + 1}${repetition}`),
        task: {
          handle: task.handle,
          revisionDigest: task.revisionDigest,
          easyCanary: taskIndex === 4,
          weight: 1,
          sensitiveLiterals: [task.harborTaskName],
        },
        repetition,
      })),
    );
    const environment = evaluationEnvironment();
    const environmentDigest = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(environment).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          ),
        ),
      )
      .digest("hex");
    const candidateRevision = revision("a");
    const championRevision = revision("b");
    const requests: PrivateEvaluationRequest[] = cells.map(
      (cell) => ({
        schemaVersion: MVP_SCHEMA_VERSION,
        experimentId: "002-cache-hit-screen",
        cell,
        arm: "candidate",
        harnessRevision: candidateRevision,
        environment,
        environmentDigest,
      }),
    );
    const materialized: string[] = [];
    const source: MvpPiRuntimeSourcePort = {
      materialize: async (input) => {
        materialized.push(`${input.arm}:${input.revision}`);
        return runtime(input.arm, input.revision);
      },
    };
    const harbor: MvpHarborExecutionPort = {
      execute: async (plan) => ({
        sensitivity: "trusted-mvp-harbor-requested-output",
        schemaVersion: MVP_SCHEMA_VERSION,
        harborVersion: "0.20.0",
        experimentId: plan.basePlan.experimentId,
        executionPlanHash: plan.executionPlanHash,
        trials: plan.invocations.flatMap((invocation) =>
          invocation.expectedTrials.map((expected, index) => ({
            invocationId: invocation.invocationId,
            trialId: `trial-${invocation.invocationId}-${index + 1}`,
            harborTaskName: expected.harborTaskName,
            agentName:
              expected.arm === "candidate"
                ? "dark-factory-candidate"
                : "dark-factory-champion",
            attemptOrdinal: expected.harborAttemptOrdinal,
            runtimeArchiveSha256:
              expected.arm === "candidate"
                ? plan.basePlan.candidateRuntime.artifact.sha256
                : plan.basePlan.championRuntime.artifact.sha256,
            adapterSha256: plan.basePlan.adapter.artifact.sha256,
            modelProvider: "microsoft-foundry",
            modelDeployment: plan.basePlan.model.deployment,
            endpointHost: plan.basePlan.model.endpointHost,
            passed: true,
            reward: 1,
            infrastructureValid: true,
            durationMs: 1_000,
            evaluatedAt: "2026-07-26T10:00:00.000Z",
            traceArtifactRefs: [
              `trusted://mvp-private/traces/${digest("f")}`,
            ],
            rawDiagnostics: [],
          })),
        ),
      }),
    };
    const catalog = {
      resolveSelectedCells: async () =>
        cells.map((cell, index) => ({
          cellId: cell.cellId,
          taskHandle: cell.task.handle,
          taskRevisionDigest: cell.task.revisionDigest,
          repetition: cell.repetition,
          harborTaskLocator:
            tasks[Math.floor(index / 3)]!.harborTaskName,
        })),
    } as unknown as MountedHiddenTaskCatalog;
    const evaluator = new MvpTrustedBatchEvaluator({
      stateRoot: root,
      pin: pin(adapterPath, adapterSha256, tasks.map((task) => task.revisionDigest)),
      catalog,
      environment,
      evaluatedDeployment: "existing-opus-4-8",
      endpointHost: "existing-resource.services.ai.azure.com",
      championRevision,
      evaluatedSecretSourceName: "FOUNDRY_EVALUATED",
      source,
      harbor,
      expectedCandidateProposal: {
        hypothesisId: "hypothesis-002",
        hypothesisSummary: "Improve general harness reliability.",
        interventionSummary: "Adjust a general harness implementation.",
        candidateRevision,
        changedFiles: ["packages/coding-agent/src/agent.ts"],
      },
    });

    const observations = await evaluator.evaluateBatch(requests);

    expect(observations).toHaveLength(15);
    expect(materialized).toEqual(
      expect.arrayContaining([
        `candidate:${candidateRevision}`,
        `champion:${championRevision}`,
      ]),
    );
  });
});

function runtime(
  arm: "candidate" | "champion",
  harnessRevision: string,
): MvpPiRuntimeMaterialization {
  const sha256 = digest(arm === "candidate" ? "c" : "d");
  return {
    arm,
    revision: harnessRevision,
    treeSha: revision(arm === "candidate" ? "e" : "f"),
    lockSha256: digest("9"),
    archive: {
      arm,
      harnessRevision,
      artifact: {
        uri: `trusted://mvp-private/runtimes/${arm}`,
        sha256,
        mediaType: "application/gzip",
        byteLength: 1_024,
      },
      remotePath: `/private/runtimes/${arm}.tar.gz`,
    },
  };
}

function pin(
  adapterPath: string,
  adapterSha256: string,
  eligible: readonly string[],
): MvpEvaluatorRuntimePin {
  return {
    schemaVersion: 1,
    domain: "dark-factory.mvp-evaluator-runtime-pin.v1",
    harborVersion: "0.20.0",
    terminalBenchVersion: "2.1",
    datasetName: "terminal-bench",
    datasetRef: "2.1",
    datasetRevision: "terminal-bench-2.1",
    datasetContentSha256: digest("1"),
    graderProtocolVersion: "harbor-0.20.0",
    evaluatorVersion: "mvp-1",
    harborExecutable: "/usr/local/bin/harbor",
    harborExecutableSha256: digest("2"),
    bunExecutable: "/usr/local/bin/bun",
    bunExecutableSha256: digest("a"),
    adapterPath,
    adapterSha256,
    piEntrypoint: "packages/coding-agent/dist/pi",
    enabledTools: ["read", "bash", "write", "edit"],
    timeoutSeconds: 7_200,
    directSandboxEligibleTaskRevisionDigests: eligible,
    hiddenTaskDefinitions: eligible.map(
      (revisionDigest, index) => ({
        harborTaskLocator: `terminal-bench/hidden-${index + 1}`,
        revisionDigest,
        difficulty:
          index === eligible.length - 1
            ? ("easy" as const)
            : ("hard" as const),
        easyCanary: index === eligible.length - 1,
        baselineFailureRate: 0.8,
        baselineProvenance: {
          kind: "trusted-measurement" as const,
          sourceDigest: digest("b"),
          datasetRevision: "terminal-bench-2.1",
        },
        graderIsolation: {
          verifierEnvironmentMode: "separate" as const,
          allStepVerifierEnvironmentModesSeparate: true as const,
          sourceDigest: digest("c"),
        },
        leaderboard: {
          kind: "unknown" as const,
          reason: "not-published" as const,
        },
        initialFailureRate: 0.8,
        uncertainty: 0.5,
        normalizedCost: 0.2,
        sensitiveLiterals: [
          `terminal-bench/hidden-${index + 1}`,
        ],
      }),
    ),
    imageDigest: digest("3"),
    architecture: "x86_64",
    runtimeAbi: "linux-x64-glibc",
    resourcesDigest: digest("4"),
    networkPolicyDigest: digest("5"),
    samplingSettingsDigest: digest("6"),
    contextSettingsDigest: digest("7"),
    harnessConfigDigest: digest("8"),
    extraConfigDigest: digest("9"),
  };
}

function evaluationEnvironment(): EvaluationEnvironment {
  return {
    terminalBenchVersion: "2.1",
    datasetRevision: "terminal-bench-2.1",
    graderProtocolVersion: "harbor-0.20.0",
    evaluatorVersion: "mvp-1",
    modelProvider: "microsoft-foundry",
    modelDeployment: "existing-opus-4-8",
    reasoningEffort: "high",
    samplingSettingsDigest: digest("6"),
    contextSettingsDigest: digest("7"),
    sandboxProvider: "daytona",
    sandboxRegion: "eu",
    imageDigest: digest("3"),
    architecture: "x86_64",
    resourcesDigest: digest("4"),
    networkPolicyDigest: digest("5"),
    harnessConfigDigest: digest("8"),
    extraConfigDigest: digest("9"),
  };
}
