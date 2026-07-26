import { describe, expect, it } from "vitest";
import { hiddenTaskHandle, MVP_SCHEMA_VERSION } from "../../src/mvp/contracts.js";
import {
  assertCanonicalFreshMvpHarborEvaluation,
  buildCanonicalFreshMvpHarborExecutionPlan,
  buildTrustedMvpHarborExecutionPlan,
  buildTrustedMvpHarborPlan,
  decodeTrustedMvpHarborOutput,
  decodeTrustedMvpHarborRequestedOutput,
  MVP_HARBOR_TRIAL_COUNT,
  type MvpHarborBuildInput,
  type MvpHarborExecutionRequest,
  type TrustedMvpHarborExecutionPlan,
  type TrustedMvpHarborPlan,
  type TrustedMvpHarborRawOutput,
  type TrustedMvpHarborRawTrial,
  type TrustedMvpHarborRequestedRawOutput,
  type TrustedMvpHarborRequestedRawTrial,
} from "../../src/mvp/harbor.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);
const revision = (value: string): string => value.repeat(40).slice(0, 40);

function artifact(name: string, sha256: string, mediaType: string) {
  return {
    uri: `trusted://mvp/${name}` as const,
    sha256,
    mediaType,
    byteLength: 1_024,
  };
}

function buildInput(
  experimentNumber = 1,
  experimentId = "001-first-improvement",
): MvpHarborBuildInput {
  return {
    experimentId,
    experimentNumber,
    environmentDigest: digest("e"),
    datasetName: "terminal-bench",
    datasetRef: "2.1",
    jobsDirectory: "/trusted/harbor/jobs",
    environmentType: "daytona",
    evaluatedSecretSourceName: "DF_EVALUATED_FOUNDRY",
    tasks: Array.from({ length: 5 }, (_, index) => ({
      sensitivity: "trusted-hidden-mvp-task" as const,
      hiddenTaskId: hiddenTaskHandle(digest(String(index + 1))),
      taskRevisionDigest: digest(String(index + 6)),
      harborTaskName: `terminal-bench/hidden-${index + 1}`,
      cellIds: [digest(`${index + 1}a`), digest(`${index + 1}b`), digest(`${index + 1}c`)],
    })),
    candidateRuntime: {
      arm: "candidate",
      harnessRevision: revision("a"),
      artifact: artifact("candidate.tar", digest("a"), "application/x-tar"),
      remotePath: "/trusted/input/candidate.tar",
    },
    championRuntime: {
      arm: "champion",
      harnessRevision: revision("b"),
      artifact: artifact("champion.tar", digest("b"), "application/x-tar"),
      remotePath: "/trusted/input/champion.tar",
    },
    adapter: {
      artifact: artifact("dark-factory-pi.py", digest("c"), "text/x-python"),
      remotePath: "/trusted/input/dark_factory_pi.py",
      importPath: "dark_factory_pi:DarkFactoryPi",
    },
    model: {
      provider: "microsoft-foundry",
      deployment: "existing-opus-4-8",
      modelFamily: "claude-opus-4-8",
      endpointHost: "existing-resource.services.ai.azure.com",
      reasoningEffort: "high",
      credentialEnvironmentName: "ANTHROPIC_FOUNDRY_API_KEY",
    },
    piEntrypoint: "packages/coding-agent/dist/cli.js",
    enabledTools: ["read", "bash", "write", "edit"],
    timeoutSeconds: 7_200,
  };
}

