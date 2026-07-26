import { Type } from "@sinclair/typebox";
import Ajv2020 from "ajv/dist/2020.js";
import {
  MVP_SCHEMA_VERSION,
  type CandidateProposal,
  type EvaluationEnvironment,
  type HiddenTaskHandle,
  type MvpLoopPorts,
  type OptimizerInput,
  type OptimizerPort,
  canonicalJson,
} from "./contracts.js";
import {
  type MvpCampaignState,
  type MvpCampaignStateStore,
} from "./campaign-state.js";
import { buildTaskFreeMvpOptimizerInput, runMvpIteration } from "./loop.js";
import { validateCandidateProposal } from "./schemas.js";

const CAMPAIGN_RECEIPT_POLICY = "task-free-campaign-receipt-v1" as const;
const CampaignReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(CAMPAIGN_RECEIPT_POLICY),
    campaignId: Type.String({
      pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
      minLength: 3,
      maxLength: 128,
    }),
    experimentNumber: Type.Integer({ minimum: 1 }),
    experimentId: Type.String({
      pattern: "^\\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*$",
      maxLength: 80,
    }),
    disposition: Type.Union([
      Type.Literal("promote"),
      Type.Literal("reject"),
      Type.Literal("inconclusive"),
    ]),
    championChanged: Type.Boolean(),
    evidenceFresh: Type.Boolean(),
    meanRewardDelta: Type.Number({ minimum: -1, maximum: 1 }),
    confidenceCandidateBetter: Type.Number({ minimum: 0, maximum: 1 }),
    nextExperimentNumber: Type.Integer({ minimum: 2 }),
    panelAction: Type.Union([
      Type.Literal("cleared-after-promotion"),
      Type.Literal("retained-after-nonpromotion"),
    ]),
    cache: Type.Object(
      {
        hits: Type.Integer({ minimum: 0, maximum: 15 }),
        misses: Type.Integer({ minimum: 0, maximum: 15 }),
        refreshedForPromotion: Type.Integer({ minimum: 0, maximum: 15 }),
        seededFromPromotion: Type.Integer({ minimum: 0, maximum: 15 }),
      },
      { additionalProperties: false },
    ),
    diagnosticCardCount: Type.Integer({ minimum: 0, maximum: 12 }),
    containsTaskIdentifiers: Type.Literal(false),
    containsTaskNames: Type.Literal(false),
    containsPerTaskOutcomes: Type.Literal(false),
    containsGraderMaterial: Type.Literal(false),
  },
  { additionalProperties: false },
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateCampaignReceipt = ajv.compile(CampaignReceiptSchema);

export interface PreparedMvpOptimization {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly campaignId: string;
  readonly stateRevision: number;
  readonly optimizerInput: OptimizerInput;
  readonly containsTaskIdentifiers: false;
  readonly containsTaskNames: false;
  readonly containsGraderMaterial: false;
}

export interface ReleaseSafeMvpCampaignReceipt {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly policyVersion: typeof CAMPAIGN_RECEIPT_POLICY;
  readonly campaignId: string;
  readonly experimentNumber: number;
  readonly experimentId: string;
  readonly disposition: "promote" | "reject" | "inconclusive";
  readonly championChanged: boolean;
  readonly evidenceFresh: boolean;
  readonly meanRewardDelta: number;
  readonly confidenceCandidateBetter: number;
  readonly nextExperimentNumber: number;
  readonly panelAction:
    | "cleared-after-promotion"
    | "retained-after-nonpromotion";
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly refreshedForPromotion: number;
    readonly seededFromPromotion: number;
  };
  readonly diagnosticCardCount: number;
  readonly containsTaskIdentifiers: false;
  readonly containsTaskNames: false;
  readonly containsPerTaskOutcomes: false;
  readonly containsGraderMaterial: false;
}

export async function prepareNextMvpOptimization(
  stateStore: MvpCampaignStateStore,
): Promise<PreparedMvpOptimization> {
  const state = await stateStore.load();
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    campaignId: state.campaignId,
    stateRevision: state.revision,
    optimizerInput: optimizerInputFromState(state),
    containsTaskIdentifiers: false,
    containsTaskNames: false,
    containsGraderMaterial: false,
  };
}

