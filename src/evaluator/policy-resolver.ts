import type { OnlineErrorBudgetState } from "../evaluation/statistics.js";
import { canonicalHash, canonicalJson } from "../schemas/canonical.js";
import type { TrustedRawRun } from "../terminal-bench/runner.js";
import type {
  TrustedMatchedArmSchedule,
  TrustedMatchedPanel,
} from "../terminal-bench/trusted.js";
import {
  fingerprintForbiddenReleaseLiteral,
  hashTrustedCacheEvidence,
  type TrustedBehavioralReleaseBinding,
  type TrustedCanonicalDerivationPolicy,
  type TrustedCanonicalDerivationPolicyResolver,
  type TrustedRepairControl,
} from "./deriver.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "./contracts.js";
import type { TrustedEvaluatorPortBoundary } from "./raw-reader.js";

export interface TrustedCachePolicyBinding {
  readonly sensitivity: "trusted-cache-policy-binding";
  readonly requestHash: string;
  readonly dispositionAttestationHash: string;
  readonly cacheAttestationHash: string;
  readonly cacheEvidenceSetHash: string;
  readonly repair: {
    readonly alternatingBucket: "easy" | "coverage";
    readonly attemptOrdinal: 1 | 2;
    readonly controls: readonly TrustedRepairControl[];
  } | null;
  readonly bindingHash: string;
}

export interface TrustedGuardrailPolicyBinding {
  readonly sensitivity: "trusted-guardrail-policy-binding";
  readonly requestHash: string;
  readonly externalIntegrityVeto: boolean;
  readonly correctnessVeto: boolean;
  readonly capabilityVeto: boolean;
  readonly costWithinGuardrail: boolean;
  readonly latencyWithinGuardrail: boolean;
  readonly accuracyTradeoffPredeclared: boolean;
  readonly complianceFlagsPassed: boolean;
  readonly bindingHash: string;
}

export interface TrustedReleaseScannerBinding {
  readonly sensitivity: "trusted-release-scanner-binding";
  readonly requestHash: string;
  readonly scannerPolicyVersion: string;
  readonly forbiddenReleaseLiterals: readonly string[];
  readonly forbiddenContentFingerprints: readonly string[];
  readonly graderCanaryFingerprints: readonly string[];
  readonly bindingHash: string;
}

export interface TrustedOnlineErrorBudgetBinding {
  readonly sensitivity: "trusted-online-error-budget-binding";
  readonly requestHash: string;
  readonly state: OnlineErrorBudgetState;
  readonly bindingHash: string;
}

export interface TrustedBehavioralPolicyBinding {
  readonly sensitivity: "trusted-behavioral-policy-binding";
  readonly requestHash: string;
  readonly release: TrustedBehavioralReleaseBinding | null;
  readonly privacyThresholdPassed: boolean;
  readonly bindingHash: string;
}

export interface TrustedCanonicalPolicyMaterial {
  readonly sensitivity: "trusted-canonical-policy-material";
  readonly schemaVersion: 1;
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly dispositionAttestationHash: string;
  readonly rawManifestHash: string;
  readonly rawArtifactSetHash: string;
  readonly jobSha256: string;
  readonly runtimeAttestationHash: string;
  readonly expectedEnvironmentFingerprintHash: string;
  readonly candidateFrozenAt: string;
  readonly sealedAt: string;
  readonly presealedStratumWeights: Readonly<Record<string, number>>;
  readonly integrationPoints: number;
  readonly replacementAttemptCeiling: number;
  readonly cache: TrustedCachePolicyBinding;
  readonly guardrails: TrustedGuardrailPolicyBinding;
  readonly scanner: TrustedReleaseScannerBinding;
  readonly errorBudget: TrustedOnlineErrorBudgetBinding;
  readonly behavioral: TrustedBehavioralPolicyBinding;
  readonly policyAttestationHash: string;
}

