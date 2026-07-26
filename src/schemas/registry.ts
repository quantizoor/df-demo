import type { Static, TSchema } from "@sinclair/typebox";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { reproduceFreshValidationDisposition } from "../core/validation-decision.js";

import {
  AmendmentSchema,
  AnalysisSchema,
  AttestationSchema,
  BehavioralEvidenceSchema,
  CacheAttestationSchema,
  CandidateSchema,
  DecisionSchema,
  DiagnosticBriefSchema,
  EvaluationPlanSchema,
  EventRecordSchema,
  ExperimentSchema,
  FailureCardsSchema,
  FeedbackEntrySchema,
  HypothesisSchema,
  LeakScanReceiptSchema,
  ResultsSchema,
} from "./artifacts.js";
import { canonicalHash, canonicalJson, hasValidContentHash } from "./canonical.js";
import {
  type CampaignState,
  CampaignStateSchema,
  type HarnessRegistration,
  HarnessRegistrationSchema,
} from "./control.js";
import { assertReleaseSafe } from "./safety.js";
import {
  ComplianceManifestSchema,
  NormalizedGraderOutcomeSchema,
  SignedBehavioralReleaseSchema,
  SignedResultEnvelopeSchema,
} from "./trusted.js";

export const schemaRegistry = {
  amendment: AmendmentSchema,
  analysis: AnalysisSchema,
  attestation: AttestationSchema,
  behavioralEvidence: BehavioralEvidenceSchema,
  cacheAttestation: CacheAttestationSchema,
  campaignState: CampaignStateSchema,
  candidate: CandidateSchema,
  complianceManifest: ComplianceManifestSchema,
  decision: DecisionSchema,
  diagnosticBrief: DiagnosticBriefSchema,
  evaluationPlan: EvaluationPlanSchema,
  eventRecord: EventRecordSchema,
  experiment: ExperimentSchema,
  failureCards: FailureCardsSchema,
  feedbackEntry: FeedbackEntrySchema,
  hypothesis: HypothesisSchema,
  harnessRegistration: HarnessRegistrationSchema,
  leakScanReceipt: LeakScanReceiptSchema,
  normalizedGraderOutcome: NormalizedGraderOutcomeSchema,
  results: ResultsSchema,
  signedBehavioralRelease: SignedBehavioralReleaseSchema,
  signedResultEnvelope: SignedResultEnvelopeSchema,
} as const satisfies Record<string, TSchema>;

export type SchemaName = keyof typeof schemaRegistry;
export type SchemaValue<Name extends SchemaName> = Static<(typeof schemaRegistry)[Name]>;
export type SchemaIdentifier = string;

export const artifactFileSchemas = {
  "analysis.json": "analysis",
  "attestation.json": "attestation",
  "behavioral-evidence.json": "behavioralEvidence",
  "cache-attestation.json": "cacheAttestation",
  "candidate.json": "candidate",
  "decision.json": "decision",
  "diagnostic-brief.json": "diagnosticBrief",
  "evaluation-plan.json": "evaluationPlan",
  "experiment.json": "experiment",
  "failure-cards.json": "failureCards",
  "feedback-entry.json": "feedbackEntry",
  "hypothesis.json": "hypothesis",
  "results.json": "results",
} as const satisfies Record<string, SchemaName>;

export type ArtifactFileName = keyof typeof artifactFileSchemas;

export const REQUIRED_PRESEAL_ARTIFACT_FILES = [
  "analysis.json",
  "behavioral-evidence.json",
  "cache-attestation.json",
  "candidate.json",
  "decision.json",
  "diagnostic-brief.json",
  "evaluation-plan.json",
  "experiment.json",
  "failure-cards.json",
  "feedback-entry.json",
  "hypothesis.json",
  "results.json",
] as const satisfies readonly ArtifactFileName[];

const releaseSafeSchemas = new Set<SchemaName>([
  "behavioralEvidence",
  "cacheAttestation",
  "campaignState",
  "diagnosticBrief",
  "failureCards",
  "harnessRegistration",
  "normalizedGraderOutcome",
  "results",
  "signedBehavioralRelease",
  "signedResultEnvelope",
]);

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormatsModule.default(ajv);

