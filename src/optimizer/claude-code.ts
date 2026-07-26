import { isAbsolute } from "node:path";

import type { RemoteCommandSpec, SecretReference } from "../cloud/types.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCodeLaunchOptions {
  readonly claudeExecutable: string;
  readonly projectRoot: string;
  readonly pluginRoot: string;
  readonly releasedEvidenceRoot: string;
  readonly submissionRoot: string;
  readonly auditRoot: string;
  readonly pluginDataRoot: string;
  readonly campaignId: string;
  readonly experimentNumber: number;
  readonly phase: "proposal" | "analysis";
  /** Exact existing Microsoft Foundry deployment name passed to Claude Code. */
  readonly model: string;
  /** Public model identity pinned by the campaign protocol. */
  readonly modelFamily: "claude-opus-5";
  readonly foundryResourceName: string;
  readonly effort: ClaudeEffort;
  readonly maximumBudgetUsd: number;
  readonly maximumTurns: number;
  readonly timeoutMs: number;
  readonly secretReferences: readonly SecretReference[];
}

export interface ClaudeCodeLaunchSpec {
  readonly protocol: "claude-code-stream-json-v1";
  readonly minimumClaudeCodeVersion: "2.1.217";
  readonly command: RemoteCommandSpec;
}

export interface ClaudeCodeSessionSummary {
  readonly initialized: boolean;
  readonly pluginLoaded: boolean;
  readonly pluginErrors: readonly string[];
  readonly sessionId: string | null;
  readonly model: string | null;
  readonly result: "completed" | "failed" | "incomplete";
  readonly totalCostUsd: number;
  readonly turns: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const SAFE_FOUNDRY_RESOURCE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PROPOSAL_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Grep",
  "Glob",
  "Skill",
  "mcp__plugin_dark-factory_evidence__df_get_campaign_context",
  "mcp__plugin_dark-factory_evidence__df_query_experiments",
  "mcp__plugin_dark-factory_evidence__df_get_latest_diagnostic_brief",
  "mcp__plugin_dark-factory_evidence__df_get_component_history",
  "mcp__plugin_dark-factory_evidence__df_get_regressions",
  "mcp__plugin_dark-factory_evidence__df_submit_hypothesis",
  "mcp__plugin_dark-factory_evidence__df_stage_candidate",
  "mcp__plugin_dark-factory_evidence__df_report_contamination",
].join(",");
const ANALYSIS_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Skill",
  "mcp__plugin_dark-factory_evidence__df_get_campaign_context",
  "mcp__plugin_dark-factory_evidence__df_get_current_result",
  "mcp__plugin_dark-factory_evidence__df_submit_analysis",
  "mcp__plugin_dark-factory_evidence__df_report_contamination",
].join(",");
const DENIED_TOOLS = "Bash,Shell,WebSearch,WebFetch,Agent,Task,NotebookEdit";

export class ClaudeCodeSpecificationError extends Error {
  override readonly name = "ClaudeCodeSpecificationError";
}

function assertAbsoluteTraversalFree(path: string, label: string): void {
  if (!isAbsolute(path) || path.includes("/../") || path.includes("\u0000")) {
    throw new ClaudeCodeSpecificationError(
      `${label} must be an absolute traversal-free cloud path.`,
    );
  }
}

function optimizerPrompt(
  experimentNumber: number,
  phase: ClaudeCodeLaunchOptions["phase"],
): string {
  const padded = experimentNumber.toString().padStart(3, "0");
  if (phase === "analysis") {
    return [
      `Analyze Dark Factory experiment ${padded}.`,
      "Use the dark-factory workflow, statistical-decision-making, and document-decisions skills.",
      "Read only the released task-agnostic current result and previously released evidence.",
      "Compare it with the frozen hypothesis, submit exactly one analysis, and record a recommendation.",
      "Do not edit Pi, infer benchmark tasks, invoke a shell, contact the network, or inspect protected files.",
      "If protected information appears, report contamination and stop.",
    ].join(" ");
  }
  return [
    `Run Dark Factory experiment ${padded}.`,
    "Use the dark-factory workflow and benchmark-integrity skills.",
    "Inspect only the permitted Pi source and released task-agnostic evidence.",
    "Submit exactly one falsifiable hypothesis before editing.",
    "Make one small general harness change, then call df_stage_candidate to hand control back.",
    "Never infer benchmark tasks, invoke a shell, run tests, contact the network, or inspect protected files.",
    "If protected information appears, report contamination and stop.",
  ].join(" ");
}

