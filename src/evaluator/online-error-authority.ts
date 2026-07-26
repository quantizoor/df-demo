import {
  allocateOnlineGate,
  assertOnlineErrorBudgetState,
  type OnlineErrorBudgetState,
  type OnlineGateAllocation,
  type ReleaseSafeOnlineErrorBudgetAccounting,
} from "../evaluation/statistics.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import { hashEvaluationRequest, type TrustedEvaluationRequest } from "./contracts.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAXIMUM_RESERVATIONS = 100_000;

export interface TrustedOnlineErrorBudgetReservation {
  readonly sensitivity: "trusted-online-error-budget-reservation";
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestHash: string;
  readonly experimentId: string;
  readonly protocolHash: string;
  readonly dispositionAttestationHash: string;
  readonly reservedAt: string;
  readonly stateBefore: OnlineErrorBudgetState;
  readonly allocation: OnlineGateAllocation & { readonly authorized: true };
  readonly accounting: ReleaseSafeOnlineErrorBudgetAccounting;
  readonly reservationHash: string;
}

export interface DurableOnlineErrorBudgetState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-online-error-budget-state";
  readonly campaignIdHash: string;
  readonly revision: number;
  readonly current: OnlineErrorBudgetState;
  readonly reservations: Readonly<Record<string, TrustedOnlineErrorBudgetReservation>>;
  readonly stateCommitment: string;
}

export interface TrustedOnlineErrorBudgetCasStore {
  /**
   * Production implementations must provide linearizable reads and CAS over
   * provider-managed trusted-cloud durable state.
   */
  readonly boundary: "trusted-cloud";
  read(): Promise<DurableOnlineErrorBudgetState>;
  compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly next: DurableOnlineErrorBudgetState;
  }): Promise<boolean>;
}

export interface TrustedOnlineErrorBudgetAuthority {
  readonly boundary: "trusted-cloud-online-error-authority";
  reserve(input: {
    readonly request: TrustedEvaluationRequest;
    readonly requestHash: string;
    readonly dispositionAttestationHash: string;
  }): Promise<TrustedOnlineErrorBudgetReservation>;
  /**
   * Returns the latest release-safe durable-state commitment. Interruption
   * accounting authorities use this to attest a burned look into
   * CampaignState even when no evaluator result envelope was issued.
   */
  reconcile(): Promise<TrustedOnlineErrorBudgetReconciliation>;
}

export interface TrustedOnlineErrorBudgetReconciliation {
  readonly sensitivity: "release-safe-online-error-reconciliation";
  readonly schemaVersion: 1;
  readonly campaignIdHash: string;
  readonly storeRevision: number;
  readonly policyVersion: "online-alpha-spending-v1";
  readonly maximumOnlineError: number;
  readonly onlineErrorSpent: number;
  readonly onlineErrorRemaining: number;
  readonly gatesSpent: number;
  readonly resultingStateHash: string;
  readonly durableStateCommitment: string;
  readonly observedAt: string;
  readonly reconciliationHash: string;
}

export interface DurableTrustedOnlineErrorBudgetAuthorityOptions {
  readonly store: TrustedOnlineErrorBudgetCasStore;
  readonly campaignIdHash: string;
  readonly initialBudget: OnlineErrorBudgetState;
  readonly now?: () => Date;
  readonly maximumCasAttempts?: number;
}

export class TrustedOnlineErrorBudgetError extends Error {
  override readonly name = "TrustedOnlineErrorBudgetError";
  readonly code: "invalid-input" | "request-conflict" | "budget-exhausted" | "state-conflict";

