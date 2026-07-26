import {
  assertPostDestructionReleaseRecoveryRecord,
  assertPostDestructionReleaseRecoveryTransition,
  type TrustedPostDestructionReleaseRecoveryRecord,
  type TrustedPostDestructionReleaseRecoveryStore,
  type TrustedReleaseRecoveryResolution,
  type TrustedReleaseRecoveryWriteReceipt,
} from "../evaluator/release-recovery-store.js";
import {
  canonicalHash,
  canonicalJson,
} from "../schemas/canonical.js";
import type {
  ProductionOptimizeLifecycleRegistrar,
  TrustedProductionOptimizeCloseable,
} from "./production-optimize-composition-owner.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_RECORDS = 4_096;
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export interface MountedVolumeReleaseRecoveryStoreOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly lifecycle?: ProductionOptimizeLifecycleRegistrar;
}

interface DurableReleaseRecoveryState {
  readonly schemaVersion: 1;
  readonly sensitivity:
    "trusted-private-post-destruction-release-recovery-state";
  readonly scopeHash: string;
  readonly revision: number;
  readonly records: Readonly<
    Record<string, TrustedPostDestructionReleaseRecoveryRecord>
  >;
}

export class MountedVolumeReleaseRecoveryStoreError extends Error {
  override readonly name =
    "MountedVolumeReleaseRecoveryStoreError";
}

function fail(): never {
  throw new MountedVolumeReleaseRecoveryStoreError(
    "Mounted-volume release recovery state failed closed.",
  );
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail();
  }
}

function clone<Value>(value: Value): Value {
  return JSON.parse(canonicalJson(value)) as Value;
}

