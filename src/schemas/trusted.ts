import { Type, type Static } from "@sinclair/typebox";

import {
  AggregateCostSchema,
  ArtifactMetadataProperties,
  HashSchema,
  IntegrityStatusSchema,
  IntervalSchema,
  JSON_SCHEMA_DIALECT,
  Nullable,
  PolicyVersionsSchema,
  PrivacySupportSchema,
  ProbabilitySchema,
  RunModeSchema,
  SafeIdentifierSchema,
  SignatureSchema,
  TimestampSchema,
  UnitIntervalSchema,
} from "./primitives.js";

export const NormalizedGraderOutcomeSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    outcome: Type.Union([
      Type.Literal("pass"),
      Type.Literal("fail"),
      Type.Literal("invalid"),
    ]),
    boundedReward: UnitIntervalSchema,
    infrastructureInvalidClass: Nullable(
      Type.Union([
        Type.Literal("provider-capacity"),
        Type.Literal("provider-timeout"),
        Type.Literal("sandbox-startup"),
        Type.Literal("image"),
        Type.Literal("network"),
        Type.Literal("evaluator"),
        Type.Literal("unknown"),
      ]),
    ),
    integrityStatus: IntegrityStatusSchema,
    elapsedTimeBucket: Type.Union([
      Type.Literal("under-1m"),
      Type.Literal("1-5m"),
      Type.Literal("5-15m"),
      Type.Literal("15-30m"),
      Type.Literal("30m-plus"),
    ]),
    cpuBucket: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("unknown"),
    ]),
    memoryBucket: Type.Union([
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("unknown"),
    ]),
    protocolHash: HashSchema,
    environmentFingerprintHash: HashSchema,
    oneUseAttemptDigest: HashSchema,
    derivationHash: HashSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/normalized-grader-outcome-1.0.0.json",
    additionalProperties: false,
  },
);

const RepairReleaseSchema = Type.Object(
  {
    kind: Type.Literal("repair"),
    disposition: Type.Union([
      Type.Literal("passed"),
      Type.Literal("failed"),
      Type.Literal("inconclusive"),
    ]),
    attemptOrdinal: Type.Integer({ minimum: 1, maximum: 2 }),
    integrityStatus: IntegrityStatusSchema,
    aggregateCost: AggregateCostSchema,
    policyAttestationHash: HashSchema,
  },
  { additionalProperties: false },
);

const ValidationReleaseSchema = Type.Object(
  {
    kind: Type.Literal("validation"),
    disposition: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
    ]),
    matchedTaskCount: Type.Literal(12),
    validFreshArmCount: Type.Literal(24),
    invalidArmTotal: Type.Integer({ minimum: 0, maximum: 4 }),
    stratumCount: Type.Integer({ minimum: 2, maximum: 16 }),
    pairOutcomeTotals: Type.Object(
      {
        bothPass: Type.Integer({ minimum: 0 }),
        challengerOnlyPass: Type.Integer({ minimum: 0 }),
        championOnlyPass: Type.Integer({ minimum: 0 }),
        bothFail: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    weightedAccuracy: Type.Object(
      {
        medianDelta: Type.Number({ minimum: -1, maximum: 1 }),
        credibleInterval: IntervalSchema,
        probabilityPositive: ProbabilitySchema,
      },
      { additionalProperties: false },
    ),
    requiredPosteriorProbability: ProbabilitySchema,
    onlineGateAuthorized: Type.Boolean(),
    stratumRegressionVeto: Type.Boolean(),
    integrityVeto: Type.Boolean(),
    correctnessVeto: Type.Boolean(),
    capabilityVeto: Type.Boolean(),
    costWithinGuardrail: Type.Boolean(),
    latencyWithinGuardrail: Type.Boolean(),
    accuracyTradeoffPredeclared: Type.Boolean(),
    aggregateCost: AggregateCostSchema,
  },
  { additionalProperties: false },
);

