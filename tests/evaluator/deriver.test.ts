import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  DeterministicCanonicalEvaluationDeriver,
  assertTrustedHiddenCatalogOutcomeUpdateIntegrity,
  fingerprintForbiddenReleaseLiteral,
  hashTrustedCacheEvidence,
  TrustedCanonicalDeriverError,
  type DeterministicCanonicalEvaluationDeriverOptions,
  type TrustedCanonicalDerivationPolicy,
  type TrustedDecodedEvaluation,
  type TrustedDecodedEvaluationAttempt,
  type TrustedRepairControl,
  type TrustedSignedHiddenCatalogOutcomeUpdate,
} from "../../src/evaluator/deriver.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  createTrustedRawArtifactManifest,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import { createOnlineErrorBudget } from "../../src/evaluation/statistics.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  createEd25519Signature,
  verifyEd25519Signature,
} from "../../src/evidence/signatures.js";
import type { TrustedRawRun } from "../../src/terminal-bench/runner.js";
import {
  createTrustedMatchedArmSchedule,
  type TrustedMatchedArm,
  type TrustedMatchedPanel,
} from "../../src/terminal-bench/trusted.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const ENVIRONMENT_HASH = "c".repeat(64);
const SECRET_LITERAL = "hidden-task-command-never-release";
const CANARY_LITERAL = "terminal-bench-grader-canary";
const hiddenOutcomeKeys = generateKeyPairSync("ed25519");

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "d".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function request(
  stage: "repair" | "validation" | "shadow",
): TrustedEvaluationRequest {
  const selection =
    stage === "repair"
      ? ({
          kind: "repair-reuse",
          sourceExperimentId: "000-baseline",
          taskCount: 5,
          attemptsPerTask: 1,
          candidateAttempt: 1,
        } as const)
      : stage === "validation"
        ? ({
            kind: "fresh-matched-validation",
            taskCount: 12,
            attemptsPerArm: 1,
            pairOrder: "balanced-6-ab-6-ba",
            weightingPolicyHash: digest(901),
            hypothesisExclusionAttestationHash: digest(902),
          } as const)
        : ({
            kind: "fresh-shadow",
            taskCount: 12,
            attemptsPerTask: 1,
            shadowSlice: 1,
            feedback: "disabled",
          } as const);
  return {
    schemaVersion: 1,
    requestId: `request-${stage}`,
    experimentId: "001-canonical-evaluation",
    runMode: "research",
    stage,
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH_A,
    complianceManifestHash: HASH_B,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: "1".repeat(40),
      treeSha: "1".repeat(40),
      archiveSha256: digest(801),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "2".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: digest(802),
    },
    selection,
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${digest(803)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: digest(804),
      protocolHash: HASH_A,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "evaluated-model",
      thinkingLevel: "high",
    },
  };
}

function panel(
  evaluationRequest: TrustedEvaluationRequest & {
    readonly stage: "repair" | "validation" | "shadow";
  },
): TrustedMatchedPanel {
  const count = evaluationRequest.stage === "repair" ? 5 : 12;
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: `lease-${evaluationRequest.stage}`,
    requestId: evaluationRequest.requestId,
    stage: evaluationRequest.stage,
    sealedAt: "2026-07-01T00:01:00.000Z",
    expiresAt: "2026-07-01T05:00:00.000Z",
    dispositionAttestationHash: digest(810),
    cells: Array.from({ length: count }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId(digest(index + 1)),
      taskRevisionDigest: digest(index + 101),
      capabilityStratum: index % 2 === 0 ? "shell" : "filesystem",
      replicateOrdinal: 1,
      order:
        evaluationRequest.stage === "repair" || index < 6
          ? ("AB" as const)
          : ("BA" as const),
    })),
  };
}

