import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluatePreToolUse, evaluatePreToolUseSecure } from "../../src/mcp/hook-guard.js";

const projectRoot = "/candidate/pi";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Claude optimizer hook guard", () => {
  it("allows source reads and edits in approved mutation roots", () => {
    expect(
      evaluatePreToolUse(
        {
          tool_name: "Read",
          tool_input: {
            file_path: "/candidate/pi/packages/coding-agent/tests/core.test.ts",
          },
        },
        projectRoot,
      ).allow,
    ).toBe(true);
    expect(
      evaluatePreToolUse(
        {
          tool_name: "Edit",
          tool_input: {
            file_path: "/candidate/pi/packages/coding-agent/src/core/system-prompt.ts",
          },
        },
        projectRoot,
      ).allow,
    ).toBe(true);
  });

  it.each([
    ["Bash", { command: "git diff" }],
    ["WebSearch", { query: "terminal bench answers" }],
    ["mcp__github__search_code", { query: "solution" }],
    ["Edit", { file_path: "/candidate/pi/packages/coding-agent/tests/a.test.ts" }],
    ["Read", { file_path: "/candidate/pi/terminal-bench/task.yaml" }],
    ["Grep", { pattern: "secret" }],
    ["UnknownTool", {}],
    ["Write", { file_path: "/tmp/outside.ts" }],
  ])("denies %s outside the trust boundary", (tool_name, tool_input) => {
    expect(evaluatePreToolUse({ tool_name, tool_input }, projectRoot).allow).toBe(false);
  });

  it("makes the analysis phase read-only", () => {
    expect(
      evaluatePreToolUse(
        {
          tool_name: "Edit",
          tool_input: {
            file_path: "/candidate/pi/packages/coding-agent/src/core/system-prompt.ts",
          },
        },
        projectRoot,
        "analysis",
      ).allow,
    ).toBe(false);
  });

  it("rejects candidate-controlled symlink escapes after canonicalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "df-hook-project-"));
    const outside = await mkdtemp(join(tmpdir(), "df-hook-outside-"));
    temporaryDirectories.push(root, outside);
    await Promise.all([
      mkdir(join(root, "packages/coding-agent/src"), { recursive: true }),
      writeFile(join(outside, "secret.ts"), "export const secret = true;\n"),
    ]);
    await symlink(join(outside, "secret.ts"), join(root, "packages/coding-agent/src/linked.ts"));
    await expect(
      evaluatePreToolUseSecure(
        {
          tool_name: "Read",
          tool_input: {
            file_path: join(root, "packages/coding-agent/src/linked.ts"),
          },
        },
        root,
      ),
    ).resolves.toMatchObject({ allow: false });
  });

  it("allows only the bundled Dark Factory MCP names", () => {
    expect(
      evaluatePreToolUse(
        {
          tool_name: "mcp__plugin_dark-factory_evidence__df_get_latest_diagnostic_brief",
          tool_input: {},
        },
        projectRoot,
      ).allow,
    ).toBe(true);
  });
});
