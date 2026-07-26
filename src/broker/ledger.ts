import { randomBytes } from "node:crypto";
import type { SignedResultEnvelope } from "../schemas/trusted.js";

export type BrokerFailureCode =
  | "panel-allocation-failed"
  | "runtime-attestation-failed"
  | "evaluation-failed"
  | "normalization-failed"
  | "raw-destruction-failed"
  | "release-validation-failed";

export type OneUseClaim =
  | {
      readonly state: "acquired";
      readonly claimToken: string;
    }
  | {
      readonly state: "completed";
      readonly requestHash: string;
      readonly envelope: SignedResultEnvelope;
    }
  | {
      readonly state: "in-flight";
      readonly requestHash: string;
      readonly retryAfterMs: number;
    }
  | {
      readonly state: "consumed";
      readonly requestHash: string;
      readonly failureCode: BrokerFailureCode;
    }
  | {
      readonly state: "conflict";
    };

export type OneUseLedgerInspection =
  | Exclude<OneUseClaim, { readonly state: "acquired" }>
  | {
      readonly state: "missing";
    };

/**
 * Implementations must provide linearizable operations backed by durable cloud
 * storage. A request ID is permanently bound to its first request hash, and a
 * disposition attestation hash may be bound to only one claim globally.
 */
export interface OneUseRequestLedger {
  claim(requestId: string, requestHash: string): Promise<OneUseClaim>;

  /**
   * Read-only completion reconciliation. This must never create a claim. It is
   * used after an ambiguous `complete` failure to decide whether a committed
   * result—and any privacy-spending release it references—must be returned
   * rather than orphaned.
   */
  inspect(
    requestId: string,
    requestHash: string,
  ): Promise<OneUseLedgerInspection>;

  bindDispositionAttestation(
    claimToken: string,
    requestHash: string,
    dispositionAttestationHash: string,
  ): Promise<boolean>;

  complete(
    claimToken: string,
    requestHash: string,
    dispositionAttestationHash: string,
    envelope: SignedResultEnvelope,
  ): Promise<void>;

  consumeFailure(
    claimToken: string,
    requestHash: string,
    failureCode: BrokerFailureCode,
  ): Promise<void>;
}

export interface OneUseLedgerRecord {
  readonly requestHash: string;
  readonly claimToken: string;
  readonly status: "in-flight" | "completed" | "consumed";
  readonly dispositionAttestationHash: string | null;
  readonly envelope: SignedResultEnvelope | null;
  readonly failureCode: BrokerFailureCode | null;
}

export interface OneUseLedgerState {
  readonly revision: number;
  readonly records: Readonly<Record<string, OneUseLedgerRecord>>;
  readonly usedDispositionAttestations: readonly string[];
}

export interface AtomicOneUseLedgerStore {
  /**
   * The store must execute this callback exactly once inside a linearizable
   * compare-and-set transaction and durably commit `next` before resolving.
   */
  transact<Result>(
    operation: (state: OneUseLedgerState) => {
      readonly next: OneUseLedgerState;
      readonly result: Result;
    },
  ): Promise<Result>;
}

export interface DurableOneUseRequestLedgerOptions {
  readonly store: AtomicOneUseLedgerStore;
  readonly retryAfterMs?: number;
  readonly claimTokenFactory?: () => string;
}

export class OneUseLedgerError extends Error {
  override readonly name = "OneUseLedgerError";
}

export function emptyOneUseLedgerState(): OneUseLedgerState {
  return {
    revision: 0,
    records: {},
    usedDispositionAttestations: [],
  };
}

export function assertOneUseClaim(claim: OneUseClaim): void {
  if (claim.state === "acquired") {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claim.claimToken)) {
      throw new OneUseLedgerError("One-use ledger returned a malformed claim token.");
    }
    return;
  }
  if (claim.state === "conflict") return;
  if (!/^[a-f0-9]{64}$/u.test(claim.requestHash)) {
    throw new OneUseLedgerError("One-use ledger returned a malformed request hash.");
  }
  if (
    claim.state === "in-flight" &&
    (!Number.isSafeInteger(claim.retryAfterMs) ||
      claim.retryAfterMs <= 0 ||
      claim.retryAfterMs > 60 * 60_000)
  ) {
    throw new OneUseLedgerError("One-use ledger returned an invalid retry interval.");
  }
}

