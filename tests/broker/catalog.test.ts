import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DurableTrustedHiddenCatalog,
  TRUSTED_HIDDEN_SELECTION_POLICY_HASH,
  TrustedHiddenCatalogError,
  type LinearizableHiddenCatalogCasStore,
  type TrustedHiddenCatalogState,
  type TrustedHiddenTaskSeed,
} from "../../src/broker/catalog.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  hashTrustedHiddenCatalogOutcomeSet,
  hashTrustedHiddenCatalogSourceBinding,
  type TrustedSignedHiddenCatalogOutcomeUpdate,
} from "../../src/evaluator/deriver.js";
import {
  allocateValidationQuotas,
  initialValidationQuotaCarry,
} from "../../src/evaluation/selection.js";
import type {
  HiddenTaskEstimates,
  SelectionBucket,
} from "../../src/evaluation/types.js";
import { canonicalHash, canonicalJson } from "../../src/schemas/canonical.js";
import type { TerminalBench21Pin } from "../../src/terminal-bench/pin.js";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const WEIGHTING_POLICY_HASH = TRUSTED_HIDDEN_SELECTION_POLICY_HASH;
const TASK_ID_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const SECOND_TASK_ID_SECRET = Uint8Array.from(
  { length: 32 },
  (_, index) => 64 + index,
);
const DISPOSITION_SECRET = Uint8Array.from(
  { length: 32 },
  (_, index) => 128 + index,
);

const pin: TerminalBench21Pin = {
  benchmark: "terminal-bench-2.1",
  dataset: "terminal-bench/terminal-bench-2-1",
  registryRevision: 6,
  taskCount: 89,
  datasetContentSha256: "1".repeat(64),
  datasetManifestSha256: "2".repeat(64),
  harborVersion: "0.20.0",
  harborPackageSha256: "3".repeat(64),
  harborExecutableSha256: "4".repeat(64),
  piHarborAdapterSha256: "5".repeat(64),
};

const estimates: HiddenTaskEstimates = {
  championFailureProbability: 0.6,
  baselineFailureProbability: 0.55,
  leaderboardFailureProbability: 0.5,
  recentFailureProbability: 0.6,
  outcomeUncertainty: 0.7,
  discrimination: 0.7,
  componentRelevance: 0.6,
  underexposure: 0.5,
  missingCapabilityCoverage: 0.4,
  normalizedCost: 0.2,
  impossibleProbability: 0.05,
};

class AtomicMemoryCatalogStore implements LinearizableHiddenCatalogCasStore {
  state: TrustedHiddenCatalogState | null = null;
  throwAfterNextCommit = false;

