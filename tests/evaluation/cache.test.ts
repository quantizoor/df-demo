import { describe, expect, it } from "vitest";
import {
  type CacheDistribution,
  type CacheObservationSignatureVerifier,
  cacheKeyDigest,
  evaluateCacheEntry,
  evaluateDrift,
  type HiddenCacheHit,
  makeReleaseSafeCacheAttestation,
  type SignedCacheObservation,
  selectDriftAnchors,
} from "../../src/evaluation/index.js";
import { cacheKey, digest, ociImageDigest, taskId } from "./fixtures.js";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const ENVIRONMENT = digest(700);
const VALID_SIGNATURE = "A".repeat(86);
const SIGNATURE_VERIFIER: CacheObservationSignatureVerifier = {
  verify: (_observation, signature) =>
    signature.algorithm === "ed25519" &&
    signature.keyId === "evaluator-key-1" &&
    signature.signature === VALID_SIGNATURE,
};

describe("exact-key champion cache", () => {
  it("hard-misses on any complete-key difference", () => {
    const key = cacheKey();
    const result = evaluateCacheEntry(
      cacheEntry(key, [observation(1, key, "2026-07-26T10:00:00.000Z")]),
      cacheKey({ modelProviderVersion: "provider-2" }),
      ENVIRONMENT,
      NOW,
      SIGNATURE_VERIFIER,
    );
    expect(result.status).toBe("hard-miss");
    expect(result.distribution).toBeNull();
  });

  it("invalidates reuse for every cache-key field", () => {
    const key = cacheKey();
    for (const field of Object.keys(key) as (keyof typeof key)[]) {
      const changed = {
        ...key,
        [field]:
          field === "imageDigest"
            ? ociImageDigest(9_000 + Object.keys(key).indexOf(field))
            : digest(9_000 + Object.keys(key).indexOf(field)),
      };
      const result = evaluateCacheEntry(
        cacheEntry(key, [observation(1, key, "2026-07-26T10:00:00.000Z")]),
        changed,
        ENVIRONMENT,
        NOW,
        SIGNATURE_VERIFIER,
      );
      expect(result.status, field).toBe("hard-miss");
    }
  });

  it("distinguishes exact Git object IDs from OCI image digests", () => {
    expect(() =>
      cacheKeyDigest(cacheKey({ harnessCommit: digest(12).slice(0, 40) })),
    ).not.toThrow();
    expect(() => cacheKeyDigest(cacheKey({ harnessCommit: digest(12) }))).not.toThrow();
    expect(() => cacheKeyDigest(cacheKey({ harnessCommit: ociImageDigest(12) }))).toThrow(
      /Git commit/u,
    );
    expect(() => cacheKeyDigest(cacheKey({ imageDigest: digest(12) }))).toThrow(
      /OCI sha256 digest/u,
    );
  });

  it("expires observations individually and never lets a new sample refresh old evidence", () => {
    const key = cacheKey();
    const result = evaluateCacheEntry(
      cacheEntry(key, [
        observation(1, key, "2026-07-10T10:00:00.000Z"),
        observation(2, key, "2026-07-26T10:00:00.000Z"),
      ]),
      key,
      ENVIRONMENT,
      NOW,
      SIGNATURE_VERIFIER,
    );
    expect(result.status).toBe("eligible");
    expect(result.eligibleObservations).toHaveLength(1);
    expect(result.distribution?.validAttempts).toBe(1);
    expect(result.distribution?.oldestFreshnessBand).toBe("0-24h");
  });

  it("deduplicates signed attempt digests and excludes observations rejected by the verifier", () => {
    const key = cacheKey();
    const valid = observation(1, key, "2026-07-25T10:00:00.000Z");
    const untrusted = observation(2, key, "2026-07-25T11:00:00.000Z");
    const result = evaluateCacheEntry(
      cacheEntry(key, [
        valid,
        { ...valid },
        {
          ...untrusted,
          evaluatorSignature: {
            ...untrusted.evaluatorSignature,
            keyId: "untrusted-evaluator-key",
          },
        },
      ]),
      key,
      ENVIRONMENT,
      NOW,
      SIGNATURE_VERIFIER,
    );
    expect(result.eligibleObservations).toHaveLength(1);
    expect(result.distribution?.passes).toBe(1);
  });

  it("requires an explicit signature verifier", () => {
    const key = cacheKey();
    expect(() =>
      evaluateCacheEntry(
        cacheEntry(key, [observation(1, key, "2026-07-25T10:00:00.000Z")]),
        key,
        ENVIRONMENT,
        NOW,
        undefined as never,
      ),
    ).toThrow(/signature verifier is required/u);
  });

  it("rejects observations signed before or long after they were recorded", () => {
    const key = cacheKey();
    const base = observation(1, key, "2026-07-25T10:00:00.000Z");
    for (const signedAt of ["2026-07-25T09:59:59.000Z", "2026-07-25T10:05:01.000Z"]) {
      expect(() =>
        evaluateCacheEntry(
          cacheEntry(key, [
            {
              ...base,
              evaluatorSignature: {
                ...base.evaluatorSignature,
                signedAt,
              },
            },
          ]),
          key,
          ENVIRONMENT,
          NOW,
          SIGNATURE_VERIFIER,
        ),
      ).toThrow(/Invalid signed cache observation/u);
    }
  });

  it("rejects conflicting duplicate digests as cache poisoning", () => {
    const key = cacheKey();
    const valid = observation(1, key, "2026-07-25T10:00:00.000Z");
    expect(() =>
      evaluateCacheEntry(
        cacheEntry(key, [valid, { ...valid, pass: false }]),
        key,
        ENVIRONMENT,
        NOW,
        SIGNATURE_VERIFIER,
      ),
    ).toThrow(/Conflicting observations/u);
  });

  it("rejects observations detached from the entry's hidden task", () => {
    const key = cacheKey();
    const detached = {
      ...observation(1, key, "2026-07-25T10:00:00.000Z"),
      taskId: taskId(2),
    };
    expect(() =>
      evaluateCacheEntry(cacheEntry(key, [detached]), key, ENVIRONMENT, NOW, SIGNATURE_VERIFIER),
    ).toThrow(/entry task$/u);
  });

  it("rejects observations detached from the entry's task revision", () => {
    const key = cacheKey();
    const detached = {
      ...observation(1, key, "2026-07-25T10:00:00.000Z"),
      taskRevisionDigest: digest(999),
    };
    expect(() =>
      evaluateCacheEntry(cacheEntry(key, [detached]), key, ENVIRONMENT, NOW, SIGNATURE_VERIFIER),
    ).toThrow(/entry task revision/u);
  });

  it("fails closed on an environment fingerprint mismatch", () => {
    const key = cacheKey();
    const result = evaluateCacheEntry(
      cacheEntry(key, [observation(1, key, "2026-07-26T10:00:00.000Z")]),
      key,
      digest(999),
      NOW,
      SIGNATURE_VERIFIER,
    );
    expect(result.status).toBe("environment-mismatch");
  });

  it("selects max(1, ceil(25%)) deterministic drift anchors per cohort", () => {
    const hits = Array.from({ length: 5 }, (_, index) =>
      cacheHit(index + 1, index === 0 ? "3-7d" : "0-24h"),
    );
    const cohorts = selectDriftAnchors(hits);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0]?.anchors).toHaveLength(2);
    expect(cohorts[0]?.anchors[0]?.taskId).toBe(taskId(1));
  });

  it("uses an exact posterior-predictive tail and invalidates surprising drift", () => {
    const result = evaluateDrift([
      {
        predictedPassProbability: 0.999,
        freshPass: false,
        environmentFingerprintMatches: true,
      },
    ]);
    expect(result.status).toBe("fail");
    expect(result.exactTailProbability).toBeCloseTo(0.001, 12);
  });

  it("returns no task counts or cache keys in its release-safe attestation", () => {
    const attestation = makeReleaseSafeCacheAttestation({
      cacheUse: "eligible-cohorts",
      driftStatus: "pass",
      freshnessBands: ["1-3d", "0-24h"],
      withinRepairBudget: true,
      aggregateCostUsd: 1.25,
    });
    const serialized = JSON.stringify(attestation);
    expect(serialized).not.toContain("taskId");
    expect(serialized).not.toContain("cacheKey");
    expect(attestation.smallCountSuppressed).toBe(true);
  });
});