export function assertOneUseLedgerInspection(
  inspection: OneUseLedgerInspection,
): void {
  if (inspection.state === "missing" || inspection.state === "conflict") {
    return;
  }
  assertOneUseClaim(inspection);
}

function assertRequestIdentity(requestId: string, requestHash: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) ||
    !/^[a-f0-9]{64}$/u.test(requestHash)
  ) {
    throw new OneUseLedgerError("One-use request identity is malformed.");
  }
}

function nextState(
  state: OneUseLedgerState,
  records: Readonly<Record<string, OneUseLedgerRecord>>,
  usedDispositionAttestations = state.usedDispositionAttestations,
): OneUseLedgerState {
  return {
    revision: state.revision + 1,
    records,
    usedDispositionAttestations,
  };
}

/**
 * Durable behavior comes from the injected linearizable cloud store. There is
 * intentionally no filesystem or process-local fallback.
 */
export class DurableOneUseRequestLedger implements OneUseRequestLedger {
  readonly #store: AtomicOneUseLedgerStore;
  readonly #retryAfterMs: number;
  readonly #claimTokenFactory: () => string;

  constructor(options: DurableOneUseRequestLedgerOptions) {
    this.#store = options.store;
    this.#retryAfterMs = options.retryAfterMs ?? 5_000;
    this.#claimTokenFactory =
      options.claimTokenFactory ??
      (() => `claim-${randomBytes(24).toString("base64url")}`);
    if (
      !Number.isSafeInteger(this.#retryAfterMs) ||
      this.#retryAfterMs <= 0 ||
      this.#retryAfterMs > 60 * 60_000
    ) {
      throw new OneUseLedgerError("Ledger retry interval is outside policy.");
    }
  }

  claim(requestId: string, requestHash: string): Promise<OneUseClaim> {
    assertRequestIdentity(requestId, requestHash);
    return this.#store.transact((state) => {
      const existing = state.records[requestId];
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          return { next: state, result: { state: "conflict" as const } };
        }
        if (existing.status === "completed") {
          if (existing.envelope === null) {
            throw new OneUseLedgerError("Completed ledger record has no signed envelope.");
          }
          return {
            next: state,
            result: {
              state: "completed" as const,
              requestHash,
              envelope: existing.envelope,
            },
          };
        }
        if (existing.status === "consumed") {
          if (existing.failureCode === null) {
            throw new OneUseLedgerError("Consumed ledger record has no failure code.");
          }
          return {
            next: state,
            result: {
              state: "consumed" as const,
              requestHash,
              failureCode: existing.failureCode,
            },
          };
        }
        return {
          next: state,
          result: {
            state: "in-flight" as const,
            requestHash,
            retryAfterMs: this.#retryAfterMs,
          },
        };
      }