function rawRun(evaluationRequest: TrustedEvaluationRequest): TrustedRawRun {
  const manifest = createTrustedRawArtifactManifest(retentionPolicy, {
    manifestId: `manifest-${evaluationRequest.stage}`,
    createdAt: "2026-07-01T00:00:30.000Z",
    destroyBy: "2026-07-01T00:59:30.000Z",
    artifacts: [
      {
        kind: "atif",
        uri: "trusted://raw/evaluator/atif.enc",
        sha256: digest(820),
        byteLength: 1_024,
        encrypted: true,
      },
      {
        kind: "grader-output",
        uri: "trusted://raw/evaluator/grader.enc",
        sha256: digest(821),
        byteLength: 1_024,
        encrypted: true,
      },
      {
        kind: "harbor-output",
        uri: "trusted://raw/evaluator/harbor.enc",
        sha256: digest(822),
        byteLength: 1_024,
        encrypted: true,
      },
    ],
  });
  return {
    sensitivity: "raw-terminal-bench-run",
    requestId: evaluationRequest.requestId,
    pinHash: digest(823),
    jobSha256: digest(824),
    runtimeAttestationHash: digest(825),
    executions: [],
    rawBundles: [],
    manifest,
  };
}

function secondsAfterMidnight(seconds: number): string {
  return new Date(
    Date.parse("2026-07-01T00:00:00.000Z") + seconds * 1_000,
  ).toISOString();
}

function attempt(input: {
  readonly arm: TrustedMatchedArm;
  readonly sequence: number;
  readonly passed: boolean;
  readonly attemptOrdinal?: number;
  readonly invalid?: boolean;
  readonly startOffsetSeconds?: number;
}): TrustedDecodedEvaluationAttempt {
  const startedAt = secondsAfterMidnight(
    input.startOffsetSeconds ?? 120 + input.sequence * 20,
  );
  const completedAt = secondsAfterMidnight(
    (input.startOffsetSeconds ?? 120 + input.sequence * 20) + 10,
  );
  const attemptDigest = digest(
    1_000 + input.sequence * 4 + (input.attemptOrdinal ?? 1),
  );
  return {
    sensitivity: "trusted-decoded-evaluation-attempt",
    attemptDigest,
    scheduleArmId: input.arm.armId,
    taskId: input.arm.taskId,
    taskRevisionDigest: input.arm.taskRevisionDigest,
    capabilityStratum: input.arm.capabilityStratum,
    arm: input.arm.arm,
    order: input.arm.order,
    harnessArchiveSha256: input.arm.harness.archiveSha256,
    attemptOrdinal: input.attemptOrdinal ?? 1,
    startedAt,
    completedAt,
    grader: {
      passed: input.invalid ? false : input.passed,
      boundedReward: input.invalid ? 0 : input.passed ? 1 : 0,
      infrastructureInvalidClass: input.invalid ? "provider-capacity" : null,
      integrityStatus: input.invalid ? "not-run" : "passed",
      elapsedMs: 10_000,
      cpuUtilizationPercent: input.invalid ? null : 40,
      maxRssMb: input.invalid ? null : 1_024,
      protocolHash: HASH_A,
      environmentFingerprintHash: ENVIRONMENT_HASH,
      oneUseAttemptDigest: attemptDigest,
    },
    atif: {
      elapsedMs: 10_000,
      planningTokens: 10,
      actionTokens: 40,
      totalTokens: 100,
      events: [
        {
          kind: "tool-call",
          category: "execute",
          invocationValid: true,
          actionFingerprint: SECRET_LITERAL,
          command: `${SECRET_LITERAL} ${CANARY_LITERAL}`,
          path: `/private/${SECRET_LITERAL}`,
        },
        {
          kind: "tool-result",
          exitCode: input.passed ? 0 : 1,
          stderr: CANARY_LITERAL,
        },
        { kind: "stop", reason: input.passed ? "completed" : "error" },
      ],
    },
    cost: {
      inputTokens: 100,
      outputTokens: 20,
      modelUsd: 0.01,
      sandboxUsd: 0.005,
    },
  };
}

