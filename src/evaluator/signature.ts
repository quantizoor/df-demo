import { createHash, type KeyObject, verify } from "node:crypto";
import type {
  AggregateResultBody,
  BehavioralDiagnosticCard,
  EnvelopeSignature,
  SignedAggregateEnvelope,
  TrustedEvaluationRequest,
} from "./contracts.js";

export type VerificationKey = KeyObject | string | Buffer;

export interface EnvelopeKeyring {
  getVerificationKey(keyId: string): Promise<VerificationKey | undefined>;
}

export class EnvelopeVerificationError extends Error {
  override readonly name = "EnvelopeVerificationError";
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new EnvelopeVerificationError("Canonical JSON cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalValue(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new EnvelopeVerificationError("Canonical JSON cannot contain undefined.");
        }
        return `${JSON.stringify(key)}:${canonicalValue(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new EnvelopeVerificationError("Canonical JSON contains an unsupported value.");
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new EnvelopeVerificationError(
      `${label} contains forbidden field(s): ${extras.join(", ")}.`,
    );
  }
}

function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeVerificationError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EnvelopeVerificationError(`${label} must be a string.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new EnvelopeVerificationError(`${label} must be a finite number.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new EnvelopeVerificationError(`${label} must be a boolean.`);
  }
  return value;
}

function assertRange(value: number, minimum: number, maximum: number, label: string): void {
  if (value < minimum || value > maximum) {
    throw new EnvelopeVerificationError(`${label} is outside its allowed range.`);
  }
}

const BEHAVIORAL_PATTERNS = new Set([
  "nonzero-exit-without-inspection",
  "repeated-action-without-replan",
  "write-before-read",
  "verification-omitted",
  "premature-termination",
  "timeout-after-low-progress",
  "compaction-followed-by-recovery",
  "invalid-tool-invocation",
  "recovery-after-failure",
]);
const TOOL_CATEGORIES = new Set(["execute", "read", "write", "search", "plan", "other"]);
const ASSOCIATIONS = new Set([
  "more-common-in-failures",
  "more-common-in-successes",
  "candidate-regression",
]);
const RECOMMENDATIONS = new Set([
  "inspect-before-retry",
  "replan-before-repeat",
  "read-before-write",
  "verify-before-stop",
  "improve-time-budgeting",
  "validate-tool-arguments",
  "preserve-recovery-state",
]);

function parseDiagnostic(value: unknown): BehavioralDiagnosticCard {
  const card = requireRecord(value, "Diagnostic card");
  assertExactKeys(
    card,
    [
      "cardId",
      "pattern",
      "toolCategory",
      "association",
      "effectSizeBand",
      "uncertaintyBand",
      "distinctTasksBand",
      "trajectoryCountBand",
      "recommendation",
    ],
    "Diagnostic card",
  );
  const cardId = requireString(card.cardId, "Diagnostic card id");
  const pattern = requireString(card.pattern, "Diagnostic pattern");
  const toolCategory = requireString(card.toolCategory, "Diagnostic tool category");
  const association = requireString(card.association, "Diagnostic association");
  const effectSizeBand = requireString(card.effectSizeBand, "Diagnostic effect size");
  const uncertaintyBand = requireString(card.uncertaintyBand, "Diagnostic uncertainty");
  const distinctTasksBand = requireString(card.distinctTasksBand, "Diagnostic task support");
  const trajectoryCountBand = requireString(
    card.trajectoryCountBand,
    "Diagnostic trajectory support",
  );
  const recommendation = requireString(card.recommendation, "Diagnostic recommendation");
  if (
    !/^card-(?:0[1-9]|[12][0-9]|3[0-2])$/u.test(cardId) ||
    !BEHAVIORAL_PATTERNS.has(pattern) ||
    !TOOL_CATEGORIES.has(toolCategory) ||
    !ASSOCIATIONS.has(association) ||
    !new Set(["small", "medium", "large"]).has(effectSizeBand) ||
    !new Set(["low", "medium", "high"]).has(uncertaintyBand) ||
    !new Set(["5-9", "10-19", "20+"]).has(distinctTasksBand) ||
    !new Set(["20-39", "40-79", "80+"]).has(trajectoryCountBand) ||
    !RECOMMENDATIONS.has(recommendation)
  ) {
    throw new EnvelopeVerificationError("Diagnostic card contains a non-allowlisted value.");
  }
  return card as unknown as BehavioralDiagnosticCard;
}

function parseArmScore(value: unknown, label: string): AggregateResultBody["score"]["candidate"] {
  const score = requireRecord(value, label);
  assertExactKeys(score, ["validArms", "successRate", "meanReward"], label);
  const validArms = requireNumber(score.validArms, `${label} valid arms`);
  const successRate = requireNumber(score.successRate, `${label} success rate`);
  const meanReward = requireNumber(score.meanReward, `${label} mean reward`);
  if (!Number.isSafeInteger(validArms) || validArms < 0) {
    throw new EnvelopeVerificationError(`${label} valid arms must be a non-negative integer.`);
  }
  assertRange(successRate, 0, 1, `${label} success rate`);
  assertRange(meanReward, 0, 1, `${label} mean reward`);
  return { validArms, successRate, meanReward };
}

function parseBody(value: unknown): AggregateResultBody {
  const body = requireRecord(value, "Envelope body");
  assertExactKeys(
    body,
    [
      "schemaVersion",
      "requestId",
      "requestHash",
      "dispositionAttestationHash",
      "reuseProhibited",
      "experimentId",
      "runMode",
      "stage",
      "protocolHash",
      "environmentFingerprintHash",
      "sealedAt",
      "gateDecision",
      "attempts",
      "score",
      "cost",
      "integrity",
      "privacy",
      "cache",
      "diagnostics",
      "rawArtifacts",
      "leaderboardEligibility",
    ],
    "Envelope body",
  );
  if (body.schemaVersion !== 1) {
    throw new EnvelopeVerificationError("Envelope schema version is unsupported.");
  }
  const requestId = requireString(body.requestId, "Envelope request id");
  const requestHash = requireString(body.requestHash, "Envelope request hash");
  const dispositionAttestationHash = requireString(
    body.dispositionAttestationHash,
    "Disposition attestation hash",
  );
  const experimentId = requireString(body.experimentId, "Envelope experiment id");
  const runMode = requireString(body.runMode, "Envelope run mode");
  const stage = requireString(body.stage, "Envelope stage");
  const protocolHash = requireString(body.protocolHash, "Envelope protocol hash");
  const environmentFingerprintHash = requireString(
    body.environmentFingerprintHash,
    "Envelope environment fingerprint",
  );
  const sealedAt = requireString(body.sealedAt, "Envelope seal time");
  const gateDecision = requireString(body.gateDecision, "Envelope decision");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(experimentId) ||
    !/^[a-f0-9]{64}$/u.test(requestHash) ||
    !/^[a-f0-9]{64}$/u.test(dispositionAttestationHash) ||
    body.reuseProhibited !== true ||
    !/^[a-f0-9]{64}$/u.test(protocolHash) ||
    !/^[a-f0-9]{64}$/u.test(environmentFingerprintHash) ||
    !Number.isFinite(Date.parse(sealedAt)) ||
    !new Set(["research", "submission"]).has(runMode) ||
    !new Set(["baseline", "repair", "validation", "shadow", "official"]).has(stage) ||
    !new Set(["pass", "fail", "inconclusive"]).has(gateDecision)
  ) {
    throw new EnvelopeVerificationError("Envelope identity or lifecycle fields are invalid.");
  }
  if ((runMode === "submission") !== (stage === "official")) {
    throw new EnvelopeVerificationError("Envelope run mode conflicts with its evaluation stage.");
  }

  const attempts = requireRecord(body.attempts, "Attempt aggregate");
  assertExactKeys(
    attempts,
    ["requestedArms", "startedArms", "validArms", "infrastructureInvalidArms"],
    "Attempt aggregate",
  );
  const requestedArms = requireNumber(attempts.requestedArms, "Requested arms");
  const startedArms = requireNumber(attempts.startedArms, "Started arms");
  const validArms = requireNumber(attempts.validArms, "Valid arms");
  const infrastructureInvalidArms = requireNumber(
    attempts.infrastructureInvalidArms,
    "Infrastructure-invalid arms",
  );
  if (
    ![requestedArms, startedArms, validArms, infrastructureInvalidArms].every(
      (entry) => Number.isSafeInteger(entry) && entry >= 0,
    ) ||
    validArms > requestedArms ||
    validArms + infrastructureInvalidArms !== startedArms ||
    startedArms > requestedArms * 2
  ) {
    throw new EnvelopeVerificationError("Attempt aggregate is internally inconsistent.");
  }
  const expectedRequested =
    stage === "repair" ? 5 : stage === "validation" ? 24 : stage === "official" ? null : 12;
  if (
    (expectedRequested !== null && requestedArms !== expectedRequested) ||
    (stage === "official" && (requestedArms <= 0 || requestedArms > 1000))
  ) {
    throw new EnvelopeVerificationError("Attempt aggregate violates the frozen stage budget.");
  }

  const score = requireRecord(body.score, "Score aggregate");
  assertExactKeys(
    score,
    ["candidate", "champion", "delta", "confidenceInterval95"],
    "Score aggregate",
  );
  const candidate = parseArmScore(score.candidate, "Candidate score");
  const champion =
    score.champion === undefined ? undefined : parseArmScore(score.champion, "Champion score");
  const delta = score.delta === undefined ? undefined : requireNumber(score.delta, "Score delta");
  let confidenceInterval95: readonly [number, number] | undefined;
  if (score.confidenceInterval95 !== undefined) {
    if (!Array.isArray(score.confidenceInterval95) || score.confidenceInterval95.length !== 2) {
      throw new EnvelopeVerificationError("Confidence interval must contain two bounds.");
    }
    const lower = requireNumber(score.confidenceInterval95[0], "Confidence lower bound");
    const upper = requireNumber(score.confidenceInterval95[1], "Confidence upper bound");
    if (lower > upper) {
      throw new EnvelopeVerificationError("Confidence interval bounds are reversed.");
    }
    confidenceInterval95 = [lower, upper];
  }
  if (
    (stage === "validation" && (champion === undefined || delta === undefined)) ||
    (stage !== "validation" &&
      (champion !== undefined || delta !== undefined || confidenceInterval95 !== undefined))
  ) {
    throw new EnvelopeVerificationError(
      "Score comparison fields do not match the evaluation stage.",
    );
  }
  if (
    (stage === "validation" && candidate.validArms + (champion?.validArms ?? 0) !== validArms) ||
    (stage !== "validation" && candidate.validArms !== validArms) ||
    (gateDecision !== "inconclusive" && validArms !== requestedArms) ||
    (stage === "validation" &&
      gateDecision !== "inconclusive" &&
      (candidate.validArms !== 12 || champion?.validArms !== 12))
  ) {
    throw new EnvelopeVerificationError("Score support does not match the valid arm aggregate.");
  }

  const cost = requireRecord(body.cost, "Cost aggregate");
  assertExactKeys(
    cost,
    ["totalUsd", "modelUsd", "sandboxUsd", "wallTimeSeconds"],
    "Cost aggregate",
  );
  const totalUsd = requireNumber(cost.totalUsd, "Total cost");
  const modelUsd = requireNumber(cost.modelUsd, "Model cost");
  const sandboxUsd = requireNumber(cost.sandboxUsd, "Sandbox cost");
  const wallTimeSeconds = requireNumber(cost.wallTimeSeconds, "Wall time");
  if (
    [totalUsd, modelUsd, sandboxUsd, wallTimeSeconds].some((entry) => entry < 0) ||
    Math.abs(totalUsd - modelUsd - sandboxUsd) > 0.000_001
  ) {
    throw new EnvelopeVerificationError("Cost aggregate is invalid.");
  }

  const integrity = requireRecord(body.integrity, "Integrity aggregate");
  assertExactKeys(integrity, ["status", "reasonCodes", "canaryMatchCount"], "Integrity aggregate");
  const integrityStatus = requireString(integrity.status, "Integrity status");
  const canaryMatchCount = requireNumber(integrity.canaryMatchCount, "Canary match count");
  const allowedReasons = new Set([
    "clean",
    "canary-match",
    "candidate-policy-violation",
    "protocol-mismatch",
    "duplicate-attempt",
    "infrastructure-invalid",
  ]);
  if (
    !new Set(["passed", "failed"]).has(integrityStatus) ||
    !Array.isArray(integrity.reasonCodes) ||
    integrity.reasonCodes.some(
      (reason) => typeof reason !== "string" || !allowedReasons.has(reason),
    ) ||
    !Number.isSafeInteger(canaryMatchCount) ||
    canaryMatchCount < 0 ||
    (integrityStatus === "passed" &&
      (canaryMatchCount !== 0 ||
        integrity.reasonCodes.length !== 1 ||
        integrity.reasonCodes[0] !== "clean"))
  ) {
    throw new EnvelopeVerificationError("Integrity aggregate is invalid.");
  }
  if (
    (canaryMatchCount > 0 && !integrity.reasonCodes.includes("canary-match")) ||
    (integrityStatus === "failed" && gateDecision === "pass")
  ) {
    throw new EnvelopeVerificationError("Integrity findings conflict with the gate decision.");
  }

  const privacy = requireRecord(body.privacy, "Privacy aggregate");
  assertExactKeys(
    privacy,
    [
      "releaseEligible",
      "everyComparedGroupAtLeastFive",
      "complementarySuppressionPassed",
      "differencingBudgetStatus",
      "suppressedCardCountBand",
    ],
    "Privacy aggregate",
  );
  const releaseEligible = requireBoolean(privacy.releaseEligible, "Privacy release eligibility");
  const everyComparedGroupAtLeastFive = requireBoolean(
    privacy.everyComparedGroupAtLeastFive,
    "Privacy group support",
  );
  const complementarySuppressionPassed = requireBoolean(
    privacy.complementarySuppressionPassed,
    "Complementary suppression",
  );
  const differencingBudgetStatus = requireString(
    privacy.differencingBudgetStatus,
    "Differencing budget",
  );
  const suppressedCardCountBand = requireString(
    privacy.suppressedCardCountBand,
    "Suppressed card count",
  );
  if (
    !new Set(["available", "exhausted", "not-applicable"]).has(differencingBudgetStatus) ||
    !new Set(["0", "1-4", "5+"]).has(suppressedCardCountBand)
  ) {
    throw new EnvelopeVerificationError("Privacy aggregate contains invalid bands.");
  }
  if (
    (releaseEligible &&
      (!everyComparedGroupAtLeastFive ||
        !complementarySuppressionPassed ||
        differencingBudgetStatus !== "available")) ||
    (stage !== "validation" && releaseEligible)
  ) {
    throw new EnvelopeVerificationError("Privacy release eligibility lacks required support.");
  }

  const cache = requireRecord(body.cache, "Cache attestation");
  assertExactKeys(
    cache,
    ["usedForRepair", "usedForDecision", "promotionEvidence", "driftAnchorsPassed"],
    "Cache attestation",
  );
  const usedForRepair = requireBoolean(cache.usedForRepair, "Cache repair use");
  const usedForDecision = requireBoolean(cache.usedForDecision, "Cache decision use");
  const promotionEvidence = requireString(cache.promotionEvidence, "Promotion evidence");
  const driftAnchorsPassed = requireBoolean(cache.driftAnchorsPassed, "Drift anchors");
  if (
    usedForDecision ||
    !new Set(["fresh-only", "not-a-promotion-stage"]).has(promotionEvidence) ||
    (stage === "validation" && promotionEvidence !== "fresh-only") ||
    (stage !== "validation" && promotionEvidence !== "not-a-promotion-stage") ||
    (stage !== "repair" && usedForRepair)
  ) {
    throw new EnvelopeVerificationError("Cache attestation could influence a forbidden decision.");
  }

  if (!Array.isArray(body.diagnostics)) {
    throw new EnvelopeVerificationError("Diagnostics must be an array.");
  }
  const diagnostics = body.diagnostics.map((card) => parseDiagnostic(card));
  if (
    ((stage !== "validation" || runMode === "submission") && diagnostics.length > 0) ||
    (diagnostics.length > 0 &&
      (!releaseEligible ||
        !everyComparedGroupAtLeastFive ||
        !complementarySuppressionPassed ||
        differencingBudgetStatus !== "available"))
  ) {
    throw new EnvelopeVerificationError("Diagnostic release violates feedback or privacy policy.");
  }

  const rawArtifacts = requireRecord(body.rawArtifacts, "Raw artifact attestation");
  assertExactKeys(rawArtifacts, ["exported", "retentionPolicyHash"], "Raw artifact attestation");
  if (rawArtifacts.exported !== false) {
    throw new EnvelopeVerificationError("Raw evaluator artifacts may never be exported.");
  }
  const retentionPolicyHash = requireString(
    rawArtifacts.retentionPolicyHash,
    "Retention policy hash",
  );
  if (!/^[a-f0-9]{64}$/u.test(retentionPolicyHash)) {
    throw new EnvelopeVerificationError("Retention policy hash is invalid.");
  }

  const leaderboardEligibility = requireString(
    body.leaderboardEligibility,
    "Leaderboard eligibility",
  );
  if (
    !new Set(["ineligible-research", "ineligible-policy", "eligible-pending-human-gate"]).has(
      leaderboardEligibility,
    ) ||
    (runMode === "research" && leaderboardEligibility !== "ineligible-research")
  ) {
    throw new EnvelopeVerificationError("Leaderboard eligibility conflicts with run mode.");
  }

  const parsedScore: AggregateResultBody["score"] = {
    candidate,
    ...(champion === undefined ? {} : { champion }),
    ...(delta === undefined ? {} : { delta }),
    ...(confidenceInterval95 === undefined ? {} : { confidenceInterval95 }),
  };
  return {
    schemaVersion: 1,
    requestId,
    requestHash,
    dispositionAttestationHash,
    reuseProhibited: true,
    experimentId,
    runMode: runMode as AggregateResultBody["runMode"],
    stage: stage as AggregateResultBody["stage"],
    protocolHash,
    environmentFingerprintHash,
    sealedAt,
    gateDecision: gateDecision as AggregateResultBody["gateDecision"],
    attempts: {
      requestedArms,
      startedArms,
      validArms,
      infrastructureInvalidArms,
    },
    score: parsedScore,
    cost: { totalUsd, modelUsd, sandboxUsd, wallTimeSeconds },
    integrity: {
      status: integrityStatus as AggregateResultBody["integrity"]["status"],
      reasonCodes: integrity.reasonCodes as AggregateResultBody["integrity"]["reasonCodes"],
      canaryMatchCount,
    },
    privacy: {
      releaseEligible,
      everyComparedGroupAtLeastFive,
      complementarySuppressionPassed,
      differencingBudgetStatus:
        differencingBudgetStatus as AggregateResultBody["privacy"]["differencingBudgetStatus"],
      suppressedCardCountBand:
        suppressedCardCountBand as AggregateResultBody["privacy"]["suppressedCardCountBand"],
    },
    cache: {
      usedForRepair,
      usedForDecision: false,
      promotionEvidence: promotionEvidence as AggregateResultBody["cache"]["promotionEvidence"],
      driftAnchorsPassed,
    },
    diagnostics,
    rawArtifacts: { exported: false, retentionPolicyHash },
    leaderboardEligibility: leaderboardEligibility as AggregateResultBody["leaderboardEligibility"],
  };
}

function parseSignature(value: unknown): EnvelopeSignature {
  const signature = requireRecord(value, "Envelope signature");
  assertExactKeys(
    signature,
    ["algorithm", "keyId", "issuedAt", "signedBodySha256", "value"],
    "Envelope signature",
  );
  if (signature.algorithm !== "Ed25519") {
    throw new EnvelopeVerificationError("Envelope must use Ed25519.");
  }
  const keyId = requireString(signature.keyId, "Signing key id");
  const issuedAt = requireString(signature.issuedAt, "Signature issue time");
  const signedBodySha256 = requireString(signature.signedBodySha256, "Signed body digest");
  const signatureValue = requireString(signature.value, "Signature value");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(keyId) ||
    !Number.isFinite(Date.parse(issuedAt)) ||
    !/^[a-f0-9]{64}$/u.test(signedBodySha256) ||
    !/^[A-Za-z0-9_-]{80,128}$/u.test(signatureValue)
  ) {
    throw new EnvelopeVerificationError("Envelope signature metadata is invalid.");
  }
  return {
    algorithm: "Ed25519",
    keyId,
    issuedAt,
    signedBodySha256,
    value: signatureValue,
  };
}

export function parseSignedAggregateEnvelope(value: unknown): SignedAggregateEnvelope {
  const envelope = requireRecord(value, "Signed aggregate envelope");
  assertExactKeys(envelope, ["body", "signature"], "Signed aggregate envelope");
  return {
    body: parseBody(envelope.body),
    signature: parseSignature(envelope.signature),
  };
}

export async function verifySignedAggregateEnvelope(
  value: unknown,
  request: TrustedEvaluationRequest,
  requestHash: string,
  keyring: EnvelopeKeyring,
): Promise<SignedAggregateEnvelope> {
  const envelope = parseSignedAggregateEnvelope(value);
  if (
    envelope.body.requestId !== request.requestId ||
    envelope.body.experimentId !== request.experimentId ||
    envelope.body.runMode !== request.runMode ||
    envelope.body.stage !== request.stage ||
    envelope.body.protocolHash !== request.protocolHash ||
    envelope.body.requestHash !== requestHash
  ) {
    throw new EnvelopeVerificationError("Signed result does not correlate to its request.");
  }
  if (
    (envelope.body.runMode === "submission") !== (envelope.body.stage === "official") ||
    Date.parse(envelope.body.sealedAt) > Date.parse(request.deadlineAt) ||
    Date.parse(envelope.signature.issuedAt) < Date.parse(envelope.body.sealedAt) ||
    Date.parse(envelope.signature.issuedAt) > Date.parse(envelope.body.sealedAt) + 5 * 60_000
  ) {
    throw new EnvelopeVerificationError(
      "Envelope mode or signing timestamps violate the evaluation contract.",
    );
  }
  if (
    request.selection.kind === "official-full" &&
    envelope.body.attempts.requestedArms !== request.selection.expectedArmCount
  ) {
    throw new EnvelopeVerificationError(
      "Official result arm count does not match its authorized request.",
    );
  }
  if (Date.parse(envelope.body.sealedAt) < Date.parse(request.submittedAt)) {
    throw new EnvelopeVerificationError("Signed result predates its request.");
  }
  const serializedBody = canonicalJson(envelope.body);
  const bodyDigest = createHash("sha256").update(serializedBody).digest("hex");
  if (bodyDigest !== envelope.signature.signedBodySha256) {
    throw new EnvelopeVerificationError("Signed body digest does not match the envelope body.");
  }
  const key = await keyring.getVerificationKey(envelope.signature.keyId);
  if (key === undefined) {
    throw new EnvelopeVerificationError("Envelope signing key is unknown.");
  }
  const valid = verify(
    null,
    Buffer.from(serializedBody, "utf8"),
    key,
    Buffer.from(envelope.signature.value, "base64url"),
  );
  if (!valid) {
    throw new EnvelopeVerificationError("Envelope signature is invalid.");
  }
  return envelope;
}
