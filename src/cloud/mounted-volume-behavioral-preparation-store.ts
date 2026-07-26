import {
  hashTrustedBehavioralReleaseOrphanFinalization,
  type TrustedBehavioralReleaseFinalization,
  type TrustedBehavioralReleaseOrphanFinalizationReceipt,
} from "../evaluator/behavioral-release-producer.js";
import {
  hashTrustedBehavioralPreparation,
  hashTrustedBehavioralPreparationAbandonment,
  hashTrustedBehavioralPreparationFinalization,
  type TrustedBehavioralPreparationAbandonmentReceipt,
  type TrustedBehavioralPreparationConsumptionReceipt,
  type TrustedBehavioralPreparationFinalizationReceipt,
  type TrustedBehavioralPreparationResolution,
  type TrustedBehavioralPreparationStore,
  type TrustedBehavioralPreparationWriteReceipt,
} from "../evaluator/behavioral-preparation-store.js";
import type {
  TrustedPrivateBehavioralPreparation,
} from "../evaluator/deriver.js";
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
const SAFE_VERSION =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/u;
const MAXIMUM_RECORDS = 4_096;
const MAXIMUM_LITERAL_COUNT = 4_096;
const MAXIMUM_LITERAL_LENGTH = 8_192;
const DANGEROUS_RECORD_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "sensitivity",
  "scopeHash",
  "revision",
  "records",
] as const;
const RECORD_KEYS = [
  "requestHash",
  "protocolHash",
  "behaviorSourceSetHash",
  "preparationHash",
  "status",
  "preparation",
  "sourceResultEnvelopeHash",
  "finalizationHash",
  "finalization",
  "orphanFinalizationHash",
  "abandonmentHash",
  "orphanFinalization",
] as const;
const PREPARATION_KEYS = [
  "sensitivity",
  "requestHash",
  "protocolHash",
  "experimentNumber",
  "behaviorSourceSetHash",
  "analysisWindow",
  "observations",
  "policy",
  "forbiddenReleaseLiterals",
  "forbiddenContentFingerprints",
  "graderCanaryFingerprints",
] as const;
const WINDOW_KEYS = ["openedAt", "closedAt"] as const;
const OBSERVATION_KEYS = [
  "taskId",
  "arm",
  "outcome",
  "behavior",
] as const;
const POLICY_KEYS = [
  "diagnosticsEnabled",
  "comparison",
  "maximumPrivacyReleases",
  "diagnosticTtlMs",
  "policyVersions",
] as const;
const POLICY_VERSION_KEYS = [
  "protocol",
  "broker",
  "extraction",
  "statistics",
  "privacy",
  "weighting",
  "cache",
  "repeatedTesting",
  "leakScanner",
] as const;
const BEHAVIOR_KEYS = [
  "schemaVersion",
  "invocationInvalidity",
  "nonzeroExitFrequency",
  "retryFrequency",
  "repeatedActionFrequency",
  "inspectedAfterNonzeroExit",
  "recoveryAfterFailure",
  "replanAfterFailure",
  "verificationPerformed",
  "planBeforeFirstExecution",
  "compactionFrequency",
  "stopReason",
  "prematureTermination",
  "durationBucket",
  "planningShareBucket",
  "actionShareBucket",
  "ordering",
  "toolUse",
] as const;
const TOOL_USE_KEYS = [
  "read",
  "write",
  "execute",
  "search",
  "plan",
  "inspect",
  "network",
  "other",
] as const;
const FINALIZATION_KEYS = [
  "contentHash",
  "sourceSetHash",
  "privacyThresholdPassed",
  "authorizationHash",
  "requestHash",
] as const;
const ORPHAN_FINALIZATION_KEYS = [
  "status",
  "authorizationHash",
  "requestHash",
  "releaseContentHash",
  "sourceSetHash",
  "orphanedAt",
  "orphanFinalizationHash",
] as const;
const RATIOS = new Set(["none", "low", "medium", "high", "all"]);
const COUNTS = new Set(["none", "one", "two-three", "four-plus"]);
const STOP_REASONS = new Set([
  "completed",
  "agent-stop",
  "timeout",
  "budget",
  "error",
  "unknown",
]);
const DURATIONS = new Set([
  "under-1m",
  "1-5m",
  "5-15m",
  "15m-plus",
]);
const ORDERINGS = new Set([
  "read-before-write",
  "write-before-read",
  "execute-first",
  "no-stateful-action",
  "mixed",
]);

