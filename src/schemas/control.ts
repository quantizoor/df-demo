import { Type, type Static } from "@sinclair/typebox";

import {
  HashSchema,
  JSON_SCHEMA_DIALECT,
  Nullable,
  RunModeSchema,
  SafeIdentifierSchema,
  TimestampSchema,
} from "./primitives.js";

export const CONTROL_SCHEMA_VERSION = "1.2.0" as const;

const ControlMetadataProperties = {
  schemaVersion: Type.Literal(CONTROL_SCHEMA_VERSION),
  createdAt: TimestampSchema,
  contentHash: HashSchema,
};

const ControlProvenanceReferenceSchema = Type.Object(
  {
    artifactName: Type.Union([
      Type.Literal("harness-registration"),
      Type.Literal("campaign-state"),
    ]),
    contentHash: HashSchema,
  },
  { additionalProperties: false },
);

const RegistrationProvenanceReferenceSchema = Type.Object(
  {
    artifactName: Type.Union([
      Type.Literal("operator-authorization"),
      Type.Literal("repository-verification"),
    ]),
    contentHash: HashSchema,
  },
  { additionalProperties: false },
);

const WorkspaceRelativePathSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern:
    "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*\\\\)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
});

const SanitizedRemoteFingerprintSchema = Type.Object(
  {
    hostFingerprint: HashSchema,
    repositoryFingerprint: HashSchema,
    fingerprintAlgorithm: Type.Literal("hmac-sha256"),
    fingerprintKeyId: SafeIdentifierSchema,
    transport: Type.Union([Type.Literal("https"), Type.Literal("ssh")]),
    verificationAttestationHash: HashSchema,
    verifiedAt: TimestampSchema,
    credentialMaterialPersisted: Type.Literal(false),
  },
  { additionalProperties: false },
);

const SafeCounterSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

const PositiveExperimentNumberSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const GitObjectIdSchema = Type.String({
  pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
});

/**
 * Credential-free identity for one operator-approved harness checkout.
 *
 * Remote locations are represented only by salted fingerprints. The controller
 * obtains usable remotes and credentials from its runtime secret boundary.
 */