export interface TrustedCanonicalPolicyMaterialProvider {
  readonly boundary: TrustedEvaluatorPortBoundary;
  load(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly dispositionAttestationHash: string;
    readonly rawManifestHash: string;
    readonly rawArtifactSetHash: string;
    readonly jobSha256: string;
    readonly runtimeAttestationHash: string;
  }): Promise<TrustedCanonicalPolicyMaterial>;
}

export interface BoundCanonicalDerivationPolicyResolverOptions {
  readonly deployment: "trusted-cloud" | "test-only";
  readonly provider: TrustedCanonicalPolicyMaterialProvider;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/u;

export class TrustedPolicyResolutionError extends Error {
  override readonly name = "TrustedPolicyResolutionError";

  constructor() {
    super("Trusted canonical policy could not be resolved.");
  }
}

function exactPlainObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error("Policy binding is not a plain object.");
  }
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  ) {
    throw new Error("Policy binding contains unexpected fields.");
  }
}

function digest(value: string): void {
  if (!SHA256.test(value)) {
    throw new Error("Policy binding digest is malformed.");
  }
}

function canonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Policy binding timestamp is not canonical UTC.");
  }
}

function materialContext(input: {
  readonly request: TrustedEvaluationRequest;
  readonly panel: TrustedMatchedPanel;
  readonly rawRun: TrustedRawRun;
}) {
  return {
    requestHash: hashEvaluationRequest(input.request),
    protocolHash: input.request.protocolHash,
    dispositionAttestationHash: input.panel.dispositionAttestationHash,
    rawManifestHash: input.rawRun.manifest.manifestHash,
    rawArtifactSetHash: input.rawRun.manifest.artifactSetHash,
    jobSha256: input.rawRun.jobSha256,
    runtimeAttestationHash: input.rawRun.runtimeAttestationHash,
  } as const;
}

export function hashTrustedCachePolicyBinding(
  value: Omit<TrustedCachePolicyBinding, "bindingHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.cache-policy-binding.v1",
    ...value,
  });
}

export function hashTrustedGuardrailPolicyBinding(
  value: Omit<TrustedGuardrailPolicyBinding, "bindingHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.guardrail-policy-binding.v1",
    ...value,
  });
}

export function hashTrustedReleaseScannerBinding(
  value: Omit<TrustedReleaseScannerBinding, "bindingHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.release-scanner-binding.v1",
    ...value,
  });
}

export function hashTrustedOnlineErrorBudgetBinding(
  value: Omit<TrustedOnlineErrorBudgetBinding, "bindingHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.online-error-budget-binding.v1",
    ...value,
  });
}

export function hashTrustedBehavioralPolicyBinding(
  value: Omit<TrustedBehavioralPolicyBinding, "bindingHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.behavioral-policy-binding.v1",
    ...value,
  });
}

export function hashTrustedCanonicalPolicyAttestation(
  value: Omit<TrustedCanonicalPolicyMaterial, "policyAttestationHash">,
): string {
  return canonicalHash({
    domain: "dark-factory.canonical-policy-attestation.v1",
    sensitivity: value.sensitivity,
    schemaVersion: value.schemaVersion,
    requestHash: value.requestHash,
    protocolHash: value.protocolHash,
    dispositionAttestationHash: value.dispositionAttestationHash,
    expectedEnvironmentFingerprintHash:
      value.expectedEnvironmentFingerprintHash,
    candidateFrozenAt: value.candidateFrozenAt,
    sealedAt: value.sealedAt,
    presealedStratumWeights: value.presealedStratumWeights,
    integrationPoints: value.integrationPoints,
    replacementAttemptCeiling: value.replacementAttemptCeiling,
    componentBindings: {
      cache: value.cache.bindingHash,
      guardrails: value.guardrails.bindingHash,
      scanner: value.scanner.bindingHash,
      errorBudget: value.errorBudget.bindingHash,
      behavioral: value.behavioral.bindingHash,
    },
  });
}

function withoutBindingHash<T extends { readonly bindingHash: string }>(
  value: T,
): Omit<T, "bindingHash"> {
  const { bindingHash: _bindingHash, ...unsigned } = value;
  return unsigned;
}

