import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertMvpCandidateChangedFiles,
  assertMvpCandidateProposal,
  assertTaskFreeMvpOptimizerInput,
  createMvpOptimizerWorkerInvocation,
  MVP_OPTIMIZER_ALLOWED_TOOLS,
  MVP_OPTIMIZER_CLAUDE_CODE_VERSION,
  MVP_OPTIMIZER_DENIED_TOOLS,
  MVP_OPTIMIZER_REASONING_EFFORT,
  MVP_OPTIMIZER_WORKER_DELIVERY,
} from "../../src/mvp/optimizer-worker.js";

const optimizerInput = {
  schemaVersion: "mvp-1.0.0",
  experimentNumber: 1,
  championRevision: "a".repeat(40),
  previousOutcome: null,
  diagnosticBrief: {
    schemaVersion: "mvp-1.0.0",
    policyVersion: "closed-vocabulary-task-free-v1",
    cards: [
      {
        category: "error-recovery",
        toolClass: "shell",
        cause: "nonzero-exit-not-inspected",
        intervention: "inspect-before-retry",
        affectedArm: "candidate",
        direction: "candidate-worse",
        supportBand: "medium",
        confidenceBand: "high",
      },
    ],
    containsTaskIdentifiers: false,
    containsTaskLiterals: false,
    containsGraderSecrets: false,
    containsPerTaskOutcomes: false,
  },
  boundary: {
    taskCatalogVisible: false,
    taskIdentifiersVisible: false,
    taskPromptsVisible: false,
    graderVisible: false,
    rawTracesVisible: false,
    taskSpecificFeedbackVisible: false,
  },
};

describe("MVP optimizer worker delivery", () => {
  it("pins the cloud entrypoint, Claude version, model effort, and tool boundary", () => {
    expect(MVP_OPTIMIZER_WORKER_DELIVERY).toMatchObject({
      sourceRelativePath: "scripts/mvp-optimizer-worker.mjs",
      bundleRoot: "/tmp/df-mvp-controller",
      installedScriptPath: "/tmp/df-mvp-controller/scripts/mvp-optimizer-worker.mjs",
      nodeExecutablePath: "/usr/bin/node",
      exactClaudeCodeVersion: "2.1.217",
      requiredNodeMajor: 24,
      requiredSecretTargets: ["ANTHROPIC_FOUNDRY_API_KEY", "DF_GITHUB_BASIC_AUTH"],
      secretValueTransport: "daytona-opaque-outbound-header-placeholder-v1",
    });
    expect(MVP_OPTIMIZER_CLAUDE_CODE_VERSION).toBe("2.1.217");
    expect(MVP_OPTIMIZER_REASONING_EFFORT).toBe("high");
    expect(MVP_OPTIMIZER_ALLOWED_TOOLS).toEqual(["Read", "Edit", "Write", "Grep", "Glob", "Skill"]);
    expect(MVP_OPTIMIZER_DENIED_TOOLS).toEqual(
      expect.arrayContaining(["Bash", "Shell", "WebSearch", "WebFetch", "Agent", "Task"]),
    );
  });

  it("builds an explicit mounted-file invocation", () => {
    const invocation = createMvpOptimizerWorkerInvocation({
      campaignId: "mvp-first",
      maximumIterations: 2,
      stateRoot: "/workspace/df-state",
      configurationHash: "b".repeat(64),
    });

    expect(invocation).toMatchObject({
      executable: "/usr/bin/node",
      inputPath: "/workspace/df-state/inbox/optimizer-input.json",
      outputPath: "/workspace/df-state/outbox/candidate-proposal.json",
      environment: {
        CI: "true",
        DF_CLOUD_EXECUTION: "1",
        DF_MVP_ROLE: "optimizer",
      },
    });
    expect(invocation.arguments).toEqual(
      expect.arrayContaining([
        "/tmp/df-mvp-controller/scripts/mvp-optimizer-worker.mjs",
        "--input",
        invocation.inputPath,
        "--output",
        invocation.outputPath,
      ]),
    );
  });
});

