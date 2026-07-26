import { type Static, Type } from "@sinclair/typebox";

import {
  AggregateCostSchema,
  ArtifactMetadataProperties,
  CommitShaSchema,
  CountBandSchema,
  DispositionSchema,
  GitReferenceSchema,
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
  SafeSummarySchema,
  SignatureSchema,
  TimestampSchema,
  UnitIntervalSchema,
  VersionIdentifierSchema,
} from "./primitives.js";

export const ExperimentLifecycleSchema = Type.Union([
  Type.Literal("planned"),
  Type.Literal("candidate-ready"),
  Type.Literal("gates-passed"),
  Type.Literal("repair-evaluating"),
  Type.Literal("challenger"),
  Type.Literal("validation-evaluating"),
  Type.Literal("analyzed"),
  Type.Literal("promoted"),
  Type.Literal("rejected"),
  Type.Literal("inconclusive"),
  Type.Literal("shadow-evaluating"),
  Type.Literal("certified"),
  Type.Literal("not-certified"),
  Type.Literal("sealed"),
]);

export const ExperimentSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 0 }),
    slug: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
    }),
    lifecycleState: ExperimentLifecycleSchema,
    runMode: RunModeSchema,
    parentExperimentNumber: Nullable(Type.Integer({ minimum: 0 })),
    baselineLineageId: SafeIdentifierSchema,
    championBefore: Nullable(CommitShaSchema),
    championAfter: Nullable(CommitShaSchema),
    protocolHash: HashSchema,
    startedAt: TimestampSchema,
    finishedAt: Nullable(TimestampSchema),
    publication: Type.Object(
      {
        status: Type.Union([
          Type.Literal("not-requested"),
          Type.Literal("pending"),
          Type.Literal("published"),
          Type.Literal("failed"),
        ]),
        attempts: Type.Integer({ minimum: 0 }),
        remoteReference: Nullable(GitReferenceSchema),
      },
      { additionalProperties: false },
    ),
    leaderboardEligibility: Type.Union([
      Type.Literal("unverified"),
      Type.Literal("cleared"),
      Type.Literal("strict-score-only"),
    ]),
    finalDisposition: Nullable(
      Type.Union([
        Type.Literal("promoted"),
        Type.Literal("rejected"),
        Type.Literal("inconclusive"),
        Type.Literal("certified"),
        Type.Literal("not-certified"),
        Type.Literal("interrupted"),
      ]),
    ),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/experiment-1.0.0.json",
    additionalProperties: false,
  },
);

export const HypothesisSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    sourceDiagnosticBriefHash: Nullable(HashSchema),
    citedCardIds: Type.Array(SafeIdentifierSchema, { maxItems: 16, uniqueItems: true }),
    observedFailurePattern: SafeSummarySchema,
    causalClaim: SafeSummarySchema,
    proposedIntervention: SafeSummarySchema,
    affectedHarnessComponents: Type.Array(SafeIdentifierSchema, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
    }),
    predictions: Type.Object(
      {
        discoveryRepair: SafeSummarySchema,
        freshAccuracy: SafeSummarySchema,
        freshCapability: SafeSummarySchema,
        freshCost: SafeSummarySchema,
        freshLatency: SafeSummarySchema,
      },
      { additionalProperties: false },
    ),
    generalityJustification: SafeSummarySchema,
    falsificationCriteria: Type.Array(SafeSummarySchema, { minItems: 1, maxItems: 12 }),
    rollbackCondition: SafeSummarySchema,
    frozenAt: TimestampSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/hypothesis-1.0.0.json",
    additionalProperties: false,
  },
);

const GateResultSchema = Type.Object(
  {
    name: SafeIdentifierSchema,
    status: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
    durationMs: Type.Integer({ minimum: 0 }),
    cloudExecutionAttestationHash: HashSchema,
  },
  { additionalProperties: false },
);

