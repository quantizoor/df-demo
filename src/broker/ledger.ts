import { randomBytes } from "node:crypto";
import { canonicalHash } from "../schemas/canonical.js";
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

export interface OneUseClaimRecoveryObservation {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.one-use-claim-recovery-observation.v1";
  readonly requestId: string;
  readonly requestHash: string;
  readonly recoveryRecordHash: string;
  readonly dispositionAttestationHash: string;
  readonly priorClaimTokenHash: string;
  readonly priorOwnerInstanceIdHash: string;
  readonly priorClaimEpoch: number;
  readonly successorOwnerInstanceIdHash: string;
  readonly observationHash: string;
}

export interface TrustedOneUseClaimRecoveryAuthorization {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.one-use-claim-recovery-authorization.v1";
  readonly authorizationId: string;
  readonly requestId: string;
  readonly requestHash: string;
  readonly recoveryRecordHash: string;
  readonly dispositionAttestationHash: string;
  readonly priorClaimTokenHash: string;
  readonly priorOwnerInstanceIdHash: string;
  readonly priorClaimEpoch: number;
  readonly successorOwnerInstanceIdHash: string;
  readonly observationHash: string;
  readonly providerTerminationAttestationHash: string;
  readonly authorityAttestationHash: string;
  readonly authorizedAt: string;
  readonly signerKeyId: string;
  readonly authorizationHash: string;
}

/**
 * The implementation verifies provider evidence and signs/attests the exact
 * recovery observation outside this package. Returning `null` means that
 * predecessor termination was not proven. The ledger never accepts caller-
 * supplied provider evidence directly.
 */
export interface TrustedOneUseClaimRecoveryAuthority {
  readonly boundary: "trusted-cloud-provider-termination-authority";
  authorize(
    observation: OneUseClaimRecoveryObservation,
  ): Promise<TrustedOneUseClaimRecoveryAuthorization | null>;
}

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
  inspect(requestId: string, requestHash: string): Promise<OneUseLedgerInspection>;

  /**
   * Rotates an in-flight claim to this controller only after a trusted
   * authority proves termination of the exact prior owner. The exact durable
   * post-destruction record is part of the authorization, so recovery cannot
   * be used to rerun an evaluation or substitute another release.
   */
  recoverInFlight(input: {
    readonly requestId: string;
    readonly requestHash: string;
    readonly recoveryRecordHash: string;
  }): Promise<OneUseClaim>;

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
  readonly ownerInstanceIdHash: string;
  readonly claimEpoch: number;
  readonly recoveryRecordHash: string | null;
  readonly recoveryAuthorizationHash: string | null;
  readonly envelope: SignedResultEnvelope | null;
  readonly failureCode: BrokerFailureCode | null;
}

export interface OneUseLedgerState {
  readonly revision: number;
  readonly records: Readonly<Record<string, OneUseLedgerRecord>>;
  readonly usedDispositionAttestations: readonly string[];
  readonly usedRecoveryAuthorizations: readonly string[];
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
  /** SHA-256 commitment to this unique cloud controller/sandbox instance. */
  readonly controllerInstanceIdHash: string;
  readonly recoveryAuthority?: TrustedOneUseClaimRecoveryAuthority;
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
    usedRecoveryAuthorizations: [],
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

export function assertOneUseLedgerInspection(inspection: OneUseLedgerInspection): void {
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
  usedRecoveryAuthorizations = state.usedRecoveryAuthorizations,
): OneUseLedgerState {
  return {
    revision: state.revision + 1,
    records,
    usedDispositionAttestations,
    usedRecoveryAuthorizations,
  };
}

function claimTokenHash(claimToken: string): string {
  return canonicalHash({
    domain: "dark-factory.one-use-claim-token.v1",
    claimToken,
  });
}

function recoveryObservation(
  input: {
    readonly requestId: string;
    readonly requestHash: string;
    readonly recoveryRecordHash: string;
  },
  record: OneUseLedgerRecord,
  successorOwnerInstanceIdHash: string,
): OneUseClaimRecoveryObservation {
  if (record.dispositionAttestationHash === null || record.status !== "in-flight") {
    throw new OneUseLedgerError("Only a disposition-bound in-flight claim can be recovered.");
  }
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.one-use-claim-recovery-observation.v1" as const,
    requestId: input.requestId,
    requestHash: input.requestHash,
    recoveryRecordHash: input.recoveryRecordHash,
    dispositionAttestationHash: record.dispositionAttestationHash,
    priorClaimTokenHash: claimTokenHash(record.claimToken),
    priorOwnerInstanceIdHash: record.ownerInstanceIdHash,
    priorClaimEpoch: record.claimEpoch,
    successorOwnerInstanceIdHash,
  };
  return {
    ...unsigned,
    observationHash: canonicalHash(unsigned),
  };
}