function decoded(input: {
  readonly evaluationRequest: TrustedEvaluationRequest;
  readonly raw: TrustedRawRun;
  readonly schedule: ReturnType<typeof createTrustedMatchedArmSchedule>;
  readonly candidatePass: (cellOrdinal: number) => boolean;
  readonly championPass: (cellOrdinal: number) => boolean;
  readonly replacementOnFirstCandidate?: boolean;
}): TrustedDecodedEvaluation {
  const attempts: TrustedDecodedEvaluationAttempt[] = [];
  input.schedule.arms.forEach((arm, sequence) => {
    const passed =
      arm.arm === "candidate"
        ? input.candidatePass(arm.cellOrdinal)
        : input.championPass(arm.cellOrdinal);
    if (
      input.replacementOnFirstCandidate === true &&
      arm.arm === "candidate" &&
      arm.cellOrdinal === 0
    ) {
      attempts.push(
        attempt({
          arm,
          sequence,
          passed: false,
          invalid: true,
          attemptOrdinal: 1,
          startOffsetSeconds: 115,
        }),
      );
      attempts.push(
        attempt({
          arm,
          sequence,
          passed,
          attemptOrdinal: 2,
          startOffsetSeconds: 130,
        }),
      );
    } else {
      attempts.push(attempt({ arm, sequence, passed }));
    }
  });
  return {
    sensitivity: "trusted-decoded-evaluation",
    requestId: input.evaluationRequest.requestId,
    jobSha256: input.raw.jobSha256,
    runtimeAttestationHash: input.raw.runtimeAttestationHash,
    rawManifestHash: input.raw.manifest.manifestHash,
    rawArtifactSetHash: input.raw.manifest.artifactSetHash,
    attempts,
  };
}

function repairControls(
  hiddenPanel: TrustedMatchedPanel,
): readonly TrustedRepairControl[] {
  return hiddenPanel.cells.map((cell, index) => ({
    taskId: cell.taskId,
    bucket:
      index < 3
        ? ("hard" as const)
        : index === 3
          ? ("uncertain" as const)
          : ("easy" as const),
    championEvidence: {
      source: "fresh" as const,
      passes: 0,
      failures: 1,
      presealedFreshControl: true,
    },
    targetBehaviorImproved: true,
  }));
}

function policy(input: {
  readonly evaluationRequest: TrustedEvaluationRequest;
  readonly hiddenPanel: TrustedMatchedPanel;
  readonly behavioralRelease?: {
    readonly contentHash: string;
    readonly sourceSetHash: string;
  } | null;
}): TrustedCanonicalDerivationPolicy {
  const controls =
    input.evaluationRequest.stage === "repair"
      ? repairControls(input.hiddenPanel)
      : [];
  const requestHash = hashEvaluationRequest(input.evaluationRequest);
  return {
    sensitivity: "trusted-canonical-derivation-policy",
    requestHash,
    protocolHash: input.evaluationRequest.protocolHash,
    dispositionAttestationHash:
      input.hiddenPanel.dispositionAttestationHash,
    expectedEnvironmentFingerprintHash: ENVIRONMENT_HASH,
    cacheAttestationHash: digest(830),
    cacheEvidenceSetHash: hashTrustedCacheEvidence({
      requestHash,
      dispositionAttestationHash:
        input.hiddenPanel.dispositionAttestationHash,
      repairControls: controls,
    }),
    policyAttestationHash: digest(831),
    candidateFrozenAt: "2026-07-01T00:00:45.000Z",
    presealedStratumWeights: {
      filesystem: 0.5,
      shell: 0.5,
    },
    onlineErrorBudget: createOnlineErrorBudget(
      0.05,
      "null-calibration-v1",
    ),
    integrationPoints: 1_024,
    replacementAttemptCeiling: 4,
    repair:
      input.evaluationRequest.stage === "repair"
        ? {
            alternatingBucket: "easy",
            attemptOrdinal: 1,
            controls,
          }
        : null,
    guardrails: {
      externalIntegrityVeto: false,
      correctnessVeto: false,
      capabilityVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      complianceFlagsPassed: true,
    },
    behavioralRelease: input.behavioralRelease ?? null,
    privacyThresholdPassed: input.behavioralRelease != null,
    forbiddenReleaseLiterals: [SECRET_LITERAL, CANARY_LITERAL],
    forbiddenContentFingerprints: [
      fingerprintForbiddenReleaseLiteral(SECRET_LITERAL),
    ],
    graderCanaryFingerprints: [
      fingerprintForbiddenReleaseLiteral(CANARY_LITERAL),
    ],
  };
}

