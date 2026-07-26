import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  type EvaluationEnvironment,
  hiddenTaskHandle,
  MVP_SCHEMA_VERSION,
  type PrivateEvaluationRequest,
} from "../../src/mvp/contracts.js";
import type {
  MvpDaytonaProviderLimits,
  MvpEligibleHarborTaskDefinition,
  MvpHarborExecutionPort,
  MvpPiRuntimeMaterialization,
} from "../../src/mvp/evaluator-runtime.js";
import {
  assertMvpEvaluatorRuntimePin,
  type MvpEvaluatorRuntimePin,
  type MvpPiRuntimeSourcePort,
  MvpTrustedBatchEvaluator,
  mvpEvaluatorEligibilityPolicyDigest,
} from "../../src/mvp/evaluator-runtime.js";
import type { MountedHiddenTaskCatalog } from "../../src/mvp/mounted-hidden-task-catalog.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const revision = (value: string): string => value.repeat(40).slice(0, 40);

describe("MVP trusted evaluator runtime", () => {
  it("materializes the trusted campaign champion for an all-cache-hit screen", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-mvp-evaluator-"));
    const adapterPath = join(root, "dark_factory_pi.py");
    await writeFile(adapterPath, "class DarkFactoryPi: pass\n");
    const adapterSha256 = createHash("sha256").update("class DarkFactoryPi: pass\n").digest("hex");
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      handle: hiddenTaskHandle(digest(String(index + 1))),
      revisionDigest: digest(String(index + 6)),
      harborTaskName: `terminal-bench/hidden-${index + 1}`,
    }));
    const runtimePin = pin(
      adapterPath,
      adapterSha256,
      tasks.map((task) => task.revisionDigest),
    );
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
    const environment = evaluationEnvironment(runtimePin);
    const environmentDigest = createHash("sha256")
      .update(
        JSON.stringify(
          Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))),
        ),
      )
      .digest("hex");
    const candidateRevision = revision("a");
    const championRevision = revision("b");
    const requests: PrivateEvaluationRequest[] = cells.map((cell) => ({
      schemaVersion: MVP_SCHEMA_VERSION,
      experimentId: "002-cache-hit-screen",
      cell,
      arm: "candidate",
      harnessRevision: candidateRevision,
      environment,
      environmentDigest,
    }));
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
              expected.arm === "candidate" ? "dark-factory-candidate" : "dark-factory-champion",
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
            traceArtifactRefs: [`trusted://mvp-private/traces/${digest("f")}`],
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
          harborTaskLocator: tasks[Math.floor(index / 3)]!.harborTaskName,
        })),
    } as unknown as MountedHiddenTaskCatalog;
    const evaluator = new MvpTrustedBatchEvaluator({
      stateRoot: root,
      pin: runtimePin,
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
      expect.arrayContaining([`candidate:${candidateRevision}`, `champion:${championRevision}`]),
    );
  });

  it("accepts a fully bound V2 runtime pin", () => {
    const runtimePin = pin(
      "/tmp/df-mvp-controller/src/terminal-bench/assets/dark_factory_pi.py",
      digest("a"),
      Array.from({ length: 5 }, (_, index) => digest(String(index + 1))),
    );

    expect(() => assertMvpEvaluatorRuntimePin(runtimePin)).not.toThrow();
  });

  it("rejects a difficulty prior that is not bound to the eligibility policy", () => {
    const runtimePin = pin(
      "/tmp/df-mvp-controller/src/terminal-bench/assets/dark_factory_pi.py",
      digest("a"),
      Array.from({ length: 5 }, (_, index) => digest(String(index + 1))),
    );
    const driftedDefinitions = runtimePin.hiddenTaskDefinitions.map((definition, index) =>
      index === 0
        ? {
            ...definition,
            baselineProvenance: {
              kind: "dataset-declared-difficulty-prior" as const,
              sourceDigest: definition.baselineProvenance.sourceDigest,
              policyDigest: digest("0"),
              datasetRevision: definition.baselineProvenance.datasetRevision,
            },
          }
        : definition,
    );
    const driftedPin: MvpEvaluatorRuntimePin = {
      ...runtimePin,
      hiddenTaskDefinitions: driftedDefinitions,
      inventoryDigest: canonicalDigest(driftedDefinitions),
    };

    expect(() => assertMvpEvaluatorRuntimePin(driftedPin)).toThrow("Runtime pin is incomplete.");
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
  const providerLimits: MvpDaytonaProviderLimits = {
    perSandbox: {
      cpu: 4,
      memoryMiB: 8 * 1_024,
      storageMiB: 10 * 1_024,
      gpus: 0,
    },
    organization: {
      cpu: 100,
      memoryMiB: 200 * 1_024,
      storageMiB: 300 * 1_024,
    },
    outerEvaluator: {
      cpu: 4,
      memoryMiB: 8 * 1_024,
      storageMiB: 10 * 1_024,
      gpus: 0,
    },
    harborMaxConcurrentTrials: 5,
    maximumOverlappingChildSandboxes: 10,
  };
  const providerLimitsDigest = canonicalDigest(providerLimits);
  const eligibilityPolicyDigest = mvpEvaluatorEligibilityPolicyDigest();
  const bunExecutableSha256 = digest("a");
  const sortedEligible = [...eligible].sort();
  const hiddenTaskDefinitions: MvpEligibleHarborTaskDefinition[] = sortedEligible.map(
    (revisionDigest, index) => {
      const officialResources = {
        agent: {
          cpu: 1,
          memoryMiB: 1_024,
          storageMiB: 1_024,
          gpus: 0 as const,
        },
        verifiers: [
          {
            cpu: 1,
            memoryMiB: 1_024,
            storageMiB: 1_024,
            gpus: 0 as const,
          },
        ],
      };
      return {
        harborTaskLocator: `terminal-bench/hidden-${index + 1}`,
        revisionDigest,
        difficulty: index === sortedEligible.length - 1 ? ("easy" as const) : ("hard" as const),
        easyCanary: index === sortedEligible.length - 1,
        baselineFailureRate: index === sortedEligible.length - 1 ? 0.3 : 0.8,
        baselineProvenance: {
          kind: "dataset-declared-difficulty-prior" as const,
          sourceDigest: digest("b"),
          policyDigest: eligibilityPolicyDigest,
          datasetRevision: "terminal-bench-2-1-r6",
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
        initialFailureRate: index === sortedEligible.length - 1 ? 0.3 : 0.8,
        uncertainty: 0.9,
        normalizedCost: 0.2,
        sensitiveLiterals: [`terminal-bench/hidden-${index + 1}`],
        executionEligibility: {
          environmentType: "daytona" as const,
          sandboxMode: "direct" as const,
          compose: false as const,
          officialResources,
          resourceSourceDigest: canonicalDigest({
            revisionDigest,
            agent: officialResources.agent,
            verifiers: officialResources.verifiers,
          }),
          providerLimitsDigest,
          resourceFit: true as const,
          runtimeCompatibility: {
            architecture: "x86_64" as const,
            runtimeAbi: "linux-x64-glibc" as const,
            bunExecutableSha256,
            smokeEvidenceDigest: canonicalDigest({
              policy: "direct-daytona-bun-exec-v1",
              revisionDigest,
              bunExecutableSha256,
              reportedVersion: "1.3.14",
              exitCode: 0,
              destroyed: true,
            }),
            compatible: true as const,
          },
        },
      };
    },
  );
  const imageDigest = digest("3");
  const resourcesDigest = canonicalDigest({
    providerLimits,
    tasks: hiddenTaskDefinitions.map((definition) => ({
      revisionDigest: definition.revisionDigest,
      officialResources: definition.executionEligibility.officialResources,
      resourceSourceDigest: definition.executionEligibility.resourceSourceDigest,
    })),
  });
  return {
    schemaVersion: 2,
    domain: "dark-factory.mvp-evaluator-runtime-pin.v2",
    sourceCommit: revision("d"),
    imageReference: `ghcr.io/parallaxai/dark-factory-mvp@sha256:${imageDigest}`,
    runtimePinsSha256: digest("f"),
    harborVersion: "0.20.0",
    harborPackageSha256: digest("1"),
    terminalBenchVersion: "2.1",
    datasetName: "terminal-bench/terminal-bench-2-1",
    datasetRef: `sha256:${digest("2")}`,
    datasetRevision: "terminal-bench-2-1-r6",
    datasetContentSha256: digest("1"),
    datasetManifestSha256: digest("2"),
    graderProtocolVersion: "harbor-0.20.0-separate-verifier",
    evaluatorVersion: "mvp-2",
    harborExecutable: "/usr/local/bin/harbor",
    harborExecutableSha256: digest("2"),
    bunExecutable: "/usr/local/bin/bun",
    bunExecutableSha256,
    adapterPath,
    adapterSha256,
    piEntrypoint: "packages/coding-agent/dist/pi",
    enabledTools: ["read", "bash", "write", "edit"],
    timeoutSeconds: 7_200,
    directSandboxEligibleTaskRevisionDigests: sortedEligible,
    hiddenTaskDefinitions,
    imageDigest,
    architecture: "x86_64",
    runtimeAbi: "linux-x64-glibc",
    providerLimits,
    providerLimitsDigest,
    eligibilityPolicyDigest,
    inventoryDigest: canonicalDigest(hiddenTaskDefinitions),
    resourcesDigest,
    networkPolicyDigest: digest("5"),
    samplingSettingsDigest: digest("6"),
    contextSettingsDigest: digest("7"),
    harnessConfigDigest: digest("8"),
    extraConfigDigest: digest("9"),
  };
}

function evaluationEnvironment(pin: MvpEvaluatorRuntimePin): EvaluationEnvironment {
  return {
    terminalBenchVersion: pin.terminalBenchVersion,
    datasetRevision: pin.datasetRevision,
    graderProtocolVersion: pin.graderProtocolVersion,
    evaluatorVersion: pin.evaluatorVersion,
    modelProvider: "microsoft-foundry",
    modelDeployment: "existing-opus-4-8",
    reasoningEffort: "high",
    samplingSettingsDigest: pin.samplingSettingsDigest,
    contextSettingsDigest: pin.contextSettingsDigest,
    sandboxProvider: "daytona",
    sandboxRegion: "eu",
    imageDigest: pin.imageDigest,
    architecture: "x86_64",
    resourcesDigest: pin.resourcesDigest,
    networkPolicyDigest: pin.networkPolicyDigest,
    harnessConfigDigest: pin.harnessConfigDigest,
    extraConfigDigest: pin.extraConfigDigest,
  };
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