  constructor(code: "invalid-input" | "request-conflict" | "budget-exhausted" | "state-conflict") {
    super("Trusted online error budget failed closed.");
    this.code = code;
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

function assertCanonicalTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

/**
 * Canonical campaign scope for the online-error authority.
 *
 * Callers must derive this value from the same non-sensitive campaign ID
 * instead of inventing or reusing an opaque SHA-256 value. The separate
 * domain prevents a valid identifier hash from another subsystem from being
 * replayed as an online-error campaign scope.
 */
export function onlineErrorBudgetCampaignIdHash(campaignId: string): string {
  if (!SAFE_ID.test(campaignId)) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  return canonicalHash({
    domain: "dark-factory.online-error-budget-campaign-id.v1",
    campaignId,
  });
}

export function hashOnlineErrorBudgetState(state: OnlineErrorBudgetState): string {
  assertOnlineErrorBudgetState(state);
  return canonicalHash({
    domain: "dark-factory.online-error-budget-state.v1",
    state,
  });
}

function reservationWithoutHash(
  reservation: TrustedOnlineErrorBudgetReservation,
): Omit<TrustedOnlineErrorBudgetReservation, "reservationHash"> {
  const { reservationHash: _reservationHash, ...unsigned } = reservation;
  return unsigned;
}

export function hashOnlineErrorBudgetReservation(
  reservation: Omit<TrustedOnlineErrorBudgetReservation, "reservationHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.online-error-budget-reservation.v1",
    ...reservation,
    /*
     * The mirrored release-safe field is excluded from the identity digest to
     * avoid a self-referential hash while still making every other accounting
     * byte immutable.
     */
    accounting: {
      ...reservation.accounting,
      reservationHash: "0".repeat(64),
    },
  });
}

function stateWithoutCommitment(
  state: DurableOnlineErrorBudgetState,
): Omit<DurableOnlineErrorBudgetState, "stateCommitment"> {
  const { stateCommitment: _stateCommitment, ...unsigned } = state;
  return unsigned;
}

export function hashDurableOnlineErrorBudgetState(
  state: Omit<DurableOnlineErrorBudgetState, "stateCommitment">,
): string {
  return canonicalHash({
    domain: "dark-factory.online-error-budget-durable-state.v1",
    ...state,
  });
}

function reconciliationWithoutHash(
  value: TrustedOnlineErrorBudgetReconciliation,
): Omit<TrustedOnlineErrorBudgetReconciliation, "reconciliationHash"> {
  const { reconciliationHash: _reconciliationHash, ...unsigned } = value;
  return unsigned;
}

export function hashOnlineErrorBudgetReconciliation(
  value: Omit<TrustedOnlineErrorBudgetReconciliation, "reconciliationHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.online-error-budget-reconciliation.v1",
    ...value,
  });
}

