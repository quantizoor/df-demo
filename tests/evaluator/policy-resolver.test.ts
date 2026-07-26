import { describe, expect, it } from "vitest";

import { createOnlineErrorBudget } from "../../src/evaluation/statistics.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  fingerprintForbiddenReleaseLiteral,
  hashTrustedCacheEvidence,
} from "../../src/evaluator/deriver.js";
import {
  BoundCanonicalDerivationPolicyResolver,
  TrustedPolicyResolutionError,
  hashTrustedBehavioralPolicyBinding,
  hashTrustedCachePolicyBinding,
  hashTrustedCanonicalPolicyAttestation,
  hashTrustedGuardrailPolicyBinding,
  hashTrustedOnlineErrorBudgetBinding,
  hashTrustedReleaseScannerBinding,
  type TrustedBehavioralPolicyBinding,
  type TrustedCachePolicyBinding,
  type TrustedCanonicalPolicyMaterial,
  type TrustedCanonicalPolicyMaterialProvider,
  type TrustedGuardrailPolicyBinding,
  type TrustedOnlineErrorBudgetBinding,
  type TrustedReleaseScannerBinding,
} from "../../src/evaluator/policy-resolver.js";
import {
  createTrustedRawArtifactManifest,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import type { TrustedRawRun } from "../../src/terminal-bench/runner.js";
import {
  createTrustedMatchedArmSchedule,
  type TrustedMatchedPanel,
} from "../../src/terminal-bench/trusted.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const forbiddenLiteral = "private-grader-canary";

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "c".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};

function request(): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "policy-request-1",
    experimentId: "001-policy",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH_A,
    complianceManifestHash: HASH_B,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: "1".repeat(40),
      treeSha: "1".repeat(40),
      archiveSha256: "1".repeat(64),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "2".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: "2".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "3".repeat(64),
      hypothesisExclusionAttestationHash: "4".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"5".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash: "6".repeat(64),
      protocolHash: HASH_A,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "evaluated-model",
      thinkingLevel: "high",
    },
  };
}