interface DurableBehavioralPreparationRecord {
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly behaviorSourceSetHash: string;
  readonly preparationHash: string;
  readonly status:
    | "prepared"
    | "finalized"
    | "abandoned"
    | "consumed";
  readonly preparation: TrustedPrivateBehavioralPreparation | null;
  readonly sourceResultEnvelopeHash: string | null;
  readonly finalizationHash: string | null;
  readonly finalization: TrustedBehavioralReleaseFinalization | null;
  readonly orphanFinalizationHash: string | null;
  readonly abandonmentHash: string | null;
  readonly orphanFinalization:
    | TrustedBehavioralReleaseOrphanFinalizationReceipt
    | null;
}

interface DurableBehavioralPreparationState {
  readonly schemaVersion: 2;
  readonly sensitivity: "trusted-private-behavioral-preparation-state";
  readonly scopeHash: string;
  readonly revision: number;
  readonly records: Readonly<
    Record<string, DurableBehavioralPreparationRecord>
  >;
}

export interface MountedVolumeBehavioralPreparationStoreOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly lifecycle?: ProductionOptimizeLifecycleRegistrar;
}

export class MountedVolumeBehavioralPreparationStoreError extends Error {
  override readonly name =
    "MountedVolumeBehavioralPreparationStoreError";

  constructor() {
    super(
      "Trusted private behavioral preparation transaction failed closed.",
    );
  }
}

function fail(): never {
  throw new MountedVolumeBehavioralPreparationStoreError();
}

function isPlainRecord(
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
  value: unknown,
  expected: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) fail();
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => !expected.includes(key))
  ) {
    fail();
  }
}

function canonicalClone<Value>(value: Value): Value {
  try {
    return JSON.parse(canonicalJson(value)) as Value;
  } catch {
    return fail();
  }
}

function assertHash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail();
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
}

function assertStringArray(
  value: unknown,
  mode: "literal" | "hash",
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_LITERAL_COUNT ||
    new Set(value).size !== value.length
  ) {
    fail();
  }
  for (const item of value) {
    if (
      typeof item !== "string" ||
      (mode === "hash"
        ? !SHA256.test(item)
        : item.length < 1 ||
          item.length > MAXIMUM_LITERAL_LENGTH)
    ) {
      fail();
    }
  }
}

function assertBehavior(value: unknown): void {
  exactKeys(value, BEHAVIOR_KEYS);
  exactKeys(value.toolUse, TOOL_USE_KEYS);
  if (
    value.schemaVersion !== "behavior-summary-v1" ||
    !RATIOS.has(String(value.invocationInvalidity)) ||
    !RATIOS.has(String(value.nonzeroExitFrequency)) ||
    !COUNTS.has(String(value.retryFrequency)) ||
    !COUNTS.has(String(value.repeatedActionFrequency)) ||
    !RATIOS.has(String(value.inspectedAfterNonzeroExit)) ||
    typeof value.recoveryAfterFailure !== "boolean" ||
    typeof value.replanAfterFailure !== "boolean" ||
    typeof value.verificationPerformed !== "boolean" ||
    typeof value.planBeforeFirstExecution !== "boolean" ||
    !COUNTS.has(String(value.compactionFrequency)) ||
    !STOP_REASONS.has(String(value.stopReason)) ||
    typeof value.prematureTermination !== "boolean" ||
    !DURATIONS.has(String(value.durationBucket)) ||
    !RATIOS.has(String(value.planningShareBucket)) ||
    !RATIOS.has(String(value.actionShareBucket)) ||
    !ORDERINGS.has(String(value.ordering)) ||
    TOOL_USE_KEYS.some((key) =>
      !COUNTS.has(String(value.toolUse[key])),
    )
  ) {
    fail();
  }
}

