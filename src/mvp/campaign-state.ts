import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  MVP_SCHEMA_VERSION,
  type DecisionDisposition,
  type HiddenTaskHandle,
  type MvpIterationResult,
  type SanitizedDiagnosticBrief,
  canonicalJson,
  hiddenTaskHandle,
} from "./contracts.js";
import {
  assertMountedRoot,
  readOptionalBoundedJson,
  withMountedLock,
  writeJsonAtomic,
} from "./mounted-files.js";
import { assertTaskFreeDiagnosticBrief } from "./privacy.js";
import { SanitizedDiagnosticBriefSchema } from "./schemas.js";

export const CAMPAIGN_STATE_POLICY = "frozen-baseline-campaign-state-v1" as const;
const RevisionSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const ExperimentIdSchema = Type.String({
  pattern: "^\\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$",
  maxLength: 80,
});
const CampaignStateSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(CAMPAIGN_STATE_POLICY),
    campaignId: Type.String({
      pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
      minLength: 3,
      maxLength: 128,
    }),
    revision: Type.Integer({ minimum: 0 }),
    frozenBaselineRevision: RevisionSchema,
    championRevision: RevisionSchema,
    nextExperimentNumber: Type.Integer({ minimum: 1 }),
    previousOutcome: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
      Type.Null(),
    ]),
    previousDiagnosticBrief: Type.Union([SanitizedDiagnosticBriefSchema, Type.Null()]),
    retainedTaskHandles: Type.Union([
      Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
        minItems: 5,
        maxItems: 5,
        uniqueItems: true,
      }),
      Type.Null(),
    ]),
    lastExperimentId: Type.Union([ExperimentIdSchema, Type.Null()]),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
const validateCampaignState = ajv.compile(CampaignStateSchema);

export interface MvpCampaignState {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof CAMPAIGN_STATE_POLICY;
  readonly campaignId: string;
  readonly revision: number;
  readonly frozenBaselineRevision: string;
  readonly championRevision: string;
  readonly nextExperimentNumber: number;
  readonly previousOutcome: DecisionDisposition | null;
  readonly previousDiagnosticBrief: SanitizedDiagnosticBrief | null;
  readonly retainedTaskHandles: readonly HiddenTaskHandle[] | null;
  readonly lastExperimentId: string | null;
  readonly updatedAt: string;
}

export interface CampaignStateAdvance {
  readonly expectedRevision: number;
  readonly iteration: MvpIterationResult;
  readonly retainedTaskHandles: readonly HiddenTaskHandle[] | null;
  readonly updatedAt: string;
}

export interface MvpCampaignStateStore {
  readonly initialize: (input: {
    readonly campaignId: string;
    readonly frozenBaselineRevision: string;
    readonly initializedAt: string;
  }) => Promise<MvpCampaignState>;
  readonly load: () => Promise<MvpCampaignState>;
  readonly advance: (input: CampaignStateAdvance) => Promise<MvpCampaignState>;
}

export class MountedMvpCampaignStateStore implements MvpCampaignStateStore {
  private readonly path: string;

  public constructor(private readonly root: string) {
    assertMountedRoot(root);
    this.path = join(root, "campaign-state.json");
  }

  public async initialize(input: {
    readonly campaignId: string;
    readonly frozenBaselineRevision: string;
    readonly initializedAt: string;
  }): Promise<MvpCampaignState> {
    const initial: MvpCampaignState = {
      schemaVersion: MVP_SCHEMA_VERSION,
      policyVersion: CAMPAIGN_STATE_POLICY,
      campaignId: input.campaignId,
      revision: 0,
      frozenBaselineRevision: input.frozenBaselineRevision,
      championRevision: input.frozenBaselineRevision,
      nextExperimentNumber: 1,
      previousOutcome: null,
      previousDiagnosticBrief: null,
      retainedTaskHandles: null,
      lastExperimentId: null,
      updatedAt: input.initializedAt,
    };
    assertCampaignState(initial);
    return withMountedLock(this.root, "campaign-state", async () => {
      const existing = await readOptionalBoundedJson(this.path);
      if (existing === null) {
        await writeJsonAtomic(this.path, initial);
        return initial;
      }
      const state = campaignState(existing);
      if (
        state.campaignId !== input.campaignId ||
        state.frozenBaselineRevision !== input.frozenBaselineRevision
      ) {
        throw new Error("Mounted campaign does not match the requested frozen Pi baseline");
      }
      return state;
    });
  }

  public async load(): Promise<MvpCampaignState> {
    const value = await readOptionalBoundedJson(this.path);
    if (value === null) {
      throw new Error("MVP campaign state has not been initialized");
    }
    return campaignState(value);
  }