const validators = new Map<SchemaName, ValidateFunction>();
for (const [name, schema] of Object.entries(schemaRegistry) as [
  SchemaName,
  (typeof schemaRegistry)[SchemaName],
][]) {
  validators.set(name, ajv.compile(schema));
}

export class SchemaValidationError extends Error {
  public readonly schemaName: SchemaName;
  public readonly validationErrors: readonly ErrorObject[];

  public constructor(schemaName: SchemaName, validationErrors: readonly ErrorObject[]) {
    const details = validationErrors
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    super(`Schema "${schemaName}" validation failed: ${details}`);
    this.name = "SchemaValidationError";
    this.schemaName = schemaName;
    this.validationErrors = validationErrors;
  }
}

function validatorFor(name: SchemaName): ValidateFunction {
  const validator = validators.get(name);
  if (validator === undefined) {
    throw new Error(`No validator registered for schema "${name}"`);
  }
  return validator;
}

function semanticFailure(name: SchemaName, instancePath: string, message: string): never {
  throw new SchemaValidationError(name, [
    {
      instancePath,
      keyword: "semanticInvariant",
      message,
      params: {},
      schemaPath: "#/semanticInvariant",
    },
  ]);
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a validated object");
  }
  return value as Readonly<Record<string, unknown>>;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("Expected a validated number");
  }
  return value;
}

function checkIntervals(name: SchemaName, value: unknown, path = ""): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      checkIntervals(name, item, `${path}/${index}`);
    });
    return;
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (
    typeof object.modelUsd === "number" &&
    typeof object.sandboxUsd === "number" &&
    typeof object.totalUsd === "number" &&
    Math.abs(object.modelUsd + object.sandboxUsd - object.totalUsd) > 1e-9
  ) {
    semanticFailure(name, `${path}/totalUsd`, "must equal modelUsd plus sandboxUsd");
  }
  if (
    typeof object.lower === "number" &&
    typeof object.upper === "number" &&
    object.lower > object.upper
  ) {
    semanticFailure(name, path, "interval lower bound must not exceed its upper bound");
  }
  for (const [key, item] of Object.entries(object)) {
    checkIntervals(name, item, `${path}/${key}`);
  }
}