function assertPreparation(
  value: unknown,
): asserts value is TrustedPrivateBehavioralPreparation {
  exactKeys(value, PREPARATION_KEYS);
  exactKeys(value.analysisWindow, WINDOW_KEYS);
  exactKeys(value.policy, POLICY_KEYS);
  exactKeys(value.policy.policyVersions, POLICY_VERSION_KEYS);
  if (
    value.sensitivity !==
      "trusted-private-behavioral-preparation" ||
    !SHA256.test(String(value.requestHash)) ||
    !SHA256.test(String(value.protocolHash)) ||
    !SHA256.test(String(value.behaviorSourceSetHash)) ||
    !Number.isSafeInteger(value.experimentNumber) ||
    (value.experimentNumber as number) < 1 ||
    !isCanonicalTimestamp(value.analysisWindow.openedAt) ||
    !isCanonicalTimestamp(value.analysisWindow.closedAt) ||
    Date.parse(value.analysisWindow.openedAt as string) >
      Date.parse(value.analysisWindow.closedAt as string) ||
    value.policy.diagnosticsEnabled !== true ||
    value.policy.comparison !== "candidate-vs-champion" ||
    !Number.isSafeInteger(value.policy.maximumPrivacyReleases) ||
    (value.policy.maximumPrivacyReleases as number) < 1 ||
    (value.policy.maximumPrivacyReleases as number) >
      MAXIMUM_RECORDS ||
    !Number.isSafeInteger(value.policy.diagnosticTtlMs) ||
    (value.policy.diagnosticTtlMs as number) < 1 ||
    POLICY_VERSION_KEYS.some(
      (key) =>
        !SAFE_VERSION.test(
          String(value.policy.policyVersions[key]),
        ),
    ) ||
    !Array.isArray(value.observations) ||
    value.observations.length !== 24
  ) {
    fail();
  }
  const taskArms = new Map<string, Set<string>>();
  for (const observation of value.observations) {
    exactKeys(observation, OBSERVATION_KEYS);
    if (
      !SHA256.test(String(observation.taskId)) ||
      (observation.arm !== "candidate" &&
        observation.arm !== "champion") ||
      (observation.outcome !== "pass" &&
        observation.outcome !== "fail")
    ) {
      fail();
    }
    assertBehavior(observation.behavior);
    const arms =
      taskArms.get(observation.taskId as string) ??
      new Set<string>();
    if (arms.has(observation.arm as string)) fail();
    arms.add(observation.arm as string);
    taskArms.set(observation.taskId as string, arms);
  }
  if (
    taskArms.size !== 12 ||
    [...taskArms.values()].some(
      (arms) =>
        arms.size !== 2 ||
        !arms.has("candidate") ||
        !arms.has("champion"),
    )
  ) {
    fail();
  }
  assertStringArray(
    value.forbiddenReleaseLiterals,
    "literal",
  );
  assertStringArray(
    value.forbiddenContentFingerprints,
    "hash",
  );
  assertStringArray(value.graderCanaryFingerprints, "hash");
}

function assertFinalization(
  value: unknown,
): asserts value is TrustedBehavioralReleaseFinalization {
  exactKeys(value, FINALIZATION_KEYS);
  assertHash(value.contentHash);
  assertHash(value.sourceSetHash);
  assertHash(value.authorizationHash);
  assertHash(value.requestHash);
  if (value.privacyThresholdPassed !== true) fail();
}

function assertOrphanFinalization(
  value: unknown,
): asserts value is TrustedBehavioralReleaseOrphanFinalizationReceipt {
  exactKeys(value, ORPHAN_FINALIZATION_KEYS);
  assertHash(value.authorizationHash);
  assertHash(value.requestHash);
  assertHash(value.releaseContentHash);
  assertHash(value.sourceSetHash);
  assertHash(value.orphanFinalizationHash);
  if (
    value.status !== "orphaned" ||
    !isCanonicalTimestamp(value.orphanedAt) ||
    hashTrustedBehavioralReleaseOrphanFinalization({
      authorizationHash: value.authorizationHash,
      requestHash: value.requestHash,
      releaseContentHash: value.releaseContentHash,
      sourceSetHash: value.sourceSetHash,
      orphanedAt: value.orphanedAt,
    }) !== value.orphanFinalizationHash
  ) {
    fail();
  }
}

