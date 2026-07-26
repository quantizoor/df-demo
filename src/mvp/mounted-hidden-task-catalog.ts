import { createHmac } from "node:crypto";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalJson,
  type HiddenEvaluationCell,
  type HiddenTaskCatalogPort,
  type HiddenTaskHandle,
  type HiddenTaskOutcomeUpdate,
  type HiddenTaskProfile,
  hiddenTaskHandle,
  MVP_SCHEMA_VERSION,
  sha256,
} from "./contracts.js";
import {
  assertMountedRoot,
  readOptionalBoundedJson,
  withMountedLock,
  writeJsonAtomic,
} from "./mounted-files.js";

const CATALOG_POLICY = "trusted-harbor-hidden-catalog-v1" as const;
const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const DatasetRevisionSchema = Type.String({
  pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
  minLength: 3,
  maxLength: 128,
});
const UnitIntervalSchema = Type.Number({ minimum: 0, maximum: 1 });
const MeasurementProvenanceSchema = Type.Object(
  {
    kind: Type.Literal("trusted-measurement"),
    sourceDigest: DigestSchema,
    datasetRevision: DatasetRevisionSchema,
  },
  { additionalProperties: false },
);
const GraderIsolationAttestationSchema = Type.Object(
  {
    verifierEnvironmentMode: Type.Literal("separate"),
    allStepVerifierEnvironmentModesSeparate: Type.Literal(true),
    sourceDigest: DigestSchema,
  },
  { additionalProperties: false },
);
const LeaderboardProvenanceSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("comparable-measurement"),
      sourceDigest: DigestSchema,
      datasetRevision: DatasetRevisionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("unknown"),
      reason: Type.Union([
        Type.Literal("not-published"),
        Type.Literal("not-comparable"),
        Type.Literal("task-unmatched"),
      ]),
    },
    { additionalProperties: false },
  ),
]);
const TaskRecordSchema = Type.Object(
  {
    handle: DigestSchema,
    harborTaskLocator: Type.String({
      minLength: 1,
      maxLength: 1_024,
      pattern: "^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\u0000]+$",
    }),
    revisionDigest: DigestSchema,
    difficulty: Type.Union([Type.Literal("hard"), Type.Literal("medium"), Type.Literal("easy")]),
    easyCanary: Type.Boolean(),
    baselineFailureRate: UnitIntervalSchema,
    baselineProvenance: MeasurementProvenanceSchema,
    graderIsolation: GraderIsolationAttestationSchema,
    leaderboardFailureRate: Type.Union([UnitIntervalSchema, Type.Null()]),
    leaderboardProvenance: LeaderboardProvenanceSchema,
    selectionLeaderboardFailureRate: UnitIntervalSchema,
    previousFailureRate: UnitIntervalSchema,
    uncertainty: UnitIntervalSchema,
    underexposure: UnitIntervalSchema,
    normalizedCost: UnitIntervalSchema,
    consecutiveSelections: Type.Integer({ minimum: 0 }),
    observationCount: Type.Integer({ minimum: 0 }),
    lastSelectedExperiment: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    sensitiveLiterals: Type.Array(Type.String({ minLength: 3, maxLength: 2_000 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
const CatalogDocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(CATALOG_POLICY),
    revision: Type.Integer({ minimum: 0 }),
    namespaceDigest: DigestSchema,
    genesisDigest: DigestSchema,
    datasetRevision: DatasetRevisionSchema,
    lastAppliedExperimentNumber: Type.Integer({ minimum: 0 }),
    appliedExperiments: Type.Array(
      Type.Object(
        {
          experimentId: Type.String({
            pattern: "^\\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$",
            maxLength: 80,
          }),
          experimentNumber: Type.Integer({ minimum: 1 }),
          updateDigest: DigestSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 4_096 },
    ),
    tasks: Type.Array(TaskRecordSchema, {
      minItems: 5,
      maxItems: 1_000,
    }),
  },
  { additionalProperties: false },
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCatalog = ajv.compile(CatalogDocumentSchema);

export interface TrustedHarborTaskDefinition {
  readonly harborTaskLocator: string;
  readonly revisionDigest: string;
  readonly difficulty: "hard" | "medium" | "easy";
  readonly easyCanary: boolean;
  readonly baselineFailureRate: number;
  readonly baselineProvenance: {
    readonly kind: "trusted-measurement";
    readonly sourceDigest: string;
    readonly datasetRevision: string;
  };
  readonly graderIsolation: {
    readonly verifierEnvironmentMode: "separate";
    readonly allStepVerifierEnvironmentModesSeparate: true;
    readonly sourceDigest: string;
  };
  readonly leaderboard:
    | {
        readonly kind: "comparable-measurement";
        readonly failureRate: number;
        readonly sourceDigest: string;
        readonly datasetRevision: string;
      }
    | {
        readonly kind: "unknown";
        readonly reason: "not-published" | "not-comparable" | "task-unmatched";
      };
  readonly initialFailureRate: number;
  readonly uncertainty: number;
  readonly normalizedCost: number;
  readonly sensitiveLiterals: readonly string[];
}

interface HiddenTaskRecord {
  readonly handle: HiddenTaskHandle;
  readonly harborTaskLocator: string;
  readonly revisionDigest: string;
  readonly difficulty: "hard" | "medium" | "easy";
  readonly easyCanary: boolean;
  readonly baselineFailureRate: number;
  readonly baselineProvenance: TrustedHarborTaskDefinition["baselineProvenance"];
  readonly graderIsolation: TrustedHarborTaskDefinition["graderIsolation"];
  readonly leaderboardFailureRate: number | null;
  readonly leaderboardProvenance:
    | {
        readonly kind: "comparable-measurement";
        readonly sourceDigest: string;
        readonly datasetRevision: string;
      }
    | {
        readonly kind: "unknown";
        readonly reason: "not-published" | "not-comparable" | "task-unmatched";
      };
  readonly selectionLeaderboardFailureRate: number;
  readonly previousFailureRate: number;
  readonly uncertainty: number;
  readonly underexposure: number;
  readonly normalizedCost: number;
  readonly consecutiveSelections: number;
  readonly sensitiveLiterals: readonly string[];
  readonly observationCount: number;
  readonly lastSelectedExperiment: number | null;
}

interface CatalogDocument {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof CATALOG_POLICY;
  readonly revision: number;
  readonly namespaceDigest: string;
  readonly genesisDigest: string;
  readonly datasetRevision: string;
  readonly lastAppliedExperimentNumber: number;
  readonly appliedExperiments: readonly {
    readonly experimentId: string;
    readonly experimentNumber: number;
    readonly updateDigest: string;
  }[];
  readonly tasks: readonly HiddenTaskRecord[];
}

export interface ResolvedHarborEvaluationCell {
  readonly cellId: string;
  readonly taskHandle: HiddenTaskHandle;
  readonly taskRevisionDigest: string;
  readonly repetition: 1 | 2 | 3;
  readonly harborTaskLocator: string;
}

export class MountedHiddenTaskCatalog implements HiddenTaskCatalogPort {
  private readonly path: string;
  private readonly namespaceDigest: string;

  public constructor(
    private readonly root: string,
    private readonly namespaceSecret: string,
  ) {
    assertMountedRoot(root);
    if (namespaceSecret.length < 32) {
      throw new Error("Hidden catalog namespace secret must contain at least 32 characters");
    }
    this.path = join(root, "hidden-task-catalog.json");
    this.namespaceDigest = sha256(namespaceSecret);
  }

  public async initialize(input: {
    readonly datasetRevision: string;
    readonly definitions: readonly TrustedHarborTaskDefinition[];
  }): Promise<void> {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(input.datasetRevision)) {
      throw new Error("Hidden catalog requires a bounded dataset revision");
    }
    const tasks = input.definitions.map((definition) =>
      this.taskRecord(definition, input.datasetRevision),
    );
    assertGenesisTasks(tasks);
    const genesisDigest = sha256(canonicalJson({ datasetRevision: input.datasetRevision, tasks }));
    await withMountedLock(this.root, "hidden-task-catalog", async () => {
      const existing = await readOptionalBoundedJson(this.path);
      if (existing !== null) {
        const document = catalogDocument(existing);
        this.assertNamespace(document);
        if (document.genesisDigest !== genesisDigest) {
          throw new Error("Hidden task catalog genesis differs from mounted state");
        }
        return;
      }
      const document: CatalogDocument = {
        schemaVersion: MVP_SCHEMA_VERSION,
        policyVersion: CATALOG_POLICY,
        revision: 0,
        namespaceDigest: this.namespaceDigest,
        genesisDigest,
        datasetRevision: input.datasetRevision,
        lastAppliedExperimentNumber: 0,
        appliedExperiments: [],
        tasks,
      };
      catalogDocument(document);
      await writeJsonAtomic(this.path, document);
    });
  }

  public async list(): Promise<readonly HiddenTaskProfile[]> {
    const document = await this.read();
    return document.tasks.map((task) => ({
      handle: hiddenTaskHandle(task.handle),
      revisionDigest: task.revisionDigest,
      difficulty: task.difficulty,
      easyCanary: task.easyCanary,
      baselineFailureRate: task.baselineFailureRate,
      leaderboardFailureRate: task.selectionLeaderboardFailureRate,
      previousFailureRate: task.previousFailureRate,
      uncertainty: task.uncertainty,
      underexposure: task.underexposure,
      normalizedCost: task.normalizedCost,
      consecutiveSelections: task.consecutiveSelections,
      sensitiveLiterals: [...task.sensitiveLiterals],
    }));
  }

  public async recordOutcomes(
    experimentId: string,
    updates: readonly HiddenTaskOutcomeUpdate[],
  ): Promise<void> {
    const experimentNumber = experimentNumberFromId(experimentId);
    const normalizedUpdates = [...updates].sort((left, right) =>
      left.taskHandle.localeCompare(right.taskHandle),
    );
    validateOutcomeUpdates(experimentId, normalizedUpdates);
    const updateDigest = sha256(canonicalJson(normalizedUpdates));

    await withMountedLock(this.root, "hidden-task-catalog", async () => {
      const current = await this.read();
      const prior = current.appliedExperiments.find((entry) => entry.experimentId === experimentId);
      if (prior !== undefined) {
        if (prior.updateDigest !== updateDigest) {
          throw new Error("Hidden catalog experiment replay contains different outcomes");
        }
        return;
      }
      if (experimentNumber <= current.lastAppliedExperimentNumber) {
        throw new Error("Hidden catalog refuses an unrecognized stale experiment update");
      }
      const updatesByHandle = new Map(
        normalizedUpdates.map((update) => [update.taskHandle, update]),
      );
      for (const handle of updatesByHandle.keys()) {
        if (!current.tasks.some((task) => task.handle === handle)) {
          throw new Error("Hidden catalog outcome references an unknown task handle");
        }
      }

      const tasks = current.tasks.map((task): HiddenTaskRecord => {
        const update = updatesByHandle.get(task.handle);
        if (update === undefined) {
          return {
            ...task,
            underexposure: rounded(Math.min(1, task.underexposure + 0.08)),
            consecutiveSelections: 0,
          };
        }
        const observedFailure = 1 - (update.candidateMeanReward + update.championMeanReward) / 2;
        const observedUncertainty =
          1 - Math.abs(update.candidateMeanReward - update.championMeanReward);
        return {
          ...task,
          previousFailureRate: rounded(0.65 * task.previousFailureRate + 0.35 * observedFailure),
          uncertainty: rounded(0.7 * task.uncertainty + 0.3 * observedUncertainty),
          underexposure: rounded(Math.max(0, task.underexposure - 0.25)),
          consecutiveSelections:
            task.lastSelectedExperiment === experimentNumber - 1
              ? task.consecutiveSelections + 1
              : 1,
          observationCount: task.observationCount + 6,
          lastSelectedExperiment: experimentNumber,
        };
      });
      const next: CatalogDocument = {
        ...current,
        revision: current.revision + 1,
        lastAppliedExperimentNumber: experimentNumber,
        appliedExperiments: [
          ...current.appliedExperiments.slice(-4_095),
          { experimentId, experimentNumber, updateDigest },
        ],
        tasks,
      };
      catalogDocument(next);
      await writeJsonAtomic(this.path, next);
    });
  }

  public async resolveSelectedCells(
    cells: readonly HiddenEvaluationCell[],
  ): Promise<readonly ResolvedHarborEvaluationCell[]> {
    if (
      cells.length < 1 ||
      cells.length > 30 ||
      new Set(cells.map((cell) => cell.cellId)).size !== cells.length
    ) {
      throw new Error("Hidden Harbor resolver requires one to thirty unique cells");
    }
    const document = await this.read();
    const tasks = new Map(document.tasks.map((task) => [task.handle, task]));
    return cells.map((cell) => {
      const task = tasks.get(cell.task.handle);
      if (task === undefined || task.revisionDigest !== cell.task.revisionDigest) {
        throw new Error("Opaque evaluation cell does not resolve to the trusted catalog");
      }
      return {
        cellId: cell.cellId,
        taskHandle: hiddenTaskHandle(task.handle),
        taskRevisionDigest: task.revisionDigest,
        repetition: cell.repetition,
        harborTaskLocator: task.harborTaskLocator,
      };
    });
  }

  private async read(): Promise<CatalogDocument> {
    const value = await readOptionalBoundedJson(this.path);
    if (value === null) {
      throw new Error("Hidden task catalog has not been initialized");
    }
    const document = catalogDocument(value);
    this.assertNamespace(document);
    return document;
  }

  private assertNamespace(document: CatalogDocument): void {
    if (document.namespaceDigest !== this.namespaceDigest) {
      throw new Error("Hidden task catalog namespace secret does not match mounted state");
    }
  }

  private taskRecord(
    definition: TrustedHarborTaskDefinition,
    datasetRevision: string,
  ): HiddenTaskRecord {
    validateDefinition(definition, datasetRevision);
    const handle = hiddenTaskHandle(
      createHmac("sha256", this.namespaceSecret)
        .update(`${definition.harborTaskLocator}\0${definition.revisionDigest}`)
        .digest("hex"),
    );
    return {
      handle,
      harborTaskLocator: definition.harborTaskLocator,
      revisionDigest: definition.revisionDigest,
      difficulty: definition.difficulty,
      easyCanary: definition.easyCanary,
      baselineFailureRate: definition.baselineFailureRate,
      baselineProvenance: definition.baselineProvenance,
      graderIsolation: definition.graderIsolation,
      leaderboardFailureRate:
        definition.leaderboard.kind === "comparable-measurement"
          ? definition.leaderboard.failureRate
          : null,
      leaderboardProvenance:
        definition.leaderboard.kind === "comparable-measurement"
          ? {
              kind: definition.leaderboard.kind,
              sourceDigest: definition.leaderboard.sourceDigest,
              datasetRevision: definition.leaderboard.datasetRevision,
            }
          : {
              kind: definition.leaderboard.kind,
              reason: definition.leaderboard.reason,
            },
      selectionLeaderboardFailureRate:
        definition.leaderboard.kind === "comparable-measurement"
          ? definition.leaderboard.failureRate
          : 0.5,
      previousFailureRate: definition.initialFailureRate,
      uncertainty:
        definition.leaderboard.kind === "unknown"
          ? Math.max(0.9, definition.uncertainty)
          : definition.uncertainty,
      underexposure: 1,
      normalizedCost: definition.normalizedCost,
      consecutiveSelections: 0,
      observationCount: 0,
      lastSelectedExperiment: null,
      sensitiveLiterals: [
        definition.harborTaskLocator,
        ...definition.sensitiveLiterals.filter(
          (literal) => literal !== definition.harborTaskLocator,
        ),
      ],
    };
  }
}

function catalogDocument(value: unknown): CatalogDocument {
  if (!validateCatalog(value)) {
    throw new Error(
      `Invalid hidden task catalog: ${(validateCatalog.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
  }
  const document = value as CatalogDocument;
  if (new Set(document.tasks.map((task) => task.handle)).size !== document.tasks.length) {
    throw new Error("Hidden task catalog contains duplicate handles");
  }
  if (
    new Set(document.tasks.map((task) => task.harborTaskLocator)).size !== document.tasks.length
  ) {
    throw new Error("Hidden task catalog contains duplicate Harbor locators");
  }
  return document;
}

function assertGenesisTasks(tasks: readonly HiddenTaskRecord[]): void {
  if (tasks.length < 5 || tasks.filter((task) => task.easyCanary).length < 1) {
    throw new Error("Hidden catalog requires at least five tasks and an easy canary");
  }
  if (new Set(tasks.map((task) => task.handle)).size !== tasks.length) {
    throw new Error("Hidden catalog genesis contains duplicate tasks");
  }
}

function validateDefinition(
  definition: TrustedHarborTaskDefinition,
  datasetRevision: string,
): void {
  if (
    definition.harborTaskLocator.startsWith("/") ||
    definition.harborTaskLocator.includes("\0") ||
    definition.harborTaskLocator.split("/").includes("..") ||
    definition.harborTaskLocator.length < 3 ||
    definition.harborTaskLocator.length > 1_024
  ) {
    throw new Error("Harbor task locator must be a bounded trusted relative locator");
  }
  if (!/^[a-f0-9]{64}$/u.test(definition.revisionDigest)) {
    throw new Error("Harbor task revision must be a SHA-256 digest");
  }
  for (const value of [
    definition.baselineFailureRate,
    definition.initialFailureRate,
    definition.uncertainty,
    definition.normalizedCost,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("Hidden catalog numeric signals must be in [0, 1]");
    }
  }
  if (
    !/^[a-f0-9]{64}$/u.test(definition.baselineProvenance.sourceDigest) ||
    definition.baselineProvenance.datasetRevision !== datasetRevision
  ) {
    throw new Error("Baseline failure rate requires comparable trusted provenance");
  }
  if (
    definition.graderIsolation.verifierEnvironmentMode !== "separate" ||
    definition.graderIsolation.allStepVerifierEnvironmentModesSeparate !== true ||
    !/^[a-f0-9]{64}$/u.test(definition.graderIsolation.sourceDigest)
  ) {
    throw new Error("Hidden task requires a separate-verifier isolation attestation");
  }
  if (definition.leaderboard.kind === "comparable-measurement") {
    if (
      !Number.isFinite(definition.leaderboard.failureRate) ||
      definition.leaderboard.failureRate < 0 ||
      definition.leaderboard.failureRate > 1 ||
      !/^[a-f0-9]{64}$/u.test(definition.leaderboard.sourceDigest) ||
      definition.leaderboard.datasetRevision !== datasetRevision
    ) {
      throw new Error("Leaderboard failure rate is not dataset-comparable");
    }
  }
}

function validateOutcomeUpdates(
  experimentId: string,
  updates: readonly HiddenTaskOutcomeUpdate[],
): void {
  if (updates.length !== 5 || new Set(updates.map((update) => update.taskHandle)).size !== 5) {
    throw new Error("Hidden catalog requires outcomes for exactly five distinct tasks");
  }
  for (const update of updates) {
    if (
      update.experimentId !== experimentId ||
      !Number.isInteger(update.candidatePasses) ||
      update.candidatePasses < 0 ||
      update.candidatePasses > 3 ||
      !Number.isInteger(update.championPasses) ||
      update.championPasses < 0 ||
      update.championPasses > 3 ||
      !Number.isFinite(update.candidateMeanReward) ||
      update.candidateMeanReward < 0 ||
      update.candidateMeanReward > 1 ||
      !Number.isFinite(update.championMeanReward) ||
      update.championMeanReward < 0 ||
      update.championMeanReward > 1
    ) {
      throw new Error("Hidden catalog outcome update is invalid");
    }
  }
}

function experimentNumberFromId(experimentId: string): number {
  const match = /^(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/u.exec(experimentId);
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Hidden catalog experiment ID is invalid");
  }
  return number;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
