import { describe, expect, it } from "vitest";

import { createOnlineErrorBudget } from "../../src/evaluation/statistics.js";
import {
  DurableTrustedOnlineErrorBudgetAuthority,
  TrustedOnlineErrorBudgetError,
  assertDurableOnlineErrorBudgetState,
  assertTrustedOnlineErrorBudgetReconciliation,
  assertTrustedOnlineErrorBudgetReservation,
  createDurableOnlineErrorBudgetState,
  onlineErrorBudgetCampaignIdHash,
  type DurableOnlineErrorBudgetState,
  type TrustedOnlineErrorBudgetCasStore,
} from "../../src/evaluator/online-error-authority.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";

const CAMPAIGN_ID = "campaign-online-error-authority-test";
const CAMPAIGN_HASH =
  onlineErrorBudgetCampaignIdHash(CAMPAIGN_ID);
const DISPOSITION_HASH = "b".repeat(64);
const INITIAL = createOnlineErrorBudget(
  0.05,
  "null-calibration-v1",
);

function request(ordinal: number): TrustedEvaluationRequest {
  const suffix = ordinal.toString().padStart(3, "0");
  return {
    schemaVersion: 1,
    requestId: `online-look-${suffix}`,
    experimentId: `${suffix}-online-look`,
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: "c".repeat(64),
    complianceManifestHash: "d".repeat(64),
    candidate: {
      uri: `trusted://harness/candidate-${suffix}`,
      commitSha: ordinal.toString(16).padStart(40, "0"),
      treeSha: (ordinal + 1).toString(16).padStart(40, "0"),
      archiveSha256: (ordinal + 1).toString(16).padStart(64, "0"),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "e".repeat(40),
      treeSha: "e".repeat(40),
      archiveSha256: "e".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "f".repeat(64),
      frozenHypothesisHash: "1".repeat(64),
      hypothesisExclusionAttestationHash: "2".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"3".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: "4".repeat(64),
      protocolHash: "c".repeat(64),
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "evaluated-model",
      thinkingLevel: "high",
    },
  };
}

class AtomicMemoryCasStore implements TrustedOnlineErrorBudgetCasStore {
  readonly boundary = "trusted-cloud" as const;
  state = createDurableOnlineErrorBudgetState({
    campaignIdHash: CAMPAIGN_HASH,
    initialBudget: INITIAL,
  });
  conflictsRemaining = 0;
  alwaysConflict = false;

  read(): Promise<DurableOnlineErrorBudgetState> {
    return Promise.resolve(structuredClone(this.state));
  }

  compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly next: DurableOnlineErrorBudgetState;
  }): Promise<boolean> {
    if (this.alwaysConflict) return Promise.resolve(false);
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      return Promise.resolve(false);
    }
    if (this.state.revision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    assertDurableOnlineErrorBudgetState(input.next);
    this.state = structuredClone(input.next);
    return Promise.resolve(true);
  }
}

function authority(
  store = new AtomicMemoryCasStore(),
  maximumCasAttempts = 32,
) {
  return {
    store,
    authority: new DurableTrustedOnlineErrorBudgetAuthority({
      store,
      campaignIdHash: CAMPAIGN_HASH,
      initialBudget: INITIAL,
      now: () => new Date("2026-07-01T00:00:30.000Z"),
      maximumCasAttempts,
    }),
  };
}

function reserveInput(evaluationRequest: TrustedEvaluationRequest) {
  return {
    request: evaluationRequest,
    requestHash: hashEvaluationRequest(evaluationRequest),
    dispositionAttestationHash: DISPOSITION_HASH,
  } as const;
}

