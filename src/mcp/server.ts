import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { ReleasedEvidenceRepository } from "./repository.js";
import {
  assertBoundedInput,
  assertExistingDirectory,
  boundedJson,
} from "./security.js";

const COMPONENTS = [
  "system-prompt",
  "tool-policy",
  "tool-recovery",
  "agent-session",
  "compaction",
  "agent-loop",
  "provider-transport",
  "runtime-extension",
] as const;

const MUTATION_CATEGORIES = [
  "prompt",
  "tool-description",
  "tool-validation",
  "tool-recovery",
  "context-management",
  "control-flow",
  "provider-compatibility",
  "extension",
] as const;

interface ServerArguments {
  readonly releasedEvidenceRoot: string;
  readonly submissionRoot: string;
  readonly auditRoot: string;
  readonly campaignId: string;
  readonly projectRoot: string;
  readonly pluginData: string;
}

function parseArguments(argv: readonly string[]): ServerArguments {
  if (argv.length % 2 !== 0) {
    throw new Error("Invalid MCP server arguments");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Invalid MCP server arguments");
    }
    if (values.has(key)) {
      throw new Error(`Duplicate MCP server argument ${key}`);
    }
    values.set(key, value);
  }
  const required = [
    "--released-evidence-root",
    "--submission-root",
    "--audit-root",
    "--campaign-id",
    "--project-root",
    "--plugin-data",
  ];
  if (values.size !== required.length) {
    throw new Error("Unknown MCP server argument");
  }
  for (const key of required) {
    if (!values.get(key)?.trim()) {
      throw new Error(`Missing required argument ${key}`);
    }
  }
  return {
    releasedEvidenceRoot: values.get("--released-evidence-root") ?? "",
    submissionRoot: values.get("--submission-root") ?? "",
    auditRoot: values.get("--audit-root") ?? "",
    campaignId: values.get("--campaign-id") ?? "",
    projectRoot: values.get("--project-root") ?? "",
    pluginData: values.get("--plugin-data") ?? "",
  };
}

function success(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: boundedJson(value) }] };
}

