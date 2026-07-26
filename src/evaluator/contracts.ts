import { createHash } from "node:crypto";
import type { MatchedExecutionProfile } from "../cloud/types.js";
import { canonicalJson } from "./signature.js";

export type RunMode = "research" | "submission";
export type EvaluationStage = "baseline" | "repair" | "validation" | "shadow" | "official";
export type GateDecision = "pass" | "fail" | "inconclusive";

export interface HarnessArtifactReference {
  readonly uri: `trusted://${string}`;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly archiveSha256: string;
}

export type PanelSelectionRequest =
  | {
      readonly kind: "weighted-baseline";
      readonly taskCount: 12;
      readonly attemptsPerTask: 1;
      readonly weightingPolicyHash: string;
    }
  | {
      readonly kind: "repair-reuse";
      readonly sourceExperimentId: string;
      readonly taskCount: 5;
      readonly attemptsPerTask: 1;
      readonly candidateAttempt: 1 | 2;
    }
  | {
      readonly kind: "fresh-matched-validation";
      readonly taskCount: 12;
      readonly attemptsPerArm: 1;
      readonly pairOrder: "balanced-6-ab-6-ba";
      readonly weightingPolicyHash: string;
      readonly hypothesisExclusionAttestationHash: string;
    }
  | {
      readonly kind: "fresh-shadow";
      readonly taskCount: 12;
      readonly attemptsPerTask: 1;
      readonly shadowSlice: 1 | 2;
      readonly feedback: "disabled";
    }
  | {
      readonly kind: "official-full";
      readonly expectedArmCount: number;
      readonly authorizationHash: string;
      readonly feedback: "disabled";
    };

export interface EvaluatedModelReference {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface TrustedEvaluationRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly experimentId: string;
  readonly runMode: RunMode;
  readonly stage: EvaluationStage;
  readonly submittedAt: string;
  readonly deadlineAt: string;
  readonly protocolHash: string;
  readonly complianceManifestHash: string;
  readonly candidate: HarnessArtifactReference;
  readonly champion?: HarnessArtifactReference;
  readonly selection: PanelSelectionRequest;
  readonly executionProfile: MatchedExecutionProfile;
  readonly evaluatedModel: EvaluatedModelReference;
}

export type BehavioralPattern =
  | "nonzero-exit-without-inspection"
  | "repeated-action-without-replan"
  | "write-before-read"
  | "verification-omitted"
  | "premature-termination"
  | "timeout-after-low-progress"
  | "compaction-followed-by-recovery"
  | "invalid-tool-invocation"
  | "recovery-after-failure";

export type GenericToolCategory =
  | "execute"
  | "read"
  | "write"
  | "search"
  | "plan"
  | "other";

export interface BehavioralDiagnosticCard {
  readonly cardId: string;
  readonly pattern: BehavioralPattern;
  readonly toolCategory: GenericToolCategory;
  readonly association: "more-common-in-failures" | "more-common-in-successes" | "candidate-regression";
  readonly effectSizeBand: "small" | "medium" | "large";
  readonly uncertaintyBand: "low" | "medium" | "high";
  readonly distinctTasksBand: "5-9" | "10-19" | "20+";
  readonly trajectoryCountBand: "20-39" | "40-79" | "80+";
  readonly recommendation:
    | "inspect-before-retry"
    | "replan-before-repeat"
    | "read-before-write"
    | "verify-before-stop"
    | "improve-time-budgeting"
    | "validate-tool-arguments"
    | "preserve-recovery-state";
}

export interface AggregateArmScore {
  readonly validArms: number;
  readonly successRate: number;
  readonly meanReward: number;
}