export const CandidateSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    repositoryRegistrationId: SafeIdentifierSchema,
    upstreamCommit: CommitShaSchema,
    forkBaseCommit: CommitShaSchema,
    parentCommit: CommitShaSchema,
    candidateCommit: CommitShaSchema,
    treeHash: CommitShaSchema,
    dependencyLockHash: HashSchema,
    patchHash: HashSchema,
    changedFiles: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 512,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
      }),
      { maxItems: 128, uniqueItems: true },
    ),
    mutation: Type.Object(
      {
        category: Type.Union([
          Type.Literal("system-prompt"),
          Type.Literal("tool-policy"),
          Type.Literal("context-management"),
          Type.Literal("recovery"),
          Type.Literal("planning"),
          Type.Literal("verification"),
          Type.Literal("other"),
        ]),
        filesChanged: Type.Integer({ minimum: 0 }),
        linesAdded: Type.Integer({ minimum: 0 }),
        linesDeleted: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    gates: Type.Array(GateResultSchema, { minItems: 1, maxItems: 64 }),
    integrityScan: Type.Object(
      {
        status: IntegrityStatusSchema,
        matchCountBand: CountBandSchema,
        scannedTreeHash: HashSchema,
        policyVersion: SafeIdentifierSchema,
      },
      { additionalProperties: false },
    ),
    allGatesPassed: Type.Boolean(),
    frozenAt: TimestampSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/candidate-1.0.0.json",
    additionalProperties: false,
  },
);

const PanelStageSchema = Type.Union([
  Type.Literal("repair"),
  Type.Literal("validation"),
  Type.Literal("shadow"),
]);

const PanelAttestationSchema = Type.Object(
  {
    stage: PanelStageSchema,
    oneUseAttestationHash: HashSchema,
    nonLinkabilityPolicyVersion: SafeIdentifierSchema,
    reuseProhibited: Type.Literal(true),
    sealedAt: TimestampSchema,
  },
  { additionalProperties: false },
);