export function assertTrustedOnlineErrorBudgetReconciliation(
  value: unknown,
  expectedCampaignId?: string,
): asserts value is TrustedOnlineErrorBudgetReconciliation {
  assertExactKeys(value, [
    "sensitivity",
    "schemaVersion",
    "campaignIdHash",
    "storeRevision",
    "policyVersion",
    "maximumOnlineError",
    "onlineErrorSpent",
    "onlineErrorRemaining",
    "gatesSpent",
    "resultingStateHash",
    "durableStateCommitment",
    "observedAt",
    "reconciliationHash",
  ]);
  const receipt = value as unknown as TrustedOnlineErrorBudgetReconciliation;
  if (
    receipt.sensitivity !== "release-safe-online-error-reconciliation" ||
    receipt.schemaVersion !== 1 ||
    receipt.policyVersion !== "online-alpha-spending-v1" ||
    !Number.isSafeInteger(receipt.storeRevision) ||
    receipt.storeRevision < 0 ||
    !Number.isSafeInteger(receipt.gatesSpent) ||
    receipt.gatesSpent < 0 ||
    receipt.storeRevision !== receipt.gatesSpent ||
    !Number.isFinite(receipt.maximumOnlineError) ||
    receipt.maximumOnlineError <= 0 ||
    receipt.maximumOnlineError > 0.05 ||
    !Number.isFinite(receipt.onlineErrorSpent) ||
    receipt.onlineErrorSpent < 0 ||
    receipt.onlineErrorSpent > receipt.maximumOnlineError ||
    !Number.isFinite(receipt.onlineErrorRemaining) ||
    receipt.onlineErrorRemaining < 0 ||
    receipt.onlineErrorRemaining > receipt.maximumOnlineError ||
    Math.abs(receipt.onlineErrorSpent + receipt.onlineErrorRemaining - receipt.maximumOnlineError) >
      1e-12 ||
    (expectedCampaignId !== undefined &&
      receipt.campaignIdHash !== onlineErrorBudgetCampaignIdHash(expectedCampaignId))
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  for (const hash of [
    receipt.campaignIdHash,
    receipt.resultingStateHash,
    receipt.durableStateCommitment,
    receipt.reconciliationHash,
  ]) {
    assertHash(hash);
  }
  assertCanonicalTimestamp(receipt.observedAt);
  if (
    receipt.reconciliationHash !==
    hashOnlineErrorBudgetReconciliation(reconciliationWithoutHash(receipt))
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

function withStateCommitment(
  state: Omit<DurableOnlineErrorBudgetState, "stateCommitment">,
): DurableOnlineErrorBudgetState {
  return {
    ...state,
    stateCommitment: hashDurableOnlineErrorBudgetState(state),
  };
}

export function createDurableOnlineErrorBudgetState(input: {
  readonly campaignIdHash: string;
  readonly initialBudget: OnlineErrorBudgetState;
}): DurableOnlineErrorBudgetState {
  assertHash(input.campaignIdHash);
  assertOnlineErrorBudgetState(input.initialBudget);
  if (
    input.initialBudget.gatesSpent !== 0 ||
    input.initialBudget.spentAlpha !== 0 ||
    input.initialBudget.remainingAlpha !== input.initialBudget.initialAlpha
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  return withStateCommitment({
    schemaVersion: 1,
    sensitivity: "trusted-online-error-budget-state",
    campaignIdHash: input.campaignIdHash,
    revision: 0,
    current: input.initialBudget,
    reservations: {},
  });
}

function assertAllocation(
  allocation: OnlineGateAllocation,
  stateBefore: OnlineErrorBudgetState,
): void {
  assertExactKeys(allocation, [
    "authorized",
    "alphaSpent",
    "requiredPosteriorProbability",
    "nextState",
  ]);
  const expected = allocateOnlineGate(stateBefore);
  if (canonicalJson(allocation) !== canonicalJson(expected)) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

function assertAccounting(
  accounting: ReleaseSafeOnlineErrorBudgetAccounting,
  reservation: Omit<TrustedOnlineErrorBudgetReservation, "accounting" | "reservationHash">,
): void {
  assertExactKeys(accounting, [
    "policyVersion",
    "maximumOnlineError",
    "gateOrdinal",
    "alphaSpent",
    "cumulativeSpentBefore",
    "cumulativeSpentAfter",
    "remainingAfter",
    "reservationHash",
    "priorStateHash",
    "resultingStateHash",
  ]);
  for (const value of [
    accounting.maximumOnlineError,
    accounting.alphaSpent,
    accounting.cumulativeSpentBefore,
    accounting.cumulativeSpentAfter,
    accounting.remainingAfter,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
  }
  for (const value of [
    accounting.reservationHash,
    accounting.priorStateHash,
    accounting.resultingStateHash,
  ]) {
    assertHash(value);
  }
  if (
    accounting.policyVersion !== "online-alpha-spending-v1" ||
    !Number.isSafeInteger(accounting.gateOrdinal) ||
    accounting.gateOrdinal < 1 ||
    accounting.maximumOnlineError !== reservation.stateBefore.initialAlpha ||
    accounting.gateOrdinal !== reservation.allocation.nextState.gatesSpent ||
    accounting.alphaSpent !== reservation.allocation.alphaSpent ||
    accounting.cumulativeSpentBefore !== reservation.stateBefore.spentAlpha ||
    accounting.cumulativeSpentAfter !== reservation.allocation.nextState.spentAlpha ||
    accounting.cumulativeSpentBefore + accounting.alphaSpent !== accounting.cumulativeSpentAfter ||
    accounting.remainingAfter !== reservation.allocation.nextState.remainingAlpha ||
    accounting.priorStateHash !== hashOnlineErrorBudgetState(reservation.stateBefore) ||
    accounting.resultingStateHash !== hashOnlineErrorBudgetState(reservation.allocation.nextState)
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

export function assertTrustedOnlineErrorBudgetReservation(
  value: unknown,
): asserts value is TrustedOnlineErrorBudgetReservation {
  assertExactKeys(value, [
    "sensitivity",
    "schemaVersion",
    "requestId",
    "requestHash",
    "experimentId",
    "protocolHash",
    "dispositionAttestationHash",
    "reservedAt",
    "stateBefore",
    "allocation",
    "accounting",
    "reservationHash",
  ]);
  const reservation = value as unknown as TrustedOnlineErrorBudgetReservation;
  if (
    reservation.sensitivity !== "trusted-online-error-budget-reservation" ||
    reservation.schemaVersion !== 1 ||
    !SAFE_ID.test(reservation.requestId) ||
    !SAFE_ID.test(reservation.experimentId)
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  assertHash(reservation.requestHash);
  assertHash(reservation.protocolHash);
  assertHash(reservation.dispositionAttestationHash);
  assertCanonicalTimestamp(reservation.reservedAt);
  assertOnlineErrorBudgetState(reservation.stateBefore);
  assertAllocation(reservation.allocation, reservation.stateBefore);
  if (!reservation.allocation.authorized) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  const {
    accounting: _accounting,
    reservationHash: _reservationHash,
    ...accountingContext
  } = reservation;
  assertAccounting(reservation.accounting, accountingContext);
  if (
    reservation.accounting.reservationHash !== reservation.reservationHash ||
    reservation.reservationHash !==
      hashOnlineErrorBudgetReservation(reservationWithoutHash(reservation))
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

export function assertDurableOnlineErrorBudgetState(
  value: unknown,
): asserts value is DurableOnlineErrorBudgetState {
  assertExactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "campaignIdHash",
    "revision",
    "current",
    "reservations",
    "stateCommitment",
  ]);
  const state = value as unknown as DurableOnlineErrorBudgetState;
  if (
    state.schemaVersion !== 1 ||
    state.sensitivity !== "trusted-online-error-budget-state" ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  assertHash(state.campaignIdHash);
  assertHash(state.stateCommitment);
  assertOnlineErrorBudgetState(state.current);
  if (
    !isPlainRecord(state.reservations) ||
    Object.keys(state.reservations).length > MAXIMUM_RESERVATIONS ||
    Object.keys(state.reservations).length !== state.revision
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  const requestIds = new Set<string>();
  const reservations = Object.entries(state.reservations).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  for (const [requestHash, reservation] of reservations) {
    assertHash(requestHash);
    assertTrustedOnlineErrorBudgetReservation(reservation);
    if (reservation.requestHash !== requestHash || requestIds.has(reservation.requestId)) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
    requestIds.add(reservation.requestId);
  }
  const byGate = reservations
    .map(([, reservation]) => reservation)
    .sort((left, right) => left.accounting.gateOrdinal - right.accounting.gateOrdinal);
  for (let index = 0; index < byGate.length; index += 1) {
    const reservation = byGate[index];
    if (
      reservation === undefined ||
      reservation.accounting.gateOrdinal !== index + 1 ||
      (index > 0 &&
        reservation.accounting.priorStateHash !== byGate[index - 1]?.accounting.resultingStateHash)
    ) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
  }
  const last = byGate.at(-1);
  if (
    (last === undefined && (state.current.gatesSpent !== 0 || state.current.spentAlpha !== 0)) ||
    (last !== undefined &&
      last.accounting.resultingStateHash !== hashOnlineErrorBudgetState(state.current))
  ) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
  if (state.stateCommitment !== hashDurableOnlineErrorBudgetState(stateWithoutCommitment(state))) {
    throw new TrustedOnlineErrorBudgetError("invalid-input");
  }
}

/**
 * Deterministic reservation constructor. Production callers must persist its
 * result with CAS before exposing or executing any outcome-bearing workload;
 * DurableTrustedOnlineErrorBudgetAuthority is that production entry point.
 */
export function createTrustedOnlineErrorBudgetReservation(input: {
  readonly request: TrustedEvaluationRequest;
  readonly requestHash: string;
  readonly dispositionAttestationHash: string;
  readonly stateBefore: OnlineErrorBudgetState;
  readonly reservedAt: string;
}): TrustedOnlineErrorBudgetReservation {
  const allocation = allocateOnlineGate(input.stateBefore);
  if (!allocation.authorized || allocation.alphaSpent <= 0) {
    throw new TrustedOnlineErrorBudgetError("budget-exhausted");
  }
  const base = {
    sensitivity: "trusted-online-error-budget-reservation" as const,
    schemaVersion: 1 as const,
    requestId: input.request.requestId,
    requestHash: input.requestHash,
    experimentId: input.request.experimentId,
    protocolHash: input.request.protocolHash,
    dispositionAttestationHash: input.dispositionAttestationHash,
    reservedAt: input.reservedAt,
    stateBefore: input.stateBefore,
    allocation: {
      ...allocation,
      authorized: true as const,
    },
  };
  const priorStateHash = hashOnlineErrorBudgetState(input.stateBefore);
  const resultingStateHash = hashOnlineErrorBudgetState(allocation.nextState);
  const accountingWithoutReservationHash = {
    policyVersion: "online-alpha-spending-v1" as const,
    maximumOnlineError: input.stateBefore.initialAlpha,
    gateOrdinal: allocation.nextState.gatesSpent,
    alphaSpent: allocation.alphaSpent,
    cumulativeSpentBefore: input.stateBefore.spentAlpha,
    cumulativeSpentAfter: allocation.nextState.spentAlpha,
    remainingAfter: allocation.nextState.remainingAlpha,
    reservationHash: "0".repeat(64),
    priorStateHash,
    resultingStateHash,
  };
  const provisional = {
    ...base,
    accounting: accountingWithoutReservationHash,
  };
  const reservationHash = hashOnlineErrorBudgetReservation(provisional);
  const unsigned = {
    ...base,
    accounting: {
      ...accountingWithoutReservationHash,
      reservationHash,
    },
  };
  return {
    ...unsigned,
    reservationHash,
  };
}

function reservationMatches(
  reservation: TrustedOnlineErrorBudgetReservation,
  input: {
    readonly request: TrustedEvaluationRequest;
    readonly requestHash: string;
    readonly dispositionAttestationHash: string;
  },
): boolean {
  return (
    reservation.requestId === input.request.requestId &&
    reservation.requestHash === input.requestHash &&
    reservation.experimentId === input.request.experimentId &&
    reservation.protocolHash === input.request.protocolHash &&
    reservation.dispositionAttestationHash === input.dispositionAttestationHash
  );
}

export class DurableTrustedOnlineErrorBudgetAuthority implements TrustedOnlineErrorBudgetAuthority {
  readonly boundary = "trusted-cloud-online-error-authority" as const;
  readonly #store: TrustedOnlineErrorBudgetCasStore;
  readonly #campaignIdHash: string;
  readonly #initialBudget: OnlineErrorBudgetState;
  readonly #now: () => Date;
  readonly #maximumCasAttempts: number;

  constructor(options: DurableTrustedOnlineErrorBudgetAuthorityOptions) {
    assertHash(options.campaignIdHash);
    assertOnlineErrorBudgetState(options.initialBudget);
    if (
      options.store.boundary !== "trusted-cloud" ||
      options.initialBudget.gatesSpent !== 0 ||
      options.initialBudget.spentAlpha !== 0 ||
      options.initialBudget.remainingAlpha !== options.initialBudget.initialAlpha
    ) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
    const maximumCasAttempts = options.maximumCasAttempts ?? 32;
    if (
      !Number.isSafeInteger(maximumCasAttempts) ||
      maximumCasAttempts < 1 ||
      maximumCasAttempts > 1_024
    ) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
    this.#store = options.store;
    this.#campaignIdHash = options.campaignIdHash;
    this.#initialBudget = options.initialBudget;
    this.#now = options.now ?? (() => new Date());
    this.#maximumCasAttempts = maximumCasAttempts;
  }

  async reserve(input: {
    readonly request: TrustedEvaluationRequest;
    readonly requestHash: string;
    readonly dispositionAttestationHash: string;
  }): Promise<TrustedOnlineErrorBudgetReservation> {
    if (
      input.request.stage !== "validation" ||
      input.request.selection.kind !== "fresh-matched-validation" ||
      input.requestHash !== hashEvaluationRequest(input.request)
    ) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
    assertHash(input.requestHash);
    assertHash(input.dispositionAttestationHash);

    for (let attempt = 0; attempt < this.#maximumCasAttempts; attempt += 1) {
      const state = await this.#store.read();
      assertDurableOnlineErrorBudgetState(state);
      if (
        state.campaignIdHash !== this.#campaignIdHash ||
        state.current.initialAlpha !== this.#initialBudget.initialAlpha ||
        state.current.nullCalibrationId !== this.#initialBudget.nullCalibrationId
      ) {
        throw new TrustedOnlineErrorBudgetError("invalid-input");
      }
      const existing = state.reservations[input.requestHash];
      if (existing !== undefined) {
        if (!reservationMatches(existing, input)) {
          throw new TrustedOnlineErrorBudgetError("request-conflict");
        }
        return existing;
      }
      if (
        Object.values(state.reservations).some(
          (reservation) => reservation.requestId === input.request.requestId,
        )
      ) {
        throw new TrustedOnlineErrorBudgetError("request-conflict");
      }
      const reservation = createTrustedOnlineErrorBudgetReservation({
        ...input,
        stateBefore: state.current,
        reservedAt: this.#now().toISOString(),
      });
      /*
       * Validate before CAS. A provider failure after a successful CAS cannot
       * remove this reservation, so opening a gate always burns its alpha.
       */
      assertTrustedOnlineErrorBudgetReservation(reservation);
      const next = withStateCommitment({
        schemaVersion: 1,
        sensitivity: "trusted-online-error-budget-state",
        campaignIdHash: state.campaignIdHash,
        revision: state.revision + 1,
        current: reservation.allocation.nextState,
        reservations: {
          ...state.reservations,
          [input.requestHash]: reservation,
        },
      });
      assertDurableOnlineErrorBudgetState(next);
      if (
        await this.#store.compareAndSwap({
          expectedRevision: state.revision,
          next,
        })
      ) {
        return reservation;
      }
    }
    throw new TrustedOnlineErrorBudgetError("state-conflict");
  }

  async reconcile(): Promise<TrustedOnlineErrorBudgetReconciliation> {
    const state = await this.#store.read();
    assertDurableOnlineErrorBudgetState(state);
    if (
      state.campaignIdHash !== this.#campaignIdHash ||
      state.current.initialAlpha !== this.#initialBudget.initialAlpha ||
      state.current.nullCalibrationId !== this.#initialBudget.nullCalibrationId
    ) {
      throw new TrustedOnlineErrorBudgetError("invalid-input");
    }
    const unsigned = {
      sensitivity: "release-safe-online-error-reconciliation" as const,
      schemaVersion: 1 as const,
      campaignIdHash: state.campaignIdHash,
      storeRevision: state.revision,
      policyVersion: state.current.policyVersion,
      maximumOnlineError: state.current.initialAlpha,
      onlineErrorSpent: state.current.spentAlpha,
      onlineErrorRemaining: state.current.remainingAlpha,
      gatesSpent: state.current.gatesSpent,
      resultingStateHash: hashOnlineErrorBudgetState(state.current),
      durableStateCommitment: state.stateCommitment,
      observedAt: this.#now().toISOString(),
    };
    const receipt = {
      ...unsigned,
      reconciliationHash: hashOnlineErrorBudgetReconciliation(unsigned),
    };
    assertTrustedOnlineErrorBudgetReconciliation(receipt);
    return receipt;
  }
}