describe("trusted online sequential-error authority", () => {
  it("derives one domain-separated campaign scope from a safe campaign ID", () => {
    expect(onlineErrorBudgetCampaignIdHash(CAMPAIGN_ID)).toBe(
      CAMPAIGN_HASH,
    );
    expect(
      onlineErrorBudgetCampaignIdHash("another-campaign"),
    ).not.toBe(CAMPAIGN_HASH);
    expect(() =>
      onlineErrorBudgetCampaignIdHash("../unsafe-campaign"),
    ).toThrow(TrustedOnlineErrorBudgetError);
  });

  it("is idempotent for one immutable validation request", async () => {
    const value = authority();
    const input = reserveInput(request(1));
    const first = await value.authority.reserve(input);
    const replay = await value.authority.reserve(input);

    expect(replay).toEqual(first);
    expect(value.store.state.revision).toBe(1);
    expect(value.store.state.current.spentAlpha).toBe(
      first.accounting.cumulativeSpentAfter,
    );
    expect(first.accounting.alphaSpent).toBeGreaterThan(0);
  });

  it("linearizes concurrent distinct reservations and retries a CAS conflict", async () => {
    const value = authority();
    value.store.conflictsRemaining = 1;
    const [first, second] = await Promise.all([
      value.authority.reserve(reserveInput(request(1))),
      value.authority.reserve(reserveInput(request(2))),
    ]);

    expect(new Set([
      first.accounting.gateOrdinal,
      second.accounting.gateOrdinal,
    ])).toEqual(new Set([1, 2]));
    expect(value.store.state.revision).toBe(2);
    expect(value.store.state.current.spentAlpha).toBe(
      first.accounting.alphaSpent + second.accounting.alphaSpent,
    );
  });

  it("fails closed after bounded persistent CAS conflicts", async () => {
    const value = authority(new AtomicMemoryCasStore(), 3);
    value.store.alwaysConflict = true;
    await expect(
      value.authority.reserve(reserveInput(request(1))),
    ).rejects.toMatchObject({ code: "state-conflict" });
    expect(value.store.state.revision).toBe(0);
  });

  it("burns a reservation even if the outcome-bearing workload later fails", async () => {
    const value = authority();
    const reservation = await value.authority.reserve(
      reserveInput(request(1)),
    );
    await expect(
      Promise.reject(new Error("simulated provider failure")),
    ).rejects.toThrow(/provider failure/u);

    expect(value.store.state.revision).toBe(1);
    expect(value.store.state.current.spentAlpha).toBe(
      reservation.accounting.alphaSpent,
    );
    expect(
      value.store.state.reservations[reservation.requestHash],
    ).toEqual(reservation);
    const reconciliation = await value.authority.reconcile();
    expect(() =>
      assertTrustedOnlineErrorBudgetReconciliation(
        reconciliation,
        CAMPAIGN_ID,
      ),
    ).not.toThrow();
    expect(reconciliation.onlineErrorSpent).toBe(
      reservation.accounting.cumulativeSpentAfter,
    );
    expect(reconciliation.campaignIdHash).toBe(
      onlineErrorBudgetCampaignIdHash(CAMPAIGN_ID),
    );
    expect(() =>
      assertTrustedOnlineErrorBudgetReconciliation(
        reconciliation,
        "different-campaign",
      ),
    ).toThrow(TrustedOnlineErrorBudgetError);
    expect(() =>
      assertTrustedOnlineErrorBudgetReconciliation({
        ...reconciliation,
        durableStateCommitment: "f".repeat(64),
      }),
    ).toThrow(TrustedOnlineErrorBudgetError);
    expect(reconciliation.resultingStateHash).toBe(
      reservation.accounting.resultingStateHash,
    );
  });

  it("rejects replay mutation and reservation tampering", async () => {
    const value = authority();
    const original = request(1);
    const reservation = await value.authority.reserve(
      reserveInput(original),
    );
    const mutated = {
      ...original,
      candidate: {
        ...original.candidate,
        archiveSha256: "9".repeat(64),
      },
    };
    await expect(
      value.authority.reserve(reserveInput(mutated)),
    ).rejects.toMatchObject({ code: "request-conflict" });

    const tampered = {
      ...reservation,
      accounting: {
        ...reservation.accounting,
        alphaSpent: reservation.accounting.alphaSpent / 2,
      },
    };
    expect(() =>
      assertTrustedOnlineErrorBudgetReservation(tampered),
    ).toThrow(TrustedOnlineErrorBudgetError);
  });

  it("eventually refuses another look when the summable schedule is below the minimum", async () => {
    const value = authority();
    let exhausted = false;
    for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
      try {
        await value.authority.reserve(
          reserveInput(request(ordinal)),
        );
      } catch (error) {
        expect(error).toMatchObject({ code: "budget-exhausted" });
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
    const revision = value.store.state.revision;
    await expect(
      value.authority.reserve(reserveInput(request(revision + 2))),
    ).rejects.toMatchObject({ code: "budget-exhausted" });
    expect(value.store.state.revision).toBe(revision);
  });
});
