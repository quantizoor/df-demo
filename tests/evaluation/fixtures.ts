import {
  extractBehaviorSummary,
  hiddenPanelId,
  hiddenTaskId,
  type BehaviorSummary,
  type CacheKeyMaterial,
  type HiddenTaskLedgerEntry,
  type SelectionBucket,
} from "../../src/evaluation/index.js";

export function digest(index: number): string {
  return index.toString(16).padStart(64, "0");
}

export function ociImageDigest(index: number): string {
  return `sha256:${digest(index)}`;
}

export function taskId(index: number) {
  return hiddenTaskId(digest(index));
}

export function panelId(index: number) {
  return hiddenPanelId(digest(index));
}

export function makeTask(
  index: number,
  buckets: readonly SelectionBucket[],
  overrides: Partial<HiddenTaskLedgerEntry> = {},
): HiddenTaskLedgerEntry {
  const defaults: HiddenTaskLedgerEntry = {
    taskId: taskId(index),
    taskRevisionDigest: digest(index + 10_000),
    capabilityStratum: `capability-${index % 3}`,
    difficultyStratum: index % 2 === 0 ? "difficult" : "moderate",
    buckets,
    estimates: {
      championFailureProbability: 0.6,
      baselineFailureProbability: 0.55,
      leaderboardFailureProbability: 0.5,
      recentFailureProbability: 0.6,
      outcomeUncertainty: 0.7,
      discrimination: 0.7,
      componentRelevance: 0.6,
      underexposure: 0.5,
      missingCapabilityCoverage: 0.4,
      normalizedCost: 0.2,
      impossibleProbability: 0.05,
    },
    exposure: {
      total: 0,
      consecutiveExperiments: 0,
      lastExperiment: null,
      feedbackReleased: false,
      positiveValidationConsumed: false,
      repairCooldownThroughExperiment: null,
      informedHypothesisDigests: [],
    },
    shadowReserved: false,
    regressionCanary: false,
    infrastructureValid: true,
    discriminating: true,
  };
  return {
    ...defaults,
    ...overrides,
    estimates: { ...defaults.estimates, ...overrides.estimates },
    exposure: { ...defaults.exposure, ...overrides.exposure },
  };
}

export function cacheKey(overrides: Partial<CacheKeyMaterial> = {}): CacheKeyMaterial {
  return {
    taskRevisionDigest: digest(101),
    harnessCommit: digest(102),
    harnessConfigurationHash: digest(103),
    modelId: "evaluated-model-1",
    modelProviderVersion: "provider-1",
    reasoningSettingsHash: digest(104),
    samplingSettingsHash: digest(105),
    contextSettingsHash: digest(106),
    datasetVersion: "terminal-bench-2.1-pinned",
    harborVersion: "harbor-pinned",
    sandboxProvider: "cloud-provider",
    imageDigest: ociImageDigest(107),
    architecture: "arm64",
    resourceHash: digest(108),
    regionClass: "region-class-a",
    networkPolicyHash: digest(109),
    protocolHash: digest(110),
    ...overrides,
  };
}

export function behaviorWithFailure(overrides: Partial<BehaviorSummary> = {}): BehaviorSummary {
  return {
    ...extractBehaviorSummary({
      elapsedMs: 120_000,
      planningTokens: 100,
      actionTokens: 800,
      totalTokens: 1_000,
      events: [
        { kind: "tool-call", category: "execute", invocationValid: false },
        { kind: "tool-result", exitCode: 1 },
        { kind: "stop", reason: "error" },
      ],
    }),
    ...overrides,
  };
}

export function behaviorWithoutFailure(
  overrides: Partial<BehaviorSummary> = {},
): BehaviorSummary {
  return {
    ...extractBehaviorSummary({
      elapsedMs: 120_000,
      planningTokens: 300,
      actionTokens: 600,
      totalTokens: 1_000,
      events: [
        { kind: "plan" },
        { kind: "tool-call", category: "read", invocationValid: true },
        { kind: "tool-result", exitCode: 0 },
        { kind: "verification" },
        { kind: "stop", reason: "completed" },
      ],
    }),
    ...overrides,
  };
}