function assertSemanticInvariants(name: SchemaName, value: unknown): void {
  const document = objectValue(value);
  checkIntervals(name, document);

  if (name === "candidate") {
    const gates = document.gates as readonly Readonly<Record<string, unknown>>[];
    const integrity = objectValue(document.integrityScan);
    const expected =
      gates.every((gate) => gate.status === "passed") && integrity.status === "passed";
    if (document.allGatesPassed !== expected) {
      semanticFailure(name, "/allGatesPassed", "must agree with every gate and integrity scan");
    }
  }

  if (name === "evaluationPlan") {
    const attestations = document.panelAttestations as readonly Readonly<Record<string, unknown>>[];
    const oneUseHashes = attestations.map((attestation) => attestation.oneUseAttestationHash);
    if (new Set(oneUseHashes).size !== oneUseHashes.length) {
      semanticFailure(
        name,
        "/panelAttestations",
        "one-use broker attestation hashes must not be reused",
      );
    }
    const summaries = document.aggregatePanelSummary as readonly Readonly<
      Record<string, unknown>
    >[];
    for (const [index, summary] of summaries.entries()) {
      const allocated =
        numberValue(summary.hardCount) +
        numberValue(summary.uncertainCount) +
        numberValue(summary.easyCanaryCount) +
        numberValue(summary.underexposedCount);
      if (allocated !== summary.taskCount) {
        semanticFailure(
          name,
          `/aggregatePanelSummary/${index}`,
          "difficulty-band counts must sum to taskCount",
        );
      }
    }
    const stages = document.stages as readonly Readonly<Record<string, unknown>>[];
    for (const [index, stage] of stages.entries()) {
      if (numberValue(stage.totalAttemptCeiling) < numberValue(stage.validArmCeiling)) {
        semanticFailure(
          name,
          `/stages/${index}/totalAttemptCeiling`,
          "must be at least validArmCeiling",
        );
      }
      if (stage.stage === "validation") {
        if (
          stage.taskCount !== 12 ||
          stage.validArmCeiling !== 24 ||
          stage.cacheMaySubstitute !== false ||
          stage.positivePromotionWeight !== true ||
          numberValue(stage.candidateFirstCount) + numberValue(stage.championFirstCount) !== 12
        ) {
          semanticFailure(
            name,
            `/stages/${index}`,
            "validation must preseal 12 tasks, 24 fresh arms, balanced ordering, and no cache",
          );
        }
      }
      if (
        stage.stage === "repair" &&
        (stage.taskCount !== 5 ||
          numberValue(stage.validArmCeiling) < 5 ||
          stage.cacheMaySubstitute !== true ||
          stage.positivePromotionWeight !== false)
      ) {
        semanticFailure(
          name,
          `/stages/${index}`,
          "repair must use five tasks, permit cache controls, and have zero promotion weight",
        );
      }
      if (
        stage.stage === "shadow" &&
        (stage.taskCount !== 12 ||
          stage.validArmCeiling !== 24 ||
          stage.cacheMaySubstitute !== false ||
          stage.positivePromotionWeight !== false ||
          numberValue(stage.candidateFirstCount) + numberValue(stage.championFirstCount) !== 12)
      ) {
        semanticFailure(
          name,
          `/stages/${index}`,
          "shadow must use 12 tasks, 24 fresh arms, balanced ordering, and no cache",
        );
      }
    }
  }

  if (name === "results" && document.validation !== null) {
    const validation = objectValue(document.validation);
    const outcomes = objectValue(validation.outcomes);
    const outcomeTotal =
      numberValue(outcomes.bothPass) +
      numberValue(outcomes.challengerOnlyPass) +
      numberValue(outcomes.championOnlyPass) +
      numberValue(outcomes.bothFail);
    if (outcomeTotal !== validation.matchedTaskCount) {
      semanticFailure(name, "/validation/outcomes", "paired outcomes must sum to matchedTaskCount");
    }
    if (validation.validFreshArmCount !== numberValue(validation.matchedTaskCount) * 2) {
      semanticFailure(
        name,
        "/validation/validFreshArmCount",
        "must contain exactly two fresh arms per matched task",
      );
    }
    if (validation.disposition === "promote") {
      const posterior = objectValue(validation.weightedAccuracy);
      const vetoed =
        validation.stratumRegressionVeto === true ||
        validation.integrityVeto === true ||
        validation.capabilityVeto === true ||
        validation.costVeto === true ||
        validation.latencyVeto === true;
      if (
        numberValue(posterior.probabilityPositive) < 0.95 ||
        numberValue(posterior.medianDelta) < 0.05 ||
        vetoed
      ) {
        semanticFailure(
          name,
          "/validation/disposition",
          "promotion must satisfy posterior thresholds and every veto",
        );
      }
    }
  }

  if (name === "diagnosticBrief") {
    const cards = document.cards as readonly unknown[];
    if (
      (document.status === "no-actionable-evidence" && cards.length !== 0) ||
      (document.status === "actionable-evidence" && cards.length === 0)
    ) {
      semanticFailure(name, "/cards", "card presence must agree with diagnostic status");
    }
  }

  if (name === "attestation" || name === "leakScanReceipt") {
    const leakScan = name === "attestation" ? objectValue(document.graderLeakScan) : document;
    const leakScanPath = name === "attestation" ? "/graderLeakScan" : "";
    if (name === "attestation" && !hasValidContentHash(leakScan)) {
      semanticFailure(
        name,
        "/graderLeakScan/contentHash",
        "must hash the exact signed leak-scan receipt",
      );
    }
    const manifest = leakScan.artifactManifest as readonly Readonly<Record<string, unknown>>[];
    const manifestPaths = manifest.map((entry) => entry.path);
    if (
      new Set(manifestPaths).size !== manifestPaths.length ||
      manifestPaths.some(
        (path, index) => index > 0 && String(manifestPaths[index - 1]) >= String(path),
      )
    ) {
      semanticFailure(
        name,
        `${leakScanPath}/artifactManifest`,
        "artifact paths must be unique and strictly sorted",
      );
    }
    if (leakScan.artifactManifestHash !== canonicalHash(manifest)) {
      semanticFailure(
        name,
        `${leakScanPath}/artifactManifestHash`,
        "must hash the exact leak-scan artifact manifest",
      );
    }
  }

  if (name === "attestation") {
    const checksums = document.artifactChecksums as readonly Readonly<Record<string, unknown>>[];
    const names = checksums.map((checksum) => checksum.artifactName);
    if (new Set(names).size !== names.length) {
      semanticFailure(name, "/artifactChecksums", "artifact names must be unique");
    }
    const leakScan = objectValue(document.graderLeakScan);
    if (leakScan.experimentNumber !== document.experimentNumber) {
      semanticFailure(
        name,
        "/graderLeakScan/experimentNumber",
        "must match the sealed experiment number",
      );
    }
    const manifest = leakScan.artifactManifest as readonly Readonly<Record<string, unknown>>[];
    const manifestPaths = manifest.map((entry) => entry.path);
    if (
      names.length !== manifestPaths.length ||
      checksums.some((checksum, index) => {
        const entry = manifest[index];
        return (
          entry === undefined ||
          checksum.artifactName !== entry.path ||
          checksum.contentHash !== entry.contentHash ||
          checksum.byteHash !== entry.byteHash
        );
      })
    ) {
      semanticFailure(
        name,
        "/artifactChecksums",
        "sealed checksums must exactly match the signed leak-scan manifest",
      );
    }
  }

  if (name === "normalizedGraderOutcome") {
    if (
      (document.outcome === "invalid" && document.infrastructureInvalidClass === null) ||
      (document.outcome !== "invalid" && document.infrastructureInvalidClass !== null)
    ) {
      semanticFailure(
        name,
        "/infrastructureInvalidClass",
        "must be present exactly when outcome is invalid",
      );
    }
  }

  if (name === "signedResultEnvelope") {
    const payload = objectValue(document.payload);
    if (payload.kind === "validation") {
      const totals = objectValue(payload.pairOutcomeTotals);
      const weightedAccuracy = objectValue(payload.weightedAccuracy);
      const onlineErrorBudget = objectValue(payload.onlineErrorBudget);
      const total =
        numberValue(totals.bothPass) +
        numberValue(totals.challengerOnlyPass) +
        numberValue(totals.championOnlyPass) +
        numberValue(totals.bothFail);
      if (total !== payload.matchedTaskCount) {
        semanticFailure(
          name,
          "/payload/pairOutcomeTotals",
          "paired outcomes must sum to matchedTaskCount",
        );
      }
      if (payload.validFreshArmCount !== numberValue(payload.matchedTaskCount) * 2) {
        semanticFailure(
          name,
          "/payload/validFreshArmCount",
          "validation must contain exactly two fresh arms per matched task",
        );
      }
      const alphaSpent = numberValue(onlineErrorBudget.alphaSpent);
      const spentBefore = numberValue(onlineErrorBudget.cumulativeSpentBefore);
      const spentAfter = numberValue(onlineErrorBudget.cumulativeSpentAfter);
      const maximumOnlineError = numberValue(onlineErrorBudget.maximumOnlineError);
      if (
        payload.onlineGateAuthorized !== true ||
        alphaSpent <= 0 ||
        spentBefore + alphaSpent !== spentAfter ||
        spentAfter > maximumOnlineError ||
        Math.abs(numberValue(onlineErrorBudget.remainingAfter) + spentAfter - maximumOnlineError) >
          1e-12 ||
        numberValue(payload.requiredPosteriorProbability) !== Math.max(0.95, 1 - alphaSpent)
      ) {
        semanticFailure(
          name,
          "/payload/onlineErrorBudget",
          "must bind one authorized, monotonic pre-outcome alpha reservation",
        );
      }
      const reproducedDisposition = reproduceFreshValidationDisposition({
        probabilityPositive: numberValue(weightedAccuracy.probabilityPositive),
        medianAccuracyDelta: numberValue(weightedAccuracy.medianDelta),
        requiredPosteriorProbability: numberValue(payload.requiredPosteriorProbability),
        onlineGateAuthorized: payload.onlineGateAuthorized === true,
        stratumRegressionVeto: payload.stratumRegressionVeto === true,
        integrityVeto: payload.integrityVeto === true,
        correctnessVeto: payload.correctnessVeto === true,
        capabilityVeto: payload.capabilityVeto === true,
        costWithinGuardrail: payload.costWithinGuardrail === true,
        latencyWithinGuardrail: payload.latencyWithinGuardrail === true,
        accuracyTradeoffPredeclared: payload.accuracyTradeoffPredeclared === true,
      });
      if (payload.disposition !== reproducedDisposition) {
        semanticFailure(
          name,
          "/payload/disposition",
          "must reproduce exactly from the frozen fresh-validation gate",
        );
      }
    }
  }

  if (name === "complianceManifest") {
    const channels = objectValue(document.enabledChannels);
    if (
      document.mode === "submission" &&
      (channels.diagnosticGeneration !== false ||
        channels.diagnosticRetrieval !== false ||
        channels.repairFeedback !== false ||
        channels.optimizerMcp !== false)
    ) {
      semanticFailure(
        name,
        "/enabledChannels",
        "submission mode must disable every adaptive feedback channel",
      );
    }
    if (document.mode === "research" && channels.officialEvaluation !== false) {
      semanticFailure(
        name,
        "/enabledChannels/officialEvaluation",
        "research mode cannot enable official evaluation",
      );
    }
  }

  if (name === "harnessRegistration") {
    const registration = value as HarnessRegistration;
    const origin = registration.origin;
    const upstream = registration.upstream;
    if (origin.repositoryFingerprint === upstream.repositoryFingerprint) {
      semanticFailure(
        name,
        "/origin/repositoryFingerprint",
        "private origin and canonical upstream must have distinct fingerprints",
      );
    }
    if (origin.fingerprintKeyId !== upstream.fingerprintKeyId) {
      semanticFailure(
        name,
        "/upstream/fingerprintKeyId",
        "origin and upstream fingerprints must use the same HMAC key",
      );
    }
    const expectedProvenance = [
      {
        artifactName: "operator-authorization",
        contentHash: registration.registrationAuthorizationHash,
      },
      {
        artifactName: "repository-verification",
        contentHash: registration.verification.attestationHash,
      },
    ];
    if (canonicalJson(registration.provenanceRefs) !== canonicalJson(expectedProvenance)) {
      semanticFailure(
        name,
        "/provenanceRefs",
        "must bind operator authorization and repository verification",
      );
    }
  }

  if (name === "campaignState") {
    const campaign = value as CampaignState;
    const revision = campaign.revision;
    if (
      (revision === 0 && campaign.previousStateHash !== null) ||
      (revision > 0 && campaign.previousStateHash === null)
    ) {
      semanticFailure(
        name,
        "/previousStateHash",
        "must be null exactly for campaign revision zero",
      );
    }
    const expectedProvenance =
      revision === 0
        ? [
            {
              artifactName: "harness-registration",
              contentHash: campaign.harnessRegistrationHash,
            },
          ]
        : [
            {
              artifactName: "harness-registration",
              contentHash: campaign.harnessRegistrationHash,
            },
            {
              artifactName: "campaign-state",
              contentHash: campaign.previousStateHash,
            },
          ];
    if (canonicalJson(campaign.provenanceRefs) !== canonicalJson(expectedProvenance)) {
      semanticFailure(
        name,
        "/provenanceRefs",
        "must bind the harness registration and immediate campaign predecessor",
      );
    }

    const control = campaign.control;
    const status = control.status;
    const hasStop =
      control.stopRequestedAt !== null &&
      control.stopReason !== null &&
      (status === "stop-requested" || status === "stopped");
    const hasPause =
      control.pausedAt !== null &&
      control.pauseReason !== null &&
      control.pauseAttestationHash !== null &&
      status === "paused";
    if (
      (status === "running" &&
        (control.stopRequestedAt !== null ||
          control.stopReason !== null ||
          control.stoppedAt !== null ||
          control.pausedAt !== null ||
          control.pauseReason !== null ||
          control.pauseAttestationHash !== null)) ||
      ((status === "stop-requested" || status === "stopped") &&
        (!hasStop ||
          control.pausedAt !== null ||
          control.pauseReason !== null ||
          control.pauseAttestationHash !== null)) ||
      (status === "stop-requested" && control.stoppedAt !== null) ||
      (status === "stopped" && control.stoppedAt === null) ||
      (status === "paused" &&
        (!hasPause ||
          control.stopRequestedAt !== null ||
          control.stopReason !== null ||
          control.stoppedAt !== null))
    ) {
      semanticFailure(name, "/control", "control timestamps and reasons must agree with status");
    }
    if ((control.lastResumedAt === null) !== (control.lastResumeAuthorizationHash === null)) {
      semanticFailure(
        name,
        "/control",
        "resume timestamp and authorization hash must be present together",
      );
    }
    if (
      control.runEpoch === 0 &&
      (control.lastResumedAt !== null || control.lastResumeAuthorizationHash !== null)
    ) {
      semanticFailure(name, "/control/runEpoch", "epoch zero cannot contain resume metadata");
    }

    const numbering = campaign.numbering;
    const nextExperiment = numbering.nextExperimentNumber;
    for (const [field, candidate] of [
      ["inFlightExperimentNumber", numbering.inFlightExperimentNumber],
      ["lastInterruptedExperimentNumber", numbering.lastInterruptedExperimentNumber],
    ] as const) {
      if (candidate !== null && candidate >= nextExperiment) {
        semanticFailure(name, `/numbering/${field}`, "must be below nextExperimentNumber");
      }
    }
    if (status === "stopped" && numbering.inFlightExperimentNumber !== null) {
      semanticFailure(
        name,
        "/numbering/inFlightExperimentNumber",
        "must be null while the campaign is stopped",
      );
    }
    if ((numbering.inFlightExperimentNumber === null) !== (numbering.inFlightKind === null)) {
      semanticFailure(
        name,
        "/numbering",
        "in-flight experiment number and kind must be present together",
      );
    }

    const champions = campaign.champions;
    const baseline = champions.baseline;
    const active = champions.active;
    if (baseline.experimentNumber !== 0) {
      semanticFailure(
        name,
        "/champions/baseline/experimentNumber",
        "baseline must be experiment 0",
      );
    }
    if (active.experimentNumber >= nextExperiment) {
      semanticFailure(
        name,
        "/champions/active/experimentNumber",
        "active champion must precede nextExperimentNumber",
      );
    }
    if (champions.certified !== null) {
      const certified = champions.certified;
      if (certified.experimentNumber > active.experimentNumber) {
        semanticFailure(
          name,
          "/champions/certified/experimentNumber",
          "certified champion cannot be newer than the active champion",
        );
      }
    }

    const limits = campaign.budget.limits;
    const usage = campaign.budget.usage;
    const budgetPairs = [
      ["spentUsd", "maximumUsd"],
      ["tokens", "maximumTokens"],
      ["wallTimeMs", "maximumWallTimeMs"],
      ["attempts", "maximumAttempts"],
      ["privacyReleases", "maximumPrivacyReleases"],
      ["promotionLooks", "maximumPromotionLooks"],
      ["onlineErrorSpent", "maximumOnlineError"],
    ] as const;
    for (const [usageField, limitField] of budgetPairs) {
      if (usage[usageField] > limits[limitField]) {
        semanticFailure(name, `/budget/usage/${usageField}`, `must not exceed ${limitField}`);
      }
    }

    const reconstruction = campaign.reconstruction;
    const sealedNumber = reconstruction.lastFullySealedExperimentNumber;
    const sealHead = reconstruction.experimentSealChainHead;
    if ((sealedNumber === null) !== (sealHead === null)) {
      semanticFailure(
        name,
        "/reconstruction",
        "sealed experiment number and seal-chain head must be present together",
      );
    }
    if (
      (reconstruction.lastControllerRecoveryAuthorizationHash === null) !==
      (reconstruction.lastControllerRecoveryLockHash === null)
    ) {
      semanticFailure(
        name,
        "/reconstruction",
        "controller recovery authorization and observed-lock hash must be present together",
      );
    }
    if (
      reconstruction.lastSealedDecision !== null &&
      reconstruction.lastSealedDecision.experimentNumber !== sealedNumber
    ) {
      semanticFailure(
        name,
        "/reconstruction/lastSealedDecision",
        "must describe the last fully sealed experiment",
      );
    }
    if (sealedNumber !== null && sealedNumber >= nextExperiment) {
      semanticFailure(
        name,
        "/reconstruction/lastFullySealedExperimentNumber",
        "must precede nextExperimentNumber",
      );
    }
  }
}