function rawTrials(plan: TrustedMvpHarborPlan): TrustedMvpHarborRawTrial[] {
  let trialOrdinal = 0;
  return plan.tasks.flatMap((task) =>
    ([1, 2, 3] as const).flatMap((attemptOrdinal) =>
      (["candidate", "champion"] as const).map((arm) => {
        trialOrdinal += 1;
        const candidate = arm === "candidate";
        return {
          trialId: `trial-${String(trialOrdinal).padStart(2, "0")}`,
          harborTaskName: task.harborTaskName,
          agentName: candidate ? "dark-factory-candidate" : "dark-factory-champion",
          attemptOrdinal,
          runtimeArchiveSha256: candidate
            ? plan.candidateRuntime.artifact.sha256
            : plan.championRuntime.artifact.sha256,
          adapterSha256: plan.adapter.artifact.sha256,
          modelProvider: "microsoft-foundry",
          modelDeployment: plan.model.deployment,
          endpointHost: plan.model.endpointHost,
          passed: candidate ? attemptOrdinal !== 3 : attemptOrdinal === 1,
          reward: candidate ? (attemptOrdinal !== 3 ? 1 : 0) : attemptOrdinal === 1 ? 1 : 0,
          infrastructureValid: true,
          durationMs: 1_000 + trialOrdinal,
          evaluatedAt: "2026-07-26T10:00:00.000Z",
          traceArtifactRefs: [`trusted://traces/trial-${trialOrdinal}`],
          rawDiagnostics: [],
        };
      }),
    ),
  );
}

function rawOutput(
  plan: TrustedMvpHarborPlan,
  trials: readonly TrustedMvpHarborRawTrial[] = rawTrials(plan),
): TrustedMvpHarborRawOutput {
  return {
    sensitivity: "trusted-mvp-harbor-output",
    schemaVersion: MVP_SCHEMA_VERSION,
    harborVersion: "0.20.0",
    experimentId: plan.experimentId,
    trials,
  };
}

function requestedRawTrials(
  plan: TrustedMvpHarborExecutionPlan,
): TrustedMvpHarborRequestedRawTrial[] {
  let trialOrdinal = 0;
  return plan.invocations.flatMap((invocation) =>
    invocation.expectedTrials.map((expected) => {
      trialOrdinal += 1;
      const candidate = expected.arm === "candidate";
      return {
        invocationId: invocation.invocationId,
        trialId: `requested-trial-${String(trialOrdinal).padStart(2, "0")}`,
        harborTaskName: expected.harborTaskName,
        agentName: candidate ? "dark-factory-candidate" : "dark-factory-champion",
        attemptOrdinal: expected.harborAttemptOrdinal,
        runtimeArchiveSha256: candidate
          ? plan.basePlan.candidateRuntime.artifact.sha256
          : plan.basePlan.championRuntime.artifact.sha256,
        adapterSha256: plan.basePlan.adapter.artifact.sha256,
        modelProvider: "microsoft-foundry",
        modelDeployment: plan.basePlan.model.deployment,
        endpointHost: plan.basePlan.model.endpointHost,
        passed: candidate,
        reward: candidate ? 1 : 0,
        infrastructureValid: true,
        durationMs: 2_000 + trialOrdinal,
        evaluatedAt: "2026-07-26T11:00:00.000Z",
        traceArtifactRefs: [`trusted://traces/requested-${trialOrdinal}`],
        rawDiagnostics: [],
      };
    }),
  );
}

function requestedRawOutput(
  plan: TrustedMvpHarborExecutionPlan,
  trials: readonly TrustedMvpHarborRequestedRawTrial[] = requestedRawTrials(plan),
): TrustedMvpHarborRequestedRawOutput {
  return {
    sensitivity: "trusted-mvp-harbor-requested-output",
    schemaVersion: MVP_SCHEMA_VERSION,
    harborVersion: "0.20.0",
    experimentId: plan.basePlan.experimentId,
    executionPlanHash: plan.executionPlanHash,
    trials,
  };
}

function allCandidateCells(plan: TrustedMvpHarborPlan): MvpHarborExecutionRequest["cells"] {
  return plan.tasks.flatMap((task) =>
    ([1, 2, 3] as const).map((replicateOrdinal) => ({
      hiddenTaskId: task.hiddenTaskId,
      arm: "candidate" as const,
      replicateOrdinal,
    })),
  );
}