function fixture(
  stage: "repair" | "validation" | "shadow",
  options: {
    readonly replacementOnFirstCandidate?: boolean;
  } = {},
) {
  const evaluationRequest = request(stage);
  const hiddenPanel = panel(
    evaluationRequest as TrustedEvaluationRequest & {
      readonly stage: "repair" | "validation" | "shadow";
    },
  );
  const schedule = createTrustedMatchedArmSchedule(
    hiddenPanel,
    evaluationRequest.candidate,
    evaluationRequest.champion!,
  );
  const raw = rawRun(evaluationRequest);
  const decodedEvaluation = decoded({
    evaluationRequest,
    raw,
    schedule,
    candidatePass: () => true,
    championPass: (cellOrdinal) => cellOrdinal < 3,
    ...(options.replacementOnFirstCandidate === undefined
      ? {}
      : {
          replacementOnFirstCandidate:
            options.replacementOnFirstCandidate,
        }),
  });
  const derivationPolicy = policy({ evaluationRequest, hiddenPanel });
  return {
    evaluationRequest,
    hiddenPanel,
    schedule,
    raw,
    decodedEvaluation,
    derivationPolicy,
  };
}

function deriver(
  decodedEvaluation: TrustedDecodedEvaluation,
  derivationPolicy: TrustedCanonicalDerivationPolicy,
  capturedUpdates: TrustedSignedHiddenCatalogOutcomeUpdate[] = [],
  overrides: Partial<
    Pick<
      DeterministicCanonicalEvaluationDeriverOptions,
      | "hiddenOutcomeSigner"
      | "hiddenOutcomeVerifier"
      | "hiddenOutcomeSink"
    >
  > = {},
) {
  const committed = new Map<string, string>();
  const hiddenOutcomeSigner = {
    sign: (unsigned: Parameters<
      DeterministicCanonicalEvaluationDeriverOptions["hiddenOutcomeSigner"]["sign"]
    >[0]) =>
      Promise.resolve(
        createEd25519Signature(
          unsigned as unknown as Readonly<Record<string, unknown>>,
          hiddenOutcomeKeys.privateKey,
          "hidden-outcome-key-1",
          "2026-07-01T00:20:00.000Z",
        ),
      ),
  };
  const hiddenOutcomeVerifier = {
    verify: (update: TrustedSignedHiddenCatalogOutcomeUpdate) =>
      Promise.resolve(
        verifyEd25519Signature(
          update as unknown as Readonly<Record<string, unknown>>,
          hiddenOutcomeKeys.publicKey,
        ),
      ),
  };
  const hiddenOutcomeSink: DeterministicCanonicalEvaluationDeriverOptions["hiddenOutcomeSink"] =
    {
      commit: (update) => {
        const previous = committed.get(update.updateId);
        if (
          previous !== undefined &&
          previous !== update.sourceBindingHash
        ) {
          return Promise.reject(new Error("Conflicting update"));
        }
        if (previous === undefined) {
          committed.set(update.updateId, update.sourceBindingHash);
          capturedUpdates.push(update);
        }
        return Promise.resolve({
          status:
            previous === undefined
              ? ("committed" as const)
              : ("already-committed" as const),
          updateId: update.updateId,
          sourceBindingHash: update.sourceBindingHash,
        });
      },
    };
  return new DeterministicCanonicalEvaluationDeriver({
    reader: {
      decode: () => Promise.resolve(decodedEvaluation),
    },
    policies: {
      resolve: () => Promise.resolve(derivationPolicy),
    },
    hiddenOutcomeSigner:
      overrides.hiddenOutcomeSigner ?? hiddenOutcomeSigner,
    hiddenOutcomeVerifier:
      overrides.hiddenOutcomeVerifier ?? hiddenOutcomeVerifier,
    hiddenOutcomeSink: overrides.hiddenOutcomeSink ?? hiddenOutcomeSink,
    now: () => new Date("2026-07-01T00:20:00.000Z"),
  });
}