function assertContext(
  material: TrustedCanonicalPolicyMaterial,
  context: ReturnType<typeof materialContext>,
): void {
  for (const value of Object.values(context)) {
    digest(value);
  }
  if (
    material.sensitivity !== "trusted-canonical-policy-material" ||
    material.schemaVersion !== 1 ||
    material.requestHash !== context.requestHash ||
    material.protocolHash !== context.protocolHash ||
    material.dispositionAttestationHash !==
      context.dispositionAttestationHash ||
    material.rawManifestHash !== context.rawManifestHash ||
    material.rawArtifactSetHash !== context.rawArtifactSetHash ||
    material.jobSha256 !== context.jobSha256 ||
    material.runtimeAttestationHash !== context.runtimeAttestationHash
  ) {
    throw new Error("Canonical policy material is detached.");
  }
  digest(material.expectedEnvironmentFingerprintHash);
  canonicalTimestamp(material.candidateFrozenAt);
  canonicalTimestamp(material.sealedAt);
  if (
    !Number.isSafeInteger(material.integrationPoints) ||
    material.integrationPoints < 256 ||
    material.integrationPoints > 65_536 ||
    !Number.isSafeInteger(material.replacementAttemptCeiling) ||
    material.replacementAttemptCeiling < 0 ||
    material.replacementAttemptCeiling > 4
  ) {
    throw new Error("Canonical policy numeric bounds are invalid.");
  }
}

function assertCacheBinding(
  binding: TrustedCachePolicyBinding,
  request: TrustedEvaluationRequest,
  context: ReturnType<typeof materialContext>,
): void {
  exactPlainObject(binding, [
    "sensitivity",
    "requestHash",
    "dispositionAttestationHash",
    "cacheAttestationHash",
    "cacheEvidenceSetHash",
    "repair",
    "bindingHash",
  ]);
  if (
    binding.sensitivity !== "trusted-cache-policy-binding" ||
    binding.requestHash !== context.requestHash ||
    binding.dispositionAttestationHash !==
      context.dispositionAttestationHash
  ) {
    throw new Error("Cache policy binding is detached.");
  }
  digest(binding.cacheAttestationHash);
  digest(binding.cacheEvidenceSetHash);
  const controls = binding.repair?.controls ?? [];
  if (binding.repair !== null) {
    exactPlainObject(binding.repair, [
      "alternatingBucket",
      "attemptOrdinal",
      "controls",
    ]);
  }
  const requestedRepairAttempt =
    request.selection.kind === "repair-reuse"
      ? request.selection.candidateAttempt
      : null;
  if (
    (request.stage === "repair") !== (binding.repair !== null) ||
    (binding.repair !== null &&
      (!Array.isArray(binding.repair.controls) ||
        binding.repair.controls.length !== 5 ||
        (binding.repair.alternatingBucket !== "easy" &&
          binding.repair.alternatingBucket !== "coverage") ||
        (binding.repair.attemptOrdinal !== 1 &&
          binding.repair.attemptOrdinal !== 2) ||
        requestedRepairAttempt === null ||
        binding.repair.attemptOrdinal !==
          requestedRepairAttempt))
  ) {
    throw new Error("Cache policy does not match the evaluation stage.");
  }
  if (
    binding.cacheEvidenceSetHash !==
      hashTrustedCacheEvidence({
        requestHash: context.requestHash,
        dispositionAttestationHash: context.dispositionAttestationHash,
        repairControls: controls,
      }) ||
    binding.bindingHash !==
      hashTrustedCachePolicyBinding(withoutBindingHash(binding))
  ) {
    throw new Error("Cache policy binding hashes are detached.");
  }
}