export function createClaudeCodeLaunchSpec(options: ClaudeCodeLaunchOptions): ClaudeCodeLaunchSpec {
  for (const [label, path] of [
    ["Claude executable", options.claudeExecutable],
    ["Pi candidate root", options.projectRoot],
    ["plugin root", options.pluginRoot],
    ["released evidence root", options.releasedEvidenceRoot],
    ["optimizer submission root", options.submissionRoot],
    ["optimizer audit root", options.auditRoot],
    ["plugin data root", options.pluginDataRoot],
  ] as const) {
    assertAbsoluteTraversalFree(path, label);
  }
  if (!SAFE_ID.test(options.campaignId)) {
    throw new ClaudeCodeSpecificationError("Campaign identifier is malformed.");
  }
  if (!SAFE_MODEL.test(options.model)) {
    throw new ClaudeCodeSpecificationError("Claude optimizer model must be an exact safe ID.");
  }
  if (
    options.modelFamily !== "claude-opus-5" ||
    !SAFE_FOUNDRY_RESOURCE.test(options.foundryResourceName) ||
    options.secretReferences.length !== 1 ||
    options.secretReferences[0]?.targetEnvironmentName !== "ANTHROPIC_FOUNDRY_API_KEY"
  ) {
    throw new ClaudeCodeSpecificationError(
      "Claude optimizer must use the pinned Microsoft Foundry Opus 5 binding.",
    );
  }
  if (!Number.isSafeInteger(options.experimentNumber) || options.experimentNumber < 1) {
    throw new ClaudeCodeSpecificationError("Experiment number must be a positive integer.");
  }
  if (
    !Number.isFinite(options.maximumBudgetUsd) ||
    options.maximumBudgetUsd <= 0 ||
    !Number.isSafeInteger(options.maximumTurns) ||
    options.maximumTurns < 1 ||
    options.maximumTurns > 200 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 24 * 60 * 60_000
  ) {
    throw new ClaudeCodeSpecificationError("Claude optimizer limits are invalid.");
  }

  return {
    protocol: "claude-code-stream-json-v1",
    minimumClaudeCodeVersion: "2.1.217",
    command: {
      executable: options.claudeExecutable,
      arguments: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--no-chrome",
        "--permission-mode",
        "dontAsk",
        "--tools",
        options.phase === "proposal" ? PROPOSAL_TOOLS : ANALYSIS_TOOLS,
        "--disallowedTools",
        DENIED_TOOLS,
        "--model",
        options.model,
        "--effort",
        options.effort,
        "--max-budget-usd",
        options.maximumBudgetUsd.toFixed(2),
        "--max-turns",
        options.maximumTurns.toString(),
        "--plugin-dir",
        options.pluginRoot,
        optimizerPrompt(options.experimentNumber, options.phase),
      ],
      workingDirectory: options.projectRoot,
      timeoutMs: options.timeoutMs,
      environment: {
        CI: "true",
        DF_CLOUD_EXECUTION: "1",
        DF_CAMPAIGN_ID: options.campaignId,
        DF_EXPERIMENT_NUMBER: options.experimentNumber.toString(),
        DF_OPTIMIZER_PHASE: options.phase,
        DF_RELEASED_EVIDENCE_ROOT: options.releasedEvidenceRoot,
        DF_OPTIMIZER_SUBMISSION_ROOT: options.submissionRoot,
        DF_OPTIMIZER_AUDIT_ROOT: options.auditRoot,
        DF_PLUGIN_DATA_ROOT: options.pluginDataRoot,
        CLAUDE_CONFIG_DIR: `${options.pluginDataRoot}/claude-config`,
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1",
        CLAUDE_CODE_USE_FOUNDRY: "1",
        ANTHROPIC_FOUNDRY_RESOURCE: options.foundryResourceName,
        ANTHROPIC_DEFAULT_OPUS_MODEL: options.model,
        DF_OPTIMIZER_MODEL_ID: options.modelFamily,
        DISABLE_TELEMETRY: "1",
      },
      secretReferences: options.secretReferences,
    },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => (typeof item === "string" ? [item] : []))
    : [];
}

/**
 * Reduces Claude's stream to bounded operational metadata. The full stream is
 * retained only in the cloud optimizer sandbox and is never an experiment
 * artifact.
 */
export function summarizeClaudeCodeStream(jsonLines: readonly string[]): ClaudeCodeSessionSummary {
  let initialized = false;
  let pluginLoaded = false;
  let pluginErrors: string[] = [];
  let sessionId: string | null = null;
  let model: string | null = null;
  let result: ClaudeCodeSessionSummary["result"] = "incomplete";
  let totalCostUsd = 0;
  let turns = 0;

  for (const line of jsonLines) {
    if (Buffer.byteLength(line, "utf8") > 1_000_000 || line.includes("\u0000")) {
      throw new ClaudeCodeSpecificationError("Claude stream record is oversized or malformed.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ClaudeCodeSpecificationError("Claude emitted malformed stream JSON.");
    }
    const event = asRecord(parsed);
    if (event === null) {
      throw new ClaudeCodeSpecificationError("Claude stream record must be an object.");
    }
    if (event.type === "system" && event.subtype === "init") {
      initialized = true;
      sessionId = typeof event.session_id === "string" ? event.session_id : sessionId;
      model = typeof event.model === "string" ? event.model : model;
      const plugins = Array.isArray(event.plugins) ? event.plugins : [];
      pluginLoaded = plugins.some((item) => {
        const plugin = asRecord(item);
        return plugin?.name === "dark-factory";
      });
      const errors = Array.isArray(event.plugin_errors) ? event.plugin_errors : [];
      pluginErrors = errors.map((item) => {
        const error = asRecord(item);
        if (error === null) return "unknown-plugin-error";
        const type = typeof error.type === "string" ? error.type : "unknown";
        return `dark-factory-plugin-${type}`;
      });
    }
    if (event.type === "assistant") {
      turns += 1;
    }
    if (event.type === "result") {
      sessionId = typeof event.session_id === "string" ? event.session_id : sessionId;
      const cost = event.total_cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        totalCostUsd = cost;
      }
      result = event.is_error === true ? "failed" : "completed";
      pluginErrors = [...new Set([...pluginErrors, ...stringArray(event.plugin_errors)])];
    }
  }

  if (!initialized || !pluginLoaded || pluginErrors.length > 0) {
    result = "failed";
  }
  return {
    initialized,
    pluginLoaded,
    pluginErrors,
    sessionId,
    model,
    result,
    totalCostUsd,
    turns,
  };
}
