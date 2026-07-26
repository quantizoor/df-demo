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

  it.each(["120000", "160000"])(
    "rejects special Git object mode %s even when the path extension is allowed",
    (mode) => {
      const changedPath = "packages/coding-agent/src/core/policy.ts";
      const result = scanCandidate({
        changedFiles: [changedPath],
        unifiedDiff: [
          `diff --git a/${changedPath} b/${changedPath}`,
          `new file mode ${mode}`,
          "index 0000000..1111111",
          "--- /dev/null",
          `+++ b/${changedPath}`,
          "@@ -0,0 +1 @@",
          "+target",
        ].join("\n"),
        addedLines: 1,
        deletedLines: 0,
        taskFragmentHashes: new Set(),
      });

      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OPAQUE_BINARY_CHANGE" }),
        ]),
      );
    },
  );

  it.each(["120000", "160000"])(
    "rejects modification of an existing special Git object mode %s",
    (mode) => {
      const changedPath = "packages/coding-agent/src/core/policy.ts";
      const result = scanCandidate({
        changedFiles: [changedPath],
        unifiedDiff: [
          `diff --git a/${changedPath} b/${changedPath}`,
          `index 1111111..2222222 ${mode}`,
          `--- a/${changedPath}`,
          `+++ b/${changedPath}`,
          "@@ -1 +1 @@",
          "-old-target",
          "+new-target",
        ].join("\n"),
        addedLines: 1,
        deletedLines: 1,
        taskFragmentHashes: new Set(),
      });

      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OPAQUE_BINARY_CHANGE" }),
        ]),
      );
    },
  );

  it("rejects an encoded payload split across several literals", () => {
    const changedPath = "packages/coding-agent/src/core/policy.ts";
    const chunks = [
      "A".repeat(90),
      "B".repeat(90),
    ];
    const result = scanCandidate({
      changedFiles: [changedPath],
      unifiedDiff: [
        `+++ b/${changedPath}`,
        "@@ -1,1 +1,4 @@",
        `+const first = "${chunks[0]}";`,
        `+const second = "${chunks[1]}";`,
      ].join("\n"),
      addedLines: 2,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ENCODED_PAYLOAD" }),
      ]),
    );
  });

  it("decodes hex before base64 when checking protected fragments", () => {
    const changedPath = "packages/coding-agent/src/core/policy.ts";
    const encoded = Buffer.from("protected phrase").toString("hex");
    const result = scanCandidate({
      changedFiles: [changedPath],
      unifiedDiff: [
        `+++ b/${changedPath}`,
        "@@ -1,1 +1,2 @@",
        `+const clue = "${encoded}";`,
      ].join("\n"),
      addedLines: 1,
      deletedLines: 0,
      taskFragmentHashes: new Set([
        fragmentHash("protected phrase"),
      ]),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TASK_FRAGMENT_MATCH" }),
      ]),
    );
  });

  it("rejects a protected fragment reconstructed across literals", () => {
    const changedPath = "packages/coding-agent/src/core/policy.ts";
    const result = scanCandidate({
      changedFiles: [changedPath],
      unifiedDiff: [
        `+++ b/${changedPath}`,
        "@@ -1,1 +1,3 @@",
        '+const first = "protected";',
        '+const second = "phrase";',
      ].join("\n"),
      addedLines: 2,
      deletedLines: 0,
      taskFragmentHashes: new Set([
        fragmentHash("protected phrase"),
      ]),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TASK_FRAGMENT_MATCH" }),
      ]),
    );
  });

  it("rejects negative mutation counts even when the patch is otherwise allowed", () => {
    const changedPath = "packages/coding-agent/src/core/policy.ts";
    const result = scanCandidate({
      changedFiles: [changedPath],
      unifiedDiff: [
        `+++ b/${changedPath}`,
        "@@ -1,1 +1,2 @@",
        "+const recovery = true;",
      ].join("\n"),
      addedLines: -1,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DIFF_METADATA_MISMATCH",
        }),
      ]),
    );
  });

  it("rejects a protected diff path hidden behind an allowed changed-file list", () => {
    const allowedPath =
      "packages/coding-agent/src/core/policy.ts";
    const protectedPath =
      "packages/coding-agent/tests/grader/answer.ts";
    const result = scanCandidate({
      changedFiles: [allowedPath],
      unifiedDiff: [
        `+++ b/${protectedPath}`,
        "@@ -1,1 +1,2 @@",
        "+const answer = true;",
      ].join("\n"),
      addedLines: 1,
      deletedLines: 0,
      taskFragmentHashes: new Set(),
    });

    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "DIFF_METADATA_MISMATCH",
        }),
      ]),
    );
  });
});