function assertRecord(
  requestHash: string,
  value: unknown,
): asserts value is DurableBehavioralPreparationRecord {
  assertHash(requestHash);
  exactKeys(value, RECORD_KEYS);
  assertHash(value.requestHash);
  assertHash(value.protocolHash);
  assertHash(value.behaviorSourceSetHash);
  assertHash(value.preparationHash);
  if (
    value.requestHash !== requestHash ||
    (value.status !== "prepared" &&
      value.status !== "finalized" &&
      value.status !== "abandoned" &&
      value.status !== "consumed")
  ) {
    fail();
  }
  if (value.status === "prepared") {
    assertPreparation(value.preparation);
    if (
      value.preparation.requestHash !== value.requestHash ||
      value.preparation.protocolHash !== value.protocolHash ||
      value.preparation.behaviorSourceSetHash !==
        value.behaviorSourceSetHash ||
      hashTrustedBehavioralPreparation(value.preparation) !==
        value.preparationHash ||
      value.sourceResultEnvelopeHash !== null ||
      value.finalizationHash !== null ||
      value.finalization !== null ||
      value.orphanFinalizationHash !== null ||
      value.abandonmentHash !== null ||
      value.orphanFinalization !== null
    ) {
      fail();
    }
    return;
  }
  if (value.preparation !== null) fail();
  if (value.status === "consumed") {
    if (
      value.sourceResultEnvelopeHash !== null ||
      value.finalizationHash !== null ||
      value.finalization !== null ||
      value.orphanFinalizationHash !== null ||
      value.abandonmentHash !== null ||
      value.orphanFinalization !== null
    ) {
      fail();
    }
    return;
  }
  assertHash(value.sourceResultEnvelopeHash);
  assertHash(value.finalizationHash);
  if (value.status === "finalized") {
    assertFinalization(value.finalization);
    if (
      value.finalization.requestHash !== value.requestHash ||
      value.finalization.sourceSetHash !==
        value.behaviorSourceSetHash ||
      hashTrustedBehavioralPreparationFinalization({
        requestHash: value.requestHash,
        protocolHash: value.protocolHash,
        preparationHash: value.preparationHash,
        sourceResultEnvelopeHash:
          value.sourceResultEnvelopeHash,
        finalization: value.finalization,
      }) !== value.finalizationHash ||
      value.orphanFinalizationHash !== null ||
      value.abandonmentHash !== null ||
      value.orphanFinalization !== null
    ) {
      fail();
    }
    return;
  }
  if (value.finalization !== null) fail();
  assertHash(value.orphanFinalizationHash);
  assertHash(value.abandonmentHash);
  assertOrphanFinalization(value.orphanFinalization);
  if (
    value.orphanFinalization.requestHash !== value.requestHash ||
    value.orphanFinalization.sourceSetHash !==
      value.behaviorSourceSetHash ||
    value.orphanFinalizationHash !==
      value.orphanFinalization.orphanFinalizationHash ||
    hashTrustedBehavioralPreparationAbandonment({
      requestHash: value.requestHash,
      protocolHash: value.protocolHash,
      preparationHash: value.preparationHash,
      sourceResultEnvelopeHash:
        value.sourceResultEnvelopeHash,
      finalizationHash: value.finalizationHash,
      orphanFinalizationHash:
        value.orphanFinalizationHash,
    }) !== value.abandonmentHash
  ) {
    fail();
  }
}

function assertState(
  value: unknown,
  scopeHash: string,
): asserts value is DurableBehavioralPreparationState {
  exactKeys(value, TOP_LEVEL_KEYS);
  if (
    value.schemaVersion !== 2 ||
    value.sensitivity !==
      "trusted-private-behavioral-preparation-state" ||
    value.scopeHash !== scopeHash ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !isPlainRecord(value.records) ||
    Object.keys(value.records).length > MAXIMUM_RECORDS
  ) {
    fail();
  }
  let expectedRevision = 0;
  const preparationHashes = new Set<string>();
  const sourceHashes = new Set<string>();
  const authorizationHashes = new Set<string>();
  const releaseHashes = new Set<string>();
  for (const [requestHash, record] of Object.entries(
    value.records,
  )) {
    if (DANGEROUS_RECORD_KEYS.has(requestHash)) fail();
    assertRecord(requestHash, record);
    if (record.status === "prepared") {
      expectedRevision += 1;
    } else if (record.status === "abandoned") {
      expectedRevision += 3;
    } else {
      expectedRevision += 2;
    }
    if (preparationHashes.has(record.preparationHash)) fail();
    preparationHashes.add(record.preparationHash);
    if (
      record.status === "finalized" ||
      record.status === "abandoned"
    ) {
      if (record.sourceResultEnvelopeHash === null) fail();
      let authorizationHash: string;
      let releaseContentHash: string;
      if (record.status === "finalized") {
        if (record.finalization === null) fail();
        authorizationHash =
          record.finalization.authorizationHash;
        releaseContentHash = record.finalization.contentHash;
      } else {
        if (record.orphanFinalization === null) fail();
        authorizationHash =
          record.orphanFinalization.authorizationHash;
        releaseContentHash =
          record.orphanFinalization.releaseContentHash;
      }
      if (
        sourceHashes.has(record.sourceResultEnvelopeHash) ||
        authorizationHashes.has(authorizationHash) ||
        releaseHashes.has(releaseContentHash)
      ) {
        fail();
      }
      sourceHashes.add(record.sourceResultEnvelopeHash);
      authorizationHashes.add(authorizationHash);
      releaseHashes.add(releaseContentHash);
    }
  }
  if (value.revision !== expectedRevision) fail();
}