describe("MVP Harbor matched scheduling", () => {
  it("builds deterministic three-AB/two-BA configs with three attempts", () => {
    const first = buildTrustedMvpHarborPlan(buildInput());
    const repeated = buildTrustedMvpHarborPlan(buildInput());

    expect(first).toEqual(repeated);
    expect(first.tasks.map((task) => task.order)).toEqual(["AB", "AB", "AB", "BA", "BA"]);
    expect(first.configs.map((config) => config.taskCount)).toEqual([3, 2]);
    expect(first.configs.map((config) => config.expectedTrialCount)).toEqual([18, 12]);
    expect(first.configs.every((entry) => entry.config.n_attempts === 3)).toBe(true);
    expect(first.configs.every((entry) => entry.config.n_concurrent_trials === 5)).toBe(true);
    expect(
      first.configs.every(
        (entry) =>
          entry.config.environment.kwargs.secrets.ANTHROPIC_FOUNDRY_API_KEY ===
          "DF_EVALUATED_FOUNDRY",
      ),
    ).toBe(true);
    expect(first.configs[0].config.agents.map((agent) => agent.name)).toEqual([
      "dark-factory-candidate",
      "dark-factory-champion",
    ]);
    expect(first.configs[1].config.agents.map((agent) => agent.name)).toEqual([
      "dark-factory-champion",
      "dark-factory-candidate",
    ]);
    expect(first.configs.reduce((sum, config) => sum + config.expectedTrialCount, 0)).toBe(
      MVP_HARBOR_TRIAL_COUNT,
    );
  });

  it("rotates opaque tasks between arm orders across experiments", () => {
    const first = buildTrustedMvpHarborPlan(buildInput());
    const second = buildTrustedMvpHarborPlan(buildInput(2, "002-second-improvement"));
    const firstAb = new Set(
      first.tasks.filter((task) => task.order === "AB").map((task) => task.hiddenTaskId),
    );
    const secondAb = new Set(
      second.tasks.filter((task) => task.order === "AB").map((task) => task.hiddenTaskId),
    );

    expect(secondAb).not.toEqual(firstAb);
    expect(second.tasks.filter((task) => task.order === "AB")).toHaveLength(3);
    expect(second.tasks.filter((task) => task.order === "BA")).toHaveLength(2);
  });

  it("rejects duplicate hidden tasks and untrusted Foundry hosts", () => {
    const duplicate = buildInput();
    const first = duplicate.tasks[0]!;
    expect(() =>
      buildTrustedMvpHarborPlan({
        ...duplicate,
        tasks: [...duplicate.tasks.slice(0, 4), first],
      }),
    ).toThrow(/unique/u);

    expect(() =>
      buildTrustedMvpHarborPlan({
        ...buildInput(),
        model: {
          ...buildInput().model,
          endpointHost: "attacker.example.com",
        },
      }),
    ).toThrow(/Foundry deployment/u);
  });

  it("rejects a tampered config even when its outer plan shape remains valid", () => {
    const plan = buildTrustedMvpHarborPlan(buildInput());
    const tampered = {
      ...structuredClone(plan),
      configs: [
        {
          ...structuredClone(plan.configs[0]),
          config: {
            ...structuredClone(plan.configs[0].config),
            n_attempts: 1,
          },
        },
        structuredClone(plan.configs[1]),
      ],
    };

    expect(() => decodeTrustedMvpHarborOutput(tampered, rawOutput(plan))).toThrow(
      /sealed schedule/u,
    );
  });
});

