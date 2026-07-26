import { describe, expect, it } from "vitest";
import {
  claimValidationAttempt,
  createValidationAttemptLedger,
  createValidationAttemptReceipt,
  type HiddenValidationAttemptClaim,
  type HiddenValidationAttemptLedger,
  type HiddenValidationPairPlan,
  makeReleaseSafeTerminalValidationAttemptAccounting,
  recordValidationAttemptReceipt,
  validateValidationAttemptLedger,
  validationAttemptCompletion,
} from "../../src/evaluation/index.js";
import { digest, taskId } from "./fixtures.js";

const SEALED_AT = "2026-07-26T09:00:00.000Z";
const CLAIMED_AT = "2026-07-26T09:01:00.000Z";
const OBSERVED_AT = "2026-07-26T09:02:00.000Z";

function pairs(): readonly HiddenValidationPairPlan[] {
  return Array.from({ length: 12 }, (_, index) => ({
    taskId: taskId(index + 1),
    taskRevisionDigest: digest(index + 101),
    armOrder: index % 2 === 0 ? "AB" : "BA",
  }));
}

function ledger(): HiddenValidationAttemptLedger {
  return createValidationAttemptLedger({
    panelBindingDigest: digest(500),
    pairs: pairs(),
    sealedAt: SEALED_AT,
  });
}

function validReceipt(claim: HiddenValidationAttemptClaim, evidenceIndex: number) {
  return createValidationAttemptReceipt({
    attemptDigest: claim.attemptDigest,
    outcome: "valid",
    evidenceDigest: digest(evidenceIndex),
    observedAt: OBSERVED_AT,
  });
}

function completeLedger(): {
  readonly ledger: HiddenValidationAttemptLedger;
  readonly firstAttemptDigest: string;
} {
  let state = ledger();
  let firstAttemptDigest = "";
  for (let index = 0; index < 24; index += 1) {
    const claimed = claimValidationAttempt(state, {
      requestId: digest(1_000 + index),
      claimedAt: CLAIMED_AT,
    });
    if (index === 0) {
      firstAttemptDigest = claimed.claim.attemptDigest;
    }
    state = recordValidationAttemptReceipt(
      claimed.ledger,
      validReceipt(claimed.claim, 2_000 + index),
    ).ledger;
  }
  return { ledger: state, firstAttemptDigest };
}