function assertState(
  value: unknown,
  scopeHash: string,
): asserts value is DurableReleaseRecoveryState {
  if (!isRecord(value)) fail();
  exactKeys(value, [
    "schemaVersion",
    "sensitivity",
    "scopeHash",
    "revision",
    "records",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.sensitivity !==
      "trusted-private-post-destruction-release-recovery-state" ||
    value.scopeHash !== scopeHash ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isRecord(value.records) ||
    Object.keys(value.records).length > MAXIMUM_RECORDS
  ) {
    fail();
  }
  for (const [requestHash, record] of Object.entries(
    value.records,
  )) {
    if (
      DANGEROUS_KEYS.has(requestHash) ||
      !SHA256.test(requestHash)
    ) {
      fail();
    }
    try {
      assertPostDestructionReleaseRecoveryRecord(record);
    } catch {
      fail();
    }
    if (record.requestHash !== requestHash) fail();
  }
}

function assertQuery(input: {
  readonly requestHash: string;
  readonly protocolHash: string;
}): void {
  if (
    !SHA256.test(input.requestHash) ||
    !SHA256.test(input.protocolHash)
  ) {
    fail();
  }
}

function receipt(
  status: TrustedReleaseRecoveryWriteReceipt["status"],
  record: TrustedPostDestructionReleaseRecoveryRecord,
): TrustedReleaseRecoveryWriteReceipt {
  return {
    status,
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    revision: record.revision,
    recordHash: record.recordHash,
  };
}

/**
 * Fenced exact-query store for evaluator-private post-destruction
 * checkpoints. Provider-termination lock recovery is inherited from
 * `MountedVolumeTransactionalJsonStore`; no workstation fallback exists.
 */
export class MountedVolumeReleaseRecoveryStore
  implements TrustedPostDestructionReleaseRecoveryStore
{
  readonly boundary = "trusted-cloud" as const;
  readonly lifecycleId: string;
  readonly lifecycleResource: TrustedProductionOptimizeCloseable;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableReleaseRecoveryState>;

  constructor(
    options: MountedVolumeReleaseRecoveryStoreOptions,
  ) {
    if (
      !isRecord(options) ||
      (options.lifecycle !== undefined &&
        (options.lifecycle.boundary !==
          "production-optimize-composition-owner" ||
          typeof options.lifecycle.register !== "function"))
    ) {
      fail();
    }
    const scopeHash = canonicalHash({
      domain:
        "dark-factory.post-destruction-release-recovery-store-scope.v1",
      storeId: options.durableState.storeId,
    });
    this.lifecycleId =
      `release-recovery-${scopeHash.slice(0, 24)}`;
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableReleaseRecoveryState>(
        options.durableState,
        `release-recovery-${options.durableState.storeId}`,
        {
          domain:
            "dark-factory.post-destruction-release-recovery-state.v1",
          initialState: () => ({
            schemaVersion: 1,
            sensitivity:
              "trusted-private-post-destruction-release-recovery-state",
            scopeHash,
            revision: 0,
            records: {},
          }),
          assertState(
            value,
          ): asserts value is DurableReleaseRecoveryState {
            assertState(value, scopeHash);
          },
          revision: (state) => state.revision,
        },
      );
    this.lifecycleResource = Object.freeze({
      boundary:
        "trusted-cloud-production-optimize-lifecycle" as const,
      lifecycleId: this.lifecycleId,
      close: (): Promise<void> => this.close(),
    });
    options.lifecycle?.register(this.lifecycleResource);
  }

  async create(
    originalRecord: TrustedPostDestructionReleaseRecoveryRecord,
  ): Promise<TrustedReleaseRecoveryWriteReceipt> {
    const record = clone(originalRecord);
    try {
      assertPostDestructionReleaseRecoveryRecord(record);
    } catch {
      fail();
    }
    if (
      record.revision !== 1 ||
      record.status !== "open" ||
      (record.behavioral.status !== "none" &&
        record.behavioral.status !== "prepared")
    ) {
      fail();
    }
    const transact =
      (): Promise<TrustedReleaseRecoveryWriteReceipt> =>
        this.#store.transact((state) => {
          const existing = state.records[record.requestHash];
          if (existing !== undefined) {
            if (
              existing.protocolHash !== record.protocolHash ||
              canonicalJson(existing) !== canonicalJson(record)
            ) {
              fail();
            }
            return {
              next: state,
              result: receipt("already-created", existing),
            };
          }
          if (
            Object.keys(state.records).length >= MAXIMUM_RECORDS
          ) {
            fail();
          }
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [record.requestHash]: record,
              },
            },
            result: receipt("created", record),
          };
        });
    try {
      return await transact();
    } catch {
      return transact();
    }
  }

  async resolve(originalInput: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }): Promise<TrustedReleaseRecoveryResolution> {
    const input = clone(originalInput);
    assertQuery(input);
    const result = await this.#store.transact((state) => {
      const record = state.records[input.requestHash];
      if (record === undefined) {
        return {
          next: state,
          result: {
            status: "missing" as const,
            requestHash: input.requestHash,
            protocolHash: input.protocolHash,
          },
        };
      }
      if (record.protocolHash !== input.protocolHash) fail();
      return {
        next: state,
        result: {
          status: "found" as const,
          requestHash: input.requestHash,
          protocolHash: input.protocolHash,
          record: clone(record),
        },
      };
    });
    return clone(result);
  }

  async advance(originalInput: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly priorRecordHash: string;
    readonly next: TrustedPostDestructionReleaseRecoveryRecord;
  }): Promise<TrustedReleaseRecoveryWriteReceipt> {
    const input = clone(originalInput);
    assertQuery(input);
    if (
      !SHA256.test(input.priorRecordHash) ||
      input.next.requestHash !== input.requestHash ||
      input.next.protocolHash !== input.protocolHash
    ) {
      fail();
    }
    try {
      assertPostDestructionReleaseRecoveryRecord(input.next);
    } catch {
      fail();
    }
    const transact =
      (): Promise<TrustedReleaseRecoveryWriteReceipt> =>
        this.#store.transact((state) => {
          const existing = state.records[input.requestHash];
          if (
            existing === undefined ||
            existing.protocolHash !== input.protocolHash
          ) {
            fail();
          }
          if (
            existing.recordHash === input.next.recordHash &&
            canonicalJson(existing) ===
              canonicalJson(input.next)
          ) {
            return {
              next: state,
              result: receipt(
                "already-advanced",
                existing,
              ),
            };
          }
          if (existing.recordHash !== input.priorRecordHash) {
            fail();
          }
          try {
            assertPostDestructionReleaseRecoveryTransition(
              existing,
              input.next,
            );
          } catch {
            fail();
          }
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [input.requestHash]: input.next,
              },
            },
            result: receipt("advanced", input.next),
          };
        });
    try {
      return await transact();
    } catch {
      return transact();
    }
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}