export function assertSchemaShape<Name extends SchemaName>(
  name: Name,
  value: unknown,
): asserts value is SchemaValue<Name> {
  const validator = validatorFor(name);
  if (!validator(value)) {
    throw new SchemaValidationError(name, validator.errors ?? []);
  }
  if (releaseSafeSchemas.has(name)) {
    assertReleaseSafe(value);
  }
  assertSemanticInvariants(name, value);
}

export function assertValidDocument<Name extends SchemaName>(
  name: Name,
  value: unknown,
): asserts value is SchemaValue<Name> {
  assertSchemaShape(name, value);
  if (!hasValidContentHash(value)) {
    throw new SchemaValidationError(name, [
      {
        instancePath: "/contentHash",
        keyword: "contentHash",
        message: "must match the canonical SHA-256 hash of the document",
        params: {},
        schemaPath: "#/contentHash",
      },
    ]);
  }
}

export function isValidDocument<Name extends SchemaName>(
  name: Name,
  value: unknown,
): value is SchemaValue<Name> {
  try {
    assertValidDocument(name, value);
    return true;
  } catch {
    return false;
  }
}

export function schemaNameForArtifact(fileName: string): SchemaName | undefined {
  return artifactFileSchemas[fileName as ArtifactFileName];
}

export function isArtifactFileName(value: string): value is ArtifactFileName {
  return Object.hasOwn(artifactFileSchemas, value);
}