function assertGuardrailBinding(
  binding: TrustedGuardrailPolicyBinding,
  context: ReturnType<typeof materialContext>,
): void {
  exactPlainObject(binding, [
    "sensitivity",
    "requestHash",
    "externalIntegrityVeto",
    "correctnessVeto",
    "capabilityVeto",
    "costWithinGuardrail",
    "latencyWithinGuardrail",
    "accuracyTradeoffPredeclared",
    "complianceFlagsPassed",
    "bindingHash",
  ]);
  if (
    binding.sensitivity !== "trusted-guardrail-policy-binding" ||
    binding.requestHash !== context.requestHash ||
    Object.entries(binding)
      .filter(
        ([key]) =>
          key !== "sensitivity" &&
          key !== "requestHash" &&
          key !== "bindingHash",
      )
      .some(([, value]) => typeof value !== "boolean") ||
    binding.bindingHash !==
      hashTrustedGuardrailPolicyBinding(withoutBindingHash(binding))
  ) {
    throw new Error("Guardrail policy binding is invalid.");
  }
}

function assertScannerBinding(
  binding: TrustedReleaseScannerBinding,
  context: ReturnType<typeof materialContext>,
): void {
  exactPlainObject(binding, [
    "sensitivity",
    "requestHash",
    "scannerPolicyVersion",
    "forbiddenReleaseLiterals",
    "forbiddenContentFingerprints",
    "graderCanaryFingerprints",
    "bindingHash",
  ]);
  if (
    binding.sensitivity !== "trusted-release-scanner-binding" ||
    binding.requestHash !== context.requestHash ||
    !SAFE_VERSION.test(binding.scannerPolicyVersion) ||
    !Array.isArray(binding.forbiddenReleaseLiterals) ||
    !Array.isArray(binding.forbiddenContentFingerprints) ||
    !Array.isArray(binding.graderCanaryFingerprints) ||
    new Set(binding.forbiddenReleaseLiterals).size !==
      binding.forbiddenReleaseLiterals.length ||
    new Set(binding.forbiddenContentFingerprints).size !==
      binding.forbiddenContentFingerprints.length ||
    new Set(binding.graderCanaryFingerprints).size !==
      binding.graderCanaryFingerprints.length
  ) {
    throw new Error("Release scanner binding is malformed.");
  }
  for (const fingerprint of [
    ...binding.forbiddenContentFingerprints,
    ...binding.graderCanaryFingerprints,
  ]) {
    digest(fingerprint);
  }
  if (
    binding.forbiddenReleaseLiterals.some(
      (literal) =>
        typeof literal !== "string" ||
        literal.trim().length < 4 ||
        !binding.forbiddenContentFingerprints.includes(
          fingerprintForbiddenReleaseLiteral(literal),
        ),
    ) ||
    binding.bindingHash !==
      hashTrustedReleaseScannerBinding(withoutBindingHash(binding))
  ) {
    throw new Error("Release scanner commitment is incomplete.");
  }
}

function assertErrorBudgetBinding(
  binding: TrustedOnlineErrorBudgetBinding,
  context: ReturnType<typeof materialContext>,
): void {
  exactPlainObject(binding, [
    "sensitivity",
    "requestHash",
    "state",
    "bindingHash",
  ]);
  exactPlainObject(binding.state, [
    "policyVersion",
    "nullCalibrationId",
    "initialAlpha",
    "remainingAlpha",
    "gatesSpent",
  ]);
  if (
    binding.sensitivity !== "trusted-online-error-budget-binding" ||
    binding.requestHash !== context.requestHash ||
    binding.state.policyVersion !== "online-alpha-spending-v1" ||
    !/^[a-z0-9][a-z0-9._-]{2,127}$/u.test(
      binding.state.nullCalibrationId,
    ) ||
    !(binding.state.initialAlpha > 0 && binding.state.initialAlpha <= 0.05) ||
    binding.state.remainingAlpha < 0 ||
    binding.state.remainingAlpha > binding.state.initialAlpha ||
    !Number.isSafeInteger(binding.state.gatesSpent) ||
    binding.state.gatesSpent < 0 ||
    binding.bindingHash !==
      hashTrustedOnlineErrorBudgetBinding(withoutBindingHash(binding))
  ) {
    throw new Error("Online error-budget binding is invalid.");
  }
}