  async transact<Result>(
    operation: (
      state: TrustedHiddenCatalogState | null,
    ) => {
      readonly next: TrustedHiddenCatalogState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transaction = operation(this.state);
    this.state = transaction.next;
    if (this.throwAfterNextCommit) {
      this.throwAfterNextCommit = false;
      throw new Error("synthetic provider response loss");
    }
    return transaction.result;
  }
}

function taskSeeds(): readonly TrustedHiddenTaskSeed[] {
  const cycle: readonly SelectionBucket[] = [
    "hard",
    "hard",
    "hard",
    "hard",
    "hard",
    "hard",
    "uncertain",
    "uncertain",
    "easy",
    "coverage",
  ];
  return Array.from({ length: 89 }, (_, index) => {
    const failureOverrides =
      index === 0
        ? {
            championFailureProbability: 1,
            baselineFailureProbability: 1,
            leaderboardFailureProbability: 1,
            recentFailureProbability: 1,
          }
        : index === 1
          ? {
              championFailureProbability: 0,
              baselineFailureProbability: 0,
              leaderboardFailureProbability: 0,
              recentFailureProbability: 0,
            }
          : {};
    return {
      packageTaskName: `terminal-bench/task-${String(index + 1).padStart(3, "0")}`,
      taskRevisionDigest: (index + 1).toString(16).padStart(64, "0"),
      capabilityStratum: `capability-${index % 7}`,
      difficultyStratum: index % 3 === 0 ? "difficult" : "moderate",
      buckets: [cycle[index % cycle.length] ?? "hard"],
      estimates: { ...estimates, ...failureOverrides },
      // The first balanced ten-task cohort represents previously released
      // baseline feedback. Priors alone do not set this bit.
      initialFeedbackReleased: index < 10,
      regressionCanary: index === 8,
      infrastructureValid: true,
      discriminating: true,
    };
  });
}

function nonceFactory(start = 1): () => Uint8Array {
  let value = start;
  return () => {
    const bytes = new Uint8Array(32);
    bytes.fill(value);
    value += 1;
    return bytes;
  };
}

function catalog(
  store: LinearizableHiddenCatalogCasStore,
  overrides: Partial<{
    readonly datasetPin: TerminalBench21Pin;
    readonly expectedDatasetPinHash: string;
    readonly seeds: readonly TrustedHiddenTaskSeed[];
    readonly taskIdKeyId: string;
    readonly taskIdSecret: Uint8Array;
    readonly dispositionKeyId: string;
    readonly dispositionSecret: Uint8Array;
    readonly nonce: () => Uint8Array;
    readonly outcomeVerifier: {
      verify(update: TrustedSignedHiddenCatalogOutcomeUpdate): Promise<boolean>;
    };
  }> = {},
): DurableTrustedHiddenCatalog {
  const datasetPin = overrides.datasetPin ?? pin;
  return new DurableTrustedHiddenCatalog({
    store,
    datasetPin,
    expectedDatasetPinHash:
      overrides.expectedDatasetPinHash ?? canonicalHash(datasetPin),
    taskSeeds: overrides.seeds ?? taskSeeds(),
    taskIdKey: {
      keyId: overrides.taskIdKeyId ?? "hidden-task-key-1",
      secret: overrides.taskIdSecret ?? TASK_ID_SECRET,
    },
    expectedTaskIdKeyId: overrides.taskIdKeyId ?? "hidden-task-key-1",
    dispositionKey: {
      keyId: overrides.dispositionKeyId ?? "panel-disposition-key-1",
      secret: overrides.dispositionSecret ?? DISPOSITION_SECRET,
    },
    expectedDispositionKeyId:
      overrides.dispositionKeyId ?? "panel-disposition-key-1",
    outcomeVerifier: overrides.outcomeVerifier ?? {
      verify: async () => true,
    },
    weightingPolicyHash: WEIGHTING_POLICY_HASH,
    now: () => new Date("2026-07-01T00:00:00.000Z"),
    nonceFactory: overrides.nonce ?? nonceFactory(),
  });
}

function artifact(index: number) {
  const digit = ((index % 9) + 1).toString();
  return {
    uri: `trusted://harness/artifact-${index}` as const,
    commitSha: digit.repeat(40),
    treeSha: digit.repeat(40),
    archiveSha256: index.toString(16).padStart(64, digit),
  };
}

function request(
  stage: "repair" | "validation" | "shadow",
  index: number,
  options: {
    readonly candidate?: ReturnType<typeof artifact>;
    readonly shadowSlice?: 1 | 2;
  } = {},
): TrustedEvaluationRequest {
  const candidate = options.candidate ?? artifact(index + 1);
  const selection =
    stage === "repair"
      ? ({
          kind: "repair-reuse",
          sourceExperimentId: `${Math.max(0, index - 1)}-source`,
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
            weightingPolicyHash: WEIGHTING_POLICY_HASH,
            hypothesisExclusionAttestationHash: "d".repeat(64),
          } as const)
        : ({
            kind: "fresh-shadow",
            taskCount: 12,
            attemptsPerTask: 1,
            shadowSlice: options.shadowSlice ?? 1,
            feedback: "disabled",
          } as const);
  return {
    schemaVersion: 1,
    requestId: `request-${stage}-${index}`,
    experimentId: `${index}-catalog`,
    runMode: "research",
    stage,
    submittedAt: "2026-06-30T23:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH,
    complianceManifestHash: SECOND_HASH,
    candidate,
    champion: artifact(9),
    selection,
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"e".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: "f".repeat(64),
      protocolHash: HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function allocation(
  store: AtomicMemoryCatalogStore,
  requestHash: string,
) {
  const record = store.state?.allocations[requestHash];
  if (record === undefined) {
    throw new Error("Synthetic trusted allocation fixture is absent");
  }
  return record;
}

function requiredState(
  store: AtomicMemoryCatalogStore,
): TrustedHiddenCatalogState {
  if (store.state === null) {
    throw new Error("Synthetic trusted catalog state is absent");
  }
  return store.state;
}

function outcomeUpdate(
  record: ReturnType<typeof allocation>,
  options: {
    readonly candidatePass?: boolean;
    readonly championPass?: boolean;
    readonly sourceSuffix?: string;
  } = {},
): TrustedSignedHiddenCatalogOutcomeUpdate {
  const candidatePass = options.candidatePass ?? false;
  const championPass = options.championPass ?? true;
  const suffix = options.sourceSuffix ?? "1";
  const outcomes = record.panel.cells.map((cell, index) => {
    const arm = (pass: boolean, offset: number) => ({
      pass,
      boundedReward: pass ? 1 : 0,
      infrastructureValid: true as const,
      infrastructureInvalidAttemptCount: 0,
      latencyMs: 10_000 + index,
      inputTokens: 1_000,
      outputTokens: 500,
      modelUsd: 0.1,
      sandboxUsd: 0.02,
      finalAttemptDigest: createHash("sha256")
        .update(`${suffix}:${index}:${offset}`)
        .digest("hex"),
    });
    return {
      taskId: cell.taskId,
      taskRevisionDigest: cell.taskRevisionDigest,
      capabilityStratum: cell.capabilityStratum,
      order: cell.order,
      candidate: arm(candidatePass, 1),
      champion:
        record.panel.stage === "repair"
          ? null
          : arm(championPass, 2),
    };
  });
  const updateSetHash = hashTrustedHiddenCatalogOutcomeSet(outcomes);
  const source = {
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    stage: record.panel.stage,
    dispositionAttestationHash:
      record.panel.dispositionAttestationHash,
    rawManifestHash: suffix.repeat(64),
    jobSha256: "2".repeat(64),
    runtimeAttestationHash: "3".repeat(64),
    normalizedOutcomeSetHash: "4".repeat(64),
    environmentFingerprintHash: "5".repeat(64),
    updateSetHash,
  } as const;
  const sourceBindingHash =
    hashTrustedHiddenCatalogSourceBinding(source);
  return {
    sensitivity: "trusted-hidden-catalog-outcome-update",
    schemaVersion: 1,
    updateId: `catalog-${sourceBindingHash.slice(0, 48)}`,
    ...source,
    observedAt: "2026-07-01T00:30:00.000Z",
    outcomes,
    sourceBindingHash,
    signature: {
      algorithm: "ed25519",
      keyId: "hidden-outcome-key-1",
      signedAt: "2026-07-01T00:31:00.000Z",
      signature: "A".repeat(86),
    },
  };
}

describe("durable trusted hidden-task catalog", () => {
  it("imports exactly 89 revision-6 seeds and pre-reserves disjoint shadow slices", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    const health = await brokerCatalog.initialize();

    expect(health).toMatchObject({
      sensitivity: "release-safe",
      benchmark: "terminal-bench-2.1",
      datasetPinHash: canonicalHash(pin),
      taskCount: 89,
      catalogIntegrity: "passed",
      shadowReservedSliceCount: 2,
      shadowRemainingSliceCount: 2,
      containsTaskNames: false,
      containsTaskIdentifiers: false,
      containsPanelHandles: false,
    });
    const state = requiredState(store);
    expect(state.taskOrder).toHaveLength(89);
    const first = new Set(state.shadowSlices[0].taskIds);
    const second = new Set(state.shadowSlices[1].taskIds);
    expect(first.size).toBe(12);
    expect(second.size).toBe(12);
    expect([...first].some((taskId) => second.has(taskId))).toBe(false);
    expect(
      state.taskOrder.filter(
        (taskId) => state.tasks[taskId]?.shadowReserved,
      ),
    ).toHaveLength(24);
    expect(
      state.taskOrder.every((taskId) => {
        const task = state.tasks[taskId];
        return (
          task?.datasetPinHash === canonicalHash(pin) &&
          task.registryRevision === 6
        );
      }),
    ).toBe(true);
    const afterFirstShadow = allocateValidationQuotas(
      initialValidationQuotaCarry(),
    ).nextCarry;
    expect(state.validationCarry).toEqual(
      allocateValidationQuotas(afterFirstShadow).nextCarry,
    );
  });

  it("rejects non-89 imports, duplicate revisions, pin drift, and key-ID drift", () => {
    expect(() =>
      catalog(new AtomicMemoryCatalogStore(), {
        seeds: taskSeeds().slice(0, 88),
      }),
    ).toThrow(TrustedHiddenCatalogError);

    const duplicateRevision = taskSeeds().map((seed, index, all) =>
      index === 1
        ? {
            ...seed,
            taskRevisionDigest: all[0]?.taskRevisionDigest ?? seed.taskRevisionDigest,
          }
        : seed,
    );
    expect(() =>
      catalog(new AtomicMemoryCatalogStore(), {
        seeds: duplicateRevision,
      }),
    ).toThrow(TrustedHiddenCatalogError);

    expect(() =>
      catalog(new AtomicMemoryCatalogStore(), {
        datasetPin: { ...pin, registryRevision: 7 },
      }),
    ).toThrow(TrustedHiddenCatalogError);
    expect(() =>
      catalog(new AtomicMemoryCatalogStore(), {
        expectedDatasetPinHash: "0".repeat(64),
      }),
    ).toThrow(TrustedHiddenCatalogError);

    expect(
      () =>
        new DurableTrustedHiddenCatalog({
          store: new AtomicMemoryCatalogStore(),
          datasetPin: pin,
          expectedDatasetPinHash: canonicalHash(pin),
          taskSeeds: taskSeeds(),
          taskIdKey: {
            keyId: "unexpected-key",
            secret: TASK_ID_SECRET,
          },
          expectedTaskIdKeyId: "hidden-task-key-1",
          dispositionKey: {
            keyId: "panel-disposition-key-1",
            secret: DISPOSITION_SECRET,
          },
          expectedDispositionKeyId: "panel-disposition-key-1",
          outcomeVerifier: {
            verify: async () => true,
          },
          weightingPolicyHash: WEIGHTING_POLICY_HASH,
        }),
    ).toThrow(TrustedHiddenCatalogError);
    expect(
      () =>
        new DurableTrustedHiddenCatalog({
          store: new AtomicMemoryCatalogStore(),
          datasetPin: pin,
          expectedDatasetPinHash: canonicalHash(pin),
          taskSeeds: taskSeeds(),
          taskIdKey: {
            keyId: "hidden-task-key-1",
            secret: TASK_ID_SECRET,
          },
          expectedTaskIdKeyId: "hidden-task-key-1",
          dispositionKey: {
            keyId: "panel-disposition-key-1",
            secret: DISPOSITION_SECRET,
          },
          expectedDispositionKeyId: "panel-disposition-key-1",
          outcomeVerifier: {
            verify: async () => true,
          },
          weightingPolicyHash: "0".repeat(64),
        }),
    ).toThrow(TrustedHiddenCatalogError);
  });

  it("uses keyed, key-separated HMAC task identities rather than plain hashes", async () => {
    const firstStore = new AtomicMemoryCatalogStore();
    const secondStore = new AtomicMemoryCatalogStore();
    const thirdStore = new AtomicMemoryCatalogStore();
    await catalog(firstStore).initialize();
    await catalog(secondStore, {
      taskIdKeyId: "hidden-task-key-2",
      taskIdSecret: TASK_ID_SECRET,
    }).initialize();
    await catalog(thirdStore, {
      taskIdKeyId: "hidden-task-key-1",
      taskIdSecret: SECOND_TASK_ID_SECRET,
    }).initialize();

    expect(firstStore.state?.taskOrder).not.toEqual(secondStore.state?.taskOrder);
    expect(firstStore.state?.taskOrder).not.toEqual(thirdStore.state?.taskOrder);
    const firstSeed = taskSeeds()[0];
    if (firstSeed === undefined) throw new Error("Synthetic seed missing");
    const unkeyed = createHash("sha256")
      .update(
        canonicalJson({
          domain: "dark-factory/hidden-task-id/v1",
          keyId: "hidden-task-key-1",
          datasetPin: pin,
          packageTaskName: firstSeed.packageTaskName,
          taskRevisionDigest: firstSeed.taskRevisionDigest,
        }),
      )
      .digest("hex");
    expect(firstStore.state?.taskOrder).not.toContain(unkeyed);
  });

  it("weights prior failures strongly while retaining the alternating easy canary", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();

    const firstRequest = request("repair", 10);
    const firstHash = hashEvaluationRequest(firstRequest);
    const firstPanel = await brokerCatalog.allocateAndConsume(
      firstRequest,
      firstHash,
      "claim-repair-10",
    );
    const firstNames = firstPanel.cells.map(
      (cell) => store.state?.tasks[cell.taskId]?.packageTaskName,
    );
    expect(JSON.stringify(firstPanel)).not.toContain("terminal-bench/task-");
    expect(firstNames).toContain("terminal-bench/task-001");
    expect(firstNames).not.toContain("terminal-bench/task-002");
    expect(allocation(store, firstHash).selectedBuckets).toEqual([
      "hard",
      "hard",
      "hard",
      "uncertain",
      "easy",
    ]);
    expect(allocation(store, firstHash)).toMatchObject({
      datasetPinHash: canonicalHash(pin),
      registryRevision: 6,
    });
    expect(JSON.stringify(allocation(store, firstHash))).not.toContain(
      "terminal-bench/task-",
    );

    const secondRequest = request("repair", 11);
    const secondHash = hashEvaluationRequest(secondRequest);
    await brokerCatalog.allocateAndConsume(
      secondRequest,
      secondHash,
      "claim-repair-11",
    );
    expect(allocation(store, secondHash).selectedBuckets).toEqual([
      "hard",
      "hard",
      "hard",
      "uncertain",
      "coverage",
    ]);
  });

  it("allocates fresh hypothesis-disjoint validation with exact balanced AB/BA order", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const candidate = artifact(2);
    const repairRequest = request("repair", 20, { candidate });
    const repairHash = hashEvaluationRequest(repairRequest);
    const repairPanel = await brokerCatalog.allocateAndConsume(
      repairRequest,
      repairHash,
      "claim-hypothesis-repair",
    );
    const validationRequest = request("validation", 21, { candidate });
    const validationHash = hashEvaluationRequest(validationRequest);
    const carryBeforeValidation = requiredState(store).validationCarry;
    const validationPanel = await brokerCatalog.allocateAndConsume(
      validationRequest,
      validationHash,
      "claim-hypothesis-validation",
    );

    expect(validationPanel.cells).toHaveLength(12);
    expect(
      validationPanel.cells.filter((cell) => cell.order === "AB"),
    ).toHaveLength(6);
    expect(
      validationPanel.cells.filter((cell) => cell.order === "BA"),
    ).toHaveLength(6);
    const repairIds = new Set(repairPanel.cells.map((cell) => cell.taskId));
    expect(
      validationPanel.cells.some((cell) => repairIds.has(cell.taskId)),
    ).toBe(false);
    for (const cell of validationPanel.cells) {
      expect(store.state?.tasks[cell.taskId]?.exposure).toMatchObject({
        feedbackReleased: true,
        positiveValidationConsumed: true,
      });
    }
    expect(
      allocation(store, repairHash).panel.dispositionAttestationHash,
    ).toMatch(/^[a-f0-9]{64}$/u);
    expect(requiredState(store).validationCarry).toEqual(
      allocateValidationQuotas(carryBeforeValidation).nextCarry,
    );
  });

  it("makes request-hash and claim-token replay idempotent and conflicts fail closed", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const evaluationRequest = request("repair", 30);
    const requestHash = hashEvaluationRequest(evaluationRequest);
    const first = await brokerCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-idempotent",
    );
    const revision = store.state?.revision;
    const replay = await brokerCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-idempotent",
    );
    expect(replay).toEqual(first);
    expect(store.state?.revision).toBe(revision);