describe("deterministic trusted canonical evaluation derivation", () => {
  it("derives the same fresh matched validation aggregate without releasing raw literals", async () => {
    const value = fixture("validation", {
      replacementOnFirstCandidate: true,
    });
    const capturedUpdates: TrustedSignedHiddenCatalogOutcomeUpdate[] = [];
    const deterministicDeriver = deriver(
      value.decodedEvaluation,
      value.derivationPolicy,
      capturedUpdates,
    );
    const first = await deterministicDeriver.derive({
      request: value.evaluationRequest,
      panel: value.hiddenPanel,
      schedule: value.schedule,
      rawRun: value.raw,
    });
    const second = await deterministicDeriver.derive({
      request: value.evaluationRequest,
      panel: value.hiddenPanel,
      schedule: value.schedule,
      rawRun: value.raw,
    });

    expect(second).toEqual(first);
    expect(first.payload.kind).toBe("validation");
    if (first.payload.kind !== "validation") {
      throw new Error("Expected validation payload");
    }
    expect(first.payload.invalidArmTotal).toBe(1);
    expect(first.payload.validFreshArmCount).toBe(24);
    expect(first.payload.pairOutcomeTotals).toEqual({
      bothPass: 3,
      challengerOnlyPass: 9,
      championOnlyPass: 0,
      bothFail: 0,
    });
    expect(first.payload.aggregateCost.inputTokens).toBe(2_500);
    expect(first.normalizedOutcomeSetHash).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(SECRET_LITERAL);
    expect(serialized).not.toContain(CANARY_LITERAL);
    value.hiddenPanel.cells.forEach((cell) => {
      expect(serialized).not.toContain(cell.taskId);
      expect(serialized).not.toContain(cell.taskRevisionDigest);
    });
    expect(capturedUpdates).toHaveLength(1);
    const hiddenUpdate = capturedUpdates[0];
    expect(hiddenUpdate?.outcomes).toHaveLength(12);
    expect(hiddenUpdate?.outcomes[0]).toMatchObject({
      taskId: value.hiddenPanel.cells[0]?.taskId,
      candidate: {
        pass: true,
        infrastructureValid: true,
        infrastructureInvalidAttemptCount: 1,
        latencyMs: 20_000,
        inputTokens: 200,
      },
      champion: {
        pass: true,
        infrastructureValid: true,
      },
    });
    expect(hiddenUpdate?.normalizedOutcomeSetHash).toBe(
      first.normalizedOutcomeSetHash,
    );
    if (hiddenUpdate === undefined) {
      throw new Error("Expected a trusted hidden catalog update");
    }
    expect(
      verifyEd25519Signature(
        hiddenUpdate as unknown as Readonly<Record<string, unknown>>,
        hiddenOutcomeKeys.publicKey,
      ),
    ).toBe(true);
    const firstOutcome = hiddenUpdate.outcomes[0];
    if (firstOutcome === undefined) {
      throw new Error("Expected a hidden task outcome");
    }
    expect(() =>
      assertTrustedHiddenCatalogOutcomeUpdateIntegrity({
        ...hiddenUpdate,
        outcomes: [
          {
            ...firstOutcome,
            candidate: {
              ...firstOutcome.candidate,
              pass: false,
              boundedReward: 0,
            },
          },
          ...hiddenUpdate.outcomes.slice(1),
        ],
      }),
    ).toThrow(/hashes are detached/u);
  });

  it("derives candidate-only repair from five committed champion controls", async () => {
    const value = fixture("repair");
    const aggregate = await deriver(
      value.decodedEvaluation,
      value.derivationPolicy,
    ).derive({
      request: value.evaluationRequest,
      panel: value.hiddenPanel,
      schedule: value.schedule,
      rawRun: value.raw,
    });

    expect(aggregate.payload).toMatchObject({
      kind: "repair",
      disposition: "passed",
      attemptOrdinal: 1,
      integrityStatus: "passed",
    });
    expect(value.schedule.championArmCount).toBe(0);
  });

  it("collapses feedback-dark shadow evidence to certification only", async () => {
    const value = fixture("shadow");
    const aggregate = await deriver(
      value.decodedEvaluation,
      value.derivationPolicy,
    ).derive({
      request: value.evaluationRequest,
      panel: value.hiddenPanel,
      schedule: value.schedule,
      rawRun: value.raw,
    });

    expect(aggregate.payload).toMatchObject({
      kind: "shadow",
      disposition: "certified",
      compliancePassed: true,
    });
    expect(aggregate.behavioralAggregateHash).toBeNull();
    expect(aggregate.releaseChecks.privacyThresholdPassed).toBe(false);
  });

  it("fails generically when a decoded record is detached from its hidden task", async () => {
    const value = fixture("validation");
    const first = value.decodedEvaluation.attempts[0];
    if (first === undefined) {
      throw new Error("Missing synthetic attempt");
    }
    const tampered: TrustedDecodedEvaluation = {
      ...value.decodedEvaluation,
      attempts: [
        {
          ...first,
          taskId: hiddenTaskId(digest(9_999)),
        },
        ...value.decodedEvaluation.attempts.slice(1),
      ],
    };

    const rejection = deriver(tampered, value.derivationPolicy).derive({
      request: value.evaluationRequest,
      panel: value.hiddenPanel,
      schedule: value.schedule,
      rawRun: value.raw,
    });
    await expect(rejection).rejects.toMatchObject({
      name: "TrustedCanonicalDeriverError",
      code: "normalization-failed",
      message: "Canonical evaluation derivation failed closed.",
    });
    await expect(rejection).rejects.not.toThrow(SECRET_LITERAL);
  });

  it("rejects a detached behavioral release source commitment", async () => {
    const value = fixture("validation");
    const detached = policy({
      evaluationRequest: value.evaluationRequest,
      hiddenPanel: value.hiddenPanel,
      behavioralRelease: {
        contentHash: digest(840),
        sourceSetHash: digest(841),
      },
    });

    await expect(
      deriver(value.decodedEvaluation, detached).derive({
        request: value.evaluationRequest,
        panel: value.hiddenPanel,
        schedule: value.schedule,
        rawRun: value.raw,
      }),
    ).rejects.toBeInstanceOf(TrustedCanonicalDeriverError);
  });

  it("rejects a signature produced over a different hidden source binding", async () => {
    const value = fixture("validation");
    const wrongSourceSigner: DeterministicCanonicalEvaluationDeriverOptions["hiddenOutcomeSigner"] =
      {
        sign: (unsigned) =>
          Promise.resolve(
            createEd25519Signature(
              {
                ...unsigned,
                rawManifestHash: digest(9_700),
              } as unknown as Readonly<Record<string, unknown>>,
              hiddenOutcomeKeys.privateKey,
              "hidden-outcome-key-1",
              "2026-07-01T00:20:00.000Z",
            ),
          ),
      };

    await expect(
      deriver(value.decodedEvaluation, value.derivationPolicy, [], {
        hiddenOutcomeSigner: wrongSourceSigner,
      }).derive({
        request: value.evaluationRequest,
        panel: value.hiddenPanel,
        schedule: value.schedule,
        rawRun: value.raw,
      }),
    ).rejects.toMatchObject({
      code: "normalization-failed",
      message: "Canonical evaluation derivation failed closed.",
    });
  });

  it("rejects a detached idempotent-commit receipt", async () => {
    const value = fixture("validation");
    await expect(
      deriver(value.decodedEvaluation, value.derivationPolicy, [], {
        hiddenOutcomeSink: {
          commit: (update) =>
            Promise.resolve({
              status: "already-committed",
              updateId: update.updateId,
              sourceBindingHash: digest(9_701),
            }),
        },
      }).derive({
        request: value.evaluationRequest,
        panel: value.hiddenPanel,
        schedule: value.schedule,
        rawRun: value.raw,
      }),
    ).rejects.toMatchObject({
      code: "normalization-failed",
      message: "Canonical evaluation derivation failed closed.",
    });
  });

  it("fails the release firewall when policy marks a generated output literal sensitive", async () => {
    const value = fixture("validation");
    const adversarialPolicy: TrustedCanonicalDerivationPolicy = {
      ...value.derivationPolicy,
      forbiddenReleaseLiterals: [
        ...value.derivationPolicy.forbiddenReleaseLiterals,
        "trusted-canonical-aggregate",
      ],
    };
    const capturedUpdates: TrustedSignedHiddenCatalogOutcomeUpdate[] = [];

    await expect(
      deriver(
        value.decodedEvaluation,
        adversarialPolicy,
        capturedUpdates,
      ).derive({
        request: value.evaluationRequest,
        panel: value.hiddenPanel,
        schedule: value.schedule,
        rawRun: value.raw,
      }),
    ).rejects.toMatchObject({
      code: "release-scan-failed",
      message: "Canonical evaluation derivation failed closed.",
    });
    expect(capturedUpdates).toHaveLength(0);
  });

  it("fails before normalization when the trusted decoder leaks an extra top-level field", async () => {
    const value = fixture("validation");
    const leaked = {
      ...value.decodedEvaluation,
      taskName: SECRET_LITERAL,
    } as unknown as TrustedDecodedEvaluation;

    await expect(
      deriver(leaked, value.derivationPolicy).derive({
        request: value.evaluationRequest,
        panel: value.hiddenPanel,
        schedule: value.schedule,
        rawRun: value.raw,
      }),
    ).rejects.toMatchObject({
      code: "decode-failed",
      message: "Canonical evaluation derivation failed closed.",
    });
  });
});