function registerTools(server: McpServer, repository: ReleasedEvidenceRepository): void {
  server.registerTool(
    "df_get_campaign_context",
    {
      description:
        "Get task-agnostic campaign, champion, budget-band, holdout, and allowed-action context.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => success(await repository.campaignContext()),
  );

  server.registerTool(
    "df_query_experiments",
    {
      description:
        "Get up to five explicitly numbered task-agnostic experiment summaries; no arbitrary filtering.",
      inputSchema: {
        experimentNumbers: z.array(z.number().int().nonnegative()).min(1).max(5),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ experimentNumbers }) => {
      assertBoundedInput({ experimentNumbers });
      return success(await repository.queryExperiments(experimentNumbers));
    },
  );

  server.registerTool(
    "df_get_latest_diagnostic_brief",
    {
      description:
        "Release the latest eligible privacy-thresholded diagnostic brief exactly once in this optimizer session.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async () => success(await repository.latestDiagnosticBrief()),
  );

  server.registerTool(
    "df_get_current_result",
    {
      description:
        "Release the current signed task-agnostic aggregate evaluation result exactly once for hypothesis analysis.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async () => success(await repository.currentResult()),
  );

  server.registerTool(
    "df_get_component_history",
    {
      description:
        "Get at most five task-agnostic experiment summaries for one approved Pi component.",
      inputSchema: { component: z.enum(COMPONENTS) },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ component }) => success(await repository.componentHistory(component)),
  );

  server.registerTool(
    "df_get_regressions",
    {
      description:
        "Get at most five released regression summaries, optionally for one approved mutation category.",
      inputSchema: { mutationCategory: z.enum(MUTATION_CATEGORIES).nullable() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ mutationCategory }) => success(await repository.regressions(mutationCategory)),
  );

  const hypothesisSchema = {
    sourceBriefHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
    citedCardIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/u)).max(8),
    observedPattern: z.string().min(20).max(1_200),
    causalClaim: z.string().min(20).max(1_200),
    intervention: z.string().min(20).max(1_200),
    affectedComponents: z.array(z.enum(COMPONENTS)).min(1).max(4),
    predictedRepairBehavior: z.string().min(20).max(1_200),
    predictedFreshEffect: z.object({
      accuracy: z.string().min(5).max(400),
      capability: z.string().min(5).max(400),
      cost: z.string().min(5).max(400),
      latency: z.string().min(5).max(400),
    }),
    generalityJustification: z.string().min(20).max(1_200),
    falsificationCriteria: z.array(z.string().min(10).max(400)).min(1).max(8),
    rollbackCondition: z.string().min(10).max(800),
  };
  server.registerTool(
    "df_submit_hypothesis",
    {
      description:
        "Freeze one falsifiable, task-agnostic Pi harness hypothesis before candidate editing.",
      inputSchema: hypothesisSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (payload) => {
      assertBoundedInput(payload);
      return success(await repository.submit("hypothesis", payload));
    },
  );

  server.registerTool(
    "df_stage_candidate",
    {
      description:
        "Declare edits complete; the controller computes immutable Git identifiers and runs integrity and cloud correctness gates.",
      inputSchema: {
        hypothesisReceiptId: z.string().min(16).max(128),
        mutationCategory: z.enum(MUTATION_CATEGORIES),
        changedComponents: z.array(z.enum(COMPONENTS)).min(1).max(4),
        summary: z.string().min(20).max(600),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (payload) => {
      assertBoundedInput(payload);
      return success(await repository.submit("candidate", payload));
    },
  );

  server.registerTool(
    "df_submit_analysis",
    {
      description:
        "Submit the task-agnostic post-evaluation analysis required before an optimizer session closes.",
      inputSchema: {
        hypothesisReceiptId: z.string().min(16).max(128),
        candidateReceiptId: z.string().min(16).max(128),
        resultHash: z.string().regex(/^[a-f0-9]{64}$/u),
        evidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(12),
        citedCardIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/u)).max(8),
        support: z.enum(["supported", "not-supported", "inconclusive"]),
        expectedVersusObserved: z.string().min(20).max(1_600),
        regressions: z.array(z.string().min(5).max(400)).max(8),
        confounders: z.array(z.string().min(5).max(400)).max(8),
        nextDirection: z.string().min(10).max(800),
        rollbackRequired: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (payload) => {
      assertBoundedInput(payload);
      return success(await repository.submit("analysis", payload));
    },
  );

  server.registerTool(
    "df_report_contamination",
    {
      description:
        "Stop the optimizer session and report only a fixed-category contamination signal; never include the sensitive content.",
      inputSchema: {
        sourceCategory: z.enum([
          "task-identity",
          "task-instruction",
          "grader-content",
          "reference-solution",
          "raw-trajectory",
          "protected-path",
          "unexpected-channel",
        ]),
        detectionPoint: z.enum([
          "released-evidence",
          "candidate-workspace",
          "tool-output",
          "plugin-output",
        ]),
        actionTaken: z.literal("stopped-without-using-content"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (payload) => {
      assertBoundedInput(payload);
      return success(await repository.submit("contamination", payload));
    },
  );
}

export async function createDarkFactoryMcpServer(
  args: ServerArguments,
): Promise<McpServer> {
  const repository = new ReleasedEvidenceRepository({
    releasedEvidenceRoot: await assertExistingDirectory(
      args.releasedEvidenceRoot,
    ),
    submissionRoot: await assertExistingDirectory(args.submissionRoot),
    auditRoot: await assertExistingDirectory(args.auditRoot),
    campaignId: args.campaignId,
    projectRoot: await assertExistingDirectory(args.projectRoot),
    pluginData: args.pluginData,
  });
  await repository.initialize();
  const server = new McpServer(
    { name: "dark-factory-evidence", version: "0.1.0" },
    {
      instructions:
        "Use only released task-agnostic aggregates. Never infer tasks, narrow cohorts, or compare unmatched subsets.",
    },
  );
  registerTools(server, repository);
  return server;
}

async function main(): Promise<void> {
  const server = await createDarkFactoryMcpServer(parseArguments(process.argv.slice(2)));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const close = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
