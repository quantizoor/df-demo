import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { opaqueDigest } from "./security.js";

interface HookInput {
  readonly session_id?: unknown;
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly stop_hook_active?: unknown;
  readonly source?: unknown;
}

export interface HookDecision {
  readonly allow: boolean;
  readonly reason: string;
}

const ALLOWED_MCP_TOOLS = new Set([
  "mcp__plugin_dark-factory_evidence__df_get_campaign_context",
  "mcp__plugin_dark-factory_evidence__df_query_experiments",
  "mcp__plugin_dark-factory_evidence__df_get_latest_diagnostic_brief",
  "mcp__plugin_dark-factory_evidence__df_get_current_result",
  "mcp__plugin_dark-factory_evidence__df_get_component_history",
  "mcp__plugin_dark-factory_evidence__df_get_regressions",
  "mcp__plugin_dark-factory_evidence__df_submit_hypothesis",
  "mcp__plugin_dark-factory_evidence__df_stage_candidate",
  "mcp__plugin_dark-factory_evidence__df_submit_analysis",
  "mcp__plugin_dark-factory_evidence__df_report_contamination",
]);
const PROPOSAL_MCP_TOOLS = new Set([
  "mcp__plugin_dark-factory_evidence__df_get_campaign_context",
  "mcp__plugin_dark-factory_evidence__df_query_experiments",
  "mcp__plugin_dark-factory_evidence__df_get_latest_diagnostic_brief",
  "mcp__plugin_dark-factory_evidence__df_get_component_history",
  "mcp__plugin_dark-factory_evidence__df_get_regressions",
  "mcp__plugin_dark-factory_evidence__df_submit_hypothesis",
  "mcp__plugin_dark-factory_evidence__df_stage_candidate",
  "mcp__plugin_dark-factory_evidence__df_report_contamination",
]);
const ANALYSIS_MCP_TOOLS = new Set([
  "mcp__plugin_dark-factory_evidence__df_get_campaign_context",
  "mcp__plugin_dark-factory_evidence__df_get_current_result",
  "mcp__plugin_dark-factory_evidence__df_submit_analysis",
  "mcp__plugin_dark-factory_evidence__df_report_contamination",
]);
const ALLOWED_BUILTIN_TOOLS = new Set([
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "Skill",
]);

const DENIED_TOOL =
  /(?:WebSearch|WebFetch|Browser|Chrome|Computer|GitHub|Harbor|Terminal.?Bench|Agent|Task|Notebook)/iu;