const ShadowReleaseSchema = Type.Object(
  {
    kind: Type.Literal("shadow"),
    disposition: Type.Union([
      Type.Literal("certified"),
      Type.Literal("not-certified"),
      Type.Literal("inconclusive"),
    ]),
    compliancePassed: Type.Boolean(),
    aggregateCost: AggregateCostSchema,
  },
  { additionalProperties: false },
);

export const SignedResultEnvelopeSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    envelopeId: SafeIdentifierSchema,
    experimentNumber: Type.Integer({ minimum: 0 }),
    mode: RunModeSchema,
    protocolHash: HashSchema,
    oneUseRequest: Type.Object(
      {
        requestId: SafeIdentifierSchema,
        requestHash: HashSchema,
        dispositionAttestationHash: HashSchema,
        reuseProhibited: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    payload: Type.Union([RepairReleaseSchema, ValidationReleaseSchema, ShadowReleaseSchema]),
    derivation: Type.Object(
      {
        normalizedOutcomeSetHash: HashSchema,
        cacheAttestationHash: HashSchema,
        behavioralAggregateHash: Nullable(HashSchema),
        rawArtifacts: Type.Object(
          {
            exported: Type.Literal(false),
            retentionDisposition: Type.Union([
              Type.Literal("destroyed"),
              Type.Literal("quarantined"),
            ]),
            retentionPolicyHash: HashSchema,
          },
          { additionalProperties: false },
        ),
        derivedAt: TimestampSchema,
      },
      { additionalProperties: false },
    ),
    releaseChecks: Type.Object(
      {
        schemaPassed: Type.Literal(true),
        graderCanaryScanPassed: Type.Literal(true),
        contentFingerprintScanPassed: Type.Literal(true),
        taskIdentityScanPassed: Type.Literal(true),
        privacyThresholdPassed: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    signature: SignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/signed-result-envelope-1.0.0.json",
    additionalProperties: false,
  },
);

export const SignedBehavioralReleaseSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    releaseId: SafeIdentifierSchema,
    experimentNumber: Type.Integer({ minimum: 1 }),
    sourceResultEnvelopeHash: HashSchema,
    protocolHash: HashSchema,
    policyVersions: PolicyVersionsSchema,
    support: PrivacySupportSchema,
    aggregateArtifactHashes: Type.Object(
      {
        behavioralEvidence: HashSchema,
        failureCards: HashSchema,
        diagnosticBrief: HashSchema,
      },
      { additionalProperties: false },
    ),
    suppressedFindingCountBand: Type.Union([
      Type.Literal("0"),
      Type.Literal("1-4"),
      Type.Literal("5-9"),
      Type.Literal("10-19"),
      Type.Literal("20+"),
    ]),
    releaseOnce: Type.Literal(true),
    signature: SignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/signed-behavioral-release-1.0.0.json",
    additionalProperties: false,
  },
);

export const ComplianceManifestSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    manifestId: SafeIdentifierSchema,
    experimentNumber: Type.Integer({ minimum: 0 }),
    mode: RunModeSchema,
    baselineLineageId: SafeIdentifierSchema,
    protocolHash: HashSchema,
    enabledChannels: Type.Object(
      {
        diagnosticGeneration: Type.Boolean(),
        diagnosticRetrieval: Type.Boolean(),
        repairFeedback: Type.Boolean(),
        optimizerMcp: Type.Boolean(),
        officialEvaluation: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    pluginPermissionPolicyHash: HashSchema,
    panelPolicyHash: HashSchema,
    leaderboardEligibility: Type.Union([
      Type.Literal("unverified"),
      Type.Literal("cleared"),
      Type.Literal("strict-score-only"),
    ]),
    failClosed: Type.Literal(true),
    issuedAt: TimestampSchema,
    signature: SignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/compliance-manifest-1.0.0.json",
    additionalProperties: false,
  },
);

export type NormalizedGraderOutcome = Static<typeof NormalizedGraderOutcomeSchema>;
export type SignedResultEnvelope = Static<typeof SignedResultEnvelopeSchema>;
export type SignedBehavioralRelease = Static<typeof SignedBehavioralReleaseSchema>;
export type ComplianceManifest = Static<typeof ComplianceManifestSchema>;
