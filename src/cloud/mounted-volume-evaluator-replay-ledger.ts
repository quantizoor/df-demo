import type {
  CanonicalEvaluatorReplayClaim,
  CanonicalEvaluatorReplayLedger,
} from "../evaluator/canonical-client.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import {
  type MountedVolumeDurableStateOptions,
  MountedVolumeTransactionalJsonStore,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_STORE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAXIMUM_CLAIMS = 100_000;
const DANGEROUS_RECORD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const STATE_KEYS = ["schemaVersion", "sensitivity", "revision", "claims", "requestHashes"] as const;

const CLAIM_KEYS = ["requestId", "requestHash", "claimedAt", "claimHash"] as const;

interface DurableEvaluatorReplayClaim extends CanonicalEvaluatorReplayClaim {
  readonly claimHash: string;
}

interface DurableEvaluatorReplayState {
  readonly schemaVersion: 1;
  readonly sensitivity: "trusted-evaluator-replay-ledger";
  readonly revision: number;
  readonly claims: Readonly<Record<string, DurableEvaluatorReplayClaim>>;
  readonly requestHashes: Readonly<Record<string, string>>;
}

export class MountedVolumeEvaluatorReplayLedgerError extends Error {
  override readonly name = "MountedVolumeEvaluatorReplayLedgerError";

  public constructor() {
    super("Trusted evaluator replay ledger failed closed.");
  }
}

function fail(): never {
  throw new MountedVolumeEvaluatorReplayLedgerError();
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail();
  }
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeRequestId(value: unknown): value is string {
  return (
    typeof value === "string" && SAFE_REQUEST_ID.test(value) && !DANGEROUS_RECORD_KEYS.has(value)
  );
}

function claimHash(claim: CanonicalEvaluatorReplayClaim): string {
  return canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.evaluator-replay-claim.v1",
    requestId: claim.requestId,
    requestHash: claim.requestHash,
    claimedAt: claim.claimedAt,
  });
}

function assertClaim(value: unknown): asserts value is CanonicalEvaluatorReplayClaim {
  exactKeys(value, ["requestId", "requestHash", "claimedAt"]);
  if (
    !safeRequestId(value.requestId) ||
    typeof value.requestHash !== "string" ||
    !SHA256.test(value.requestHash) ||
    !canonicalTimestamp(value.claimedAt)
  ) {
    fail();
  }
}

function assertStoredClaim(
  requestId: string,
  value: unknown,
): asserts value is DurableEvaluatorReplayClaim {
  exactKeys(value, CLAIM_KEYS);
  if (
    value.requestId !== requestId ||
    typeof value.requestHash !== "string" ||
    !SHA256.test(value.requestHash) ||
    !canonicalTimestamp(value.claimedAt) ||
    typeof value.claimHash !== "string" ||
    value.claimHash !==
      claimHash({
        requestId,
        requestHash: value.requestHash,
        claimedAt: value.claimedAt,
      })
  ) {
    fail();
  }
}

function assertState(value: unknown): asserts value is DurableEvaluatorReplayState {
  exactKeys(value, STATE_KEYS);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !== "trusted-evaluator-replay-ledger" ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.claims) ||
    !isPlainRecord(value.requestHashes)
  ) {
    fail();
  }
  const state = value as unknown as DurableEvaluatorReplayState;
  const claimEntries = Object.entries(state.claims);
  const hashEntries = Object.entries(state.requestHashes);
  if (
    claimEntries.length !== state.revision ||
    hashEntries.length !== state.revision ||
    claimEntries.length > MAXIMUM_CLAIMS
  ) {
    fail();
  }
  const observedHashes = new Set<string>();
  for (const [requestId, claim] of claimEntries) {
    if (!safeRequestId(requestId)) fail();
    assertStoredClaim(requestId, claim);
    if (
      observedHashes.has(claim.requestHash) ||
      state.requestHashes[claim.requestHash] !== requestId
    ) {
      fail();
    }
    observedHashes.add(claim.requestHash);
  }
  for (const [requestHash, requestId] of hashEntries) {
    if (
      !SHA256.test(requestHash) ||
      !safeRequestId(requestId) ||
      state.claims[requestId]?.requestHash !== requestHash
    ) {
      fail();
    }
  }
}

function initialState(): DurableEvaluatorReplayState {
  return {
    schemaVersion: 1,
    sensitivity: "trusted-evaluator-replay-ledger",
    revision: 0,
    claims: {},
    requestHashes: {},
  };
}

function cloneCanonical<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

/**
 * Durable one-way replay burn for the release-facing evaluator client.
 *
 * The mounted-volume primitive retains a non-expiring controller fence until
 * close(). A transport failure therefore cannot make a claimed hidden panel
 * reusable after a controller restart.
 */
export class MountedVolumeCanonicalEvaluatorReplayLedger implements CanonicalEvaluatorReplayLedger {
  readonly #store: MountedVolumeTransactionalJsonStore<DurableEvaluatorReplayState>;

  public constructor(options: MountedVolumeDurableStateOptions) {
    if (!SAFE_STORE_ID.test(options.storeId)) fail();
    this.#store = new MountedVolumeTransactionalJsonStore(
      options,
      `evaluator-replay-${options.storeId}`,
      {
        domain: "dark-factory.evaluator-replay-ledger-state.v1",
        initialState,
        assertState,
        revision: (state) => state.revision,
      },
    );
  }

  public async claim(input: CanonicalEvaluatorReplayClaim): Promise<boolean> {
    assertClaim(input);
    const claim = cloneCanonical(input);
    const stored: DurableEvaluatorReplayClaim = {
      ...claim,
      claimHash: claimHash(claim),
    };
    return await this.#store.transact((state) => {
      if (
        Object.hasOwn(state.claims, stored.requestId) ||
        Object.hasOwn(state.requestHashes, stored.requestHash)
      ) {
        return { next: state, result: false };
      }
      if (state.revision >= MAXIMUM_CLAIMS) fail();
      const next: DurableEvaluatorReplayState = {
        ...state,
        revision: state.revision + 1,
        claims: {
          ...state.claims,
          [stored.requestId]: stored,
        },
        requestHashes: {
          ...state.requestHashes,
          [stored.requestHash]: stored.requestId,
        },
      };
      assertState(next);
      return { next, result: true };
    });
  }

  public close(): Promise<void> {
    return this.#store.close();
  }
}