      const claimToken = this.#claimTokenFactory();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claimToken)) {
        throw new OneUseLedgerError("Claim token factory returned an unsafe token.");
      }
      const record: OneUseLedgerRecord = {
        requestHash,
        claimToken,
        status: "in-flight",
        dispositionAttestationHash: null,
        envelope: null,
        failureCode: null,
      };
      return {
        next: nextState(state, { ...state.records, [requestId]: record }),
        result: { state: "acquired" as const, claimToken },
      };
    });
  }

  inspect(
    requestId: string,
    requestHash: string,
  ): Promise<OneUseLedgerInspection> {
    assertRequestIdentity(requestId, requestHash);
    return this.#store.transact((state) => {
      const existing = state.records[requestId];
      if (existing === undefined) {
        return {
          next: state,
          result: { state: "missing" as const },
        };
      }
      if (existing.requestHash !== requestHash) {
        return {
          next: state,
          result: { state: "conflict" as const },
        };
      }
      if (existing.status === "completed") {
        if (existing.envelope === null) {
          throw new OneUseLedgerError(
            "Completed ledger record has no signed envelope.",
          );
        }
        return {
          next: state,
          result: {
            state: "completed" as const,
            requestHash,
            envelope: existing.envelope,
          },
        };
      }
      if (existing.status === "consumed") {
        if (existing.failureCode === null) {
          throw new OneUseLedgerError(
            "Consumed ledger record has no failure code.",
          );
        }
        return {
          next: state,
          result: {
            state: "consumed" as const,
            requestHash,
            failureCode: existing.failureCode,
          },
        };
      }
      return {
        next: state,
        result: {
          state: "in-flight" as const,
          requestHash,
          retryAfterMs: this.#retryAfterMs,
        },
      };
    });
  }

  bindDispositionAttestation(
    claimToken: string,
    requestHash: string,
    dispositionAttestationHash: string,
  ): Promise<boolean> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(claimToken) ||
      !/^[a-f0-9]{64}$/u.test(requestHash) ||
      !/^[a-f0-9]{64}$/u.test(dispositionAttestationHash)
    ) {
      throw new OneUseLedgerError("Attestation binding is malformed.");
    }
    return this.#store.transact((state) => {
      const found = Object.entries(state.records).find(
        ([, record]) => record.claimToken === claimToken,
      );
      if (found === undefined) {
        throw new OneUseLedgerError("Unknown claim token.");
      }
      const [requestId, record] = found;
      if (record.requestHash !== requestHash || record.status !== "in-flight") {
        throw new OneUseLedgerError("Claim cannot bind an attestation in its current state.");
      }
      if (record.dispositionAttestationHash !== null) {
        return {
          next: state,
          result: record.dispositionAttestationHash === dispositionAttestationHash,
        };
      }
      if (state.usedDispositionAttestations.includes(dispositionAttestationHash)) {
        return { next: state, result: false };
      }
      return {
        next: nextState(
          state,
          {
            ...state.records,
            [requestId]: {
              ...record,
              dispositionAttestationHash,
            },
          },
          [...state.usedDispositionAttestations, dispositionAttestationHash],
        ),
        result: true,
      };
    });
  }

  complete(
    claimToken: string,
    requestHash: string,
    dispositionAttestationHash: string,
    envelope: SignedResultEnvelope,
  ): Promise<void> {
    return this.#store.transact((state) => {
      const found = Object.entries(state.records).find(
        ([, record]) => record.claimToken === claimToken,
      );
      if (found === undefined) {
        throw new OneUseLedgerError("Unknown claim token.");
      }
      const [requestId, record] = found;
      if (
        record.requestHash !== requestHash ||
        record.status !== "in-flight" ||
        record.dispositionAttestationHash !== dispositionAttestationHash ||
        envelope.oneUseRequest.requestHash !== requestHash ||
        envelope.oneUseRequest.requestId !== requestId ||
        envelope.oneUseRequest.dispositionAttestationHash !== dispositionAttestationHash
      ) {
        throw new OneUseLedgerError("Completed envelope does not match its bound one-use claim.");
      }
      return {
        next: nextState(state, {
          ...state.records,
          [requestId]: {
            ...record,
            status: "completed",
            envelope,
          },
        }),
        result: undefined,
      };
    });
  }

  consumeFailure(
    claimToken: string,
    requestHash: string,
    failureCode: BrokerFailureCode,
  ): Promise<void> {
    return this.#store.transact((state) => {
      const found = Object.entries(state.records).find(
        ([, record]) => record.claimToken === claimToken,
      );
      if (found === undefined) {
        throw new OneUseLedgerError("Unknown claim token.");
      }
      const [requestId, record] = found;
      if (record.requestHash !== requestHash) {
        throw new OneUseLedgerError("Failure does not match its one-use claim.");
      }
      if (record.status === "completed") {
        throw new OneUseLedgerError("A completed one-use claim cannot be changed to failure.");
      }
      if (record.status === "consumed") {
        if (record.failureCode !== failureCode) {
          throw new OneUseLedgerError("A consumed claim cannot change its failure code.");
        }
        return { next: state, result: undefined };
      }
      return {
        next: nextState(state, {
          ...state.records,
          [requestId]: {
            ...record,
            status: "consumed",
            failureCode,
          },
        }),
        result: undefined,
      };
    });
  }
}