const EvaluationStagePlanSchema = Type.Object(
  {
    stage: PanelStageSchema,
    taskCount: Type.Integer({ minimum: 1, maximum: 89 }),
    validArmCeiling: Type.Integer({ minimum: 1, maximum: 100 }),
    replacementAttemptCeiling: Type.Integer({ minimum: 0, maximum: 20 }),
    totalAttemptCeiling: Type.Integer({ minimum: 1, maximum: 120 }),
    candidateFirstCount: Type.Integer({ minimum: 0, maximum: 89 }),
    championFirstCount: Type.Integer({ minimum: 0, maximum: 89 }),
    cacheMaySubstitute: Type.Boolean(),
    positivePromotionWeight: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const EvaluationPlanSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    mode: RunModeSchema,
    protocolHash: HashSchema,
    policyVersions: PolicyVersionsSchema,
    panelAttestations: Type.Array(PanelAttestationSchema, { minItems: 1, maxItems: 3 }),
    aggregatePanelSummary: Type.Array(
      Type.Object(
        {
          stage: PanelStageSchema,
          taskCount: Type.Integer({ minimum: 1, maximum: 89 }),
          hardCount: Type.Integer({ minimum: 0, maximum: 89 }),
          uncertainCount: Type.Integer({ minimum: 0, maximum: 89 }),
          easyCanaryCount: Type.Integer({ minimum: 0, maximum: 89 }),
          underexposedCount: Type.Integer({ minimum: 0, maximum: 89 }),
          stratumCount: Type.Integer({ minimum: 1, maximum: 16 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    stages: Type.Array(EvaluationStagePlanSchema, { minItems: 1, maxItems: 3 }),
    expectedCost: AggregateCostSchema,
    stoppingRules: Type.Object(
      {
        monetaryCeilingUsd: Type.Number({ exclusiveMinimum: 0 }),
        tokenCeiling: Type.Integer({ minimum: 1 }),
        wallTimeCeilingMs: Type.Integer({ minimum: 1 }),
        onlineErrorBudgetRemaining: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    hypothesisFrozenAt: TimestampSchema,
    candidateFrozenAt: TimestampSchema,
    brokerSelectionRequestedAt: TimestampSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/evaluation-plan-1.0.0.json",
    additionalProperties: false,
  },
);

const PairOutcomeTotalsSchema = Type.Object(
  {
    bothPass: Type.Integer({ minimum: 0 }),
    challengerOnlyPass: Type.Integer({ minimum: 0 }),
    championOnlyPass: Type.Integer({ minimum: 0 }),
    bothFail: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const AccuracyPosteriorSchema = Type.Object(
  {
    medianDelta: Type.Number({ minimum: -1, maximum: 1 }),
    credibleInterval: IntervalSchema,
    probabilityPositive: ProbabilitySchema,
    probabilityBelowRegressionFloor: ProbabilitySchema,
    method: Type.Literal("paired-dirichlet-jeffreys"),
  },
  { additionalProperties: false },
);

export const ResultsSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    protocolHash: HashSchema,
    repair: Type.Object(
      {
        disposition: DispositionSchema,
        attemptOrdinal: Type.Integer({ minimum: 0, maximum: 2 }),
        integrityStatus: IntegrityStatusSchema,
        aggregateCost: AggregateCostSchema,
        signedPolicyAttestationHash: HashSchema,
      },
      { additionalProperties: false },
    ),
    validation: Nullable(
      Type.Object(
        {
          disposition: Type.Union([
            Type.Literal("promote"),
            Type.Literal("reject"),
            Type.Literal("inconclusive"),
          ]),
          matchedTaskCount: Type.Integer({ minimum: 12, maximum: 12 }),
          stratumCount: Type.Integer({ minimum: 2, maximum: 16 }),
          validFreshArmCount: Type.Integer({ minimum: 24, maximum: 24 }),
          invalidArmTotal: Type.Integer({ minimum: 0, maximum: 4 }),
          outcomes: PairOutcomeTotalsSchema,
          weightedAccuracy: AccuracyPosteriorSchema,
          stratumRegressionVeto: Type.Boolean(),
          integrityVeto: Type.Boolean(),
          capabilityVeto: Type.Boolean(),
          costVeto: Type.Boolean(),
          latencyVeto: Type.Boolean(),
          aggregateCost: AggregateCostSchema,
          signedResultEnvelopeHash: HashSchema,
        },
        { additionalProperties: false },
      ),
    ),
    shadow: Nullable(
      Type.Object(
        {
          disposition: Type.Union([
            Type.Literal("certified"),
            Type.Literal("not-certified"),
            Type.Literal("inconclusive"),
          ]),
          validFreshArmCount: Type.Integer({ minimum: 24, maximum: 24 }),
          invalidArmTotal: Type.Integer({ minimum: 0, maximum: 4 }),
          compliancePassed: Type.Boolean(),
          aggregateCost: AggregateCostSchema,
          signedResultEnvelopeHash: HashSchema,
        },
        { additionalProperties: false },
      ),
    ),
    compatibleHistoricalIntersections: Type.Array(
      Type.Object(
        {
          comparisonLabel: SafeIdentifierSchema,
          matchedTaskCountBand: CountBandSchema,
          medianAccuracyDelta: Type.Number({ minimum: -1, maximum: 1 }),
          uncertainty: IntervalSchema,
          positivePromotionWeight: Type.Literal(false),
        },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    totalCost: AggregateCostSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/results-1.0.0.json",
    additionalProperties: false,
  },
);

export const CacheAttestationSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    cachePolicyVersion: SafeIdentifierSchema,
    protocolHash: HashSchema,
    aggregateUseStatus: Type.Union([
      Type.Literal("not-used"),
      Type.Literal("partially-used"),
      Type.Literal("used"),
      Type.Literal("ineligible"),
    ]),
    freshnessAgeBands: Type.Array(
      Type.Union([Type.Literal("0-24h"), Type.Literal("1-3d"), Type.Literal("3-7d")]),
      { maxItems: 3, uniqueItems: true },
    ),
    driftStatus: Type.Union([
      Type.Literal("not-applicable"),
      Type.Literal("passed"),
      Type.Literal("failed"),
    ]),
    smallCountSuppressionApplied: Type.Boolean(),
    sealedWindow: Type.Object(
      {
        openedAt: TimestampSchema,
        closedAt: TimestampSchema,
      },
      { additionalProperties: false },
    ),
    repairBudgetCompliant: Type.Boolean(),
    aggregateRepairCost: AggregateCostSchema,
    derivationHash: HashSchema,
    signature: SignatureSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/cache-attestation-1.0.0.json",
    additionalProperties: false,
  },
);

export const BehavioralFeatureSchema = Type.Union([
  Type.Literal("invalid-tool-invocation"),
  Type.Literal("nonzero-exit"),
  Type.Literal("repeated-action"),
  Type.Literal("output-inspection"),
  Type.Literal("recovery-transition"),
  Type.Literal("replan-transition"),
  Type.Literal("verification-action"),
  Type.Literal("compaction-event"),
  Type.Literal("premature-termination"),
  Type.Literal("timeout"),
  Type.Literal("read-write-execute-order"),
  Type.Literal("planning-action-ratio"),
  Type.Literal("token-budget-band"),
  Type.Literal("latency-band"),
  Type.Literal("stop-reason"),
]);

const AggregateBehaviorMetricSchema = Type.Object(
  {
    metricId: SafeIdentifierSchema,
    feature: BehavioralFeatureSchema,
    cohort: Type.Union([
      Type.Literal("all-valid"),
      Type.Literal("candidate"),
      Type.Literal("champion"),
      Type.Literal("successful"),
      Type.Literal("failed"),
    ]),
    support: PrivacySupportSchema,
    prevalence: UnitIntervalSchema,
    comparisonPrevalence: Nullable(UnitIntervalSchema),
    effectSize: Nullable(Type.Number()),
    uncertainty: Nullable(IntervalSchema),
    direction: Type.Union([
      Type.Literal("higher"),
      Type.Literal("lower"),
      Type.Literal("no-clear-difference"),
      Type.Literal("not-compared"),
    ]),
  },
  { additionalProperties: false },
);

export const BehavioralEvidenceSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    sourceEnvelopeHash: HashSchema,
    protocolHash: HashSchema,
    policyVersions: PolicyVersionsSchema,
    analysisWindow: Type.Object(
      {
        openedAt: TimestampSchema,
        closedAt: TimestampSchema,
        support: PrivacySupportSchema,
      },
      { additionalProperties: false },
    ),
    metrics: Type.Array(AggregateBehaviorMetricSchema, { maxItems: 128 }),
    suppressedFindingCountBand: CountBandSchema,
    releaseChecksPassed: Type.Boolean(),
    derivationHash: HashSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/behavioral-evidence-1.0.0.json",
    additionalProperties: false,
  },
);

const FailureCardSchema = Type.Object(
  {
    cardId: SafeIdentifierSchema,
    title: SafeSummarySchema,
    failurePattern: SafeSummarySchema,
    causalInterpretation: SafeSummarySchema,
    affectedHarnessComponent: SafeIdentifierSchema,
    metricIds: Type.Array(SafeIdentifierSchema, { minItems: 1, maxItems: 16, uniqueItems: true }),
    support: PrivacySupportSchema,
    effectSize: Type.Number(),
    uncertainty: IntervalSchema,
    recommendation: SafeSummarySchema,
  },
  { additionalProperties: false },
);

export const FailureCardsSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    behavioralEvidenceHash: HashSchema,
    cards: Type.Array(FailureCardSchema, { maxItems: 32 }),
    suppressionApplied: Type.Boolean(),
    policyVersions: PolicyVersionsSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/failure-cards-1.0.0.json",
    additionalProperties: false,
  },
);

export const DiagnosticBriefSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    releaseId: SafeIdentifierSchema,
    sourceExperimentNumber: Type.Integer({ minimum: 1 }),
    aggregateEvidenceHash: HashSchema,
    failureCardsHash: HashSchema,
    policyVersions: PolicyVersionsSchema,
    status: Type.Union([
      Type.Literal("actionable-evidence"),
      Type.Literal("no-actionable-evidence"),
    ]),
    cards: Type.Array(FailureCardSchema, { maxItems: 16 }),
    limitations: Type.Array(SafeSummarySchema, { minItems: 1, maxItems: 16 }),
    oneUse: Type.Literal(true),
    expiresAt: TimestampSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/diagnostic-brief-1.0.0.json",
    additionalProperties: false,
  },
);

export const AnalysisSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    hypothesisHash: HashSchema,
    resultsHash: HashSchema,
    hypothesisSupported: Nullable(Type.Boolean()),
    citedFailureCardIds: Type.Array(SafeIdentifierSchema, {
      maxItems: 16,
      uniqueItems: true,
    }),
    unexpectedEffects: Type.Array(SafeSummarySchema, { maxItems: 16 }),
    recommendations: Type.Array(SafeSummarySchema, { maxItems: 16 }),
    uncertaintySummary: SafeSummarySchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/analysis-1.0.0.json",
    additionalProperties: false,
  },
);