describe("MVP Harbor strict decoding", () => {
  it("decodes a complete order-independent 15/15 result matrix", () => {
    const plan = buildTrustedMvpHarborPlan(buildInput());
    const output = rawOutput(plan, rawTrials(plan).reverse());
    const decoded = decodeTrustedMvpHarborOutput(plan, output);

    expect(decoded.trustedMatrix.candidate).toHaveLength(15);
    expect(decoded.trustedMatrix.champion).toHaveLength(15);
    expect(
      new Set(
        [...decoded.trustedMatrix.candidate, ...decoded.trustedMatrix.champion].map(
          (trial) => `${trial.hiddenTaskId}|${trial.arm}|${trial.replicateOrdinal}`,
        ),
      ).size,
    ).toBe(30);
    expect(decoded.releaseReceipt).toMatchObject({
      complete: true,
      taskCount: 5,
      abTaskCount: 3,
      baTaskCount: 2,
      attemptsPerTaskAndArm: 3,
      candidateTrialCount: 15,
      championTrialCount: 15,
      totalTrialCount: 30,
      candidatePassCount: 10,
      championPassCount: 5,
      candidateMeanReward: 0.666667,
      championMeanReward: 0.333333,
      containsTaskIds: false,
      containsTaskNames: false,
      containsPerTaskResults: false,
    });
  });

  it("keeps every task ID and task name out of the release receipt", () => {
    const plan = buildTrustedMvpHarborPlan(buildInput());
    const { releaseReceipt } = decodeTrustedMvpHarborOutput(plan, rawOutput(plan));
    const serialized = JSON.stringify(releaseReceipt);

    for (const task of plan.tasks) {
      expect(serialized).not.toContain(task.hiddenTaskId);
      expect(serialized).not.toContain(task.harborTaskName);
    }
  });

  it("rejects incomplete and duplicate identity matrices", () => {
    const plan = buildTrustedMvpHarborPlan(buildInput());
    const complete = rawTrials(plan);
    expect(() => decodeTrustedMvpHarborOutput(plan, rawOutput(plan, complete.slice(1)))).toThrow(
      /thirty trials/u,
    );

    const duplicated = [...complete];
    duplicated[29] = {
      ...duplicated[0]!,
      trialId: "replacement-trial",
    };
    expect(() => decodeTrustedMvpHarborOutput(plan, rawOutput(plan, duplicated))).toThrow(
      /duplicate or unexpected/u,
    );
  });

  it("rejects unknown tasks, runtime substitution, and extra output fields", () => {
    const plan = buildTrustedMvpHarborPlan(buildInput());
    const unknownTask = rawTrials(plan);
    unknownTask[0] = {
      ...unknownTask[0]!,
      harborTaskName: "terminal-bench/not-selected",
    };
    expect(() => decodeTrustedMvpHarborOutput(plan, rawOutput(plan, unknownTask))).toThrow(
      /outside the sealed/u,
    );

    const substituted = rawTrials(plan);
    substituted[0] = {
      ...substituted[0]!,
      runtimeArchiveSha256: plan.championRuntime.artifact.sha256,
    };
    expect(() => decodeTrustedMvpHarborOutput(plan, rawOutput(plan, substituted))).toThrow(
      /execution bindings/u,
    );

    const extraField = {
      ...rawOutput(plan),
      leakedTask: "terminal-bench/hidden-1",
    };
    expect(() => decodeTrustedMvpHarborOutput(plan, extraField)).toThrow(
      /missing or unexpected fields/u,
    );
  });
});

