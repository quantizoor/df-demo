import { createHash } from "node:crypto";
import { betaCredibleInterval, type CredibleInterval, jeffreysPosterior } from "./statistics.js";
import type { HiddenTaskId } from "./types.js";

export const CACHE_POLICY_VERSION = "champion-cache-v1";
export const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type FreshnessBand = "0-24h" | "1-3d" | "3-7d";
export type CacheReuseStatus =
  | "eligible"
  | "hard-miss"
  | "expired"
  | "no-valid-observations"
  | "too-uncertain"
  | "environment-mismatch";

export interface CacheKeyMaterial {
  readonly taskRevisionDigest: string;
  readonly harnessCommit: string;
  readonly harnessConfigurationHash: string;
  readonly modelId: string;
  readonly modelProviderVersion: string;
  readonly reasoningSettingsHash: string;
  readonly samplingSettingsHash: string;
  readonly contextSettingsHash: string;
  readonly datasetVersion: string;
  readonly harborVersion: string;
  readonly sandboxProvider: string;
  readonly imageDigest: string;
  readonly architecture: string;
  readonly resourceHash: string;
  readonly regionClass: string;
  readonly networkPolicyHash: string;
  readonly protocolHash: string;
}

export interface SignedCacheObservation {
  readonly taskId: HiddenTaskId;
  readonly taskRevisionDigest: string;
  readonly cacheKeyDigest: string;
  readonly attemptDigest: string;
  readonly observedAt: string;
  readonly pass: boolean;
  readonly reward: number;
  readonly infrastructureValid: boolean;
  readonly evaluatorSignature: CacheObservationSignature;
  readonly environmentFingerprintHash: string;
  readonly latencyMs: number;
  readonly tokenCount: number;
  readonly costUsd: number;
}

export interface CacheObservationSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly signedAt: string;
  readonly signature: string;
}

export type UnsignedCacheObservation = Omit<SignedCacheObservation, "evaluatorSignature">;

export interface CacheObservationSignatureVerifier {
  readonly verify: (
    observation: UnsignedCacheObservation,
    signature: CacheObservationSignature,
  ) => boolean;
}

export interface HiddenCacheEntry {
  readonly taskId: HiddenTaskId;
  readonly key: CacheKeyMaterial;
  readonly observations: readonly SignedCacheObservation[];
}

export interface CacheDistribution {
  readonly validAttempts: number;
  readonly passes: number;
  readonly failures: number;
  readonly passRate: number;
  readonly rewardMean: number;
  readonly rewardVariance: number;
  readonly interval95: CredibleInterval;
  readonly oldestFreshnessBand: FreshnessBand;
  readonly freshnessBands: readonly FreshnessBand[];
  readonly firstObservationAt: string;
  readonly lastObservationAt: string;
  readonly latencyMeanMs: number;
  readonly tokenMean: number;
  readonly costMeanUsd: number;
}

export interface CacheEvaluation {
  readonly status: CacheReuseStatus;
  readonly eligibleObservations: readonly SignedCacheObservation[];
  readonly distribution: CacheDistribution | null;
}

export interface HiddenCacheHit {
  readonly taskId: HiddenTaskId;
  readonly key: CacheKeyMaterial;
  readonly distribution: CacheDistribution;
  readonly exposureAge: number;
  readonly difficultyStratum: string;
  readonly capabilityStratum: string;
}

export interface HiddenDriftCohort {
  readonly cohortDigest: string;
  readonly anchors: readonly HiddenCacheHit[];
  readonly hits: readonly HiddenCacheHit[];
}

export interface DriftAnchorObservation {
  readonly predictedPassProbability: number;
  readonly freshPass: boolean;
  readonly environmentFingerprintMatches: boolean;
}

export interface DriftResult {
  readonly status: "pass" | "fail";
  readonly exactTailProbability: number;
  readonly observedSurprisal: number | null;
  readonly reason: "within-tolerance" | "predictive-tail" | "environment-mismatch";
}