const ChampionTransitionSchema = Type.Object(
  {
    beforeCommit: CommitShaSchema,
    afterCommit: CommitShaSchema,
    changed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DecisionSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 1 }),
    repairDisposition: DispositionSchema,
    challenger: Type.Boolean(),
    validationDisposition: Type.Union([
      Type.Literal("not-run"),
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
    ]),
    shadowDisposition: Type.Union([
      Type.Literal("not-run"),
      Type.Literal("certified"),
      Type.Literal("not-certified"),
      Type.Literal("inconclusive"),
    ]),
    activeChampionTransition: ChampionTransitionSchema,
    certifiedChampionTransition: Nullable(ChampionTransitionSchema),
    policyThresholdsHash: HashSchema,
    machineRationaleCode: SafeIdentifierSchema,
    oneUseConsumptionAttestationHash: HashSchema,
    onlineErrorBudgetPassed: Type.Boolean(),
    humanOverride: Nullable(
      Type.Object(
        {
          operatorIdHash: HashSchema,
          reasonCode: SafeIdentifierSchema,
          recordedAt: TimestampSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/decision-1.0.0.json",
    additionalProperties: false,
  },
);

export const ArtifactChecksumSchema = Type.Object(
  {
    artifactName: SafeIdentifierSchema,
    contentHash: HashSchema,
    byteHash: HashSchema,
  },
  { additionalProperties: false },
);

export const LeakScanArtifactManifestEntrySchema = Type.Object(
  {
    path: SafeIdentifierSchema,
    // Registry schema names are TypeScript-style identifiers (for example,
    // "behavioralEvidence"), so the lowercase artifact-name grammar is too
    // narrow for this field.
    schemaKind: VersionIdentifierSchema,
    contentHash: HashSchema,
    byteHash: HashSchema,
    bytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

/**
 * The leak scanner signs this entire object (apart from `signature`) after
 * scanning the immutable bytes named by `artifactManifest`.  Keeping the
 * receipt in the seal makes the no-grader-leak claim independently auditable
 * instead of trusting a caller-provided boolean or version string.
 */
const LeakScanReceiptProperties = {
  contentHash: HashSchema,
  schemaVersion: Type.Literal("1.0.0"),
  experimentId: Type.String({
    minLength: 5,
    maxLength: 128,
    pattern: "^\\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$",
  }),
  experimentNumber: Type.Integer({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  }),
  artifactManifest: Type.Array(LeakScanArtifactManifestEntrySchema, {
    minItems: 1,
    maxItems: 64,
  }),
  artifactManifestHash: HashSchema,
  eventRecordCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  eventChainHead: HashSchema,
  protocolHash: HashSchema,
  scannerPolicyVersion: VersionIdentifierSchema,
  scannerVersion: VersionIdentifierSchema,
  checkedAt: TimestampSchema,
  status: Type.Literal("passed"),
  passed: Type.Literal(true),
  matchCountBand: Type.Literal("0"),
  signature: SignatureSchema,
} as const;

export const LeakScanReceiptSchema = Type.Object(LeakScanReceiptProperties, {
  $schema: JSON_SCHEMA_DIALECT,
  $id: "https://dark-factory.local/schemas/leak-scan-receipt-1.0.0.json",
  additionalProperties: false,
});

export const AttestationSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 0 }),
    schemaChecksPassed: Type.Literal(true),
    artifactChecksums: Type.Array(ArtifactChecksumSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    pinnedVersions: Type.Object(
      {
        node: VersionIdentifierSchema,
        darkFactory: VersionIdentifierSchema,
        terminalBench: VersionIdentifierSchema,
        harbor: VersionIdentifierSchema,
        piCommit: CommitShaSchema,
        claudeCode: VersionIdentifierSchema,
        optimizerModel: VersionIdentifierSchema,
        evaluatedModel: VersionIdentifierSchema,
        sandboxImageDigest: HashSchema,
      },
      { additionalProperties: false },
    ),
    graderLeakScan: Type.Object(LeakScanReceiptProperties, {
      additionalProperties: false,
    }),
    eventRecordCount: Type.Integer({ minimum: 1 }),
    eventChainHead: HashSchema,
    sealedAt: TimestampSchema,
    previousExperimentSealHash: Nullable(HashSchema),
    sealChainEntryHash: HashSchema,
    signer: Nullable(SignatureSchema),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/attestation-1.0.0.json",
    additionalProperties: false,
  },
);

