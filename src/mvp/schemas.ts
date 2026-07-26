import { type TSchema, Type } from "@sinclair/typebox";
import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  CAUSE_CODES,
  DIAGNOSTIC_CATEGORIES,
  INTERVENTION_CODES,
  MVP_CACHE_POLICY,
  MVP_DECISION_POLICY,
  MVP_SCHEMA_VERSION,
  MVP_SELECTION_POLICY,
  type MvpExperimentArtifacts,
  TOOL_CLASSES,
} from "./contracts.js";
import {
  MVP_MODEL_DEPLOYMENT_ALIAS_MAX_LENGTH,
  MVP_MODEL_DEPLOYMENT_ALIAS_PATTERN,
} from "./model-deployment.js";

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RevisionSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const TimestampSchema = Type.String({ format: "date-time" });
const ExperimentIdSchema = Type.String({
  pattern: "^\\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 80,
});
const SlugSchema = Type.String({
  pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 64,
});
const SafeCodeSchema = Type.String({
  pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
  minLength: 1,
  maxLength: 128,
});
const ModelDeploymentAliasSchema = Type.String({
  pattern: MVP_MODEL_DEPLOYMENT_ALIAS_PATTERN,
  minLength: 1,
  maxLength: MVP_MODEL_DEPLOYMENT_ALIAS_MAX_LENGTH,
});
const UnitIntervalSchema = Type.Number({ minimum: 0, maximum: 1 });

function literals<const Values extends readonly [string, ...string[]]>(values: Values) {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

export const EvaluationEnvironmentSchema = Type.Object(
  {
    terminalBenchVersion: SafeCodeSchema,
    datasetRevision: SafeCodeSchema,
    graderProtocolVersion: SafeCodeSchema,
    evaluatorVersion: SafeCodeSchema,
    modelProvider: SafeCodeSchema,
    modelDeployment: ModelDeploymentAliasSchema,
    reasoningEffort: SafeCodeSchema,
    samplingSettingsDigest: DigestSchema,
    contextSettingsDigest: DigestSchema,
    sandboxProvider: SafeCodeSchema,
    sandboxRegion: SafeCodeSchema,
    imageDigest: DigestSchema,
    architecture: SafeCodeSchema,
    resourcesDigest: DigestSchema,
    networkPolicyDigest: DigestSchema,
    harnessConfigDigest: DigestSchema,
    extraConfigDigest: DigestSchema,
  },
  { additionalProperties: false },
);

export const SanitizedDiagnosticCardSchema = Type.Object(
  {
    category: literals(DIAGNOSTIC_CATEGORIES),
    toolClass: literals(TOOL_CLASSES),
    cause: literals(CAUSE_CODES),
    intervention: literals(INTERVENTION_CODES),
    affectedArm: Type.Union([
      Type.Literal("candidate"),
      Type.Literal("champion"),
      Type.Literal("comparison"),
    ]),
    direction: Type.Union([
      Type.Literal("candidate-better"),
      Type.Literal("candidate-worse"),
      Type.Literal("mixed"),
      Type.Literal("unknown"),
    ]),
    supportBand: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    confidenceBand: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  },
  { additionalProperties: false },
);

const SanitizedDiagnosticBriefProperties = {
  schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
  policyVersion: Type.Literal("closed-vocabulary-task-free-v1"),
  cards: Type.Array(SanitizedDiagnosticCardSchema, {
    maxItems: 12,
    uniqueItems: true,
  }),
  containsTaskIdentifiers: Type.Literal(false),
  containsTaskLiterals: Type.Literal(false),
  containsGraderSecrets: Type.Literal(false),
  containsPerTaskOutcomes: Type.Literal(false),
};

const InlineSanitizedDiagnosticBriefSchema = Type.Object(SanitizedDiagnosticBriefProperties, {
  additionalProperties: false,
});

export const SanitizedDiagnosticBriefSchema = Type.Object(SanitizedDiagnosticBriefProperties, {
  $id: "https://dark-factory.local/mvp/sanitized-diagnostics-1.0.0.json",
  additionalProperties: false,
});

export const OptimizerInputSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    experimentNumber: Type.Integer({ minimum: 1 }),
    championRevision: RevisionSchema,
    previousOutcome: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
      Type.Null(),
    ]),
    diagnosticBrief: Type.Union([InlineSanitizedDiagnosticBriefSchema, Type.Null()]),
    boundary: Type.Object(
      {
        taskCatalogVisible: Type.Literal(false),
        taskIdentifiersVisible: Type.Literal(false),
        taskPromptsVisible: Type.Literal(false),
        graderVisible: Type.Literal(false),
        rawTracesVisible: Type.Literal(false),
        taskSpecificFeedbackVisible: Type.Literal(false),
      },
      { additionalProperties: false },
    ),
  },
  {
    $id: "https://dark-factory.local/mvp/optimizer-input-1.0.0.json",
    additionalProperties: false,
  },
);