export interface ReleaseSafeCacheAttestation {
  readonly policyVersion: typeof CACHE_POLICY_VERSION;
  readonly cacheUse: "none" | "eligible-cohorts" | "cohort-invalidated";
  readonly driftStatus: "not-required" | "pass" | "fail";
  readonly freshnessBands: readonly FreshnessBand[];
  readonly smallCountSuppressed: true;
  readonly withinRepairBudget: boolean;
  readonly aggregateCostUsd: number;
  readonly containsTaskKeys: false;
  readonly containsPerTaskOutcomes: false;
}

export function cacheKeyDigest(key: CacheKeyMaterial): string {
  validateCacheKey(key);
  return createHash("sha256").update(canonicalCacheKey(key)).digest("hex");
}

export function evaluateCacheEntry(
  entry: HiddenCacheEntry,
  expectedKey: CacheKeyMaterial,
  expectedEnvironmentFingerprintHash: string,
  now: Date,
  signatureVerifier: CacheObservationSignatureVerifier,
): CacheEvaluation {
  const expectedDigest = cacheKeyDigest(expectedKey);
  if (!/^[a-f0-9]{64}$/u.test(expectedEnvironmentFingerprintHash)) {
    throw new Error("Expected environment fingerprint must be a SHA-256 digest");
  }
  if (typeof signatureVerifier?.verify !== "function") {
    throw new Error("A cache-observation signature verifier is required");
  }
  if (!/^[a-f0-9]{64}$/u.test(entry.taskId)) {
    throw new Error("Cache entry task ID must be a lowercase SHA-256 digest");
  }
  if (cacheKeyDigest(entry.key) !== expectedDigest) {
    return { status: "hard-miss", eligibleObservations: [], distribution: null };
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new Error("Cache evaluation time must be valid");
  }

  const signedAttempts = new Map<string, SignedCacheObservation>();
  const deduplicated = new Map<string, SignedCacheObservation>();
  let sawExpired = false;
  let sawEnvironmentMismatch = false;
  for (const observation of entry.observations) {
    validateObservation(observation);
    if (
      !verifyObservationSignature(observation, signatureVerifier) ||
      !observation.infrastructureValid
    ) {
      continue;
    }
    if (observation.taskId !== entry.taskId) {
      throw new Error("Signed cache observation is detached from its entry task");
    }
    if (observation.taskRevisionDigest !== entry.key.taskRevisionDigest) {
      throw new Error("Signed cache observation is detached from its entry task revision");
    }
    if (observation.cacheKeyDigest !== expectedDigest) {
      throw new Error("Signed cache observation is detached from its entry key");
    }
    const signedDuplicate = signedAttempts.get(observation.attemptDigest);
    if (signedDuplicate !== undefined && !sameObservation(signedDuplicate, observation)) {
      throw new Error("Conflicting observations share a signed attempt digest");
    }
    signedAttempts.set(observation.attemptDigest, observation);
    const age = nowMs - Date.parse(observation.observedAt);
    if (age < 0 || age > CACHE_MAX_AGE_MS) {
      sawExpired = true;
      continue;
    }
    if (observation.environmentFingerprintHash !== expectedEnvironmentFingerprintHash) {
      sawEnvironmentMismatch = true;
      continue;
    }
    if (!deduplicated.has(observation.attemptDigest)) {
      deduplicated.set(observation.attemptDigest, observation);
    }
  }
  const eligible = [...deduplicated.values()].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  if (eligible.length === 0) {
    return {
      status: sawEnvironmentMismatch
        ? "environment-mismatch"
        : sawExpired
          ? "expired"
          : "no-valid-observations",
      eligibleObservations: [],
      distribution: null,
    };
  }

  const distribution = buildDistribution(eligible, nowMs);
  if (distribution.interval95.width > 0.9) {
    return { status: "too-uncertain", eligibleObservations: eligible, distribution };
  }
  return { status: "eligible", eligibleObservations: eligible, distribution };
}