export const FeedbackEntrySchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 0 }),
    heading: SafeSummarySchema,
    lifecycleDisposition: Type.Union([
      Type.Literal("baseline"),
      Type.Literal("promoted"),
      Type.Literal("rejected"),
      Type.Literal("inconclusive"),
      Type.Literal("certified"),
      Type.Literal("not-certified"),
      Type.Literal("interrupted"),
    ]),
    hypothesisSummary: SafeSummarySchema,
    decisionSummary: SafeSummarySchema,
    evidenceRefs: Type.Array(
      Type.Object(
        {
          artifactName: SafeIdentifierSchema,
          contentHash: HashSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 32 },
    ),
    aggregateCost: AggregateCostSchema,
    generatedAt: TimestampSchema,
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/feedback-entry-1.0.0.json",
    additionalProperties: false,
  },
);

export const EventTypeSchema = Type.Union([
  Type.Literal("experiment-created"),
  Type.Literal("lifecycle-transition"),
  Type.Literal("artifact-written"),
  Type.Literal("evidence-query"),
  Type.Literal("tool-request"),
  Type.Literal("evaluator-milestone"),
  Type.Literal("publication-attempt"),
  Type.Literal("operator-action"),
  Type.Literal("interrupted"),
  Type.Literal("experiment-sealed"),
]);

