import { canonicalHash } from "../schemas/canonical.js";
import type { ArmOrder, HiddenTaskId } from "./types.js";

export const VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION =
  "validation-attempt-ledger-v1" as const;
export const PRESEALED_VALIDATION_PAIR_COUNT = 12 as const;
export const PRESEALED_VALIDATION_ARM_COUNT = 24 as const;
export const MAXIMUM_INFRASTRUCTURE_REPLACEMENTS = 4 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ValidationHarnessArm = "candidate" | "champion";
export type ValidationAttemptKind = "initial" | "infrastructure-replacement";
export type ValidationAttemptOutcome =
  | "valid"
  | "infrastructure-failure"
  | "non-infrastructure-failure";
export type ValidationAttemptCompletion =
  | "active"
  | "complete"
  | "draining-incomplete"
  | "incomplete";

/**
 * Broker-private pair material. Task identities and revisions must remain in
 * the trusted evaluation store and must never enter an optimizer release.
 */
export interface HiddenValidationPairPlan {
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly armOrder: ArmOrder;
}

export interface HiddenValidationCell {
  readonly ordinal: number;
  readonly pairOrdinal: number;
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly arm: ValidationHarnessArm;
}

export interface HiddenValidationAttemptReceipt {
  readonly receiptDigest: string;
  readonly attemptDigest: string;
  readonly outcome: ValidationAttemptOutcome;
  readonly evidenceDigest: string;
  readonly observedAt: string;
}

export interface HiddenValidationAttempt {
  readonly requestId: string;
  readonly attemptDigest: string;
  readonly cellOrdinal: number;
  readonly attemptOrdinal: number;
  readonly kind: ValidationAttemptKind;
  readonly claimedAt: string;
  readonly claimRevision: number;
  readonly receipt: HiddenValidationAttemptReceipt | null;
  readonly receiptRecordedRevision: number | null;
}

/**
 * Pure, durable-store-neutral state. A durable broker must persist transitions
 * with compare-and-swap on `revision` before executing a returned claim.
 */
export interface HiddenValidationAttemptLedger {
  readonly policyVersion: typeof VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION;
  readonly revision: number;
  readonly panelBindingDigest: string;
  readonly sealDigest: string;
  readonly sealedAt: string;
  readonly cells: readonly HiddenValidationCell[];
  readonly attempts: readonly HiddenValidationAttempt[];
}

export interface HiddenValidationAttemptClaim {
  readonly requestId: string;
  readonly attemptDigest: string;
  readonly cellOrdinal: number;
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly arm: ValidationHarnessArm;
  readonly attemptOrdinal: number;
  readonly kind: ValidationAttemptKind;
}

export interface ValidationAttemptClaimResult {
  readonly ledger: HiddenValidationAttemptLedger;
  readonly claim: HiddenValidationAttemptClaim;
  readonly replayed: boolean;
  /**
   * `recover` means query or resume the already-created provider execution by
   * attempt digest. It must never create a second execution.
   */
  readonly providerAction: "start-once" | "recover" | "none";
}

export interface ValidationAttemptReceiptResult {
  readonly ledger: HiddenValidationAttemptLedger;
  readonly replayed: boolean;
}

/**
 * This is the only attempt-ledger shape allowed to leave the trusted broker.
 * It intentionally contains aggregate counts, not task, panel, cell, attempt,
 * result, timestamp, or evidence identifiers.
 */
export interface ReleaseSafeTerminalValidationAttemptAccounting {
  readonly policyVersion: typeof VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION;
  readonly terminalStatus: "complete" | "incomplete";
  readonly presealedPairCount: 12;
  readonly presealedArmCount: 24;
  readonly validArmCount: number;
  readonly attemptedArmCount: number;
  readonly unresolvedArmCount: number;
  readonly totalAttemptCount: number;
  readonly replacementAttemptCount: number;
  readonly infrastructureFailureCount: number;
  readonly nonInfrastructureFailureCount: number;
  readonly containsPanelHandle: false;
  readonly containsTaskIdentifiers: false;
  readonly containsCellIdentifiers: false;
  readonly containsAttemptIdentifiers: false;
  readonly containsEvidenceIdentifiers: false;
}