export function selectDriftAnchors(hits: readonly HiddenCacheHit[]): readonly HiddenDriftCohort[] {
  const grouped = new Map<string, HiddenCacheHit[]>();
  for (const hit of hits) {
    if (
      !Number.isSafeInteger(hit.exposureAge) ||
      hit.exposureAge < 0 ||
      hit.difficultyStratum.length === 0 ||
      hit.capabilityStratum.length === 0
    ) {
      throw new Error("Invalid hidden cache-hit cohort metadata");
    }
    const digest = driftCohortDigest(hit);
    const group = grouped.get(digest) ?? [];
    group.push(hit);
    grouped.set(digest, group);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cohortDigest, cohortHits]) => {
      const sorted = [...cohortHits].sort((left, right) => {
        const stalenessDelta =
          freshnessRank(right.distribution.oldestFreshnessBand) -
          freshnessRank(left.distribution.oldestFreshnessBand);
        if (stalenessDelta !== 0) {
          return stalenessDelta;
        }
        if (left.exposureAge !== right.exposureAge) {
          return right.exposureAge - left.exposureAge;
        }
        return left.taskId.localeCompare(right.taskId);
      });
      const anchorCount = Math.max(1, Math.ceil(sorted.length * 0.25));
      return { cohortDigest, anchors: sorted.slice(0, anchorCount), hits: sorted };
    });
}

export function evaluateDrift(
  anchors: readonly DriftAnchorObservation[],
  threshold = 0.01,
): DriftResult {
  if (anchors.length === 0) {
    throw new Error("A nonempty drift cohort is required");
  }
  if (anchors.length > 20) {
    throw new Error("Exact drift-tail enumeration is limited to twenty anchors");
  }
  if (!(threshold > 0 && threshold < 1)) {
    throw new Error("Drift threshold must be in (0, 1)");
  }
  for (const anchor of anchors) {
    if (
      !Number.isFinite(anchor.predictedPassProbability) ||
      anchor.predictedPassProbability <= 0 ||
      anchor.predictedPassProbability >= 1
    ) {
      throw new Error("Predictive probabilities must be strictly between zero and one");
    }
    if (!anchor.environmentFingerprintMatches) {
      return {
        status: "fail",
        exactTailProbability: 0,
        observedSurprisal: null,
        reason: "environment-mismatch",
      };
    }
  }

  const observedSurprisal = anchors.reduce(
    (sum, anchor) =>
      sum -
      Math.log(
        anchor.freshPass ? anchor.predictedPassProbability : 1 - anchor.predictedPassProbability,
      ),
    0,
  );
  let exactTailProbability = 0;
  const outcomes = 2 ** anchors.length;
  for (let mask = 0; mask < outcomes; mask += 1) {
    let probability = 1;
    let surprisal = 0;
    anchors.forEach((anchor, index) => {
      const pass = (mask & (1 << index)) !== 0;
      const outcomeProbability = pass
        ? anchor.predictedPassProbability
        : 1 - anchor.predictedPassProbability;
      probability *= outcomeProbability;
      surprisal -= Math.log(outcomeProbability);
    });
    if (surprisal + 1e-12 >= observedSurprisal) {
      exactTailProbability += probability;
    }
  }
  const failed = exactTailProbability <= threshold;
  return {
    status: failed ? "fail" : "pass",
    exactTailProbability,
    observedSurprisal,
    reason: failed ? "predictive-tail" : "within-tolerance",
  };
}

export function makeReleaseSafeCacheAttestation(input: {
  readonly cacheUse: ReleaseSafeCacheAttestation["cacheUse"];
  readonly driftStatus: ReleaseSafeCacheAttestation["driftStatus"];
  readonly freshnessBands: readonly FreshnessBand[];
  readonly withinRepairBudget: boolean;
  readonly aggregateCostUsd: number;
}): ReleaseSafeCacheAttestation {
  if (!Number.isFinite(input.aggregateCostUsd) || input.aggregateCostUsd < 0) {
    throw new Error("Aggregate cache cost must be finite and non-negative");
  }
  return {
    policyVersion: CACHE_POLICY_VERSION,
    cacheUse: input.cacheUse,
    driftStatus: input.driftStatus,
    freshnessBands: [...new Set(input.freshnessBands)].sort(
      (left, right) => freshnessRank(left) - freshnessRank(right),
    ),
    smallCountSuppressed: true,
    withinRepairBudget: input.withinRepairBudget,
    aggregateCostUsd: input.aggregateCostUsd,
    containsTaskKeys: false,
    containsPerTaskOutcomes: false,
  };
}