function assertBehavioralBinding(
  binding: TrustedBehavioralPolicyBinding,
  request: TrustedEvaluationRequest,
  context: ReturnType<typeof materialContext>,
): void {
  exactPlainObject(binding, [
    "sensitivity",
    "requestHash",
    "release",
    "privacyThresholdPassed",
    "bindingHash",
  ]);
  if (
    binding.sensitivity !== "trusted-behavioral-policy-binding" ||
    binding.requestHash !== context.requestHash ||
    binding.privacyThresholdPassed !== (binding.release !== null) ||
    (request.stage !== "validation" &&
      (binding.release !== null || binding.privacyThresholdPassed))
  ) {
    throw new Error("Behavioral policy does not match its release stage.");
  }
  if (binding.release !== null) {
    exactPlainObject(binding.release, ["contentHash", "sourceSetHash"]);
    digest(binding.release.contentHash);
    digest(binding.release.sourceSetHash);
  }
  if (
    binding.bindingHash !==
    hashTrustedBehavioralPolicyBinding(withoutBindingHash(binding))
  ) {
    throw new Error("Behavioral policy binding hash is detached.");
  }
}

function assertStratumWeights(
  weights: Readonly<Record<string, number>>,
  panel: TrustedMatchedPanel,
): void {
  exactPlainObject(weights, Object.keys(weights));
  const expected = [
    ...new Set(panel.cells.map((cell) => cell.capabilityStratum)),
  ].sort();
  const actual = Object.keys(weights).sort();
  if (
    canonicalJson(expected) !== canonicalJson(actual) ||
    actual.some((stratum) => {
      const weight = weights[stratum];
      return weight === undefined || !Number.isFinite(weight) || weight <= 0;
    }) ||
    Math.abs(
      actual.reduce((sum, stratum) => sum + (weights[stratum] ?? 0), 0) -
        1,
    ) > 1e-9
  ) {
    throw new Error("Policy strata are not presealed to the selected panel.");
  }
}

/**
 * Resolves only hash-bound, presealed policy material. It never derives
 * guardrails from the observed score and therefore cannot move a promotion
 * threshold after seeing the candidate result.
 */