export const CandidateProposalSchema = Type.Object(
  {
    hypothesisId: SafeCodeSchema,
    hypothesisSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
    interventionSummary: Type.String({ minLength: 1, maxLength: 4_000 }),
    candidateRevision: RevisionSchema,
    changedFiles: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 512,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
      }),
      { minItems: 1, maxItems: 64, uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

const SelectedTaskSchema = Type.Object(
  {
    handle: DigestSchema,
    revisionDigest: DigestSchema,
    easyCanary: Type.Boolean(),
    weight: Type.Number(),
    sensitiveLiterals: Type.Array(Type.String({ minLength: 3, maxLength: 2_000 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const EvaluationCellSchema = Type.Object(
  {
    cellId: DigestSchema,
    task: SelectedTaskSchema,
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
  },
  { additionalProperties: false },
);

const RawDiagnosticSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("agent"),
      Type.Literal("tool"),
      Type.Literal("grader"),
      Type.Literal("infrastructure"),
    ]),
    code: SafeCodeSchema,
    toolName: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    message: Type.String({ maxLength: 16_384 }),
    evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const ObservationSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    experimentId: ExperimentIdSchema,
    cellId: DigestSchema,
    taskHandle: DigestSchema,
    taskRevisionDigest: DigestSchema,
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    arm: Type.Union([Type.Literal("candidate"), Type.Literal("champion")]),
    harnessRevision: RevisionSchema,
    environmentDigest: DigestSchema,
    source: Type.Union([Type.Literal("fresh"), Type.Literal("champion-cache")]),
    passed: Type.Boolean(),
    reward: UnitIntervalSchema,
    infrastructureValid: Type.Boolean(),
    durationMs: Type.Integer({ minimum: 0 }),
    evaluatedAt: TimestampSchema,
    traceArtifactRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    rawDiagnostics: Type.Array(RawDiagnosticSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);

export const ManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    experimentId: ExperimentIdSchema,
    experimentNumber: Type.Integer({ minimum: 1 }),
    slug: SlugSchema,
    status: Type.Literal("completed"),
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    championBefore: RevisionSchema,
    candidateRevision: RevisionSchema,
    championAfter: RevisionSchema,
  },
  {
    $id: "https://dark-factory.local/mvp/experiment-1.0.0.json",
    additionalProperties: false,
  },
);

export const HypothesisSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    experimentNumber: Type.Integer({ minimum: 1 }),
    hypothesisId: SafeCodeSchema,
    hypothesisSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
    interventionSummary: Type.String({ minLength: 1, maxLength: 4_000 }),
    candidateRevision: RevisionSchema,
    changedFiles: Type.Array(
      Type.String({
        minLength: 1,
        maxLength: 512,
        pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
      }),
      { minItems: 1, maxItems: 64, uniqueItems: true },
    ),
  },
  {
    $id: "https://dark-factory.local/mvp/hypothesis-1.0.0.json",
    additionalProperties: false,
  },
);