function assertIdentity(input: {
  readonly requestHash: string;
  readonly protocolHash: string;
}): void {
  assertHash(input.requestHash);
  assertHash(input.protocolHash);
}

function writeReceipt(
  record: DurableBehavioralPreparationRecord,
  status: TrustedBehavioralPreparationWriteReceipt["status"],
): TrustedBehavioralPreparationWriteReceipt {
  return {
    status,
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    preparationHash: record.preparationHash,
  };
}

function finalizationReceipt(
  record: DurableBehavioralPreparationRecord & {
    readonly status: "finalized";
    readonly sourceResultEnvelopeHash: string;
    readonly finalizationHash: string;
  },
  status:
    TrustedBehavioralPreparationFinalizationReceipt["status"],
): TrustedBehavioralPreparationFinalizationReceipt {
  return {
    status,
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    preparationHash: record.preparationHash,
    sourceResultEnvelopeHash: record.sourceResultEnvelopeHash,
    finalizationHash: record.finalizationHash,
  };
}

function abandonmentReceipt(
  record: DurableBehavioralPreparationRecord & {
    readonly status: "abandoned";
    readonly sourceResultEnvelopeHash: string;
    readonly finalizationHash: string;
    readonly orphanFinalizationHash: string;
    readonly abandonmentHash: string;
  },
  status:
    TrustedBehavioralPreparationAbandonmentReceipt["status"],
): TrustedBehavioralPreparationAbandonmentReceipt {
  return {
    status,
    requestHash: record.requestHash,
    protocolHash: record.protocolHash,
    preparationHash: record.preparationHash,
    sourceResultEnvelopeHash: record.sourceResultEnvelopeHash,
    finalizationHash: record.finalizationHash,
    orphanFinalizationHash: record.orphanFinalizationHash,
    abandonmentHash: record.abandonmentHash,
  };
}

/**
 * Fenced private evaluator store. Its only read is an exact request/protocol
 * lookup; finalized, abandoned, and consumed transitions irreversibly erase
 * the task observations from live state. Abandonment can follow only exact
 * finalization and retains no reusable finalization handle.
 */