function panel(): TrustedMatchedPanel {
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: "policy-panel-1",
    requestId: "policy-request-1",
    stage: "validation",
    sealedAt: "2026-07-01T00:01:00.000Z",
    expiresAt: "2026-07-01T05:00:00.000Z",
    dispositionAttestationHash: "7".repeat(64),
    cells: Array.from({ length: 12 }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId(
        (index + 1).toString(16).padStart(64, "0"),
      ),
      taskRevisionDigest: (index + 20)
        .toString(16)
        .padStart(64, "0"),
      capabilityStratum: index % 2 === 0 ? "shell" : "filesystem",
      replicateOrdinal: 1,
      order: index < 6 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

function rawRun(): TrustedRawRun {
  const manifest = createTrustedRawArtifactManifest(retentionPolicy, {
    manifestId: "policy-manifest-1",
    createdAt: "2026-07-01T00:02:00.000Z",
    destroyBy: "2026-07-01T01:02:00.000Z",
    artifacts: [
      {
        kind: "atif",
        uri: "trusted://raw/evaluator/policy-atif.enc",
        sha256: "8".repeat(64),
        byteLength: 100,
        encrypted: true,
      },
      {
        kind: "grader-output",
        uri: "trusted://raw/evaluator/policy-grader.enc",
        sha256: "9".repeat(64),
        byteLength: 100,
        encrypted: true,
      },
      {
        kind: "harbor-output",
        uri: "trusted://raw/evaluator/policy-harbor.enc",
        sha256: "0".repeat(64),
        byteLength: 100,
        encrypted: true,
      },
    ],
  });
  return {
    sensitivity: "raw-terminal-bench-run",
    requestId: "policy-request-1",
    pinHash: "d".repeat(64),
    jobSha256: "e".repeat(64),
    runtimeAttestationHash: "f".repeat(64),
    executions: [],
    rawBundles: [],
    manifest,
  };
}

function bound<T extends { readonly bindingHash: string }>(
  value: Omit<T, "bindingHash">,
  hash: (input: Omit<T, "bindingHash">) => string,
): T {
  return { ...value, bindingHash: hash(value) } as T;
}

function material(
  evaluationRequest: TrustedEvaluationRequest,
  hiddenPanel: TrustedMatchedPanel,
  raw: TrustedRawRun,
): TrustedCanonicalPolicyMaterial {
  const requestHash = hashEvaluationRequest(evaluationRequest);
  const cache = bound<TrustedCachePolicyBinding>(
    {
      sensitivity: "trusted-cache-policy-binding",
      requestHash,
      dispositionAttestationHash:
        hiddenPanel.dispositionAttestationHash,
      cacheAttestationHash: "1".repeat(64),
      cacheEvidenceSetHash: hashTrustedCacheEvidence({
        requestHash,
        dispositionAttestationHash:
          hiddenPanel.dispositionAttestationHash,
        repairControls: [],
      }),
      repair: null,
    },
    hashTrustedCachePolicyBinding,
  );
  const guardrails = bound<TrustedGuardrailPolicyBinding>(
    {
      sensitivity: "trusted-guardrail-policy-binding",
      requestHash,
      externalIntegrityVeto: false,
      correctnessVeto: false,
      capabilityVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      complianceFlagsPassed: true,
    },
    hashTrustedGuardrailPolicyBinding,
  );
  const scanner = bound<TrustedReleaseScannerBinding>(
    {
      sensitivity: "trusted-release-scanner-binding",
      requestHash,
      scannerPolicyVersion: "release-scanner-v1",
      forbiddenReleaseLiterals: [forbiddenLiteral],
      forbiddenContentFingerprints: [
        fingerprintForbiddenReleaseLiteral(forbiddenLiteral),
      ],
      graderCanaryFingerprints: ["2".repeat(64)],
    },
    hashTrustedReleaseScannerBinding,
  );
  const errorBudget = bound<TrustedOnlineErrorBudgetBinding>(
    {
      sensitivity: "trusted-online-error-budget-binding",
      requestHash,
      state: createOnlineErrorBudget(0.05, "null-calibration-v1"),
    },
    hashTrustedOnlineErrorBudgetBinding,
  );
  const behavioral = bound<TrustedBehavioralPolicyBinding>(
    {
      sensitivity: "trusted-behavioral-policy-binding",
      requestHash,
      release: null,
      privacyThresholdPassed: false,
    },
    hashTrustedBehavioralPolicyBinding,
  );
  const unsigned: Omit<
    TrustedCanonicalPolicyMaterial,
    "policyAttestationHash"
  > = {
    sensitivity: "trusted-canonical-policy-material",
    schemaVersion: 1,
    requestHash,
    protocolHash: evaluationRequest.protocolHash,
    dispositionAttestationHash:
      hiddenPanel.dispositionAttestationHash,
    rawManifestHash: raw.manifest.manifestHash,
    rawArtifactSetHash: raw.manifest.artifactSetHash,
    jobSha256: raw.jobSha256,
    runtimeAttestationHash: raw.runtimeAttestationHash,
    expectedEnvironmentFingerprintHash: "3".repeat(64),
    candidateFrozenAt: "2026-07-01T00:00:30.000Z",
    sealedAt: "2026-07-01T00:01:30.000Z",
    presealedStratumWeights: {
      filesystem: 0.5,
      shell: 0.5,
    },
    integrationPoints: 1_024,
    replacementAttemptCeiling: 4,
    cache,
    guardrails,
    scanner,
    errorBudget,
    behavioral,
  };
  return {
    ...unsigned,
    policyAttestationHash:
      hashTrustedCanonicalPolicyAttestation(unsigned),
  };
}

function provider(
  value: TrustedCanonicalPolicyMaterial,
  boundary: "trusted-cloud" | "test-only-in-memory" = "trusted-cloud",
): TrustedCanonicalPolicyMaterialProvider {
  return {
    boundary,
    load: () => Promise.resolve(value),
  };
}

describe("bound canonical policy resolver", () => {
  it("resolves all presealed cache, guardrail, scanner, error-budget, and behavioral bindings", async () => {
    const evaluationRequest = request();
    const hiddenPanel = panel();
    const raw = rawRun();
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      evaluationRequest.candidate,
      evaluationRequest.champion,
    );
    const resolver = new BoundCanonicalDerivationPolicyResolver({
      deployment: "trusted-cloud",
      provider: provider(
        material(evaluationRequest, hiddenPanel, raw),
      ),
    });
    await expect(
      resolver.resolve({
        request: evaluationRequest,
        panel: hiddenPanel,
        schedule,
        rawRun: raw,
      }),
    ).resolves.toMatchObject({
      sensitivity: "trusted-canonical-derivation-policy",
      requestHash: hashEvaluationRequest(evaluationRequest),
      cacheAttestationHash: "1".repeat(64),
      guardrails: {
        costWithinGuardrail: true,
        latencyWithinGuardrail: true,
      },
      privacyThresholdPassed: false,
    });
  });

  it.each([
    "cache",
    "guardrails",
    "scanner",
    "errorBudget",
    "behavioral",
  ] as const)(
    "fails closed when the %s component changes after sealing",
    async (component) => {
      const evaluationRequest = request();
      const hiddenPanel = panel();
      const raw = rawRun();
      const schedule = createTrustedMatchedArmSchedule(
        hiddenPanel,
        evaluationRequest.candidate,
        evaluationRequest.champion,
      );
      const sealed = material(evaluationRequest, hiddenPanel, raw);
      const tampered = {
        ...sealed,
        [component]: {
          ...sealed[component],
          requestHash: "0".repeat(64),
        },
      } as TrustedCanonicalPolicyMaterial;
      const resolver = new BoundCanonicalDerivationPolicyResolver({
        deployment: "trusted-cloud",
        provider: provider(tampered),
      });
      await expect(
        resolver.resolve({
          request: evaluationRequest,
          panel: hiddenPanel,
          schedule,
          rawRun: raw,
        }),
      ).rejects.toBeInstanceOf(TrustedPolicyResolutionError);
    },
  );

  it("rejects a fully rehashed policy first sealed after raw outcomes existed", async () => {
    const evaluationRequest = request();
    const hiddenPanel = panel();
    const raw = rawRun();
    const schedule = createTrustedMatchedArmSchedule(
      hiddenPanel,
      evaluationRequest.candidate,
      evaluationRequest.champion,
    );
    const original = material(evaluationRequest, hiddenPanel, raw);
    const {
      policyAttestationHash: _policyAttestationHash,
      ...originalUnsigned
    } = original;
    const lateUnsigned: Omit<
      TrustedCanonicalPolicyMaterial,
      "policyAttestationHash"
    > = {
      ...originalUnsigned,
      sealedAt: "2026-07-01T00:03:00.000Z",
    };
    const late: TrustedCanonicalPolicyMaterial = {
      ...lateUnsigned,
      policyAttestationHash:
        hashTrustedCanonicalPolicyAttestation(lateUnsigned),
    };
    const resolver = new BoundCanonicalDerivationPolicyResolver({
      deployment: "trusted-cloud",
      provider: provider(late),
    });
    await expect(
      resolver.resolve({
        request: evaluationRequest,
        panel: hiddenPanel,
        schedule,
        rawRun: raw,
      }),
    ).rejects.toBeInstanceOf(TrustedPolicyResolutionError);
  });

  it("rejects test-only material providers in production", () => {
    const evaluationRequest = request();
    const hiddenPanel = panel();
    const raw = rawRun();
    expect(
      () =>
        new BoundCanonicalDerivationPolicyResolver({
          deployment: "trusted-cloud",
          provider: provider(
            material(evaluationRequest, hiddenPanel, raw),
            "test-only-in-memory",
          ),
        }),
    ).toThrow(TrustedPolicyResolutionError);
  });
});
