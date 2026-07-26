import { describe, expect, it } from "vitest";
import {
  createCandidateBuildSpec,
  createCandidateWorktreeSpec,
} from "../../src/harness/candidate.js";
import {
  createPiRpcLaunchSpec,
  PiRpcJsonlDecoder,
  serializeTrustedPiPrompt,
} from "../../src/harness/pi-rpc.js";

const EXPERIMENT_ID = "001-improve-recovery";

describe("candidate specifications", () => {
  it("builds a branch and managed worktree from the exact champion commit", () => {
    const spec = createCandidateWorktreeSpec({
      experimentId: EXPERIMENT_ID,
      baseCommit: "a".repeat(40),
      canonicalRepositoryPath: "/workspace/pi",
      worktreeRoot: "/workspace/df-worktrees",
    });
    expect(spec).toMatchObject({
      branchName: "df/experiment/001-improve-recovery",
      worktreePath: "/workspace/df-worktrees/001-improve-recovery",
      createOperation: {
        executable: "git",
        workingDirectory: "/workspace/pi",
      },
    });
    expect(spec.createOperation.arguments).toEqual([
      "worktree",
      "add",
      "-b",
      "df/experiment/001-improve-recovery",
      "/workspace/df-worktrees/001-improve-recovery",
      "a".repeat(40),
    ]);
  });

  it("creates cloud-only install, check, focused-test, and build commands", () => {
    const spec = createCandidateBuildSpec({
      experimentId: EXPERIMENT_ID,
      sourceArtifact: {
        uri: "trusted://candidate/source",
        sha256: "c".repeat(64),
        mediaType: "application/x-tar",
        byteLength: 1_024,
      },
      extractorArtifact: {
        uri: "trusted://controller/extractor",
        sha256: "d".repeat(64),
        mediaType: "text/javascript",
        byteLength: 2_048,
      },
      packagerArtifact: {
        uri: "trusted://controller/packager",
        sha256: "e".repeat(64),
        mediaType: "text/javascript",
        byteLength: 2_048,
      },
      cloudWorkingDirectory: "/workspace/pi",
      remoteInputRoot: "/trusted/inputs/",
      remoteOutputRoot: "/trusted/outputs/",
      candidateCommit: "1".repeat(40),
      candidateTree: "2".repeat(40),
      lockSha256: "3".repeat(64),
      buildPolicyHash: "4".repeat(64),
      architecture: "x86_64",
      focusedTestFiles: ["packages/coding-agent/test/recovery.test.ts"],
      runFullTestSuite: true,
    });
    const commands = spec.commands.map((command) => [command.executable, ...command.arguments]);
    expect(commands[0]).toEqual([
      "/usr/bin/node",
      "/trusted/inputs/extract-pi-source.mjs",
      "--archive",
      "/trusted/inputs/candidate-source.tar",
      "--destination",
      "/workspace/pi",
      "--sha256",
      "c".repeat(64),
      "--commit",
      "1".repeat(40),
    ]);
    expect(commands).toContainEqual([
      "npm",
      "ci",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(commands).toContainEqual([
      "node",
      "node_modules/vitest/dist/cli.js",
      "--run",
      "packages/coding-agent/test/recovery.test.ts",
    ]);
    expect(commands).toContainEqual(["npm", "test"]);
    expect(commands).toContainEqual([
      "npm",
      "run",
      "build:binary",
      "--workspace=@earendil-works/pi-coding-agent",
    ]);
    expect(commands.at(-1)).toContain("/trusted/inputs/package-pi-runtime.mjs");
    expect(spec.validationLevel).toBe("release");
    expect(spec.commands.every((command) => command.environment.DF_CLOUD_EXECUTION === "1")).toBe(
      true,
    );
  });

  it.each(["001-../../escape", "not-numbered", "001-UPPERCASE"])(
    "rejects unsafe experiment id %s",
    (experimentId) => {
      expect(() =>
        createCandidateWorktreeSpec({
          experimentId,
          baseCommit: "a".repeat(40),
          canonicalRepositoryPath: "/workspace/pi",
          worktreeRoot: "/workspace/df-worktrees",
        }),
      ).toThrow(/identifier/u);
    },
  );

  it("rejects focused test traversal", () => {
    expect(() =>
      createCandidateBuildSpec({
        experimentId: EXPERIMENT_ID,
        sourceArtifact: {
          uri: "trusted://candidate/source",
          sha256: "c".repeat(64),
          mediaType: "application/x-tar",
          byteLength: 1_024,
        },
        extractorArtifact: {
          uri: "trusted://controller/extractor",
          sha256: "d".repeat(64),
          mediaType: "text/javascript",
          byteLength: 2_048,
        },
        packagerArtifact: {
          uri: "trusted://controller/packager",
          sha256: "e".repeat(64),
          mediaType: "text/javascript",
          byteLength: 2_048,
        },
        cloudWorkingDirectory: "/workspace/pi",
        remoteInputRoot: "/trusted/inputs/",
        remoteOutputRoot: "/trusted/outputs/",
        candidateCommit: "1".repeat(40),
        candidateTree: "2".repeat(40),
        lockSha256: "3".repeat(64),
        buildPolicyHash: "4".repeat(64),
        architecture: "x86_64",
        focusedTestFiles: ["packages/coding-agent/test/../../grader.test.ts"],
        runFullTestSuite: false,
      }),
    ).toThrow(/Focused test path/u);
  });
});

describe("Pi RPC launch contract", () => {
  it("pins RPC mode, exact model, tools, trust policy, and secret references", () => {
    const spec = createPiRpcLaunchSpec({
      piRoot: "/opt/pi",
      taskWorkingDirectory: "/workspace/task",
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
      enabledTools: ["write", "read", "bash", "read"],
      timeoutMs: 3_600_000,
      secretReferences: [
        {
          sourceEnvironmentName: "OPENAI_API_KEY",
          targetEnvironmentName: "OPENAI_API_KEY",
        },
      ],
    });
    expect(spec).toMatchObject({
      protocol: "pi-rpc-jsonl-v1",
      framing: "lf-only",
      command: {
        executable: "/usr/bin/node",
        workingDirectory: "/workspace/task",
      },
    });
    expect(spec.command.arguments).toContain("rpc");
    expect(spec.command.arguments).toContain("gpt-5.6");
    expect(spec.command.arguments).toContain("--no-approve");
    expect(spec.command.arguments).toContain("--no-context-files");
    expect(spec.command.arguments).toContain("--no-extensions");
    expect(spec.command.arguments).not.toContain("--api-key");
    expect(JSON.stringify(spec)).not.toContain("secret-value");
  });

  it("rejects an empty tool allowlist", () => {
    expect(() =>
      createPiRpcLaunchSpec({
        piRoot: "/opt/pi",
        taskWorkingDirectory: "/workspace/task",
        provider: "openai",
        modelId: "gpt-5.6",
        thinkingLevel: "high",
        enabledTools: [],
        timeoutMs: 1_000,
        secretReferences: [],
      }),
    ).toThrow(/allowlist/u);
  });
});

describe("strict Pi RPC JSONL boundary", () => {
  it("serializes a trusted task prompt as one LF-delimited RPC command", () => {
    const serialized = serializeTrustedPiPrompt({
      sensitivity: "benchmark-task-trusted-evaluator-only",
      requestId: "prompt-1",
      message: "Perform the assigned task.\u2028Keep working.",
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(serialized)).toMatchObject({
      id: "prompt-1",
      type: "prompt",
    });
  });

  it("splits only on LF and preserves Unicode line separators inside JSON", () => {
    const decoder = new PiRpcJsonlDecoder();
    const records = decoder.push(
      '{"type":"message_update","message":{"text":"alpha\u2028beta\u2029gamma"}}\n',
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      sensitivity: "raw-trusted-evaluator-only",
      kind: "message",
    });
    expect(records[0]?.value).toMatchObject({
      message: { text: "alpha\u2028beta\u2029gamma" },
    });
    expect(() => decoder.finish()).not.toThrow();
  });

  it("buffers fragmented records and classifies tool events", () => {
    const decoder = new PiRpcJsonlDecoder();
    expect(decoder.push('{"type":"tool_exec')).toEqual([]);
    expect(decoder.push('ution_end","toolName":"bash"}\n')).toMatchObject([{ kind: "tool" }]);
  });

  it("rejects malformed, oversized, and unterminated records", () => {
    const malformed = new PiRpcJsonlDecoder();
    expect(() => malformed.push("{not-json}\n")).toThrow(/malformed/u);
    const oversized = new PiRpcJsonlDecoder(8);
    expect(() => oversized.push('{"type":"agent_start"}')).toThrow(/size/u);
    const unterminated = new PiRpcJsonlDecoder();
    unterminated.push('{"type":"agent_start"}');
    expect(() => unterminated.finish()).toThrow(/non-terminated/u);
  });
});