    await expect(
      brokerCatalog.allocateAndConsume(
        evaluationRequest,
        requestHash,
        "claim-different",
      ),
    ).rejects.toMatchObject({ code: "allocation-conflict" });

    const otherRequest = request("repair", 31);
    await expect(
      brokerCatalog.allocateAndConsume(
        otherRequest,
        hashEvaluationRequest(otherRequest),
        "claim-idempotent",
      ),
    ).rejects.toMatchObject({ code: "allocation-conflict" });
  });

  it("recovers an ambiguous post-commit cloud failure without double consumption", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const evaluationRequest = request("repair", 40);
    const requestHash = hashEvaluationRequest(evaluationRequest);
    store.throwAfterNextCommit = true;
    await expect(
      brokerCatalog.allocateAndConsume(
        evaluationRequest,
        requestHash,
        "claim-ambiguous-commit",
      ),
    ).rejects.toMatchObject({ code: "store-failed" });
    const committed = allocation(store, requestHash).panel;
    const totalsAfterCommit = committed.cells.map(
      (cell) => store.state?.tasks[cell.taskId]?.exposure.total,
    );
    const revisionAfterCommit = store.state?.revision;

    const recovered = await brokerCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-ambiguous-commit",
    );
    expect(recovered).toEqual(committed);
    expect(store.state?.revision).toBe(revisionAfterCommit);
    expect(
      recovered.cells.map(
        (cell) => store.state?.tasks[cell.taskId]?.exposure.total,
      ),
    ).toEqual(totalsAfterCommit);
  });

  it("consumes each pre-reserved shadow slice once and keeps the slices disjoint", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const firstRequest = request("shadow", 50, { shadowSlice: 1 });
    const secondRequest = request("shadow", 51, { shadowSlice: 2 });
    const first = await brokerCatalog.allocateAndConsume(
      firstRequest,
      hashEvaluationRequest(firstRequest),
      "claim-shadow-1",
    );
    const second = await brokerCatalog.allocateAndConsume(
      secondRequest,
      hashEvaluationRequest(secondRequest),
      "claim-shadow-2",
    );
    const firstIds = new Set(first.cells.map((cell) => cell.taskId));
    expect(firstIds.size).toBe(12);
    expect(second.cells).toHaveLength(12);
    expect(second.cells.some((cell) => firstIds.has(cell.taskId))).toBe(false);
    expect(first.cells.filter((cell) => cell.order === "AB")).toHaveLength(6);
    expect(second.cells.filter((cell) => cell.order === "BA")).toHaveLength(6);
    expect(
      (await brokerCatalog.releaseSafeHealthAttestation())
        .shadowRemainingSliceCount,
    ).toBe(0);

    const exhausted = request("shadow", 52, { shadowSlice: 1 });
    await expect(
      brokerCatalog.allocateAndConsume(
        exhausted,
        hashEvaluationRequest(exhausted),
        "claim-shadow-exhausted",
      ),
    ).rejects.toMatchObject({ code: "allocation-exhausted" });
  });

  it("uses a fresh nonce-bound keyed disposition even for identical task selection", async () => {
    const firstStore = new AtomicMemoryCatalogStore();
    const secondStore = new AtomicMemoryCatalogStore();
    const firstCatalog = catalog(firstStore, { nonce: nonceFactory(1) });
    const secondCatalog = catalog(secondStore, { nonce: nonceFactory(100) });
    await firstCatalog.initialize();
    await secondCatalog.initialize();
    const evaluationRequest = request("repair", 60);
    const requestHash = hashEvaluationRequest(evaluationRequest);
    const first = await firstCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-same",
    );
    const second = await secondCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-same",
    );
    expect(first.cells).toEqual(second.cells);
    expect(first.dispositionAttestationHash).not.toBe(
      second.dispositionAttestationHash,
    );
    expect(first.leaseId).not.toBe(second.leaseId);
  });

  it("atomically turns signed matched outcomes into reproducible failure weights", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const evaluationRequest = request("validation", 70);
    const requestHash = hashEvaluationRequest(evaluationRequest);
    await brokerCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-outcome-weighting",
    );
    const record = allocation(store, requestHash);
    const before = record.panel.cells.map((cell) => {
      const task = requiredState(store).tasks[cell.taskId];
      if (task === undefined) throw new Error("Synthetic task missing");
      return {
        taskId: cell.taskId,
        champion: task.estimates.championFailureProbability,
        recent: task.estimates.recentFailureProbability,
      };
    });
    const revisionBefore = requiredState(store).revision;
    const update = outcomeUpdate(record, {
      candidatePass: false,
      championPass: false,
    });
    const receipt = await brokerCatalog.commit(update);

    expect(receipt).toEqual({
      status: "committed",
      updateId: update.updateId,
      sourceBindingHash: update.sourceBindingHash,
    });
    expect(requiredState(store).revision).toBe(revisionBefore + 1);
    for (const prior of before) {
      const task = requiredState(store).tasks[prior.taskId];
      expect(task?.outcomeStats.candidateFailureCount).toBe(1);
      expect(task?.outcomeStats.championFailureCount).toBe(1);
      expect(task?.estimates.championFailureProbability).toBeGreaterThan(
        prior.champion,
      );
      expect(task?.estimates.recentFailureProbability).toBeGreaterThan(
        prior.recent,
      );
    }
    expect(
      JSON.stringify(
        await brokerCatalog.releaseSafeHealthAttestation(),
      ),
    ).not.toContain(record.panel.cells[0]?.taskId);
  });

  it("makes outcome ingestion idempotent and rejects conflicting, detached, or unsigned updates", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    await brokerCatalog.initialize();
    const evaluationRequest = request("repair", 71);
    const requestHash = hashEvaluationRequest(evaluationRequest);
    await brokerCatalog.allocateAndConsume(
      evaluationRequest,
      requestHash,
      "claim-outcome-idempotency",
    );
    const record = allocation(store, requestHash);
    const update = outcomeUpdate(record);
    await brokerCatalog.commit(update);
    const revision = requiredState(store).revision;
    await expect(brokerCatalog.commit(update)).resolves.toMatchObject({
      status: "already-committed",
    });
    expect(requiredState(store).revision).toBe(revision);

    await expect(
      brokerCatalog.commit({
        ...update,
        sourceBindingHash: "f".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "outcome-conflict" });
    const detached = outcomeUpdate(record, { sourceSuffix: "6" });
    await expect(
      brokerCatalog.commit({
        ...detached,
        outcomes: detached.outcomes.map((outcome, index) =>
          index === 0
            ? {
                ...outcome,
                taskRevisionDigest: "9".repeat(64),
              }
            : outcome,
        ),
      }),
    ).rejects.toMatchObject({ code: "outcome-conflict" });

    const rejectedStore = new AtomicMemoryCatalogStore();
    const rejectingCatalog = catalog(rejectedStore, {
      outcomeVerifier: {
        verify: async () => false,
      },
    });
    await rejectingCatalog.initialize();
    const rejectedRequest = request("repair", 72);
    const rejectedHash = hashEvaluationRequest(rejectedRequest);
    await rejectingCatalog.allocateAndConsume(
      rejectedRequest,
      rejectedHash,
      "claim-bad-signature",
    );
    await expect(
      rejectingCatalog.commit(
        outcomeUpdate(allocation(rejectedStore, rejectedHash)),
      ),
    ).rejects.toMatchObject({ code: "outcome-invalid" });
  });

  it("resolves names only through the trusted resolver and releases no names in health or errors", async () => {
    const store = new AtomicMemoryCatalogStore();
    const brokerCatalog = catalog(store);
    const health = await brokerCatalog.initialize();
    const trustedTask = store.state?.taskOrder[0];
    if (trustedTask === undefined) throw new Error("Synthetic task missing");
    const revision = store.state?.tasks[trustedTask]?.taskRevisionDigest;
    if (revision === undefined) throw new Error("Synthetic revision missing");

    const resolved = await brokerCatalog.resolve(trustedTask, revision);
    expect(resolved.sensitivity).toBe("trusted-hidden-task-resolution");
    expect(resolved.packageTaskName).toMatch(/^terminal-bench\/task-/u);
    expect(JSON.stringify(health)).not.toContain("terminal-bench/task-");
    expect(health).not.toHaveProperty("tasks");
    expect(health).not.toHaveProperty("allocations");

    let message = "";
    try {
      await brokerCatalog.resolve(
        "f".repeat(64) as typeof trustedTask,
        revision,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(resolved.packageTaskName);
    expect(message).not.toContain("task-");
    expect(message).toBe("Trusted hidden-task resolution failed closed.");
  });
});
