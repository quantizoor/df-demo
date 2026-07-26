import { describe, expect, it } from "vitest";
import {
  DurableOneUseRequestLedger,
  emptyOneUseLedgerState,
  hashOneUseClaimRecoveryAuthorization,
  type AtomicOneUseLedgerStore,
  type OneUseClaimRecoveryObservation,
  type OneUseLedgerState,
  type TrustedOneUseClaimRecoveryAuthorization,
} from "../../src/broker/ledger.js";

class AtomicMemoryStore implements AtomicOneUseLedgerStore {
  state: OneUseLedgerState = emptyOneUseLedgerState();

  transact<Result>(
    operation: (state: OneUseLedgerState) => {
      readonly next: OneUseLedgerState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transaction = operation(this.state);
    this.state = transaction.next;
    return Promise.resolve(transaction.result);
  }
}

describe("durable one-use ledger protocol", () => {
  it("inspects completion state without creating a claim", async () => {
    const store = new AtomicMemoryStore();
    const ledger = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => "claim-001",
    });
    const requestHash = "a".repeat(64);

    await expect(
      ledger.inspect("request-001", requestHash),
    ).resolves.toEqual({ state: "missing" });
    expect(store.state).toEqual(emptyOneUseLedgerState());
  });

  it("is idempotent for one immutable request and rejects request-ID mutation", async () => {
    const ledger = new DurableOneUseRequestLedger({
      store: new AtomicMemoryStore(),
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => "claim-001",
    });
    const requestHash = "a".repeat(64);
    await expect(ledger.claim("request-001", requestHash)).resolves.toEqual({
      state: "acquired",
      claimToken: "claim-001",
    });
    await expect(ledger.claim("request-001", requestHash)).resolves.toMatchObject({
      state: "in-flight",
      requestHash,
    });
    await expect(
      ledger.claim("request-001", "b".repeat(64)),
    ).resolves.toEqual({ state: "conflict" });
  });

