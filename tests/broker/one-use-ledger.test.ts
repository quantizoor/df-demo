import { describe, expect, it } from "vitest";
import {
  DurableOneUseRequestLedger,
  emptyOneUseLedgerState,
  type AtomicOneUseLedgerStore,
  type OneUseLedgerState,
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
  it("is idempotent for one immutable request and rejects request-ID mutation", async () => {
    const ledger = new DurableOneUseRequestLedger({
      store: new AtomicMemoryStore(),
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
});