export class MountedVolumeBehavioralPreparationStore
  implements TrustedBehavioralPreparationStore
{
  readonly boundary = "trusted-cloud" as const;
  readonly lifecycleId: string;
  readonly lifecycleResource: TrustedProductionOptimizeCloseable;
  readonly #store: MountedVolumeTransactionalJsonStore<DurableBehavioralPreparationState>;

  constructor(
    options: MountedVolumeBehavioralPreparationStoreOptions,
  ) {
    exactKeys(options, [
      "durableState",
      ...(options.lifecycle === undefined ? [] : ["lifecycle"]),
    ]);
    if (
      options.lifecycle !== undefined &&
      (options.lifecycle.boundary !==
        "production-optimize-composition-owner" ||
        typeof options.lifecycle.register !== "function")
    ) {
      fail();
    }
    const scopeHash = canonicalHash({
      domain:
        "dark-factory.behavioral-preparation-store-scope.v1",
      storeId: options.durableState.storeId,
    });
    this.lifecycleId =
      `behavioral-preparation-${scopeHash.slice(0, 24)}`;
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableBehavioralPreparationState>(
        options.durableState,
        `behavioral-preparation-${options.durableState.storeId}`,
        {
          domain:
            "dark-factory.behavioral-preparation-state.v2",
          initialState: () => ({
            schemaVersion: 2,
            sensitivity:
              "trusted-private-behavioral-preparation-state",
            scopeHash,
            revision: 0,
            records: {},
          }),
          assertState(
            value,
          ): asserts value is DurableBehavioralPreparationState {
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

  async prepare(
    originalPreparation: TrustedPrivateBehavioralPreparation,
  ): Promise<TrustedBehavioralPreparationWriteReceipt> {
    const preparation = canonicalClone(originalPreparation);
    assertPreparation(preparation);
    const preparationHash =
      hashTrustedBehavioralPreparation(preparation);
    const transact =
      (): Promise<TrustedBehavioralPreparationWriteReceipt> =>
        this.#store.transact((state) => {
          const existing =
            state.records[preparation.requestHash];
          if (existing !== undefined) {
            if (
              existing.status !== "prepared" ||
              existing.protocolHash !== preparation.protocolHash ||
              existing.behaviorSourceSetHash !==
                preparation.behaviorSourceSetHash ||
              existing.preparationHash !== preparationHash ||
              canonicalJson(existing.preparation) !==
                canonicalJson(preparation)
            ) {
              fail();
            }
            return {
              next: state,
              result: writeReceipt(
                existing,
                "already-prepared",
              ),
            };
          }
          if (
            Object.keys(state.records).length >= MAXIMUM_RECORDS
          ) {
            fail();
          }
          const record: DurableBehavioralPreparationRecord = {
            requestHash: preparation.requestHash,
            protocolHash: preparation.protocolHash,
            behaviorSourceSetHash:
              preparation.behaviorSourceSetHash,
            preparationHash,
            status: "prepared",
            preparation,
            sourceResultEnvelopeHash: null,
            finalizationHash: null,
            finalization: null,
            orphanFinalizationHash: null,
            abandonmentHash: null,
            orphanFinalization: null,
          };
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [preparation.requestHash]: record,
              },
            },
            result: writeReceipt(record, "prepared"),
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
  }): Promise<TrustedBehavioralPreparationResolution> {
    const input = canonicalClone(originalInput);
    exactKeys(input, ["requestHash", "protocolHash"]);
    assertIdentity(input);
    const result = await this.#store.transact((state) => {
      const record = state.records[input.requestHash];
      if (record === undefined) {
        return {
          next: state,
          result: {
            status: "missing" as const,
            ...input,
          },
        };
      }
      if (record.protocolHash !== input.protocolHash) fail();
      if (record.status === "prepared") {
        if (record.preparation === null) fail();
        return {
          next: state,
          result: {
            status: "prepared" as const,
            requestHash: record.requestHash,
            protocolHash: record.protocolHash,
            preparationHash: record.preparationHash,
            preparation: record.preparation,
          },
        };
      }
      if (record.status === "consumed") {
        return {
          next: state,
          result: {
            status: "consumed" as const,
            requestHash: record.requestHash,
            protocolHash: record.protocolHash,
            preparationHash: record.preparationHash,
          },
        };
      }
      if (record.status === "abandoned") {
        if (
          record.sourceResultEnvelopeHash === null ||
          record.finalizationHash === null ||
          record.orphanFinalizationHash === null ||
          record.abandonmentHash === null ||
          record.orphanFinalization === null
        ) {
          fail();
        }
        return {
          next: state,
          result: {
            status: "abandoned" as const,
            requestHash: record.requestHash,
            protocolHash: record.protocolHash,
            preparationHash: record.preparationHash,
            sourceResultEnvelopeHash:
              record.sourceResultEnvelopeHash,
            finalizationHash: record.finalizationHash,
            orphanFinalizationHash:
              record.orphanFinalizationHash,
            abandonmentHash: record.abandonmentHash,
            orphanFinalization: record.orphanFinalization,
          },
        };
      }
      if (
        record.sourceResultEnvelopeHash === null ||
        record.finalizationHash === null ||
        record.finalization === null
      ) {
        fail();
      }
      return {
        next: state,
        result: {
          status: "finalized" as const,
          requestHash: record.requestHash,
          protocolHash: record.protocolHash,
          preparationHash: record.preparationHash,
          sourceResultEnvelopeHash:
            record.sourceResultEnvelopeHash,
          finalizationHash: record.finalizationHash,
          finalization: record.finalization,
        },
      };
    });
    return canonicalClone(result);
  }

  async finalize(
    originalInput: Parameters<
      TrustedBehavioralPreparationStore["finalize"]
    >[0],
  ): Promise<TrustedBehavioralPreparationFinalizationReceipt> {
    const input = canonicalClone(originalInput);
    exactKeys(input, [
      "requestHash",
      "protocolHash",
      "preparationHash",
      "sourceResultEnvelopeHash",
      "finalization",
    ]);
    assertIdentity(input);
    assertHash(input.preparationHash);
    assertHash(input.sourceResultEnvelopeHash);
    assertFinalization(input.finalization);
    const finalizationHash =
      hashTrustedBehavioralPreparationFinalization(input);
    const transact =
      (): Promise<TrustedBehavioralPreparationFinalizationReceipt> =>
        this.#store.transact((state) => {
          const existing = state.records[input.requestHash];
          if (
            existing === undefined ||
            existing.protocolHash !== input.protocolHash ||
            existing.preparationHash !==
              input.preparationHash ||
            existing.behaviorSourceSetHash !==
              input.finalization.sourceSetHash ||
            input.finalization.requestHash !==
              input.requestHash
          ) {
            fail();
          }
          if (existing.status === "consumed") fail();
          if (existing.status === "finalized") {
            if (
              existing.sourceResultEnvelopeHash !==
                input.sourceResultEnvelopeHash ||
              existing.finalizationHash !== finalizationHash ||
              canonicalJson(existing.finalization) !==
                canonicalJson(input.finalization)
            ) {
              fail();
            }
            return {
              next: state,
              result: finalizationReceipt(
                existing as DurableBehavioralPreparationRecord & {
                  readonly status: "finalized";
                  readonly sourceResultEnvelopeHash: string;
                  readonly finalizationHash: string;
                },
                "already-finalized",
              ),
            };
          }
          if (
            existing.preparation === null ||
            Object.values(state.records).some(
              (record) =>
                (record.status === "finalized" ||
                  record.status === "abandoned") &&
                (record.sourceResultEnvelopeHash ===
                  input.sourceResultEnvelopeHash ||
                  (record.status === "finalized"
                    ? record.finalization?.authorizationHash
                    : record.orphanFinalization
                        ?.authorizationHash) ===
                    input.finalization.authorizationHash ||
                  (record.status === "finalized"
                    ? record.finalization?.contentHash
                    : record.orphanFinalization
                        ?.releaseContentHash) ===
                    input.finalization.contentHash),
            )
          ) {
            fail();
          }
          const finalized: DurableBehavioralPreparationRecord = {
            ...existing,
            status: "finalized",
            preparation: null,
            sourceResultEnvelopeHash:
              input.sourceResultEnvelopeHash,
            finalizationHash,
            finalization: input.finalization,
            orphanFinalizationHash: null,
            abandonmentHash: null,
            orphanFinalization: null,
          };
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [input.requestHash]: finalized,
              },
            },
            result: finalizationReceipt(
              finalized as DurableBehavioralPreparationRecord & {
                readonly status: "finalized";
                readonly sourceResultEnvelopeHash: string;
                readonly finalizationHash: string;
              },
              "finalized",
            ),
          };
        });
    try {
      return await transact();
    } catch {
      return transact();
    }
  }

  async abandon(
    originalInput: Parameters<
      TrustedBehavioralPreparationStore["abandon"]
    >[0],
  ): Promise<TrustedBehavioralPreparationAbandonmentReceipt> {
    const input = canonicalClone(originalInput);
    exactKeys(input, [
      "requestHash",
      "protocolHash",
      "preparationHash",
      "sourceResultEnvelopeHash",
      "finalizationHash",
      "orphanFinalization",
    ]);
    assertIdentity(input);
    assertHash(input.preparationHash);
    assertHash(input.sourceResultEnvelopeHash);
    assertHash(input.finalizationHash);
    assertOrphanFinalization(input.orphanFinalization);
    const orphanFinalizationHash =
      input.orphanFinalization.orphanFinalizationHash;
    const abandonmentHash =
      hashTrustedBehavioralPreparationAbandonment({
        requestHash: input.requestHash,
        protocolHash: input.protocolHash,
        preparationHash: input.preparationHash,
        sourceResultEnvelopeHash:
          input.sourceResultEnvelopeHash,
        finalizationHash: input.finalizationHash,
        orphanFinalizationHash,
      });
    const transact =
      (): Promise<TrustedBehavioralPreparationAbandonmentReceipt> =>
        this.#store.transact((state) => {
          const existing = state.records[input.requestHash];
          if (
            existing === undefined ||
            existing.protocolHash !== input.protocolHash ||
            existing.preparationHash !==
              input.preparationHash ||
            existing.behaviorSourceSetHash !==
              input.orphanFinalization.sourceSetHash ||
            input.orphanFinalization.requestHash !==
              input.requestHash
          ) {
            fail();
          }
          if (existing.status === "abandoned") {
            if (
              existing.sourceResultEnvelopeHash !==
                input.sourceResultEnvelopeHash ||
              existing.finalizationHash !==
                input.finalizationHash ||
              existing.orphanFinalizationHash !==
                orphanFinalizationHash ||
              existing.abandonmentHash !== abandonmentHash ||
              canonicalJson(existing.orphanFinalization) !==
                canonicalJson(input.orphanFinalization)
            ) {
              fail();
            }
            return {
              next: state,
              result: abandonmentReceipt(
                existing as DurableBehavioralPreparationRecord & {
                  readonly status: "abandoned";
                  readonly sourceResultEnvelopeHash: string;
                  readonly finalizationHash: string;
                  readonly orphanFinalizationHash: string;
                  readonly abandonmentHash: string;
                },
                "already-abandoned",
              ),
            };
          }
          if (
            existing.status !== "finalized" ||
            existing.sourceResultEnvelopeHash !==
              input.sourceResultEnvelopeHash ||
            existing.finalizationHash !==
              input.finalizationHash ||
            existing.finalization === null ||
            existing.finalization.authorizationHash !==
              input.orphanFinalization.authorizationHash ||
            existing.finalization.requestHash !==
              input.orphanFinalization.requestHash ||
            existing.finalization.contentHash !==
              input.orphanFinalization.releaseContentHash ||
            existing.finalization.sourceSetHash !==
              input.orphanFinalization.sourceSetHash
          ) {
            fail();
          }
          const abandoned: DurableBehavioralPreparationRecord = {
            ...existing,
            status: "abandoned",
            finalization: null,
            orphanFinalizationHash,
            abandonmentHash,
            orphanFinalization: input.orphanFinalization,
          };
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [input.requestHash]: abandoned,
              },
            },
            result: abandonmentReceipt(
              abandoned as DurableBehavioralPreparationRecord & {
                readonly status: "abandoned";
                readonly sourceResultEnvelopeHash: string;
                readonly finalizationHash: string;
                readonly orphanFinalizationHash: string;
                readonly abandonmentHash: string;
              },
              "abandoned",
            ),
          };
        });
    try {
      return await transact();
    } catch {
      return transact();
    }
  }

  async consume(originalInput: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }): Promise<TrustedBehavioralPreparationConsumptionReceipt> {
    const input = canonicalClone(originalInput);
    exactKeys(input, ["requestHash", "protocolHash"]);
    assertIdentity(input);
    const transact =
      (): Promise<TrustedBehavioralPreparationConsumptionReceipt> =>
        this.#store.transact((state) => {
          const existing = state.records[input.requestHash];
          if (existing === undefined) {
            return {
              next: state,
              result: {
                status: "missing" as const,
                ...input,
              },
            };
          }
          if (existing.protocolHash !== input.protocolHash) fail();
          if (existing.status === "consumed") {
            return {
              next: state,
              result: {
                status: "already-consumed" as const,
                requestHash: existing.requestHash,
                protocolHash: existing.protocolHash,
                preparationHash: existing.preparationHash,
              },
            };
          }
          if (existing.status === "finalized") {
            if (
              existing.sourceResultEnvelopeHash === null ||
              existing.finalizationHash === null
            ) {
              fail();
            }
            return {
              next: state,
              result: {
                status: "already-finalized" as const,
                requestHash: existing.requestHash,
                protocolHash: existing.protocolHash,
                preparationHash: existing.preparationHash,
                sourceResultEnvelopeHash:
                  existing.sourceResultEnvelopeHash,
                finalizationHash: existing.finalizationHash,
              },
            };
          }
          if (existing.status === "abandoned") {
            if (
              existing.sourceResultEnvelopeHash === null ||
              existing.finalizationHash === null ||
              existing.orphanFinalizationHash === null ||
              existing.abandonmentHash === null
            ) {
              fail();
            }
            return {
              next: state,
              result: {
                status: "already-abandoned" as const,
                requestHash: existing.requestHash,
                protocolHash: existing.protocolHash,
                preparationHash: existing.preparationHash,
                sourceResultEnvelopeHash:
                  existing.sourceResultEnvelopeHash,
                finalizationHash: existing.finalizationHash,
                orphanFinalizationHash:
                  existing.orphanFinalizationHash,
                abandonmentHash: existing.abandonmentHash,
              },
            };
          }
          const consumed: DurableBehavioralPreparationRecord = {
            ...existing,
            status: "consumed",
            preparation: null,
            sourceResultEnvelopeHash: null,
            finalizationHash: null,
            finalization: null,
            orphanFinalizationHash: null,
            abandonmentHash: null,
            orphanFinalization: null,
          };
          return {
            next: {
              ...state,
              revision: state.revision + 1,
              records: {
                ...state.records,
                [input.requestHash]: consumed,
              },
            },
            result: {
              status: "consumed" as const,
              requestHash: consumed.requestHash,
              protocolHash: consumed.protocolHash,
              preparationHash: consumed.preparationHash,
            },
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