function observation(
  index: number,
  key: ReturnType<typeof cacheKey>,
  observedAt: string,
): SignedCacheObservation {
  return {
    taskId: taskId(1),
    taskRevisionDigest: key.taskRevisionDigest,
    cacheKeyDigest: cacheKeyDigest(key),
    attemptDigest: digest(800 + index),
    observedAt,
    pass: true,
    reward: 1,
    infrastructureValid: true,
    evaluatorSignature: {
      algorithm: "ed25519",
      keyId: "evaluator-key-1",
      signedAt: observedAt,
      signature: VALID_SIGNATURE,
    },
    environmentFingerprintHash: ENVIRONMENT,
    latencyMs: 1_000,
    tokenCount: 2_000,
    costUsd: 0.25,
  };
}

function cacheEntry(
  key: ReturnType<typeof cacheKey>,
  observations: readonly SignedCacheObservation[],
) {
  return {
    taskId: taskId(1),
    key,
    observations,
  };
}

function cacheHit(
  index: number,
  oldestFreshnessBand: CacheDistribution["oldestFreshnessBand"],
): HiddenCacheHit {
  const distribution: CacheDistribution = {
    validAttempts: 2,
    passes: 1,
    failures: 1,
    passRate: 0.5,
    rewardMean: 0.5,
    rewardVariance: 0.5,
    interval95: { lower: 0.1, upper: 0.9, width: 0.8 },
    oldestFreshnessBand,
    freshnessBands: [oldestFreshnessBand],
    firstObservationAt: "2026-07-24T00:00:00.000Z",
    lastObservationAt: "2026-07-25T00:00:00.000Z",
    latencyMeanMs: 1_000,
    tokenMean: 2_000,
    costMeanUsd: 0.25,
  };
  return {
    taskId: taskId(index),
    key: cacheKey(),
    distribution,
    exposureAge: 10 - index,
    difficultyStratum: "hard",
    capabilityStratum: "shell",
  };
}