export interface AggregateResultBody {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly requestHash: string;
  readonly dispositionAttestationHash: string;
  readonly reuseProhibited: true;
  readonly experimentId: string;
  readonly runMode: RunMode;
  readonly stage: EvaluationStage;
  readonly protocolHash: string;
  readonly environmentFingerprintHash: string;
  readonly sealedAt: string;
  readonly gateDecision: GateDecision;
  readonly attempts: {
    readonly requestedArms: number;
    readonly startedArms: number;
    readonly validArms: number;
    readonly infrastructureInvalidArms: number;
  };
  readonly score: {
    readonly candidate: AggregateArmScore;
    readonly champion?: AggregateArmScore;
    readonly delta?: number;
    readonly confidenceInterval95?: readonly [number, number];
  };
  readonly cost: {
    readonly totalUsd: number;
    readonly modelUsd: number;
    readonly sandboxUsd: number;
    readonly wallTimeSeconds: number;
  };
  readonly integrity: {
    readonly status: "passed" | "failed";
    readonly reasonCodes: readonly (
      | "clean"
      | "canary-match"
      | "candidate-policy-violation"
      | "protocol-mismatch"
      | "duplicate-attempt"
      | "infrastructure-invalid"
    )[];
    readonly canaryMatchCount: number;
  };
  readonly privacy: {
    readonly releaseEligible: boolean;
    readonly everyComparedGroupAtLeastFive: boolean;
    readonly complementarySuppressionPassed: boolean;
    readonly differencingBudgetStatus: "available" | "exhausted" | "not-applicable";
    readonly suppressedCardCountBand: "0" | "1-4" | "5+";
  };
  readonly cache: {
    readonly usedForRepair: boolean;
    readonly usedForDecision: false;
    readonly promotionEvidence: "fresh-only" | "not-a-promotion-stage";
    readonly driftAnchorsPassed: boolean;
  };
  readonly diagnostics: readonly BehavioralDiagnosticCard[];
  readonly rawArtifacts: {
    readonly exported: false;
    readonly retentionPolicyHash: string;
  };
  readonly leaderboardEligibility:
    | "ineligible-research"
    | "ineligible-policy"
    | "eligible-pending-human-gate";
}

export interface EnvelopeSignature {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly issuedAt: string;
  readonly signedBodySha256: string;
  readonly value: string;
}

export interface SignedAggregateEnvelope {
  readonly body: AggregateResultBody;
  readonly signature: EnvelopeSignature;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const TOOL_OR_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export class EvaluatorContractError extends Error {
  override readonly name = "EvaluatorContractError";
}

function assertExactObjectKeys(
  value: object,
  allowed: readonly string[],
  label: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new EvaluatorContractError(`${label} contains forbidden field(s): ${extras.join(", ")}.`);
  }
}

function assertIsoDate(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new EvaluatorContractError(`${label} must be an ISO-compatible timestamp.`);
  }
}

function assertHash(value: string, label: string): void {
  if (!SHA256.test(value)) {
    throw new EvaluatorContractError(`${label} must be a lowercase SHA-256 digest.`);
  }
}

function assertArtifact(artifact: HarnessArtifactReference, label: string): void {
  assertExactObjectKeys(
    artifact,
    ["uri", "commitSha", "treeSha", "archiveSha256"],
    `${label} artifact`,
  );
  if (
    !/^trusted:\/\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(artifact.uri) ||
    artifact.uri.includes("..") ||
    !GIT_OBJECT.test(artifact.commitSha) ||
    !GIT_OBJECT.test(artifact.treeSha)
  ) {
    throw new EvaluatorContractError(`${label} harness artifact is malformed.`);
  }
  assertHash(artifact.archiveSha256, `${label} archive`);
}

function assertProfile(profile: MatchedExecutionProfile): void {
  assertExactObjectKeys(
    profile,
    [
      "provider",
      "imageDigest",
      "regionClass",
      "resources",
      "networkPolicyHash",
      "protocolHash",
    ],
    "Execution profile",
  );
  assertExactObjectKeys(
    profile.resources,
    ["architecture", "cpuCores", "memoryMiB", "diskMiB", "gpuClass"],
    "Execution resources",
  );
  if (
    !new Set(["daytona", "e2b", "modal"]).has(profile.provider) ||
    !profile.imageDigest.startsWith("sha256:") ||
    !SHA256.test(profile.imageDigest.slice("sha256:".length)) ||
    !SAFE_ID.test(profile.regionClass)
  ) {
    throw new EvaluatorContractError("Execution profile is not immutable and pinned.");
  }
  if (
    !new Set(["arm64", "x86_64"]).has(profile.resources.architecture) ||
    !Number.isSafeInteger(profile.resources.cpuCores) ||
    profile.resources.cpuCores <= 0 ||
    !Number.isSafeInteger(profile.resources.memoryMiB) ||
    profile.resources.memoryMiB <= 0 ||
    !Number.isSafeInteger(profile.resources.diskMiB) ||
    profile.resources.diskMiB <= 0 ||
    (profile.resources.gpuClass !== undefined &&
      !TOOL_OR_MODEL_ID.test(profile.resources.gpuClass))
  ) {
    throw new EvaluatorContractError("Execution resources are invalid.");
  }
  assertHash(profile.networkPolicyHash, "Network policy");
  assertHash(profile.protocolHash, "Execution profile protocol");
}