export const DecisionSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(MVP_DECISION_POLICY),
    disposition: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
    ]),
    reason: Type.Union([
      Type.Literal("candidate-superior"),
      Type.Literal("candidate-inferior"),
      Type.Literal("fresh-evidence-required"),
      Type.Literal("insufficient-confidence"),
      Type.Literal("aggregate-effect-too-small"),
      Type.Literal("incomplete-or-invalid-evidence"),
    ]),
    evidenceFresh: Type.Boolean(),
    matchedTaskCount: Type.Literal(5),
    repetitionsPerTask: Type.Literal(3),
    candidateObservationCount: Type.Literal(15),
    championObservationCount: Type.Literal(15),
    candidateMeanReward: UnitIntervalSchema,
    championMeanReward: UnitIntervalSchema,
    meanRewardDelta: Type.Number({ minimum: -1, maximum: 1 }),
    taskWins: Type.Integer({ minimum: 0, maximum: 5 }),
    taskLosses: Type.Integer({ minimum: 0, maximum: 5 }),
    taskTies: Type.Integer({ minimum: 0, maximum: 5 }),
    confidenceMethod: Type.Literal("exact-one-sided-cluster-sign-v1"),
    confidenceCandidateBetter: UnitIntervalSchema,
    confidenceChampionBetter: UnitIntervalSchema,
    requiredConfidence: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }),
    minimumAggregateDelta: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
    containsTaskIdentifiers: Type.Literal(false),
    containsPerTaskOutcomes: Type.Literal(false),
  },
  {
    $id: "https://dark-factory.local/mvp/decision-1.0.0.json",
    additionalProperties: false,
  },
);

export const StateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    experimentNumber: Type.Integer({ minimum: 1 }),
    championBefore: RevisionSchema,
    candidateRevision: RevisionSchema,
    championAfter: RevisionSchema,
    finalDisposition: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
    ]),
    nextExperimentNumber: Type.Integer({ minimum: 2 }),
    diagnosticFeedbackAvailable: Type.Boolean(),
    taskCatalogExposedToOptimizer: Type.Literal(false),
    graderExposedToOptimizer: Type.Literal(false),
  },
  {
    $id: "https://dark-factory.local/mvp/state-1.0.0.json",
    additionalProperties: false,
  },
);

export const PrivateSelectionSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(MVP_SELECTION_POLICY),
    tasks: Type.Array(SelectedTaskSchema, {
      minItems: 5,
      maxItems: 5,
      uniqueItems: true,
    }),
    cells: Type.Array(EvaluationCellSchema, {
      minItems: 15,
      maxItems: 15,
      uniqueItems: true,
    }),
  },
  {
    $id: "https://dark-factory.local/mvp/private-selection-1.0.0.json",
    additionalProperties: false,
  },
);

export const PrivateEvaluationsSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    screening: Type.Array(ObservationSchema, { minItems: 30, maxItems: 30 }),
    final: Type.Array(ObservationSchema, { minItems: 30, maxItems: 30 }),
  },
  {
    $id: "https://dark-factory.local/mvp/private-evaluations-1.0.0.json",
    additionalProperties: false,
  },
);

export const PrivateCacheSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(MVP_CACHE_POLICY),
    hitCellIds: Type.Array(DigestSchema, { maxItems: 15, uniqueItems: true }),
    missCellIds: Type.Array(DigestSchema, { maxItems: 15, uniqueItems: true }),
    refreshedCellIds: Type.Array(DigestSchema, { maxItems: 15, uniqueItems: true }),
    seededFromPromotedCandidateCellIds: Type.Array(DigestSchema, {
      maxItems: 15,
      uniqueItems: true,
    }),
  },
  {
    $id: "https://dark-factory.local/mvp/private-cache-1.0.0.json",
    additionalProperties: false,
  },
);