  it("globally prevents one disposition attestation from binding twice", async () => {
    const store = new AtomicMemoryStore();
    let ordinal = 0;
    const ledger = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => `claim-${++ordinal}`,
    });
    const firstHash = "a".repeat(64);
    const secondHash = "b".repeat(64);
    const attestation = "c".repeat(64);
    await ledger.claim("request-001", firstHash);
    await ledger.claim("request-002", secondHash);
    await expect(
      ledger.bindDispositionAttestation("claim-1", firstHash, attestation),
    ).resolves.toBe(true);
    await expect(
      ledger.bindDispositionAttestation("claim-2", secondHash, attestation),
    ).resolves.toBe(false);
  });

  it("permanently consumes a failed request without rerunning it", async () => {
    const ledger = new DurableOneUseRequestLedger({
      store: new AtomicMemoryStore(),
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => "claim-001",
    });
    const requestHash = "a".repeat(64);
    await ledger.claim("request-001", requestHash);
    await ledger.consumeFailure(
      "claim-001",
      requestHash,
      "raw-destruction-failed",
    );
    await expect(ledger.claim("request-001", requestHash)).resolves.toEqual({
      state: "consumed",
      requestHash,
      failureCode: "raw-destruction-failed",
    });
  });

  it("rotates an in-flight claim only after exact provider-termination authorization", async () => {
    const store = new AtomicMemoryStore();
    const requestHash = "a".repeat(64);
    const dispositionHash = "b".repeat(64);
    const recoveryRecordHash = "c".repeat(64);
    const predecessor = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => "claim-predecessor",
    });
    await predecessor.claim("request-001", requestHash);
    await predecessor.bindDispositionAttestation(
      "claim-predecessor",
      requestHash,
      dispositionHash,
    );
    let observed:
      | OneUseClaimRecoveryObservation
      | undefined;
    const successor = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "e".repeat(64),
      claimTokenFactory: () => "claim-successor",
      recoveryAuthority: {
        boundary:
          "trusted-cloud-provider-termination-authority",
        authorize: (observation) => {
          observed = observation;
          const unsigned = {
            schemaVersion: 1 as const,
            domain:
              "dark-factory.one-use-claim-recovery-authorization.v1" as const,
            authorizationId: "provider-stop-001",
            requestId: observation.requestId,
            requestHash: observation.requestHash,
            recoveryRecordHash:
              observation.recoveryRecordHash,
            dispositionAttestationHash:
              observation.dispositionAttestationHash,
            priorClaimTokenHash:
              observation.priorClaimTokenHash,
            priorOwnerInstanceIdHash:
              observation.priorOwnerInstanceIdHash,
            priorClaimEpoch: observation.priorClaimEpoch,
            successorOwnerInstanceIdHash:
              observation.successorOwnerInstanceIdHash,
            observationHash: observation.observationHash,
            providerTerminationAttestationHash:
              "f".repeat(64),
            authorityAttestationHash: "1".repeat(64),
            authorizedAt: "2026-07-26T12:00:00.000Z",
            signerKeyId: "provider-termination-key",
          };
          return Promise.resolve({
            ...unsigned,
            authorizationHash:
              hashOneUseClaimRecoveryAuthorization(unsigned),
          });
        },
      },
    });

    await expect(
      successor.recoverInFlight({
        requestId: "request-001",
        requestHash,
        recoveryRecordHash,
      }),
    ).resolves.toEqual({
      state: "acquired",
      claimToken: "claim-successor",
    });
    expect(observed).toMatchObject({
      requestHash,
      recoveryRecordHash,
      dispositionAttestationHash: dispositionHash,
      priorOwnerInstanceIdHash: "d".repeat(64),
      successorOwnerInstanceIdHash: "e".repeat(64),
      priorClaimEpoch: 1,
    });
    await expect(
      successor.recoverInFlight({
        requestId: "request-001",
        requestHash,
        recoveryRecordHash,
      }),
    ).resolves.toEqual({
      state: "acquired",
      claimToken: "claim-successor",
    });
    await expect(
      predecessor.consumeFailure(
        "claim-predecessor",
        requestHash,
        "evaluation-failed",
      ),
    ).rejects.toThrow(/Unknown claim token/u);
  });

  it("fails closed when termination authority changes any recovery binding", async () => {
    const store = new AtomicMemoryStore();
    const requestHash = "a".repeat(64);
    const predecessor = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "d".repeat(64),
      claimTokenFactory: () => "claim-predecessor",
    });
    await predecessor.claim("request-001", requestHash);
    await predecessor.bindDispositionAttestation(
      "claim-predecessor",
      requestHash,
      "b".repeat(64),
    );
    const successor = new DurableOneUseRequestLedger({
      store,
      controllerInstanceIdHash: "e".repeat(64),
      claimTokenFactory: () => "claim-successor",
      recoveryAuthority: {
        boundary:
          "trusted-cloud-provider-termination-authority",
        authorize: (observation) => {
          const unsigned: Omit<
            TrustedOneUseClaimRecoveryAuthorization,
            "authorizationHash"
          > = {
            schemaVersion: 1,
            domain:
              "dark-factory.one-use-claim-recovery-authorization.v1",
            authorizationId: "provider-stop-001",
            requestId: observation.requestId,
            requestHash: "9".repeat(64),
            recoveryRecordHash:
              observation.recoveryRecordHash,
            dispositionAttestationHash:
              observation.dispositionAttestationHash,
            priorClaimTokenHash:
              observation.priorClaimTokenHash,
            priorOwnerInstanceIdHash:
              observation.priorOwnerInstanceIdHash,
            priorClaimEpoch: observation.priorClaimEpoch,
            successorOwnerInstanceIdHash:
              observation.successorOwnerInstanceIdHash,
            observationHash: observation.observationHash,
            providerTerminationAttestationHash:
              "f".repeat(64),
            authorityAttestationHash: "1".repeat(64),
            authorizedAt: "2026-07-26T12:00:00.000Z",
            signerKeyId: "provider-termination-key",
          };
          return Promise.resolve({
            ...unsigned,
            authorizationHash:
              hashOneUseClaimRecoveryAuthorization(unsigned),
          });
        },
      },
    });

    await expect(
      successor.recoverInFlight({
        requestId: "request-001",
        requestHash,
        recoveryRecordHash: "c".repeat(64),
      }),
    ).rejects.toThrow(/malformed or detached/u);
    await expect(
      successor.claim("request-001", requestHash),
    ).resolves.toMatchObject({ state: "in-flight" });
  });
});