export const EventRecordSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 0 }),
    sequence: Type.Integer({ minimum: 0 }),
    previousEventHash: Nullable(HashSchema),
    eventType: EventTypeSchema,
    actor: Type.Union([
      Type.Literal("controller"),
      Type.Literal("optimizer"),
      Type.Literal("trusted-broker"),
      Type.Literal("operator"),
    ]),
    payload: Type.Object(
      {
        messageCode: SafeIdentifierSchema,
        artifactName: Nullable(SafeIdentifierSchema),
        stateFrom: Nullable(ExperimentLifecycleSchema),
        stateTo: Nullable(ExperimentLifecycleSchema),
        aggregateCountBand: Nullable(CountBandSchema),
        validArmCount: Nullable(Type.Integer({ minimum: 0, maximum: 100 })),
        invalidArmCount: Nullable(Type.Integer({ minimum: 0, maximum: 20 })),
        attestationHash: Nullable(HashSchema),
      },
      { additionalProperties: false },
    ),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/event-record-1.0.0.json",
    additionalProperties: false,
  },
);

export const AmendmentOperationSchema = Type.Object(
  {
    artifactName: SafeIdentifierSchema,
    jsonPointer: Type.String({
      minLength: 1,
      maxLength: 512,
      pattern: "^/(?:[^~/]|~0|~1)+(?:/(?:[^~/]|~0|~1)+)*$",
    }),
    priorValueHash: Nullable(HashSchema),
    replacementValue: Type.Union([
      Type.String({ maxLength: 1_000 }),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const AmendmentSchema = Type.Object(
  {
    ...ArtifactMetadataProperties,
    experimentNumber: Type.Integer({ minimum: 0 }),
    amendmentNumber: Type.Integer({ minimum: 1 }),
    sealedAttestationHash: HashSchema,
    previousAmendmentHash: Nullable(HashSchema),
    reasonCode: SafeIdentifierSchema,
    summary: SafeSummarySchema,
    operations: Type.Array(AmendmentOperationSchema, { minItems: 1, maxItems: 64 }),
    signer: Nullable(SignatureSchema),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/amendment-1.0.0.json",
    additionalProperties: false,
  },
);

export type Experiment = Static<typeof ExperimentSchema>;
export type Hypothesis = Static<typeof HypothesisSchema>;
export type Candidate = Static<typeof CandidateSchema>;
export type EvaluationPlan = Static<typeof EvaluationPlanSchema>;
export type Results = Static<typeof ResultsSchema>;
export type CacheAttestation = Static<typeof CacheAttestationSchema>;
export type BehavioralEvidence = Static<typeof BehavioralEvidenceSchema>;
export type FailureCards = Static<typeof FailureCardsSchema>;
export type DiagnosticBrief = Static<typeof DiagnosticBriefSchema>;
export type Analysis = Static<typeof AnalysisSchema>;
export type Decision = Static<typeof DecisionSchema>;
export type LeakScanArtifactManifestEntry = Static<typeof LeakScanArtifactManifestEntrySchema>;
export type LeakScanReceipt = Static<typeof LeakScanReceiptSchema>;
export type Attestation = Static<typeof AttestationSchema>;
export type FeedbackEntry = Static<typeof FeedbackEntrySchema>;
export type EventRecord = Static<typeof EventRecordSchema>;
export type Amendment = Static<typeof AmendmentSchema>;