export const mvpArtifactSchemas = {
  manifest: ManifestSchema,
  optimizerInput: OptimizerInputSchema,
  hypothesis: HypothesisSchema,
  diagnostics: SanitizedDiagnosticBriefSchema,
  decision: DecisionSchema,
  state: StateSchema,
  privateSelection: PrivateSelectionSchema,
  privateEvaluations: PrivateEvaluationsSchema,
  privateCache: PrivateCacheSchema,
} as const satisfies Record<string, TSchema>;

export type MvpArtifactName = keyof typeof mvpArtifactSchemas;

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormatsModule.default(ajv);
const validators = new Map<MvpArtifactName, ValidateFunction>();
for (const [name, schema] of Object.entries(mvpArtifactSchemas) as [MvpArtifactName, TSchema][]) {
  validators.set(name, ajv.compile(schema));
}
const candidateProposalValidator = ajv.compile(CandidateProposalSchema);
const environmentValidator = ajv.compile(EvaluationEnvironmentSchema);
const privateObservationValidator = ajv.compile(ObservationSchema);

export class MvpSchemaValidationError extends Error {
  public readonly artifactName: MvpArtifactName;
  public readonly validationErrors: readonly ErrorObject[];

  public constructor(artifactName: MvpArtifactName, validationErrors: readonly ErrorObject[]) {
    super(
      `MVP ${artifactName} validation failed: ${validationErrors
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
    this.name = "MvpSchemaValidationError";
    this.artifactName = artifactName;
    this.validationErrors = validationErrors;
  }
}

export function validateMvpArtifact(name: MvpArtifactName, value: unknown): void {
  const validator = validators.get(name);
  if (validator === undefined) {
    throw new Error(`No MVP validator exists for ${name}`);
  }
  if (!validator(value)) {
    throw new MvpSchemaValidationError(name, validator.errors ?? []);
  }
}

export function validateCandidateProposal(value: unknown): void {
  validateStandalone("candidate proposal", candidateProposalValidator, value);
}

export function validateEvaluationEnvironment(value: unknown): void {
  validateStandalone("evaluation environment", environmentValidator, value);
}

export function validatePrivateObservation(value: unknown): void {
  validateStandalone("private observation", privateObservationValidator, value);
}

export function validateMvpExperimentArtifacts(artifacts: MvpExperimentArtifacts): void {
  for (const name of Object.keys(mvpArtifactSchemas) as MvpArtifactName[]) {
    validateMvpArtifact(name, artifacts[name]);
  }
  if (
    artifacts.manifest.experimentNumber !== artifacts.state.experimentNumber ||
    artifacts.manifest.experimentNumber !== artifacts.hypothesis.experimentNumber ||
    artifacts.manifest.candidateRevision !== artifacts.state.candidateRevision ||
    artifacts.manifest.championAfter !== artifacts.state.championAfter ||
    artifacts.decision.disposition !== artifacts.state.finalDisposition
  ) {
    throw new Error("MVP experiment artifacts do not describe one coherent transition");
  }
  const cacheCellCount =
    artifacts.privateCache.hitCellIds.length + artifacts.privateCache.missCellIds.length;
  if (cacheCellCount !== 15) {
    throw new Error("MVP cache accounting must classify all fifteen matched cells");
  }
  if (
    artifacts.privateCache.seededFromPromotedCandidateCellIds.length !==
    (artifacts.decision.disposition === "promote" ? 15 : 0)
  ) {
    throw new Error("MVP cache must seed exactly the promoted candidate's fifteen fresh cells");
  }
  if (
    artifacts.decision.taskWins + artifacts.decision.taskLosses + artifacts.decision.taskTies !==
    5
  ) {
    throw new Error("MVP decision task counts must sum to five");
  }
}

function validateStandalone(name: string, validator: ValidateFunction, value: unknown): void {
  if (!validator(value)) {
    throw new Error(
      `Invalid MVP ${name}: ${(validator.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
  }
}