export function schemasAsJson(): Readonly<Record<SchemaName, TSchema>> {
  return schemaRegistry;
}

function resolveSchemaName(identifier: SchemaIdentifier): SchemaName {
  if (Object.hasOwn(schemaRegistry, identifier)) {
    return identifier as SchemaName;
  }
  for (const [name, schema] of Object.entries(schemaRegistry) as [
    SchemaName,
    (typeof schemaRegistry)[SchemaName],
  ][]) {
    if (schema.$id === identifier) {
      return name;
    }
  }
  throw new Error(`Unknown schema identifier "${identifier}"`);
}

export function assertSchema(identifier: SchemaIdentifier, value: unknown): void {
  assertValidDocument(resolveSchemaName(identifier), value);
}

export interface ValidatorRegistry {
  readonly assertSchema: (identifier: SchemaIdentifier, value: unknown) => void;
  readonly isValid: (identifier: SchemaIdentifier, value: unknown) => boolean;
  readonly schema: (identifier: SchemaIdentifier) => TSchema;
}

export function createValidator(): ValidatorRegistry {
  return {
    assertSchema,
    isValid: (identifier, value) => {
      try {
        assertSchema(identifier, value);
        return true;
      } catch {
        return false;
      }
    },
    schema: (identifier) => schemaRegistry[resolveSchemaName(identifier)],
  };
}