function buildDistribution(
  observations: readonly SignedCacheObservation[],
  nowMs: number,
): CacheDistribution {
  const passes = observations.filter((observation) => observation.pass).length;
  const rewards = observations.map((observation) => observation.reward);
  const rewardMean = mean(rewards);
  const rewardVariance =
    rewards.length < 2
      ? 0
      : rewards.reduce((sum, reward) => sum + (reward - rewardMean) ** 2, 0) / (rewards.length - 1);
  const bands = observations.map((observation) =>
    freshnessBand(nowMs - Date.parse(observation.observedAt)),
  );
  const first = observations[0];
  const last = observations.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("A cache distribution requires observations");
  }
  return {
    validAttempts: observations.length,
    passes,
    failures: observations.length - passes,
    passRate: passes / observations.length,
    rewardMean,
    rewardVariance,
    interval95: betaCredibleInterval(jeffreysPosterior(passes, observations.length - passes)),
    oldestFreshnessBand: bands.reduce((oldest, band) =>
      freshnessRank(band) > freshnessRank(oldest) ? band : oldest,
    ),
    freshnessBands: [...new Set(bands)].sort(
      (left, right) => freshnessRank(left) - freshnessRank(right),
    ),
    firstObservationAt: first.observedAt,
    lastObservationAt: last.observedAt,
    latencyMeanMs: mean(observations.map((observation) => observation.latencyMs)),
    tokenMean: mean(observations.map((observation) => observation.tokenCount)),
    costMeanUsd: mean(observations.map((observation) => observation.costUsd)),
  };
}

function driftCohortDigest(hit: HiddenCacheHit): string {
  const key = hit.key;
  const nonTaskMaterial = {
    harnessCommit: key.harnessCommit,
    harnessConfigurationHash: key.harnessConfigurationHash,
    modelId: key.modelId,
    modelProviderVersion: key.modelProviderVersion,
    reasoningSettingsHash: key.reasoningSettingsHash,
    samplingSettingsHash: key.samplingSettingsHash,
    contextSettingsHash: key.contextSettingsHash,
    datasetVersion: key.datasetVersion,
    harborVersion: key.harborVersion,
    sandboxProvider: key.sandboxProvider,
    imageDigest: key.imageDigest,
    architecture: key.architecture,
    resourceHash: key.resourceHash,
    regionClass: key.regionClass,
    networkPolicyHash: key.networkPolicyHash,
    protocolHash: key.protocolHash,
    difficultyStratum: hit.difficultyStratum,
    capabilityStratum: hit.capabilityStratum,
  };
  return createHash("sha256").update(JSON.stringify(nonTaskMaterial)).digest("hex");
}

function canonicalCacheKey(key: CacheKeyMaterial): string {
  return JSON.stringify([
    key.taskRevisionDigest,
    key.harnessCommit,
    key.harnessConfigurationHash,
    key.modelId,
    key.modelProviderVersion,
    key.reasoningSettingsHash,
    key.samplingSettingsHash,
    key.contextSettingsHash,
    key.datasetVersion,
    key.harborVersion,
    key.sandboxProvider,
    key.imageDigest,
    key.architecture,
    key.resourceHash,
    key.regionClass,
    key.networkPolicyHash,
    key.protocolHash,
  ]);
}