export function hashOneUseClaimRecoveryAuthorization(
  authorization: Omit<TrustedOneUseClaimRecoveryAuthorization, "authorizationHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.one-use-claim-recovery-authorization-hash.v1",
    authorization,
  });
}

function assertRecoveryAuthorization(
  authorization: TrustedOneUseClaimRecoveryAuthorization,
  observation: OneUseClaimRecoveryObservation,
): void {
  const authorizedAt = Date.parse(authorization.authorizedAt);
  const { authorizationHash: _authorizationHash, ...unsigned } = authorization;
  if (
    authorization.schemaVersion !== 1 ||
    authorization.domain !== "dark-factory.one-use-claim-recovery-authorization.v1" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(authorization.authorizationId) ||
    authorization.requestId !== observation.requestId ||
    authorization.requestHash !== observation.requestHash ||
    authorization.recoveryRecordHash !== observation.recoveryRecordHash ||
    authorization.dispositionAttestationHash !== observation.dispositionAttestationHash ||
    authorization.priorClaimTokenHash !== observation.priorClaimTokenHash ||
    authorization.priorOwnerInstanceIdHash !== observation.priorOwnerInstanceIdHash ||
    authorization.priorClaimEpoch !== observation.priorClaimEpoch ||
    authorization.successorOwnerInstanceIdHash !== observation.successorOwnerInstanceIdHash ||
    authorization.observationHash !== observation.observationHash ||
    authorization.priorOwnerInstanceIdHash === authorization.successorOwnerInstanceIdHash ||
    !/^[a-f0-9]{64}$/u.test(authorization.providerTerminationAttestationHash) ||
    !/^[a-f0-9]{64}$/u.test(authorization.authorityAttestationHash) ||
    !Number.isFinite(authorizedAt) ||
    new Date(authorizedAt).toISOString() !== authorization.authorizedAt ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(authorization.signerKeyId) ||
    authorization.authorizationHash !== hashOneUseClaimRecoveryAuthorization(unsigned)
  ) {
    throw new OneUseLedgerError("Claim recovery authorization is malformed or detached.");
  }
}

/**
 * Durable behavior comes from the injected linearizable cloud store. There is
 * intentionally no filesystem or process-local fallback.
 */
export class DurableOneUseRequestLedger implements OneUseRequestLedger {
  readonly #store: AtomicOneUseLedgerStore;
  readonly #controllerInstanceIdHash: string;
  readonly #recoveryAuthority: TrustedOneUseClaimRecoveryAuthority | undefined;
  readonly #retryAfterMs: number;
  readonly #claimTokenFactory: () => string;