export const HarnessRegistrationSchema = Type.Object(
  {
    ...ControlMetadataProperties,
    provenanceRefs: Type.Array(RegistrationProvenanceReferenceSchema, {
      minItems: 2,
      maxItems: 2,
      uniqueItems: true,
    }),
    registrationId: SafeIdentifierSchema,
    registrationAuthorizationHash: HashSchema,
    harnessKind: Type.Literal("pi-coding-agent"),
    repositoryType: Type.Literal("private-fork"),
    workspaceRelativePath: WorkspaceRelativePathSchema,
    defaultBranch: SafeIdentifierSchema,
    origin: Type.Object(
      {
        ...SanitizedRemoteFingerprintSchema.properties,
        privateVisibilityVerified: Type.Literal(true),
        writableVerified: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    upstream: Type.Object(
      {
        ...SanitizedRemoteFingerprintSchema.properties,
        canonicalPublicSourceVerified: Type.Literal(true),
        writeAccessRequired: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
    provenance: Type.Object(
      {
        registeredForkCommit: GitObjectIdSchema,
        upstreamCommit: GitObjectIdSchema,
        mergeBaseCommit: GitObjectIdSchema,
        registeredTree: GitObjectIdSchema,
      },
      { additionalProperties: false },
    ),
    dependencyLock: Type.Object(
      {
        path: WorkspaceRelativePathSchema,
        contentHash: HashSchema,
        packageManager: Type.Literal("npm"),
        installMode: Type.Literal("npm-ci"),
      },
      { additionalProperties: false },
    ),
    verification: Type.Object(
      {
        canonicalWorktreeClean: Type.Literal(true),
        canonicalWorktreeAttached: Type.Literal(true),
        originHeadPublished: Type.Literal(true),
        upstreamFetchVerified: Type.Literal(true),
        policyVersion: SafeIdentifierSchema,
        attestationHash: HashSchema,
      },
      { additionalProperties: false },
    ),
    adapter: Type.Object(
      {
        adapterId: Type.Literal("harbor-pi-print-json"),
        executionMode: Type.Literal("print-json"),
        sessionsDisabled: Type.Literal(true),
        uncontrolledExtensionsDisabled: Type.Literal(true),
        uncontrolledContextFilesDisabled: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/harness-registration-1.2.0.json",
    additionalProperties: false,
  },
);

const ChampionPointerSchema = Type.Object(
  {
    experimentNumber: SafeCounterSchema,
    commit: GitObjectIdSchema,
    sourceSealHash: HashSchema,
  },
  { additionalProperties: false },
);

const BudgetLimitsSchema = Type.Object(
  {
    maximumUsd: Type.Number({ minimum: 0 }),
    maximumTokens: SafeCounterSchema,
    maximumWallTimeMs: SafeCounterSchema,
    maximumAttempts: SafeCounterSchema,
    maximumPrivacyReleases: SafeCounterSchema,
    maximumPromotionLooks: SafeCounterSchema,
    maximumOnlineError: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

const BudgetUsageSchema = Type.Object(
  {
    spentUsd: Type.Number({ minimum: 0 }),
    tokens: SafeCounterSchema,
    wallTimeMs: SafeCounterSchema,
    attempts: SafeCounterSchema,
    privacyReleases: SafeCounterSchema,
    promotionLooks: SafeCounterSchema,
    onlineErrorSpent: Type.Number({ minimum: 0, maximum: 1 }),
  },
  { additionalProperties: false },
);

export const CampaignStopReasonSchema = Type.Union([
  Type.Literal("operator"),
  Type.Literal("sigint"),
  Type.Literal("sigterm"),
  Type.Literal("system-shutdown"),
]);

export const CampaignPauseReasonSchema = Type.Union([
  Type.Literal("budget-exhausted"),
  Type.Literal("holdout-exhausted"),
  Type.Literal("integrity"),
  Type.Literal("infrastructure"),
  Type.Literal("policy"),
  Type.Literal("publication"),
]);

const LastSealedDecisionSchema = Type.Union([
  Type.Object(
    {
      experimentNumber: PositiveExperimentNumberSchema,
      stage: Type.Literal("pre-validation"),
      disposition: Type.Union([
        Type.Literal("rejected"),
        Type.Literal("inconclusive"),
      ]),
      decisionAttestationHash: HashSchema,
      sealedAt: TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      experimentNumber: PositiveExperimentNumberSchema,
      stage: Type.Literal("validation"),
      disposition: Type.Union([
        Type.Literal("promoted"),
        Type.Literal("rejected"),
        Type.Literal("inconclusive"),
      ]),
      decisionAttestationHash: HashSchema,
      sealedAt: TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      experimentNumber: PositiveExperimentNumberSchema,
      stage: Type.Literal("shadow"),
      disposition: Type.Union([
        Type.Literal("certified"),
        Type.Literal("not-certified"),
        Type.Literal("inconclusive"),
      ]),
      decisionAttestationHash: HashSchema,
      sealedAt: TimestampSchema,
    },
    { additionalProperties: false },
  ),
]);

/**
 * The entire locally durable campaign control state.
 *
 * It intentionally stores only aggregate capacity and signed state hashes. It
 * has no field capable of carrying a benchmark assignment, pool membership,
 * one-use allocation handle, or row-level outcome.
 */
export const CampaignStateSchema = Type.Object(
  {
    ...ControlMetadataProperties,
    provenanceRefs: Type.Array(ControlProvenanceReferenceSchema, {
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    }),
    campaignId: SafeIdentifierSchema,
    revision: SafeCounterSchema,
    previousStateHash: Nullable(HashSchema),
    mode: RunModeSchema,
    baselineLineageId: SafeIdentifierSchema,
    protocolHash: HashSchema,
    harnessRegistrationHash: HashSchema,
    control: Type.Object(
      {
        status: Type.Union([
          Type.Literal("running"),
          Type.Literal("stop-requested"),
          Type.Literal("stopped"),
          Type.Literal("paused"),
        ]),
        runEpoch: SafeCounterSchema,
        stopRequestedAt: Nullable(TimestampSchema),
        stopReason: Nullable(CampaignStopReasonSchema),
        stoppedAt: Nullable(TimestampSchema),
        pausedAt: Nullable(TimestampSchema),
        pauseReason: Nullable(CampaignPauseReasonSchema),
        pauseAttestationHash: Nullable(HashSchema),
        lastResumedAt: Nullable(TimestampSchema),
        lastResumeAuthorizationHash: Nullable(HashSchema),
      },
      { additionalProperties: false },
    ),
    numbering: Type.Object(
      {
        nextExperimentNumber: PositiveExperimentNumberSchema,
        inFlightExperimentNumber: Nullable(PositiveExperimentNumberSchema),
        inFlightKind: Nullable(
          Type.Union([Type.Literal("optimization"), Type.Literal("shadow")]),
        ),
        lastInterruptedExperimentNumber: Nullable(PositiveExperimentNumberSchema),
      },
      { additionalProperties: false },
    ),
    champions: Type.Object(
      {
        baseline: ChampionPointerSchema,
        active: ChampionPointerSchema,
        certified: Nullable(ChampionPointerSchema),
        updatedAt: TimestampSchema,
      },
      { additionalProperties: false },
    ),
    budget: Type.Object(
      {
        limits: BudgetLimitsSchema,
        usage: BudgetUsageSchema,
        policyHash: HashSchema,
        authorizationHash: HashSchema,
        accountingAttestationHash: HashSchema,
      },
      { additionalProperties: false },
    ),
    holdout: Type.Object(
      {
        freshValidationSetsRemaining: SafeCounterSchema,
        shadowSlicesRemaining: SafeCounterSchema,
        generation: SafeCounterSchema,
        policyHash: HashSchema,
        availabilityAttestationHash: HashSchema,
        replenishmentAuthorizationHash: Nullable(HashSchema),
      },
      { additionalProperties: false },
    ),
    reconstruction: Type.Object(
      {
        lastFullySealedExperimentNumber: Nullable(SafeCounterSchema),
        experimentSealChainHead: Nullable(HashSchema),
        lastSealedDecision: Nullable(LastSealedDecisionSchema),
        brokerExposureStateAttestationHash: Nullable(HashSchema),
        repeatedTestingLedgerHash: Nullable(HashSchema),
        privacyLedgerHash: Nullable(HashSchema),
        cacheStateAttestationHash: Nullable(HashSchema),
        publicationQueueHash: Nullable(HashSchema),
        lastControllerRecoveryAuthorizationHash: Nullable(HashSchema),
        lastControllerRecoveryLockHash: Nullable(HashSchema),
      },
      { additionalProperties: false },
    ),
  },
  {
    $schema: JSON_SCHEMA_DIALECT,
    $id: "https://dark-factory.local/schemas/campaign-state-1.2.0.json",
    additionalProperties: false,
  },
);

export type HarnessRegistration = Static<typeof HarnessRegistrationSchema>;
export type CampaignState = Static<typeof CampaignStateSchema>;
export type CampaignStopReason = Static<typeof CampaignStopReasonSchema>;
export type CampaignPauseReason = Static<typeof CampaignPauseReasonSchema>;