const MUTATION_ROOTS = [
  "packages/agent/src/",
  "packages/coding-agent/src/",
  "packages/ai/src/",
] as const;
const PROTECTED_PATH =
  /(^|\/)(?:\.git|\.claude|test|tests|grader|graders|verifier|verifiers|solution|solutions|reference|terminal-bench|terminalbench|tbench|harbor)(\/|$)|(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const PROTECTED_READ_PATH =
  /(^|\/)(?:\.git|grader|graders|verifier|verifiers|solution|solutions|terminal-bench|terminalbench|tbench|harbor)(\/|$)/iu;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function pathInside(root: string, candidate: string): string | null {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const child = relative(resolve(root), absolute);
  if (child === "" || child.startsWith("..") || isAbsolute(child)) {
    return null;
  }
  return child.replaceAll("\\", "/");
}

function requestedPath(input: Readonly<Record<string, unknown>>): string | null {
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

export function evaluatePreToolUse(
  input: HookInput,
  projectRoot: string,
  phase: "proposal" | "analysis" = "proposal",
): HookDecision {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = record(input.tool_input);
  if (!toolName) {
    return { allow: false, reason: "Tool name is missing from the hook request." };
  }
  if (DENIED_TOOL.test(toolName)) {
    return {
      allow: false,
      reason: "This tool is outside the Dark Factory optimizer trust boundary.",
    };
  }
  if (toolName === "Bash" || toolName === "Shell") {
    return {
      allow: false,
      reason:
        "Local shell execution is disabled. Use Read/Grep/Glob for inspection and Dark Factory MCP for cloud checks.",
    };
  }
  if (toolName.startsWith("mcp__") && !ALLOWED_MCP_TOOLS.has(toolName)) {
    return {
      allow: false,
      reason: "Only the bounded Dark Factory evidence MCP tools are permitted.",
    };
  }
  if (
    toolName.startsWith("mcp__") &&
    !(phase === "proposal" ? PROPOSAL_MCP_TOOLS : ANALYSIS_MCP_TOOLS).has(toolName)
  ) {
    return {
      allow: false,
      reason: "This Dark Factory tool is unavailable in the current optimizer phase.",
    };
  }
  if (!toolName.startsWith("mcp__") && !ALLOWED_BUILTIN_TOOLS.has(toolName)) {
    return {
      allow: false,
      reason: "The requested built-in tool is not in the optimizer allowlist.",
    };
  }
  if (toolName === "Skill") {
    const skill = toolInput.skill;
    if (typeof skill !== "string" || !skill.startsWith("dark-factory:")) {
      return {
        allow: false,
        reason: "Only Dark Factory plugin skills may be invoked in an optimizer session.",
      };
    }
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    if (phase !== "proposal") {
      return {
        allow: false,
        reason: "The analysis phase is read-only.",
      };
    }
    const candidate = requestedPath(toolInput);
    const child = candidate === null ? null : pathInside(projectRoot, candidate);
    if (
      child === null ||
      PROTECTED_PATH.test(child) ||
      !MUTATION_ROOTS.some((root) => child.startsWith(root))
    ) {
      return {
        allow: false,
        reason:
          "Candidate writes must remain inside approved Pi source roots and outside protected paths.",
      };
    }
  }
  if (toolName === "Read" || toolName === "Grep" || toolName === "Glob") {
    const candidate = requestedPath(toolInput);
    const child = candidate === null ? null : pathInside(projectRoot, candidate);
    if (child === null || PROTECTED_READ_PATH.test(child)) {
      return {
        allow: false,
        reason:
          "Reads and searches require an explicit path inside the candidate source boundary and outside protected paths.",
      };
    }
  }
  return { allow: true, reason: "Allowed by the Dark Factory optimizer policy." };
}

/**
 * Re-checks lexical hook policy against canonical filesystem paths. The CLI
 * uses this variant so a candidate-controlled symlink cannot escape the cloud
 * clone or redirect an allowed source edit into a protected tree.
 */
export async function evaluatePreToolUseSecure(
  input: HookInput,
  projectRoot: string,
  phase: "proposal" | "analysis" = "proposal",
): Promise<HookDecision> {
  const decision = evaluatePreToolUse(input, projectRoot, phase);
  if (!decision.allow) {
    return decision;
  }
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!new Set(["Read", "Grep", "Glob", "Edit", "Write", "MultiEdit"]).has(toolName)) {
    return decision;
  }
  const candidate = requestedPath(record(input.tool_input));
  if (candidate === null) {
    return {
      allow: false,
      reason: "Filesystem tools require an explicit candidate path.",
    };
  }
  try {
    const canonicalRoot = await realpath(projectRoot);
    const lexicalTarget = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(projectRoot, candidate);
    let inspectedTarget = lexicalTarget;
    let targetExists = true;
    try {
      const info = await lstat(lexicalTarget);
      if (info.isSymbolicLink()) {
        throw new Error("symbolic-link-target");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        toolName === "Write"
      ) {
        targetExists = false;
        inspectedTarget = dirname(lexicalTarget);
      } else {
        throw error;
      }
    }
    const canonicalInspected = await realpath(inspectedTarget);
    const lexicalRelative = relative(resolve(projectRoot), inspectedTarget);
    const expectedCanonical = resolve(canonicalRoot, lexicalRelative);
    if (
      canonicalInspected !== expectedCanonical ||
      pathInside(
        canonicalRoot,
        targetExists ? canonicalInspected : resolve(canonicalInspected, basename(lexicalTarget)),
      ) === null
    ) {
      throw new Error("canonical-path-escape");
    }
    return decision;
  } catch {
    return {
      allow: false,
      reason:
        "The requested filesystem path is missing, symlinked, or escapes the canonical candidate clone.",
    };
  }
}

function preToolUseOutput(decision: HookDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision.allow ? "allow" : "deny",
      permissionDecisionReason: decision.reason,
    },
  });
}

function parseCliArguments(argv: readonly string[]): {
  readonly action: string;
  readonly projectRoot: string | null;
  readonly pluginData: string | null;
} {
  const [action, ...rest] = argv;
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key !== undefined && value !== undefined) {
      values.set(key, value);
    }
  }
  return {
    action: action ?? "",
    projectRoot: values.get("--project-root") ?? null,
    pluginData: values.get("--plugin-data") ?? null,
  };
}

async function readStdin(limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error("Hook input exceeds the fixed size limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function stopOutput(
  input: HookInput,
  projectRoot: string,
  pluginData: string,
): Promise<string> {
  if (input.stop_hook_active === true) {
    return "{}";
  }
  const statePath = resolve(pluginData, "sessions", `${opaqueDigest(projectRoot)}.json`);
  try {
    const state = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    const value = record(state);
    if (
      value.analysisSubmitted === true ||
      value.contaminationReported === true ||
      (value.candidateStaged === true && value.currentResultReleased !== true)
    ) {
      return "{}";
    }
  } catch {
    // Missing or malformed session state fails closed for one continuation.
  }
  return JSON.stringify({
    decision: "block",
    reason:
      "Complete candidate handoff or submit the required task-agnostic analysis before ending this optimizer session.",
  });
}

async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2));
  const input = JSON.parse(await readStdin()) as HookInput;
  if (options.action === "pre-tool-use") {
    if (options.projectRoot === null) {
      throw new Error("Missing candidate project root");
    }
    const phase = process.env.DF_OPTIMIZER_PHASE === "analysis" ? "analysis" : "proposal";
    process.stdout.write(
      preToolUseOutput(await evaluatePreToolUseSecure(input, options.projectRoot, phase)),
    );
    return;
  }
  if (options.action === "stop") {
    if (options.projectRoot === null || options.pluginData === null) {
      throw new Error("Missing stop-hook boundary paths");
    }
    process.stdout.write(await stopOutput(input, options.projectRoot, options.pluginData));
    return;
  }
  if (options.action === "config-change") {
    process.stdout.write(
      JSON.stringify({
        decision: "block",
        reason: "Optimizer sessions may not alter Claude settings, skills, or plugin policy.",
      }),
    );
    return;
  }
  throw new Error("Unknown hook action");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
