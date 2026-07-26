import { describe, expect, it } from "vitest";
import {
  assertBoundedInput,
  assertSafeReleasedObject,
  assertTaskAgnosticSubmission,
  boundedJson,
  isWithin,
} from "../../src/mcp/security.js";

describe("MCP evidence security", () => {
  it("accepts bounded task-agnostic aggregate objects", () => {
    expect(() =>
      assertSafeReleasedObject({
        protocolHash: "a".repeat(64),
        cards: [
          {
            id: "generic-recovery",
            supportBand: "20-40",
            distinctTasksBand: "5-9",
            effect: 0.2,
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    { taskId: "secret" },
    { graderOutput: "secret" },
    { rawAtif: [] },
    { command: "secret" },
    { stdout: "secret" },
    { panelId: "secret" },
  ])("rejects protected output keys", (value) => {
    expect(() => assertSafeReleasedObject(value)).toThrow(/forbidden field/u);
  });

  it("enforces input and output size budgets", () => {
    expect(() => assertBoundedInput({ value: "x".repeat(21_000) })).toThrow(/request budget/u);
    expect(() => boundedJson({ value: "x".repeat(13_000) })).toThrow(/response budget/u);
  });

  it("detects lexical path escape", () => {
    expect(isWithin("/safe/root", "/safe/root/child")).toBe(true);
    expect(isWithin("/safe/root", "/safe/other")).toBe(false);
  });

  it("rejects task, grader, path, URL, and encoded literals in model prose", () => {
    expect(() =>
      assertTaskAgnosticSubmission({
        causalClaim: "Inspect /workspace/private/grader.txt for task id abc.",
      }),
    ).toThrow(/protected literal/u);
    expect(() =>
      assertTaskAgnosticSubmission({
        causalClaim: "Inspect /var/private/control.json.",
      }),
    ).toThrow(/protected literal/u);
    expect(() =>
      assertTaskAgnosticSubmission({
        causalClaim: Buffer.from(
          "/root/grader/answer.txt",
          "utf8",
        ).toString("base64url"),
      }),
    ).toThrow(/protected literal/u);
    expect(() =>
      assertTaskAgnosticSubmission({
        causalClaim:
          "Generic execution recovery should inspect failures before choosing another action.",
      }),
    ).not.toThrow();
  });
});