describe("MVP Harbor cache-aware requested executions", () => {
  it("runs all candidate cells and only the requested champion cache misses", () => {
    const input = buildInput();
    const basePlan = buildTrustedMvpHarborPlan(input);
    const misses = [
      {
        hiddenTaskId: basePlan.tasks[0]!.hiddenTaskId,
        arm: "champion" as const,
        replicateOrdinal: 2 as const,
      },
      {
        hiddenTaskId: basePlan.tasks[3]!.hiddenTaskId,
        arm: "champion" as const,
        replicateOrdinal: 3 as const,
      },
    ];
    const executionPlan = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "screen",
      cells: [...allCandidateCells(basePlan), ...misses],
    });

    expect(executionPlan.candidateTrialCount).toBe(15);
    expect(executionPlan.championTrialCount).toBe(2);
    expect(executionPlan.totalTrialCount).toBe(17);
    expect(executionPlan.fullFreshMatchedMatrix).toBe(false);
    expect(
      executionPlan.invocations.reduce((sum, invocation) => sum + invocation.expectedTrialCount, 0),
    ).toBe(17);
    expect(
      executionPlan.invocations
        .filter((invocation) => invocation.targetReplicateOrdinal !== null)
        .every((invocation) => invocation.config.n_attempts === 1),
    ).toBe(true);

    const decoded = decodeTrustedMvpHarborRequestedOutput(
      executionPlan,
      requestedRawOutput(executionPlan, requestedRawTrials(executionPlan).reverse()),
    );
    expect(decoded.trustedMatrix.candidate).toHaveLength(15);
    expect(decoded.trustedMatrix.champion).toHaveLength(2);
    expect(decoded.releaseReceipt).toMatchObject({
      purpose: "screen",
      completeRequestedSet: true,
      fullFreshMatchedMatrix: false,
      candidateTrialCount: 15,
      championTrialCount: 2,
      totalTrialCount: 17,
    });
  });

  it("supports a one-cell champion-only promotion refresh", () => {
    const input = buildInput();
    const basePlan = buildTrustedMvpHarborPlan(input);
    const executionPlan = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "promotion-refresh",
      cells: [
        {
          hiddenTaskId: basePlan.tasks[4]!.hiddenTaskId,
          arm: "champion",
          replicateOrdinal: 2,
        },
      ],
    });
    const decoded = decodeTrustedMvpHarborRequestedOutput(
      executionPlan,
      requestedRawOutput(executionPlan),
    );

    expect(executionPlan.totalTrialCount).toBe(1);
    expect(executionPlan.invocations).toHaveLength(1);
    expect(executionPlan.invocations[0]!.config.n_attempts).toBe(1);
    expect(decoded.trustedMatrix.candidate).toHaveLength(0);
    expect(decoded.trustedMatrix.champion).toHaveLength(1);
    expect(decoded.releaseReceipt.candidateMeanReward).toBeNull();
  });

  it("uses disjoint job names for screen misses and promotion refreshes", () => {
    const input = buildInput();
    const basePlan = buildTrustedMvpHarborPlan(input);
    const championCell = {
      hiddenTaskId: basePlan.tasks[0]!.hiddenTaskId,
      arm: "champion" as const,
      replicateOrdinal: 1 as const,
    };
    const screen = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "screen",
      cells: [...allCandidateCells(basePlan), championCell],
    });
    const refresh = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "promotion-refresh",
      cells: [championCell],
    });

    const screenNames = new Set(screen.invocations.map((entry) => entry.config.job_name));
    expect(refresh.invocations.every((entry) => !screenNames.has(entry.config.job_name))).toBe(
      true,
    );
  });

  it("retains a strict helper for the canonical all-fresh 30-trial matrix", () => {
    const executionPlan = buildCanonicalFreshMvpHarborExecutionPlan(buildInput());
    const decoded = decodeTrustedMvpHarborRequestedOutput(
      executionPlan,
      requestedRawOutput(executionPlan),
    );

    expect(executionPlan.invocations).toHaveLength(2);
    expect(executionPlan.invocations.every((entry) => entry.config.n_attempts === 3)).toBe(true);
    expect(() => assertCanonicalFreshMvpHarborEvaluation(decoded)).not.toThrow();
  });

  it("rejects an incomplete screen and any unrequested result", () => {
    const input = buildInput();
    const basePlan = buildTrustedMvpHarborPlan(input);
    expect(() =>
      buildTrustedMvpHarborExecutionPlan(input, {
        purpose: "screen",
        cells: allCandidateCells(basePlan).slice(1),
      }),
    ).toThrow(/all fifteen candidate/u);

    const executionPlan = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "promotion-refresh",
      cells: [
        {
          hiddenTaskId: basePlan.tasks[0]!.hiddenTaskId,
          arm: "champion",
          replicateOrdinal: 1,
        },
      ],
    });
    const unexpected = requestedRawTrials(executionPlan);
    unexpected[0] = {
      ...unexpected[0]!,
      attemptOrdinal: 2,
    };
    expect(() =>
      decodeTrustedMvpHarborRequestedOutput(
        executionPlan,
        requestedRawOutput(executionPlan, unexpected),
      ),
    ).toThrow(/unrequested or duplicate/u);
  });

  it("keeps task material out of partial-batch release receipts", () => {
    const input = buildInput();
    const basePlan = buildTrustedMvpHarborPlan(input);
    const executionPlan = buildTrustedMvpHarborExecutionPlan(input, {
      purpose: "screen",
      cells: allCandidateCells(basePlan),
    });
    const { releaseReceipt } = decodeTrustedMvpHarborRequestedOutput(
      executionPlan,
      requestedRawOutput(executionPlan),
    );
    const serialized = JSON.stringify(releaseReceipt);

    for (const task of executionPlan.basePlan.tasks) {
      expect(serialized).not.toContain(task.hiddenTaskId);
      expect(serialized).not.toContain(task.harborTaskName);
    }
  });
});