function assertSelection(request: TrustedEvaluationRequest): void {
  const selection = request.selection;
  const allowedSelectionKeys: Readonly<Record<PanelSelectionRequest["kind"], readonly string[]>> = {
    "weighted-baseline": [
      "kind",
      "taskCount",
      "attemptsPerTask",
      "weightingPolicyHash",
    ],
    "repair-reuse": [
      "kind",
      "sourceExperimentId",
      "taskCount",
      "attemptsPerTask",
      "candidateAttempt",
    ],
    "fresh-matched-validation": [
      "kind",
      "taskCount",
      "attemptsPerArm",
      "pairOrder",
      "weightingPolicyHash",
      "hypothesisExclusionAttestationHash",
    ],
    "fresh-shadow": [
      "kind",
      "taskCount",
      "attemptsPerTask",
      "shadowSlice",
      "feedback",
    ],
    "official-full": [
      "kind",
      "expectedArmCount",
      "authorizationHash",
      "feedback",
    ],
  };
  if (!(selection.kind in allowedSelectionKeys)) {
    throw new EvaluatorContractError("Panel selection kind is unsupported.");
  }
  assertExactObjectKeys(
    selection,
    allowedSelectionKeys[selection.kind],
    "Panel selection request",
  );
  if (request.stage === "repair" && selection.kind !== "repair-reuse") {
    throw new EvaluatorContractError("Repair evaluation requires a repair-reuse selection.");
  }
  if (request.stage === "validation" && selection.kind !== "fresh-matched-validation") {
    throw new EvaluatorContractError("Validation requires a fresh matched selection.");
  }
  if (request.stage === "shadow" && selection.kind !== "fresh-shadow") {
    throw new EvaluatorContractError("Shadow evaluation requires a feedback-dark selection.");
  }
  if (request.stage === "baseline" && selection.kind !== "weighted-baseline") {
    throw new EvaluatorContractError("Baseline evaluation requires a weighted baseline selection.");
  }
  if (request.stage === "official" && selection.kind !== "official-full") {
    throw new EvaluatorContractError("Official evaluation requires an authorized full selection.");
  }
  if (
    (selection.kind === "weighted-baseline" ||
      selection.kind === "fresh-matched-validation") &&
    !SHA256.test(selection.weightingPolicyHash)
  ) {
    throw new EvaluatorContractError("Selection weighting policy must be pinned.");
  }
  if (
    selection.kind === "fresh-matched-validation" &&
    !SHA256.test(selection.hypothesisExclusionAttestationHash)
  ) {
    throw new EvaluatorContractError("Fresh validation requires a hypothesis-exclusion attestation.");
  }
  if (
    selection.kind === "repair-reuse" &&
    (!SAFE_ID.test(selection.sourceExperimentId) ||
      selection.sourceExperimentId === request.experimentId)
  ) {
    throw new EvaluatorContractError("Repair source experiment is invalid.");
  }
  if (
    (selection.kind === "weighted-baseline" &&
      (selection.taskCount !== 12 || selection.attemptsPerTask !== 1)) ||
    (selection.kind === "repair-reuse" &&
      (selection.taskCount !== 5 ||
        selection.attemptsPerTask !== 1 ||
        (selection.candidateAttempt !== 1 && selection.candidateAttempt !== 2))) ||
    (selection.kind === "fresh-matched-validation" &&
      (selection.taskCount !== 12 ||
        selection.attemptsPerArm !== 1 ||
        selection.pairOrder !== "balanced-6-ab-6-ba")) ||
    (selection.kind === "fresh-shadow" &&
      (selection.taskCount !== 12 ||
        selection.attemptsPerTask !== 1 ||
        (selection.shadowSlice !== 1 && selection.shadowSlice !== 2) ||
        selection.feedback !== "disabled"))
  ) {
    throw new EvaluatorContractError("Panel selection violates the frozen attempt budget.");
  }
  if (
    selection.kind === "official-full" &&
    (!Number.isSafeInteger(selection.expectedArmCount) ||
      selection.expectedArmCount <= 0 ||
      selection.expectedArmCount > 1000 ||
      !SHA256.test(selection.authorizationHash) ||
      selection.feedback !== "disabled")
  ) {
    throw new EvaluatorContractError("Official selection authorization is invalid.");
  }
}