describe("MVP optimizer protocol boundary", () => {
  it("accepts only the strict task-free optimizer input", () => {
    expect(() => assertTaskFreeMvpOptimizerInput(optimizerInput)).not.toThrow();
    expect(() =>
      assertTaskFreeMvpOptimizerInput({
        ...optimizerInput,
        taskName: "hidden-task",
      }),
    ).toThrow(/additional properties/u);
    expect(() =>
      assertTaskFreeMvpOptimizerInput({
        ...optimizerInput,
        boundary: {
          ...optimizerInput.boundary,
          graderVisible: true,
        },
      }),
    ).toThrow();
  });

  it("accepts a bounded generic Pi harness proposal and rejects protected content", () => {
    expect(() =>
      assertMvpCandidateProposal({
        hypothesisId: "recover-after-tool-failure",
        hypothesisSummary:
          "The general recovery path terminates before inspecting a failed tool response.",
        interventionSummary:
          "Preserve the failed response long enough for the agent loop to choose a corrective action.",
        candidateRevision: "c".repeat(40),
        changedFiles: ["packages/coding-agent/src/core/agent-session.ts"],
      }),
    ).not.toThrow();
    expect(() =>
      assertMvpCandidateChangedFiles(["packages/coding-agent/test/hidden-grader.test.ts"]),
    ).toThrow(/general Pi harness/u);
    expect(() =>
      assertMvpCandidateProposal({
        hypothesisId: "target-grader",
        hypothesisSummary: "The Terminal-Bench grader rewards a special response.",
        interventionSummary: "Route that task name to a stored answer.",
        candidateRevision: "d".repeat(40),
        changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
      }),
    ).toThrow(/benchmark-specific/u);
  });

  it("uses scoped HTTPS header auth and never a shell or credential URL", async () => {
    const source = await readFile(
      new URL("../../scripts/mvp-optimizer-worker.mjs", import.meta.url),
      "utf8",
    );

    expect(source).toContain("http.https://github.com/.extraHeader");
    expect(source).toContain("GIT_CONFIG_VALUE_0: `Authorization: Basic ${githubBasicAuth}`");
    expect(source).toContain("shell: false");
    expect(source).toContain("Fail-closed MVP optimizer filesystem boundary.");
    expect(source).toContain("${CLAUDE_PLUGIN_ROOT}/server/hook-guard.js");
    expect(source).toContain('["CapInh", "CapPrm", "CapEff", "CapAmb"]');
    expect(source).toContain("process.geteuid?.() !== 10001");
    expect(source).toContain("(process.getgroups?.() ?? []).includes(0)");
    expect(source).not.toContain("shell: true");
    expect(source).not.toMatch(/https:\/\/[^/\n]*\$\{[^}]*auth/iu);
  });

  it("routes the cloud relay directly into the bundled optimizer worker", async () => {
    const source = await readFile(
      new URL("../../src/mvp/cloud-optimizer-worker.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createMvpOptimizerWorkerInvocation");
    expect(source).toContain("shell: false");
    expect(source).toContain("DF_MVP_OPTIMIZER_INPUT_BASE64");
    expect(source).toContain('process.platform !== "linux"');
    expect(source).toContain('["CapInh", "CapPrm", "CapEff", "CapAmb"]');
    expect(source).toContain("process.geteuid?.() === 10001");
    expect(source).toContain("!(process.getgroups?.() ?? []).includes(0)");
    expect(source).not.toContain("runtime/mvp-optimizer-runtime.mjs");
  });

  it("ships skills that match the MVP no-command, exact-JSON contract", async () => {
    const skillNames = [
      "analyze-diagnostic-brief",
      "benchmark-integrity",
      "form-falsifiable-hypothesis",
      "modify-pi-harness",
    ];
    const skills = await Promise.all(
      skillNames.map((name) =>
        readFile(new URL(`../../claude-plugin/skills/${name}/SKILL.md`, import.meta.url), "utf8"),
      ),
    );
    const combined = skills.join("\n");

    expect(combined).toContain("essentials-only MVP");
    expect(combined).toContain("there is no `df_submit_hypothesis` tool");
    expect(combined).toContain("do not call commands");
    expect(combined).toContain("exactly the three-field JSON");
    expect(combined).toContain("there is no evidence or contamination-reporting tool");
  });
});