function validateCacheKey(key: CacheKeyMaterial): void {
  for (const [field, value] of Object.entries(key)) {
    if (typeof value !== "string" || value.length === 0 || value.length > 512) {
      throw new Error(`Cache key field ${field} must be a bounded nonempty string`);
    }
  }
  for (const field of [
    "taskRevisionDigest",
    "harnessConfigurationHash",
    "reasoningSettingsHash",
    "samplingSettingsHash",
    "contextSettingsHash",
    "resourceHash",
    "networkPolicyHash",
    "protocolHash",
  ] as const) {
    if (!/^[a-f0-9]{64}$/u.test(key[field])) {
      throw new Error(`Cache key field ${field} must be a lowercase SHA-256 digest`);
    }
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(key.harnessCommit)) {
    throw new Error(
      "Cache key field harnessCommit must be an exact lowercase Git commit (40 or 64 hex characters)",
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(key.imageDigest)) {
    throw new Error("Cache key field imageDigest must be a lowercase OCI sha256 digest");
  }
}

function validateObservation(observation: SignedCacheObservation): void {
  const signatureValue: unknown = observation.evaluatorSignature;
  if (!isCacheObservationSignature(signatureValue)) {
    throw new Error("Invalid signed cache observation");
  }
  const signature = signatureValue;
  const observedAt = Date.parse(observation.observedAt);
  const signedAt = Date.parse(signature.signedAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(signedAt) ||
    signedAt < observedAt ||
    signedAt - observedAt > 5 * 60_000 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(observation.observedAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(signature.signedAt) ||
    !/^[a-f0-9]{64}$/u.test(observation.taskId) ||
    !/^[a-f0-9]{64}$/u.test(observation.taskRevisionDigest) ||
    !/^[a-f0-9]{64}$/u.test(observation.cacheKeyDigest) ||
    !/^[a-f0-9]{64}$/u.test(observation.attemptDigest) ||
    !/^[a-f0-9]{64}$/u.test(observation.environmentFingerprintHash) ||
    typeof observation.pass !== "boolean" ||
    typeof observation.infrastructureValid !== "boolean" ||
    !Number.isFinite(observation.reward) ||
    observation.reward < 0 ||
    observation.reward > 1 ||
    !Number.isFinite(observation.latencyMs) ||
    observation.latencyMs < 0 ||
    !Number.isSafeInteger(observation.tokenCount) ||
    observation.tokenCount < 0 ||
    !Number.isFinite(observation.costUsd) ||
    observation.costUsd < 0
  ) {
    throw new Error("Invalid signed cache observation");
  }
}

function isCacheObservationSignature(value: unknown): value is CacheObservationSignature {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const signature = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(signature);
  return (
    keys.length === 4 &&
    keys.every((key) => ["algorithm", "keyId", "signedAt", "signature"].includes(key)) &&
    signature.algorithm === "ed25519" &&
    typeof signature.keyId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(signature.keyId) &&
    typeof signature.signedAt === "string" &&
    typeof signature.signature === "string" &&
    signature.signature.length >= 86 &&
    signature.signature.length <= 128 &&
    /^[A-Za-z0-9_-]+={0,2}$/u.test(signature.signature)
  );
}

function verifyObservationSignature(
  observation: SignedCacheObservation,
  signatureVerifier: CacheObservationSignatureVerifier,
): boolean {
  const { evaluatorSignature, ...unsignedObservation } = observation;
  try {
    return signatureVerifier.verify(unsignedObservation, evaluatorSignature) === true;
  } catch {
    return false;
  }
}

function freshnessBand(ageMs: number): FreshnessBand {
  if (ageMs <= 24 * 60 * 60 * 1000) {
    return "0-24h";
  }
  if (ageMs <= 3 * 24 * 60 * 60 * 1000) {
    return "1-3d";
  }
  return "3-7d";
}

function freshnessRank(band: FreshnessBand): number {
  return band === "0-24h" ? 0 : band === "1-3d" ? 1 : 2;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot compute a mean of no values");
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sameObservation(left: SignedCacheObservation, right: SignedCacheObservation): boolean {
  return (
    left.taskId === right.taskId &&
    left.taskRevisionDigest === right.taskRevisionDigest &&
    left.cacheKeyDigest === right.cacheKeyDigest &&
    left.attemptDigest === right.attemptDigest &&
    left.observedAt === right.observedAt &&
    left.pass === right.pass &&
    left.reward === right.reward &&
    left.infrastructureValid === right.infrastructureValid &&
    left.evaluatorSignature.algorithm === right.evaluatorSignature.algorithm &&
    left.evaluatorSignature.keyId === right.evaluatorSignature.keyId &&
    left.evaluatorSignature.signedAt === right.evaluatorSignature.signedAt &&
    left.evaluatorSignature.signature === right.evaluatorSignature.signature &&
    left.environmentFingerprintHash === right.environmentFingerprintHash &&
    left.latencyMs === right.latencyMs &&
    left.tokenCount === right.tokenCount &&
    left.costUsd === right.costUsd
  );
}
