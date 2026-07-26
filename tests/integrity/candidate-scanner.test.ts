import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scanCandidate } from "../../src/integrity/candidate-scanner.js";

function fragmentHash(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

describe("candidate integrity scanner", () => {
  it("accepts a small general harness mutation", () => {
    const result = scanCandidate({
      changedFiles: ["packages/coding-agent/src/core/system-prompt.ts"],
      unifiedDiff:
        "+++ b/packages/coding-agent/src/core/system-prompt.ts\n@@ -1,1 +1,2 @@\n+const recovery = \"Inspect a failed tool result before retrying\";",
      addedLines: 1,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it.each([
    [
      "protected path",
      ["packages/coding-agent/tests/grader/answer.ts"],
      "+const okay = true;",
      "PROTECTED_PATH",
    ],
    [
      "network",
      ["packages/coding-agent/src/core/policy.ts"],
      "+await fetch(\"https://example.invalid/answers\");",
      "NETWORK_TOOL_ADDITION",
    ],
    [
      "environment routing",
      ["packages/coding-agent/src/core/policy.ts"],
      "+if (process.env.TASK_KIND?.includes(\"special\")) route();",
      "ENVIRONMENT_FINGERPRINT_ROUTING",
    ],
    [
      "build manifest",
      ["packages/coding-agent/package.json"],
      '+"test": "true",',
      "PROTECTED_PATH",
    ],
    [
      "encoded payload",
      ["packages/coding-agent/src/core/policy.ts"],
      `+const payload = "${"a".repeat(200)}";`,
      "ENCODED_PAYLOAD",
    ],
  ])("rejects %s", (_name, files, added, expectedCode) => {
    const result = scanCandidate({
      changedFiles: files,
      unifiedDiff: `+++ b/${files[0]}\n@@ -1,1 +1,2 @@\n${added}`,
      addedLines: 1,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain(expectedCode);
  });

  it("matches protected fragments by hash without retaining a fragment catalog", () => {
    const result = scanCandidate({
      changedFiles: ["packages/coding-agent/src/core/policy.ts"],
      unifiedDiff:
        '+++ b/packages/coding-agent/src/core/policy.ts\n@@ -1,1 +1,2 @@\n+const clue = "protected phrase";',
      addedLines: 1,
      deletedLines: 0,
      taskFragmentHashes: new Set([fragmentHash("protected phrase")]),
    });
    expect(result.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "TASK_FRAGMENT_MATCH" })]),
    );
  });

  it("rejects changed opaque files and Git binary patches", () => {
    const result = scanCandidate({
      changedFiles: [
        "packages/coding-agent/src/opaque",
        "packages/coding-agent/src/payload.bin",
      ],
      unifiedDiff:
        "diff --git a/packages/coding-agent/src/payload.bin b/packages/coding-agent/src/payload.bin\nGIT binary patch\nliteral 4\nLcmeZt\n",
      addedLines: 0,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });

    expect(result.passed).toBe(false);
    expect(
      result.violations.filter(
        (violation) =>
          violation.code === "OPAQUE_BINARY_CHANGE",
      ),
    ).toHaveLength(3);
  });
});