interface HiddenAttemptCounts {
  readonly completion: ValidationAttemptCompletion;
  readonly validArmCount: number;
  readonly attemptedArmCount: number;
  readonly inFlightAttemptCount: number;
  readonly replacementAttemptCount: number;
  readonly infrastructureFailureCount: number;
  readonly nonInfrastructureFailureCount: number;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    throw new Error(`${label} must contain only its canonical fields`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC RFC 3339 timestamp`);
  }
  return timestamp;
}

function immutableSealMaterial(input: {
  readonly panelBindingDigest: string;
  readonly sealedAt: string;
  readonly cells: readonly HiddenValidationCell[];
}): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.validation-attempt-ledger.seal.v1",
    policyVersion: VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION,
    panelBindingDigest: input.panelBindingDigest,
    sealedAt: input.sealedAt,
    presealedPairCount: PRESEALED_VALIDATION_PAIR_COUNT,
    presealedArmCount: PRESEALED_VALIDATION_ARM_COUNT,
    maximumInfrastructureReplacements: MAXIMUM_INFRASTRUCTURE_REPLACEMENTS,
    cells: input.cells.map((cell) => ({
      ordinal: cell.ordinal,
      pairOrdinal: cell.pairOrdinal,
      taskId: cell.taskId,
      taskRevisionDigest: cell.taskRevisionDigest,
      arm: cell.arm,
    })),
  };
}

function attemptDigest(
  ledger: HiddenValidationAttemptLedger,
  input: {
    readonly requestId: string;
    readonly cell: HiddenValidationCell;
    readonly attemptOrdinal: number;
    readonly kind: ValidationAttemptKind;
    readonly claimRevision: number;
  },
): string {
  return canonicalHash({
    domain: "dark-factory.validation-attempt.v1",
    policyVersion: ledger.policyVersion,
    ledgerSealDigest: ledger.sealDigest,
    requestId: input.requestId,
    cellOrdinal: input.cell.ordinal,
    taskId: input.cell.taskId,
    taskRevisionDigest: input.cell.taskRevisionDigest,
    arm: input.cell.arm,
    attemptOrdinal: input.attemptOrdinal,
    kind: input.kind,
    claimRevision: input.claimRevision,
  });
}

function receiptMaterial(
  input: Omit<HiddenValidationAttemptReceipt, "receiptDigest">,
): Readonly<Record<string, unknown>> {
  return {
    domain: "dark-factory.validation-attempt-receipt.v1",
    attemptDigest: input.attemptDigest,
    outcome: input.outcome,
    evidenceDigest: input.evidenceDigest,
    observedAt: input.observedAt,
  };
}

function attemptsForCell(
  attempts: readonly HiddenValidationAttempt[],
  cellOrdinal: number,
): readonly HiddenValidationAttempt[] {
  return attempts.filter((attempt) => attempt.cellOrdinal === cellOrdinal);
}

function latestAttempt(
  attempts: readonly HiddenValidationAttempt[],
  cellOrdinal: number,
): HiddenValidationAttempt | null {
  const matching = attemptsForCell(attempts, cellOrdinal);
  return matching.at(-1) ?? null;
}

function countAttempts(
  cells: readonly HiddenValidationCell[],
  attempts: readonly HiddenValidationAttempt[],
): HiddenAttemptCounts {
  let validArmCount = 0;
  let attemptedArmCount = 0;
  let permanentFailureCount = 0;
  let inFlightAttemptCount = 0;
  let infrastructureFailureCount = 0;
  let nonInfrastructureFailureCount = 0;

  for (const attempt of attempts) {
    if (attempt.receipt?.outcome === "infrastructure-failure") {
      infrastructureFailureCount += 1;
    } else if (attempt.receipt?.outcome === "non-infrastructure-failure") {
      nonInfrastructureFailureCount += 1;
    }
  }

  const replacementAttemptCount = attempts.filter(
    (attempt) => attempt.kind === "infrastructure-replacement",
  ).length;
  for (const cell of cells) {
    const latest = latestAttempt(attempts, cell.ordinal);
    if (latest === null) {
      continue;
    }
    attemptedArmCount += 1;
    if (latest.receipt === null) {
      inFlightAttemptCount += 1;
    } else if (latest.receipt.outcome === "valid") {
      validArmCount += 1;
    } else if (latest.receipt.outcome === "non-infrastructure-failure") {
      permanentFailureCount += 1;
    } else if (replacementAttemptCount >= MAXIMUM_INFRASTRUCTURE_REPLACEMENTS) {
      permanentFailureCount += 1;
    }
  }

  let completion: ValidationAttemptCompletion = "active";
  if (validArmCount === PRESEALED_VALIDATION_ARM_COUNT) {
    completion = "complete";
  } else if (permanentFailureCount > 0) {
    completion = inFlightAttemptCount > 0 ? "draining-incomplete" : "incomplete";
  }
  return {
    completion,
    validArmCount,
    attemptedArmCount,
    inFlightAttemptCount,
    replacementAttemptCount,
    infrastructureFailureCount,
    nonInfrastructureFailureCount,
  };
}

function nextClaimableCell(
  ledger: Pick<HiddenValidationAttemptLedger, "cells" | "attempts">,
): HiddenValidationCell | null {
  const counts = countAttempts(ledger.cells, ledger.attempts);
  if (counts.completion !== "active") {
    return null;
  }
  if (counts.replacementAttemptCount < MAXIMUM_INFRASTRUCTURE_REPLACEMENTS) {
    const retry = ledger.cells.find((cell) => {
      const latest = latestAttempt(ledger.attempts, cell.ordinal);
      return latest?.receipt?.outcome === "infrastructure-failure";
    });
    if (retry !== undefined) {
      return retry;
    }
  }
  return (
    ledger.cells.find(
      (cell) => attemptsForCell(ledger.attempts, cell.ordinal).length === 0,
    ) ?? null
  );
}

function validateCells(cells: readonly HiddenValidationCell[]): void {
  if (cells.length !== PRESEALED_VALIDATION_ARM_COUNT) {
    throw new Error("A validation attempt ledger must preseal exactly 24 arms");
  }
  const taskIds = new Set<string>();
  for (let pairOrdinal = 0; pairOrdinal < PRESEALED_VALIDATION_PAIR_COUNT; pairOrdinal += 1) {
    const first = cells[pairOrdinal * 2];
    const second = cells[pairOrdinal * 2 + 1];
    if (first === undefined || second === undefined) {
      throw new Error("A validation pair is missing a presealed arm");
    }
    for (const cell of [first, second]) {
      assertExactKeys(
        cell as unknown as Readonly<Record<string, unknown>>,
        ["ordinal", "pairOrdinal", "taskId", "taskRevisionDigest", "arm"],
        "Validation cell",
      );
      if (
        !Number.isSafeInteger(cell.ordinal) ||
        cell.ordinal !== cells.indexOf(cell) ||
        cell.pairOrdinal !== pairOrdinal
      ) {
        throw new Error("Validation cell ordinals must be canonical and contiguous");
      }
      assertSha256(cell.taskId, "taskId");
      assertSha256(cell.taskRevisionDigest, "taskRevisionDigest");
      if (cell.arm !== "candidate" && cell.arm !== "champion") {
        throw new Error("Validation cells must name a canonical matched arm");
      }
    }
    if (
      first.taskId !== second.taskId ||
      first.taskRevisionDigest !== second.taskRevisionDigest ||
      first.arm === second.arm
    ) {
      throw new Error("Every validation pair must contain one candidate and one champion arm");
    }
    if (taskIds.has(first.taskId)) {
      throw new Error("A validation task may occur in exactly one presealed pair");
    }
    taskIds.add(first.taskId);
  }
}

function assertReceipt(receipt: HiddenValidationAttemptReceipt): void {
  assertExactKeys(
    receipt as unknown as Readonly<Record<string, unknown>>,
    [
      "receiptDigest",
      "attemptDigest",
      "outcome",
      "evidenceDigest",
      "observedAt",
    ],
    "Validation attempt receipt",
  );
  assertSha256(receipt.attemptDigest, "attemptDigest");
  assertSha256(receipt.evidenceDigest, "evidenceDigest");
  assertSha256(receipt.receiptDigest, "receiptDigest");
  assertTimestamp(receipt.observedAt, "observedAt");
  if (
    receipt.outcome !== "valid" &&
    receipt.outcome !== "infrastructure-failure" &&
    receipt.outcome !== "non-infrastructure-failure"
  ) {
    throw new Error("Validation attempt receipt outcome is invalid");
  }
  const expected = canonicalHash(
    receiptMaterial({
      attemptDigest: receipt.attemptDigest,
      outcome: receipt.outcome,
      evidenceDigest: receipt.evidenceDigest,
      observedAt: receipt.observedAt,
    }),
  );
  if (receipt.receiptDigest !== expected) {
    throw new Error("Validation attempt receipt digest does not reproduce");
  }
}

function replaceAttempt(
  attempts: readonly HiddenValidationAttempt[],
  replacement: HiddenValidationAttempt,
): readonly HiddenValidationAttempt[] {
  return attempts.map((attempt) =>
    attempt.attemptDigest === replacement.attemptDigest ? replacement : attempt,
  );
}

function operationRevisions(
  ledger: HiddenValidationAttemptLedger,
): ReadonlyMap<
  number,
  { readonly kind: "claim" | "receipt"; readonly attempt: HiddenValidationAttempt }
> {
  const operations = new Map<
    number,
    { readonly kind: "claim" | "receipt"; readonly attempt: HiddenValidationAttempt }
  >();
  for (const attempt of ledger.attempts) {
    if (operations.has(attempt.claimRevision)) {
      throw new Error("Validation attempt revisions must be unique");
    }
    operations.set(attempt.claimRevision, { kind: "claim", attempt });
    if (attempt.receiptRecordedRevision !== null) {
      if (operations.has(attempt.receiptRecordedRevision)) {
        throw new Error("Validation attempt revisions must be unique");
      }
      operations.set(attempt.receiptRecordedRevision, { kind: "receipt", attempt });
    }
  }
  return operations;
}

/**
 * Replays the transition log embedded in the state. This makes a JSON-backed,
 * SQL-backed, or object-store-backed implementation equivalent as long as it
 * uses revision compare-and-swap.
 */
export function validateValidationAttemptLedger(
  ledger: HiddenValidationAttemptLedger,
): void {
  assertExactKeys(
    ledger as unknown as Readonly<Record<string, unknown>>,
    [
      "policyVersion",
      "revision",
      "panelBindingDigest",
      "sealDigest",
      "sealedAt",
      "cells",
      "attempts",
    ],
    "Validation attempt ledger",
  );
  if (ledger.policyVersion !== VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION) {
    throw new Error("Unknown validation attempt ledger policy");
  }
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 0) {
    throw new Error("Validation attempt ledger revision must be a non-negative integer");
  }
  assertSha256(ledger.panelBindingDigest, "panelBindingDigest");
  assertSha256(ledger.sealDigest, "sealDigest");
  assertTimestamp(ledger.sealedAt, "sealedAt");
  validateCells(ledger.cells);
  const expectedSeal = canonicalHash(
    immutableSealMaterial({
      panelBindingDigest: ledger.panelBindingDigest,
      sealedAt: ledger.sealedAt,
      cells: ledger.cells,
    }),
  );
  if (ledger.sealDigest !== expectedSeal) {
    throw new Error("Validation attempt ledger seal digest does not reproduce");
  }
  if (
    ledger.attempts.length > PRESEALED_VALIDATION_ARM_COUNT +
      MAXIMUM_INFRASTRUCTURE_REPLACEMENTS
  ) {
    throw new Error("Validation attempt ledger exceeds its 28-attempt ceiling");
  }

  const requestIds = new Set<string>();
  const attemptDigests = new Set<string>();
  const operations = operationRevisions(ledger);
  if (operations.size !== ledger.revision) {
    throw new Error("Validation attempt ledger revision accounting is incomplete");
  }

  let replayedAttempts: readonly HiddenValidationAttempt[] = [];
  const replayLedger = (): HiddenValidationAttemptLedger => ({
    ...ledger,
    revision: 0,
    attempts: replayedAttempts,
  });
  for (let revision = 1; revision <= ledger.revision; revision += 1) {
    const operation = operations.get(revision);
    if (operation === undefined) {
      throw new Error("Validation attempt ledger revisions must be contiguous");
    }
    const attempt = operation.attempt;
    if (operation.kind === "claim") {
      assertExactKeys(
        attempt as unknown as Readonly<Record<string, unknown>>,
        [
          "requestId",
          "attemptDigest",
          "cellOrdinal",
          "attemptOrdinal",
          "kind",
          "claimedAt",
          "claimRevision",
          "receipt",
          "receiptRecordedRevision",
        ],
        "Validation attempt",
      );
      assertSha256(attempt.requestId, "requestId");
      assertSha256(attempt.attemptDigest, "attemptDigest");
      if (
        !Number.isSafeInteger(attempt.claimRevision) ||
        attempt.claimRevision !== revision ||
        requestIds.has(attempt.requestId) ||
        attemptDigests.has(attempt.attemptDigest)
      ) {
        throw new Error("Validation attempt claim is duplicated or out of sequence");
      }
      const sealedAt = assertTimestamp(ledger.sealedAt, "sealedAt");
      if (assertTimestamp(attempt.claimedAt, "claimedAt") < sealedAt) {
        throw new Error("A validation attempt cannot predate its panel seal");
      }
      const cell = nextClaimableCell(replayLedger());
      if (cell === null || cell.ordinal !== attempt.cellOrdinal) {
        throw new Error("Validation attempt does not follow the deterministic sealed schedule");
      }
      const prior = attemptsForCell(replayedAttempts, cell.ordinal);
      const expectedAttemptOrdinal = prior.length + 1;
      const expectedKind: ValidationAttemptKind =
        prior.length === 0 ? "initial" : "infrastructure-replacement";
      if (
        attempt.attemptOrdinal !== expectedAttemptOrdinal ||
        attempt.kind !== expectedKind ||
        (attempt.receiptRecordedRevision !== null) !== (attempt.receipt !== null)
      ) {
        throw new Error("Validation attempt retry accounting is invalid");
      }
      const expectedAttemptDigest = attemptDigest(ledger, {
        requestId: attempt.requestId,
        cell,
        attemptOrdinal: expectedAttemptOrdinal,
        kind: expectedKind,
        claimRevision: revision,
      });
      if (attempt.attemptDigest !== expectedAttemptDigest) {
        throw new Error("Validation attempt digest does not reproduce");
      }
      requestIds.add(attempt.requestId);
      attemptDigests.add(attempt.attemptDigest);
      replayedAttempts = [
        ...replayedAttempts,
        {
          ...attempt,
          receipt: null,
          receiptRecordedRevision: null,
        },
      ];
      continue;
    }

    const replayed = replayedAttempts.find(
      (item) => item.attemptDigest === attempt.attemptDigest,
    );
    if (
      replayed === undefined ||
      replayed.receipt !== null ||
      attempt.receipt === null ||
      attempt.receiptRecordedRevision !== revision
    ) {
      throw new Error("Validation receipt is missing, duplicated, or precedes its claim");
    }
    assertReceipt(attempt.receipt);
    if (attempt.receipt.attemptDigest !== attempt.attemptDigest) {
      throw new Error("Validation receipt does not bind its claimed attempt");
    }
    if (
      assertTimestamp(attempt.receipt.observedAt, "observedAt") <
      assertTimestamp(attempt.claimedAt, "claimedAt")
    ) {
      throw new Error("Validation receipt cannot predate its attempt claim");
    }
    replayedAttempts = replaceAttempt(replayedAttempts, attempt);
  }

  if (canonicalHash(replayedAttempts) !== canonicalHash(ledger.attempts)) {
    throw new Error("Validation attempt ledger does not match its replayed transitions");
  }
  const counts = countAttempts(ledger.cells, ledger.attempts);
  if (counts.replacementAttemptCount > MAXIMUM_INFRASTRUCTURE_REPLACEMENTS) {
    throw new Error("Validation attempt ledger exceeds four infrastructure replacements");
  }
}

export function createValidationAttemptLedger(input: {
  readonly panelBindingDigest: string;
  readonly pairs: readonly HiddenValidationPairPlan[];
  readonly sealedAt: string;
}): HiddenValidationAttemptLedger {
  assertSha256(input.panelBindingDigest, "panelBindingDigest");
  assertTimestamp(input.sealedAt, "sealedAt");
  if (input.pairs.length !== PRESEALED_VALIDATION_PAIR_COUNT) {
    throw new Error("Fresh validation requires exactly twelve hidden matched pairs");
  }
  const cells: HiddenValidationCell[] = [];
  for (const [pairOrdinal, pair] of input.pairs.entries()) {
    assertSha256(pair.taskId, "taskId");
    assertSha256(pair.taskRevisionDigest, "taskRevisionDigest");
    let arms: readonly ValidationHarnessArm[];
    if (pair.armOrder === "AB") {
      arms = ["candidate", "champion"];
    } else if (pair.armOrder === "BA") {
      arms = ["champion", "candidate"];
    } else {
      throw new Error("Validation pair arm order must be AB or BA");
    }
    for (const arm of arms) {
      cells.push({
        ordinal: cells.length,
        pairOrdinal,
        taskId: pair.taskId,
        taskRevisionDigest: pair.taskRevisionDigest,
        arm,
      });
    }
  }
  validateCells(cells);
  const sealDigest = canonicalHash(
    immutableSealMaterial({
      panelBindingDigest: input.panelBindingDigest,
      sealedAt: input.sealedAt,
      cells,
    }),
  );
  const ledger: HiddenValidationAttemptLedger = {
    policyVersion: VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION,
    revision: 0,
    panelBindingDigest: input.panelBindingDigest,
    sealDigest,
    sealedAt: input.sealedAt,
    cells,
    attempts: [],
  };
  validateValidationAttemptLedger(ledger);
  return ledger;
}

function hiddenClaim(
  ledger: HiddenValidationAttemptLedger,
  attempt: HiddenValidationAttempt,
): HiddenValidationAttemptClaim {
  const cell = ledger.cells[attempt.cellOrdinal];
  if (cell === undefined) {
    throw new Error("Validation attempt references an unknown cell");
  }
  return {
    requestId: attempt.requestId,
    attemptDigest: attempt.attemptDigest,
    cellOrdinal: cell.ordinal,
    taskId: cell.taskId,
    taskRevisionDigest: cell.taskRevisionDigest,
    arm: cell.arm,
    attemptOrdinal: attempt.attemptOrdinal,
    kind: attempt.kind,
  };
}

/**
 * Claims the next deterministic cell. Persist `ledger` with revision CAS before
 * invoking a provider. Retrying the same request ID returns the same digest;
 * a pending replay must recover that execution rather than start another.
 */
export function claimValidationAttempt(
  ledger: HiddenValidationAttemptLedger,
  input: {
    readonly requestId: string;
    readonly claimedAt: string;
  },
): ValidationAttemptClaimResult {
  validateValidationAttemptLedger(ledger);
  assertSha256(input.requestId, "requestId");
  assertTimestamp(input.claimedAt, "claimedAt");
  const existing = ledger.attempts.find(
    (attempt) => attempt.requestId === input.requestId,
  );
  if (existing !== undefined) {
    if (existing.claimedAt !== input.claimedAt) {
      throw new Error("An idempotent validation claim cannot change its timestamp");
    }
    return {
      ledger,
      claim: hiddenClaim(ledger, existing),
      replayed: true,
      providerAction: existing.receipt === null ? "recover" : "none",
    };
  }

  const counts = countAttempts(ledger.cells, ledger.attempts);
  if (counts.completion !== "active") {
    throw new Error(`Cannot claim an attempt from a ${counts.completion} validation ledger`);
  }
  const cell = nextClaimableCell(ledger);
  if (cell === null) {
    throw new Error("All currently claimable validation arms are already in flight");
  }
  const prior = attemptsForCell(ledger.attempts, cell.ordinal);
  const attemptOrdinal = prior.length + 1;
  const kind: ValidationAttemptKind =
    prior.length === 0 ? "initial" : "infrastructure-replacement";
  const claimRevision = ledger.revision + 1;
  const claimed: HiddenValidationAttempt = {
    requestId: input.requestId,
    attemptDigest: attemptDigest(ledger, {
      requestId: input.requestId,
      cell,
      attemptOrdinal,
      kind,
      claimRevision,
    }),
    cellOrdinal: cell.ordinal,
    attemptOrdinal,
    kind,
    claimedAt: input.claimedAt,
    claimRevision,
    receipt: null,
    receiptRecordedRevision: null,
  };
  const next: HiddenValidationAttemptLedger = {
    ...ledger,
    revision: claimRevision,
    attempts: [...ledger.attempts, claimed],
  };
  validateValidationAttemptLedger(next);
  return {
    ledger: next,
    claim: hiddenClaim(next, claimed),
    replayed: false,
    providerAction: "start-once",
  };
}

export function createValidationAttemptReceipt(
  input: Omit<HiddenValidationAttemptReceipt, "receiptDigest">,
): HiddenValidationAttemptReceipt {
  assertSha256(input.attemptDigest, "attemptDigest");
  assertSha256(input.evidenceDigest, "evidenceDigest");
  assertTimestamp(input.observedAt, "observedAt");
  if (
    input.outcome !== "valid" &&
    input.outcome !== "infrastructure-failure" &&
    input.outcome !== "non-infrastructure-failure"
  ) {
    throw new Error("Validation attempt receipt outcome is invalid");
  }
  return {
    attemptDigest: input.attemptDigest,
    outcome: input.outcome,
    evidenceDigest: input.evidenceDigest,
    observedAt: input.observedAt,
    receiptDigest: canonicalHash(receiptMaterial(input)),
  };
}

/**
 * Receipts are insert-once by attempt digest. Exact replay is a no-op;
 * conflicting replay fails closed.
 */
export function recordValidationAttemptReceipt(
  ledger: HiddenValidationAttemptLedger,
  receipt: HiddenValidationAttemptReceipt,
): ValidationAttemptReceiptResult {
  validateValidationAttemptLedger(ledger);
  assertReceipt(receipt);
  const existing = ledger.attempts.find(
    (attempt) => attempt.attemptDigest === receipt.attemptDigest,
  );
  if (existing === undefined) {
    throw new Error("Validation receipt references an unknown attempt");
  }
  if (existing.receipt !== null) {
    if (canonicalHash(existing.receipt) !== canonicalHash(receipt)) {
      throw new Error("A validation attempt cannot accept a conflicting receipt");
    }
    return { ledger, replayed: true };
  }
  if (
    assertTimestamp(receipt.observedAt, "observedAt") <
    assertTimestamp(existing.claimedAt, "claimedAt")
  ) {
    throw new Error("Validation receipt cannot predate its attempt claim");
  }
  const recorded: HiddenValidationAttempt = {
    ...existing,
    receipt,
    receiptRecordedRevision: ledger.revision + 1,
  };
  const next: HiddenValidationAttemptLedger = {
    ...ledger,
    revision: ledger.revision + 1,
    attempts: replaceAttempt(ledger.attempts, recorded),
  };
  validateValidationAttemptLedger(next);
  return { ledger: next, replayed: false };
}

export function validationAttemptCompletion(
  ledger: HiddenValidationAttemptLedger,
): ValidationAttemptCompletion {
  validateValidationAttemptLedger(ledger);
  return countAttempts(ledger.cells, ledger.attempts).completion;
}

export function makeReleaseSafeTerminalValidationAttemptAccounting(
  ledger: HiddenValidationAttemptLedger,
): ReleaseSafeTerminalValidationAttemptAccounting {
  validateValidationAttemptLedger(ledger);
  const counts = countAttempts(ledger.cells, ledger.attempts);
  if (counts.completion !== "complete" && counts.completion !== "incomplete") {
    throw new Error("Validation attempt accounting is not terminal");
  }
  return {
    policyVersion: VALIDATION_ATTEMPT_LEDGER_POLICY_VERSION,
    terminalStatus: counts.completion,
    presealedPairCount: PRESEALED_VALIDATION_PAIR_COUNT,
    presealedArmCount: PRESEALED_VALIDATION_ARM_COUNT,
    validArmCount: counts.validArmCount,
    attemptedArmCount: counts.attemptedArmCount,
    unresolvedArmCount: PRESEALED_VALIDATION_ARM_COUNT - counts.validArmCount,
    totalAttemptCount: ledger.attempts.length,
    replacementAttemptCount: counts.replacementAttemptCount,
    infrastructureFailureCount: counts.infrastructureFailureCount,
    nonInfrastructureFailureCount: counts.nonInfrastructureFailureCount,
    containsPanelHandle: false,
    containsTaskIdentifiers: false,
    containsCellIdentifiers: false,
    containsAttemptIdentifiers: false,
    containsEvidenceIdentifiers: false,
  };
}