export class BoundCanonicalDerivationPolicyResolver
  implements TrustedCanonicalDerivationPolicyResolver
{
  readonly boundary: TrustedEvaluatorPortBoundary;
  readonly #provider: TrustedCanonicalPolicyMaterialProvider;

  constructor(options: BoundCanonicalDerivationPolicyResolverOptions) {
    const requiredBoundary =
      options.deployment === "trusted-cloud"
        ? "trusted-cloud"
        : "test-only-in-memory";
    if (options.provider.boundary !== requiredBoundary) {
      throw new TrustedPolicyResolutionError();
    }
    this.boundary = requiredBoundary;
    this.#provider = options.provider;
  }

  async resolve(input: {
    readonly request: TrustedEvaluationRequest;
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly rawRun: TrustedRawRun;
  }): Promise<TrustedCanonicalDerivationPolicy> {
    try {
      if (
        input.request.requestId !== input.panel.requestId ||
        input.request.requestId !== input.schedule.requestId ||
        input.request.requestId !== input.rawRun.requestId
      ) {
        throw new Error("Policy inputs are detached.");
      }
      const context = materialContext(input);
      const material = await this.#provider.load(context);
      exactPlainObject(material, [
        "sensitivity",
        "schemaVersion",
        "requestHash",
        "protocolHash",
        "dispositionAttestationHash",
        "rawManifestHash",
        "rawArtifactSetHash",
        "jobSha256",
        "runtimeAttestationHash",
        "expectedEnvironmentFingerprintHash",
        "candidateFrozenAt",
        "sealedAt",
        "presealedStratumWeights",
        "integrationPoints",
        "replacementAttemptCeiling",
        "cache",
        "guardrails",
        "scanner",
        "errorBudget",
        "behavioral",
        "policyAttestationHash",
      ]);
      assertContext(material, context);
      const outcomeInputTimes = [
        Date.parse(input.rawRun.manifest.createdAt),
        ...input.rawRun.executions.map((receipt) =>
          Date.parse(receipt.startedAt),
        ),
      ];
      const earliestOutcomeBearingInput = Math.min(...outcomeInputTimes);
      if (
        outcomeInputTimes.some((value) => !Number.isFinite(value)) ||
        Date.parse(material.candidateFrozenAt) >
          Date.parse(input.panel.sealedAt) ||
        Date.parse(material.sealedAt) < Date.parse(input.panel.sealedAt) ||
        Date.parse(material.sealedAt) > earliestOutcomeBearingInput
      ) {
        throw new Error(
          "Canonical policy was not sealed before evaluation outcomes.",
        );
      }
      assertStratumWeights(material.presealedStratumWeights, input.panel);
      assertCacheBinding(material.cache, input.request, context);
      assertGuardrailBinding(material.guardrails, context);
      assertScannerBinding(material.scanner, context);
      assertErrorBudgetBinding(material.errorBudget, context);
      assertBehavioralBinding(material.behavioral, input.request, context);
      digest(material.policyAttestationHash);
      const unsigned: Omit<
        TrustedCanonicalPolicyMaterial,
        "policyAttestationHash"
      > = {
        sensitivity: material.sensitivity,
        schemaVersion: material.schemaVersion,
        requestHash: material.requestHash,
        protocolHash: material.protocolHash,
        dispositionAttestationHash: material.dispositionAttestationHash,
        rawManifestHash: material.rawManifestHash,
        rawArtifactSetHash: material.rawArtifactSetHash,
        jobSha256: material.jobSha256,
        runtimeAttestationHash: material.runtimeAttestationHash,
        expectedEnvironmentFingerprintHash:
          material.expectedEnvironmentFingerprintHash,
        candidateFrozenAt: material.candidateFrozenAt,
        sealedAt: material.sealedAt,
        presealedStratumWeights: material.presealedStratumWeights,
        integrationPoints: material.integrationPoints,
        replacementAttemptCeiling: material.replacementAttemptCeiling,
        cache: material.cache,
        guardrails: material.guardrails,
        scanner: material.scanner,
        errorBudget: material.errorBudget,
        behavioral: material.behavioral,
      };
      if (
        material.policyAttestationHash !==
        hashTrustedCanonicalPolicyAttestation(unsigned)
      ) {
        throw new Error("Canonical policy attestation is detached.");
      }
      return {
        sensitivity: "trusted-canonical-derivation-policy",
        requestHash: material.requestHash,
        protocolHash: material.protocolHash,
        dispositionAttestationHash:
          material.dispositionAttestationHash,
        expectedEnvironmentFingerprintHash:
          material.expectedEnvironmentFingerprintHash,
        cacheAttestationHash: material.cache.cacheAttestationHash,
        cacheEvidenceSetHash: material.cache.cacheEvidenceSetHash,
        policyAttestationHash: material.policyAttestationHash,
        candidateFrozenAt: material.candidateFrozenAt,
        presealedStratumWeights: material.presealedStratumWeights,
        onlineErrorBudget: material.errorBudget.state,
        integrationPoints: material.integrationPoints,
        replacementAttemptCeiling: material.replacementAttemptCeiling,
        repair: material.cache.repair,
        guardrails: {
          externalIntegrityVeto:
            material.guardrails.externalIntegrityVeto,
          correctnessVeto: material.guardrails.correctnessVeto,
          capabilityVeto: material.guardrails.capabilityVeto,
          costWithinGuardrail:
            material.guardrails.costWithinGuardrail,
          latencyWithinGuardrail:
            material.guardrails.latencyWithinGuardrail,
          accuracyTradeoffPredeclared:
            material.guardrails.accuracyTradeoffPredeclared,
          complianceFlagsPassed:
            material.guardrails.complianceFlagsPassed,
        },
        behavioralRelease: material.behavioral.release,
        privacyThresholdPassed:
          material.behavioral.privacyThresholdPassed,
        forbiddenReleaseLiterals:
          material.scanner.forbiddenReleaseLiterals,
        forbiddenContentFingerprints:
          material.scanner.forbiddenContentFingerprints,
        graderCanaryFingerprints:
          material.scanner.graderCanaryFingerprints,
      };
    } catch {
      throw new TrustedPolicyResolutionError();
    }
  }
}