export function assertEvaluationRequest(request: TrustedEvaluationRequest): void {
  assertExactObjectKeys(
    request,
    [
      "schemaVersion",
      "requestId",
      "experimentId",
      "runMode",
      "stage",
      "submittedAt",
      "deadlineAt",
      "protocolHash",
      "complianceManifestHash",
      "candidate",
      "champion",
      "selection",
      "executionProfile",
      "evaluatedModel",
    ],
    "Evaluation request",
  );
  if (request.schemaVersion !== 1) {
    throw new EvaluatorContractError("Evaluation request schema version is unsupported.");
  }
  if (!SAFE_ID.test(request.requestId) || !SAFE_ID.test(request.experimentId)) {
    throw new EvaluatorContractError("Evaluation request identifiers are malformed.");
  }
  if (
    !new Set<RunMode>(["research", "submission"]).has(request.runMode) ||
    !new Set<EvaluationStage>([
      "baseline",
      "repair",
      "validation",
      "shadow",
      "official",
    ]).has(request.stage)
  ) {
    throw new EvaluatorContractError("Evaluation run mode or stage is unsupported.");
  }
  assertIsoDate(request.submittedAt, "Submission time");
  assertIsoDate(request.deadlineAt, "Deadline");
  if (Date.parse(request.deadlineAt) <= Date.parse(request.submittedAt)) {
    throw new EvaluatorContractError("Evaluation deadline must follow submission.");
  }
  assertHash(request.protocolHash, "Protocol");
  assertHash(request.complianceManifestHash, "Compliance manifest");
  if (request.executionProfile.protocolHash !== request.protocolHash) {
    throw new EvaluatorContractError("Request and execution profile protocol hashes differ.");
  }
  assertProfile(request.executionProfile);
  assertArtifact(request.candidate, "Candidate");
  if (request.champion !== undefined) assertArtifact(request.champion, "Champion");
  const matchedRace =
    request.stage === "repair" ||
    request.stage === "validation" ||
    request.stage === "shadow";
  if (
    matchedRace &&
    (request.champion === undefined ||
      request.champion.commitSha === request.candidate.commitSha)
  ) {
    throw new EvaluatorContractError(
      "Matched evaluation requires distinct candidate and champion artifacts.",
    );
  }
  if (!matchedRace && request.champion !== undefined) {
    throw new EvaluatorContractError(
      "Champion artifact is accepted only for a matched adaptive race.",
    );
  }
  if (
    !TOOL_OR_MODEL_ID.test(request.evaluatedModel.provider) ||
    !TOOL_OR_MODEL_ID.test(request.evaluatedModel.modelId)
  ) {
    throw new EvaluatorContractError("Evaluated model must use exact safe identifiers.");
  }
  assertExactObjectKeys(
    request.evaluatedModel,
    ["provider", "modelId", "thinkingLevel"],
    "Evaluated model",
  );
  if (
    !new Set([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]).has(request.evaluatedModel.thinkingLevel)
  ) {
    throw new EvaluatorContractError("Evaluated model thinking level is unsupported.");
  }
  if (request.runMode === "submission" && request.stage !== "official") {
    throw new EvaluatorContractError(
      "Submission mode accepts only the separately authorized official evaluation.",
    );
  }
  if (request.runMode === "research" && request.stage === "official") {
    throw new EvaluatorContractError("Official evaluation cannot run in adaptive research mode.");
  }
  assertSelection(request);
}

export function hashEvaluationRequest(request: TrustedEvaluationRequest): string {
  assertEvaluationRequest(request);
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}