describe("hidden validation attempt ledger", () => {
  it("preseals exactly twelve unique matched pairs and twenty-four arms", () => {
    const state = ledger();
    expect(state.cells).toHaveLength(24);
    expect(new Set(state.cells.map((cell) => cell.taskId))).toHaveProperty("size", 12);
    for (let pairOrdinal = 0; pairOrdinal < 12; pairOrdinal += 1) {
      const arms = state.cells
        .filter((cell) => cell.pairOrdinal === pairOrdinal)
        .map((cell) => cell.arm);
      expect(new Set(arms)).toEqual(new Set(["candidate", "champion"]));
    }

    expect(() =>
      createValidationAttemptLedger({
        panelBindingDigest: digest(500),
        pairs: pairs().slice(0, 11),
        sealedAt: SEALED_AT,
      }),
    ).toThrow(/exactly twelve/u);
    expect(() =>
      createValidationAttemptLedger({
        panelBindingDigest: digest(500),
        pairs: [...pairs().slice(0, 11), pairs()[0]!],
        sealedAt: SEALED_AT,
      }),
    ).toThrow(/exactly one presealed pair/u);
  });

  it("mints deterministic one-use claims and replays a crash without a new attempt", () => {
    const initial = ledger();
    const sameInitial = ledger();
    const input = { requestId: digest(1_000), claimedAt: CLAIMED_AT };
    const first = claimValidationAttempt(initial, input);
    const independentlyReproduced = claimValidationAttempt(sameInitial, input);
    expect(independentlyReproduced.claim.attemptDigest).toBe(first.claim.attemptDigest);

    const pendingReplay = claimValidationAttempt(first.ledger, input);
    expect(pendingReplay.replayed).toBe(true);
    expect(pendingReplay.providerAction).toBe("recover");
    expect(pendingReplay.claim.attemptDigest).toBe(first.claim.attemptDigest);
    expect(pendingReplay.ledger.revision).toBe(first.ledger.revision);

    const recorded = recordValidationAttemptReceipt(
      pendingReplay.ledger,
      validReceipt(pendingReplay.claim, 2_000),
    );
    const completedReplay = claimValidationAttempt(recorded.ledger, input);
    expect(completedReplay.replayed).toBe(true);
    expect(completedReplay.providerAction).toBe("none");
    expect(completedReplay.ledger.revision).toBe(recorded.ledger.revision);
  });

  it("handles exact duplicate receipts idempotently and rejects conflicting replay", () => {
    const claimed = claimValidationAttempt(ledger(), {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    const receipt = validReceipt(claimed.claim, 2_000);
    const first = recordValidationAttemptReceipt(claimed.ledger, receipt);
    const replay = recordValidationAttemptReceipt(first.ledger, receipt);
    expect(replay.replayed).toBe(true);
    expect(replay.ledger.revision).toBe(first.ledger.revision);

    const conflict = createValidationAttemptReceipt({
      attemptDigest: claimed.claim.attemptDigest,
      outcome: "valid",
      evidenceDigest: digest(2_001),
      observedAt: OBSERVED_AT,
    });
    expect(() => recordValidationAttemptReceipt(first.ledger, conflict)).toThrow(
      /conflicting receipt/u,
    );
  });

  it("permits a retry only after a trusted infrastructure-failure receipt", () => {
    const initial = claimValidationAttempt(ledger(), {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    const infrastructureFailure = createValidationAttemptReceipt({
      attemptDigest: initial.claim.attemptDigest,
      outcome: "infrastructure-failure",
      evidenceDigest: digest(2_000),
      observedAt: OBSERVED_AT,
    });
    const failed = recordValidationAttemptReceipt(initial.ledger, infrastructureFailure).ledger;
    const replacement = claimValidationAttempt(failed, {
      requestId: digest(1_001),
      claimedAt: OBSERVED_AT,
    });
    expect(replacement.claim.cellOrdinal).toBe(initial.claim.cellOrdinal);
    expect(replacement.claim.attemptOrdinal).toBe(2);
    expect(replacement.claim.kind).toBe("infrastructure-replacement");

    const repaired = recordValidationAttemptReceipt(
      replacement.ledger,
      validReceipt(replacement.claim, 2_001),
    ).ledger;
    const nextInitial = claimValidationAttempt(repaired, {
      requestId: digest(1_002),
      claimedAt: OBSERVED_AT,
    });
    expect(nextInitial.claim.cellOrdinal).not.toBe(initial.claim.cellOrdinal);
    expect(nextInitial.claim.kind).toBe("initial");
  });

  it("never retries a valid or non-infrastructure outcome", () => {
    const validClaim = claimValidationAttempt(ledger(), {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    const afterValid = recordValidationAttemptReceipt(
      validClaim.ledger,
      validReceipt(validClaim.claim, 2_000),
    ).ledger;
    const next = claimValidationAttempt(afterValid, {
      requestId: digest(1_001),
      claimedAt: OBSERVED_AT,
    });
    expect(next.claim.cellOrdinal).not.toBe(validClaim.claim.cellOrdinal);

    const failedClaim = claimValidationAttempt(ledger(), {
      requestId: digest(3_000),
      claimedAt: CLAIMED_AT,
    });
    const nonInfrastructureFailure = createValidationAttemptReceipt({
      attemptDigest: failedClaim.claim.attemptDigest,
      outcome: "non-infrastructure-failure",
      evidenceDigest: digest(4_000),
      observedAt: OBSERVED_AT,
    });
    const failed = recordValidationAttemptReceipt(
      failedClaim.ledger,
      nonInfrastructureFailure,
    ).ledger;
    expect(validationAttemptCompletion(failed)).toBe("incomplete");
    expect(() =>
      claimValidationAttempt(failed, {
        requestId: digest(3_001),
        claimedAt: OBSERVED_AT,
      }),
    ).toThrow(/incomplete validation ledger/u);
  });

  it("caps infrastructure replacements at four and terminates incomplete", () => {
    let claimed = claimValidationAttempt(ledger(), {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    let state = claimed.ledger;
    for (let failureIndex = 0; failureIndex < 5; failureIndex += 1) {
      state = recordValidationAttemptReceipt(
        state,
        createValidationAttemptReceipt({
          attemptDigest: claimed.claim.attemptDigest,
          outcome: "infrastructure-failure",
          evidenceDigest: digest(2_000 + failureIndex),
          observedAt: OBSERVED_AT,
        }),
      ).ledger;
      if (failureIndex < 4) {
        claimed = claimValidationAttempt(state, {
          requestId: digest(1_001 + failureIndex),
          claimedAt: OBSERVED_AT,
        });
        state = claimed.ledger;
        expect(claimed.claim.kind).toBe("infrastructure-replacement");
      }
    }

    expect(validationAttemptCompletion(state)).toBe("incomplete");
    expect(() =>
      claimValidationAttempt(state, {
        requestId: digest(1_100),
        claimedAt: OBSERVED_AT,
      }),
    ).toThrow(/incomplete validation ledger/u);
    const accounting = makeReleaseSafeTerminalValidationAttemptAccounting(state);
    expect(accounting.totalAttemptCount).toBe(5);
    expect(accounting.replacementAttemptCount).toBe(4);
    expect(accounting.infrastructureFailureCount).toBe(5);
  });

  it("can complete after exactly four infrastructure replacements", () => {
    let claimed = claimValidationAttempt(ledger(), {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    let state = claimed.ledger;
    for (let failureIndex = 0; failureIndex < 4; failureIndex += 1) {
      state = recordValidationAttemptReceipt(
        state,
        createValidationAttemptReceipt({
          attemptDigest: claimed.claim.attemptDigest,
          outcome: "infrastructure-failure",
          evidenceDigest: digest(2_000 + failureIndex),
          observedAt: OBSERVED_AT,
        }),
      ).ledger;
      claimed = claimValidationAttempt(state, {
        requestId: digest(1_001 + failureIndex),
        claimedAt: OBSERVED_AT,
      });
      state = claimed.ledger;
    }
    state = recordValidationAttemptReceipt(state, validReceipt(claimed.claim, 2_100)).ledger;
    for (let index = 1; index < 24; index += 1) {
      const next = claimValidationAttempt(state, {
        requestId: digest(1_100 + index),
        claimedAt: OBSERVED_AT,
      });
      state = recordValidationAttemptReceipt(
        next.ledger,
        validReceipt(next.claim, 2_100 + index),
      ).ledger;
    }

    const accounting = makeReleaseSafeTerminalValidationAttemptAccounting(state);
    expect(accounting).toMatchObject({
      terminalStatus: "complete",
      validArmCount: 24,
      totalAttemptCount: 28,
      replacementAttemptCount: 4,
      infrastructureFailureCount: 4,
    });
  });

  it("accepts out-of-order receipts for preclaimed arms and reaches exact completeness", () => {
    let state = ledger();
    const claims: HiddenValidationAttemptClaim[] = [];
    for (let index = 0; index < 24; index += 1) {
      const claimed = claimValidationAttempt(state, {
        requestId: digest(1_000 + index),
        claimedAt: CLAIMED_AT,
      });
      state = claimed.ledger;
      claims.push(claimed.claim);
    }
    expect(() =>
      claimValidationAttempt(state, {
        requestId: digest(1_100),
        claimedAt: CLAIMED_AT,
      }),
    ).toThrow(/already in flight/u);

    for (const [index, claim] of [...claims].reverse().entries()) {
      state = recordValidationAttemptReceipt(state, validReceipt(claim, 2_000 + index)).ledger;
    }
    expect(validationAttemptCompletion(state)).toBe("complete");
    expect(state.attempts).toHaveLength(24);
  });

  it("releases terminal aggregate counts and no hidden identifiers", () => {
    const completed = completeLedger();
    const accounting = makeReleaseSafeTerminalValidationAttemptAccounting(completed.ledger);
    expect(accounting).toMatchObject({
      terminalStatus: "complete",
      presealedPairCount: 12,
      presealedArmCount: 24,
      validArmCount: 24,
      attemptedArmCount: 24,
      unresolvedArmCount: 0,
      totalAttemptCount: 24,
      replacementAttemptCount: 0,
      containsPanelHandle: false,
      containsTaskIdentifiers: false,
      containsCellIdentifiers: false,
      containsAttemptIdentifiers: false,
      containsEvidenceIdentifiers: false,
    });
    const serialized = JSON.stringify(accounting);
    expect(serialized).not.toContain(taskId(1));
    expect(serialized).not.toContain(digest(500));
    expect(serialized).not.toContain(completed.firstAttemptDigest);
  });

  it("rejects unknown receipts, conflicting claim replay, and tampered revisions", () => {
    const initial = ledger();
    const claimed = claimValidationAttempt(initial, {
      requestId: digest(1_000),
      claimedAt: CLAIMED_AT,
    });
    expect(() =>
      recordValidationAttemptReceipt(
        claimed.ledger,
        createValidationAttemptReceipt({
          attemptDigest: digest(9_999),
          outcome: "valid",
          evidenceDigest: digest(2_000),
          observedAt: OBSERVED_AT,
        }),
      ),
    ).toThrow(/unknown attempt/u);
    expect(() =>
      claimValidationAttempt(claimed.ledger, {
        requestId: digest(1_000),
        claimedAt: "2026-07-26T09:01:01.000Z",
      }),
    ).toThrow(/cannot change its timestamp/u);
    expect(() =>
      validateValidationAttemptLedger({
        ...claimed.ledger,
        revision: claimed.ledger.revision + 1,
      }),
    ).toThrow(/revision accounting/u);
  });
});
