import { describe, expect, it } from "vitest";

import {
  ClaudeCodeSpecificationError,
  createClaudeCodeLaunchSpec,
  summarizeClaudeCodeStream,
} from "../../src/optimizer/claude-code.js";

const options = {
  claudeExecutable: "/usr/local/bin/claude",
  projectRoot: "/workspace/pi",
  pluginRoot: "/workspace/df-plugin",
  releasedEvidenceRoot: "/workspace/released",
  submissionRoot: "/workspace/submissions",
  auditRoot: "/workspace/audit",
  pluginDataRoot: "/workspace/plugin-data",
  campaignId: "campaign-001",
  experimentNumber: 1,
  phase: "proposal" as const,
  model: "claude-opus-exact",
  effort: "high" as const,
  maximumBudgetUsd: 10,
  maximumTurns: 40,
  timeoutMs: 3_600_000,
  secretReferences: [
    {
      sourceEnvironmentName: "ANTHROPIC_API_KEY",
      targetEnvironmentName: "ANTHROPIC_API_KEY",
    },
  ],
};

describe("Claude Code optimizer launch", () => {
  it("pins a headless, cloud-only, no-shell plugin session", () => {
    const spec = createClaudeCodeLaunchSpec(options);
    expect(spec.command.environment.DF_CLOUD_EXECUTION).toBe("1");
    expect(spec.command.environment.DF_OPTIMIZER_SUBMISSION_ROOT).toBe(
      "/workspace/submissions",
    );
    expect(spec.command.environment.DF_OPTIMIZER_AUDIT_ROOT).toBe(
      "/workspace/audit",
    );
    expect(spec.command.arguments).toContain("dontAsk");
    expect(spec.command.arguments).toContain("Bash,Shell,WebSearch,WebFetch,Agent,Task,NotebookEdit");
    expect(spec.command.arguments).toContain("/workspace/df-plugin");
    expect(spec.command.arguments.join(" ")).not.toContain("--dangerously-skip-permissions");
  });

  it("rejects relative paths and unbounded runs", () => {
    expect(() =>
      createClaudeCodeLaunchSpec({
        ...options,
        pluginRoot: "../plugin",
      }),
    ).toThrow(ClaudeCodeSpecificationError);
    expect(() =>
      createClaudeCodeLaunchSpec({
        ...options,
        maximumTurns: 201,
      }),
    ).toThrow(ClaudeCodeSpecificationError);
  });
});

describe("Claude Code stream reduction", () => {
  it("requires the Dark Factory plugin and retains metadata only", () => {
    const summary = summarizeClaudeCodeStream([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-1",
        model: "claude-opus-exact",
        plugins: [{ name: "dark-factory", path: "/workspace/plugin" }],
      }),
      JSON.stringify({ type: "assistant", message: { content: "sensitive source text" } }),
      JSON.stringify({
        type: "result",
        session_id: "session-1",
        is_error: false,
        total_cost_usd: 2.5,
        result: "sensitive source text",
      }),
    ]);
    expect(summary).toEqual({
      initialized: true,
      pluginLoaded: true,
      pluginErrors: [],
      sessionId: "session-1",
      model: "claude-opus-exact",
      result: "completed",
      totalCostUsd: 2.5,
      turns: 1,
    });
  });

  it("fails closed when the plugin is absent", () => {
    const summary = summarizeClaudeCodeStream([
      JSON.stringify({
        type: "system",
        subtype: "init",
        plugins: [],
      }),
      JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0 }),
    ]);
    expect(summary.result).toBe("failed");
    expect(summary.pluginLoaded).toBe(false);
  });
});