  constructor(options: DurableOneUseRequestLedgerOptions) {
    this.#store = options.store;
    this.#controllerInstanceIdHash = options.controllerInstanceIdHash;
    this.#recoveryAuthority = options.recoveryAuthority;
    this.#retryAfterMs = options.retryAfterMs ?? 5_000;
    this.#claimTokenFactory =
      options.claimTokenFactory ?? (() => `claim-${randomBytes(24).toString("base64url")}`);
    if (
      !/^[a-f0-9]{64}$/u.test(this.#controllerInstanceIdHash) ||
      (this.#recoveryAuthority !== undefined &&
        (this.#recoveryAuthority.boundary !== "trusted-cloud-provider-termination-authority" ||
          typeof this.#recoveryAuthority.authorize !== "function")) ||
      !Number.isSafeInteger(this.#retryAfterMs) ||
      this.#retryAfterMs <= 0 ||
      this.#retryAfterMs > 60 * 60_000
    ) {
      throw new OneUseLedgerError("Ledger retry interval is outside policy.");
    }
  }

  claim(requestId: string, requestHash: string): Promise<OneUseClaim> {
    assertRequestIdentity(requestId, requestHash);
    return this.#store.transact<OneUseClaim>((state) => {
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
        ownerInstanceIdHash: this.#controllerInstanceIdHash,
        claimEpoch: 1,
        recoveryRecordHash: null,
        recoveryAuthorizationHash: null,
        envelope: null,
        failureCode: null,
      };
      return {
        next: nextState(state, { ...state.records, [requestId]: record }),
        result: { state: "acquired" as const, claimToken },
      };
    });
  }

  inspect(requestId: string, requestHash: string): Promise<OneUseLedgerInspection> {
    assertRequestIdentity(requestId, requestHash);
    return this.#store.transact<OneUseLedgerInspection>((state) => {
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
    });
  }

  async recoverInFlight(input: {
    readonly requestId: string;
    readonly requestHash: string;
    readonly recoveryRecordHash: string;
  }): Promise<OneUseClaim> {
    assertRequestIdentity(input.requestId, input.requestHash);
    if (!/^[a-f0-9]{64}$/u.test(input.recoveryRecordHash)) {
      throw new OneUseLedgerError("Claim recovery record commitment is malformed.");
    }
    const observed = await this.#store.transact((state) => {
      const record = state.records[input.requestId];
      return { next: state, result: record };
    });
    if (observed === undefined) {
      throw new OneUseLedgerError("An absent one-use claim cannot be recovered.");
    }
    if (observed.requestHash !== input.requestHash) {
      return { state: "conflict" };
    }
    if (observed.status === "completed") {
      if (observed.envelope === null) {
        throw new OneUseLedgerError("Completed ledger record has no signed envelope.");
      }
      return {
        state: "completed",
        requestHash: input.requestHash,
        envelope: observed.envelope,
      };
    }
    if (observed.status === "consumed") {
      if (observed.failureCode === null) {
        throw new OneUseLedgerError("Consumed ledger record has no failure code.");
      }
      return {
        state: "consumed",
        requestHash: input.requestHash,
        failureCode: observed.failureCode,
      };
    }
    if (
      observed.ownerInstanceIdHash === this.#controllerInstanceIdHash &&
      observed.recoveryRecordHash === input.recoveryRecordHash &&
      observed.recoveryAuthorizationHash !== null
    ) {
      return {
        state: "acquired",
        claimToken: observed.claimToken,
      };
    }
    if (this.#recoveryAuthority === undefined) {
      throw new OneUseLedgerError("Provider-termination-attested claim recovery is unavailable.");
    }
    const observation = recoveryObservation(input, observed, this.#controllerInstanceIdHash);
    const authorization = await this.#recoveryAuthority.authorize(observation);
    if (authorization === null) {
      throw new OneUseLedgerError(
        "The recovery authority did not prove prior controller termination.",
      );
    }
    assertRecoveryAuthorization(authorization, observation);
    const replacementClaimToken = this.#claimTokenFactory();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(replacementClaimToken)) {
      throw new OneUseLedgerError("Claim token factory returned an unsafe token.");
    }
    return this.#store.transact<OneUseClaim>((state) => {
      const current = state.records[input.requestId];
      if (current === undefined) {
        throw new OneUseLedgerError("Claim disappeared during recovery.");
      }
      if (current.requestHash !== input.requestHash) {
        return {
          next: state,
          result: { state: "conflict" as const },
        };
      }
      if (current.status === "completed") {
        if (current.envelope === null) {
          throw new OneUseLedgerError("Completed ledger record has no signed envelope.");
        }
        return {
          next: state,
          result: {
            state: "completed" as const,
            requestHash: input.requestHash,
            envelope: current.envelope,
          },
        };
      }
      if (current.status === "consumed") {
        if (current.failureCode === null) {
          throw new OneUseLedgerError("Consumed ledger record has no failure code.");
        }
        return {
          next: state,
          result: {
            state: "consumed" as const,
            requestHash: input.requestHash,
            failureCode: current.failureCode,
          },
        };
      }
      if (
        current.claimToken !== observed.claimToken ||
        current.ownerInstanceIdHash !== observed.ownerInstanceIdHash ||
        current.claimEpoch !== observed.claimEpoch ||
        current.dispositionAttestationHash !== observed.dispositionAttestationHash ||
        current.recoveryRecordHash !== observed.recoveryRecordHash ||
        current.recoveryAuthorizationHash !== observed.recoveryAuthorizationHash
      ) {
        throw new OneUseLedgerError("Claim changed while recovery authorization was pending.");
      }
      if (
        state.usedRecoveryAuthorizations.includes(authorization.authorizationHash) ||
        Object.values(state.records).some((record) => record.claimToken === replacementClaimToken)
      ) {
        throw new OneUseLedgerError(
          "Claim recovery authorization or replacement token was reused.",
        );
      }
      const recovered: OneUseLedgerRecord = {
        ...current,
        claimToken: replacementClaimToken,
        ownerInstanceIdHash: this.#controllerInstanceIdHash,
        claimEpoch: current.claimEpoch + 1,
        recoveryRecordHash: input.recoveryRecordHash,
        recoveryAuthorizationHash: authorization.authorizationHash,
      };
      return {
        next: nextState(
          state,
          {
            ...state.records,
            [input.requestId]: recovered,
          },
          state.usedDispositionAttestations,
          [...state.usedRecoveryAuthorizations, authorization.authorizationHash],
        ),
        result: {
          state: "acquired" as const,
          claimToken: replacementClaimToken,
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