export function precomputedMvpOptimizer(
  expectedInput: OptimizerInput,
  proposal: CandidateProposal,
): OptimizerPort {
  validateCandidateProposal(proposal);
  let consumed = false;
  return {
    propose: async (actualInput) => {
      if (consumed) {
        throw new Error("Precomputed MVP optimizer proposal is one-use");
      }
      if (canonicalJson(actualInput) !== canonicalJson(expectedInput)) {
        throw new Error("Precomputed optimizer input does not match campaign state");
      }
      consumed = true;
      return proposal;
    },
  };
}

export async function runPreparedMvpCampaignIteration(input: {
  readonly stateStore: MvpCampaignStateStore;
  readonly loopPorts: Omit<MvpLoopPorts, "optimizer">;
  readonly prepared: PreparedMvpOptimization;
  readonly proposal: CandidateProposal;
  readonly slug: string;
  readonly environment: EvaluationEnvironment;
  readonly requiredConfidence?: number;
  readonly minimumAggregateDelta?: number;
  readonly now?: () => Date;
}): Promise<ReleaseSafeMvpCampaignReceipt> {
  const state = await input.stateStore.load();
  const expected = optimizerInputFromState(state);
  if (
    input.prepared.campaignId !== state.campaignId ||
    input.prepared.stateRevision !== state.revision ||
    canonicalJson(input.prepared.optimizerInput) !== canonicalJson(expected)
  ) {
    throw new Error("Prepared optimization no longer matches campaign state");
  }
  return runOne({
    state,
    stateStore: input.stateStore,
    loopPorts: {
      ...input.loopPorts,
      optimizer: precomputedMvpOptimizer(expected, input.proposal),
    },
    slug: input.slug,
    environment: input.environment,
    ...(input.requiredConfidence === undefined
      ? {}
      : { requiredConfidence: input.requiredConfidence }),
    ...(input.minimumAggregateDelta === undefined
      ? {}
      : { minimumAggregateDelta: input.minimumAggregateDelta }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export async function runMvpCampaignIterations(input: {
  readonly stateStore: MvpCampaignStateStore;
  readonly loopPorts: MvpLoopPorts;
  readonly campaignId: string;
  readonly frozenBaselineRevision: string;
  readonly slugs: readonly string[];
  readonly environment: EvaluationEnvironment;
  readonly requiredConfidence?: number;
  readonly minimumAggregateDelta?: number;
  readonly now?: () => Date;
}): Promise<readonly ReleaseSafeMvpCampaignReceipt[]> {
  if (input.slugs.length < 1 || input.slugs.length > 100) {
    throw new Error("MVP campaign driver requires between one and one hundred iterations");
  }
  const now = input.now ?? (() => new Date());
  await input.stateStore.initialize({
    campaignId: input.campaignId,
    frozenBaselineRevision: input.frozenBaselineRevision,
    initializedAt: now().toISOString(),
  });
  const receipts: ReleaseSafeMvpCampaignReceipt[] = [];
  for (const slug of input.slugs) {
    const state = await input.stateStore.load();
    receipts.push(
      await runOne({
        state,
        stateStore: input.stateStore,
        loopPorts: input.loopPorts,
        slug,
        environment: input.environment,
        ...(input.requiredConfidence === undefined
          ? {}
          : { requiredConfidence: input.requiredConfidence }),
        ...(input.minimumAggregateDelta === undefined
          ? {}
          : { minimumAggregateDelta: input.minimumAggregateDelta }),
        now,
      }),
    );
  }
  return receipts;
}

function optimizerInputFromState(state: MvpCampaignState): OptimizerInput {
  return buildTaskFreeMvpOptimizerInput({
    experimentNumber: state.nextExperimentNumber,
    championRevision: state.championRevision,
    previousOutcome: state.previousOutcome,
    previousDiagnosticBrief: state.previousDiagnosticBrief,
  });
}

async function runOne(input: {
  readonly state: MvpCampaignState;
  readonly stateStore: MvpCampaignStateStore;
  readonly loopPorts: MvpLoopPorts;
  readonly slug: string;
  readonly environment: EvaluationEnvironment;
  readonly requiredConfidence?: number;
  readonly minimumAggregateDelta?: number;
  readonly now?: () => Date;
}): Promise<ReleaseSafeMvpCampaignReceipt> {
  const capture: { taskHandles?: readonly HiddenTaskHandle[] } = {};
  const result = await runMvpIteration(
    {
      ...input.loopPorts,
      artifacts: {
        persist: async (artifacts) => {
          capture.taskHandles = artifacts.privateSelection.tasks.map(
            (task) => task.handle,
          );
          return input.loopPorts.artifacts.persist(artifacts);
        },
      },
    },
    {
      experimentNumber: input.state.nextExperimentNumber,
      slug: input.slug,
      championRevision: input.state.championRevision,
      environment: input.environment,
      previousOutcome: input.state.previousOutcome,
      previousDiagnosticBrief: input.state.previousDiagnosticBrief,
      retainedTaskHandles: input.state.retainedTaskHandles,
      ...(input.requiredConfidence === undefined
        ? {}
        : { requiredConfidence: input.requiredConfidence }),
      ...(input.minimumAggregateDelta === undefined
        ? {}
        : { minimumAggregateDelta: input.minimumAggregateDelta }),
    },
  );
  const selectedTaskHandles = capture.taskHandles;
  if (selectedTaskHandles === undefined) {
    throw new Error("MVP artifact store did not capture the private selected panel");
  }
  const retainedTaskHandles =
    result.decision.disposition === "promote"
      ? null
      : selectedTaskHandles;
  const next = await input.stateStore.advance({
    expectedRevision: input.state.revision,
    iteration: result,
    retainedTaskHandles,
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  });
  const receipt: ReleaseSafeMvpCampaignReceipt = {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: CAMPAIGN_RECEIPT_POLICY,
    campaignId: next.campaignId,
    experimentNumber: input.state.nextExperimentNumber,
    experimentId: result.experimentId,
    disposition: result.decision.disposition,
    championChanged: result.championRevision !== input.state.championRevision,
    evidenceFresh: result.decision.evidenceFresh,
    meanRewardDelta: result.decision.meanRewardDelta,
    confidenceCandidateBetter: result.decision.confidenceCandidateBetter,
    nextExperimentNumber: next.nextExperimentNumber,
    panelAction:
      result.decision.disposition === "promote"
        ? "cleared-after-promotion"
        : "retained-after-nonpromotion",
    cache: result.cache,
    diagnosticCardCount: result.diagnosticBrief.cards.length,
    containsTaskIdentifiers: false,
    containsTaskNames: false,
    containsPerTaskOutcomes: false,
    containsGraderMaterial: false,
  };
  return validateReleaseSafeMvpCampaignReceipt(receipt);
}

export function validateReleaseSafeMvpCampaignReceipt(
  value: unknown,
): ReleaseSafeMvpCampaignReceipt {
  if (!validateCampaignReceipt(value)) {
    throw new Error(
      `Invalid release-safe campaign receipt: ${(validateCampaignReceipt.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
  }
  const receipt = value as ReleaseSafeMvpCampaignReceipt;
  if (receipt.cache.hits + receipt.cache.misses !== 15) {
    throw new Error("Campaign receipt cache accounting must cover fifteen cells");
  }
  const promoted = receipt.disposition === "promote";
  if (
    receipt.championChanged !== promoted ||
    receipt.panelAction !==
      (promoted
        ? "cleared-after-promotion"
        : "retained-after-nonpromotion") ||
    receipt.cache.seededFromPromotion !== (promoted ? 15 : 0) ||
    (promoted && !receipt.evidenceFresh)
  ) {
    throw new Error("Campaign receipt transition fields disagree with its disposition");
  }
  return receipt;
}