  public async advance(input: CampaignStateAdvance): Promise<MvpCampaignState> {
    return withMountedLock(this.root, "campaign-state", async () => {
      const current = await this.load();
      if (current.lastExperimentId === input.iteration.experimentId) {
        const expectedRetained =
          input.iteration.decision.disposition === "promote"
            ? null
            : input.retainedTaskHandles;
        if (
          current.championRevision === input.iteration.championRevision &&
          current.previousOutcome === input.iteration.decision.disposition &&
          canonicalJson(current.retainedTaskHandles) ===
            canonicalJson(expectedRetained) &&
          canonicalJson(current.previousDiagnosticBrief) ===
            canonicalJson(input.iteration.diagnosticBrief)
        ) {
          return current;
        }
        throw new Error("Campaign experiment replay disagrees with committed state");
      }
      if (current.revision !== input.expectedRevision) {
        throw new Error("Campaign state revision changed during the iteration");
      }
      const experimentNumber = experimentNumberFromId(input.iteration.experimentId);
      if (experimentNumber !== current.nextExperimentNumber) {
        throw new Error("Campaign iteration is not the next expected experiment");
      }
      const promoted = input.iteration.decision.disposition === "promote";
      if (
        (promoted &&
          input.iteration.championRevision !== input.iteration.candidateRevision) ||
        (!promoted &&
          input.iteration.championRevision !== current.championRevision)
      ) {
        throw new Error("Campaign champion transition is inconsistent with the decision");
      }
      if (
        promoted
          ? input.retainedTaskHandles !== null
          : input.retainedTaskHandles === null ||
            input.retainedTaskHandles.length !== 5 ||
            new Set(input.retainedTaskHandles).size !== 5
      ) {
        throw new Error(
          promoted
            ? "Promoted campaign state must clear its retained panel"
            : "Rejected or inconclusive campaign state must retain exactly five tasks",
        );
      }
      assertTaskFreeDiagnosticBrief(input.iteration.diagnosticBrief, []);
      const next: MvpCampaignState = {
        ...current,
        revision: current.revision + 1,
        championRevision: input.iteration.championRevision,
        nextExperimentNumber: current.nextExperimentNumber + 1,
        previousOutcome: input.iteration.decision.disposition,
        previousDiagnosticBrief: input.iteration.diagnosticBrief,
        retainedTaskHandles: promoted ? null : input.retainedTaskHandles,
        lastExperimentId: input.iteration.experimentId,
        updatedAt: input.updatedAt,
      };
      assertCampaignState(next);
      await writeJsonAtomic(this.path, next);
      return next;
    });
  }
}

function campaignState(value: unknown): MvpCampaignState {
  if (!validateCampaignState(value)) {
    throw new Error(
      `Invalid MVP campaign state: ${(validateCampaignState.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
  }
  const raw = value as Omit<MvpCampaignState, "retainedTaskHandles"> & {
    readonly retainedTaskHandles: readonly string[] | null;
  };
  const state: MvpCampaignState = {
    ...raw,
    retainedTaskHandles:
      raw.retainedTaskHandles === null
        ? null
        : raw.retainedTaskHandles.map((handle) => hiddenTaskHandle(handle)),
  };
  assertCampaignState(state);
  return state;
}

function assertCampaignState(state: MvpCampaignState): void {
  if (!validateCampaignState(state)) {
    throw new Error("MVP campaign state violates its strict schema");
  }
  if (state.previousDiagnosticBrief !== null) {
    assertTaskFreeDiagnosticBrief(state.previousDiagnosticBrief, []);
  }
  if (state.previousOutcome === null) {
    if (
      state.revision !== 0 ||
      state.nextExperimentNumber !== 1 ||
      state.lastExperimentId !== null ||
      state.retainedTaskHandles !== null ||
      state.championRevision !== state.frozenBaselineRevision
    ) {
      throw new Error("Unstarted campaign must point exactly to its frozen Pi baseline");
    }
    return;
  }
  if (state.lastExperimentId === null) {
    throw new Error("Started campaign state is missing its last experiment");
  }
  if (
    state.previousOutcome === "promote"
      ? state.retainedTaskHandles !== null
      : state.retainedTaskHandles === null ||
        state.retainedTaskHandles.length !== 5 ||
        new Set(state.retainedTaskHandles).size !== 5
  ) {
    throw new Error("Campaign retained-panel state disagrees with its previous outcome");
  }
  if (experimentNumberFromId(state.lastExperimentId) !== state.nextExperimentNumber - 1) {
    throw new Error("Campaign experiment numbering is not contiguous");
  }
}

function experimentNumberFromId(experimentId: string): number {
  const match = /^(\d{3,})-[a-z0-9]+(?:-[a-z0-9]+)*$/u.exec(experimentId);
  const number = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error("Campaign experiment ID is invalid");
  }
  return number;
}
