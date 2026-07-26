import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  extractBehaviorSummary,
  normalizeGraderOutcome,
} from "../../src/evaluation/index.js";
import { digest } from "./fixtures.js";

describe("deterministic behavioral extraction", () => {
  it("keeps only generic allowlisted behavior", () => {
    const summary = extractBehaviorSummary({
      elapsedMs: 70_000,
      planningTokens: 200,
      actionTokens: 700,
      totalTokens: 1_000,
      events: [
        { kind: "plan" },
        {
          kind: "tool-call",
          category: "execute",
          invocationValid: true,
          actionFingerprint: "private-within-trajectory-value",
          command: "secret-tool --secret-argument",
          path: "/private/task/path",
          url: "https://private.invalid/task",
        },
        { kind: "tool-result", exitCode: 1, stderr: "grader-specific failure" },
        { kind: "output-inspection", content: "private output" },
        { kind: "replan" },
        { kind: "recovery" },
        { kind: "verification" },
        { kind: "stop", reason: "completed" },
      ],
    });
    expect(summary.planBeforeFirstExecution).toBe(true);
    expect(summary.nonzeroExitFrequency).not.toBe("none");
    expect(summary.inspectedAfterNonzeroExit).toBe("all");
    expect(summary.replanAfterFailure).toBe(true);
    expect(summary.recoveryAfterFailure).toBe(true);
    expect(summary.verificationPerformed).toBe(true);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("secret-tool");
    expect(serialized).not.toContain("/private/task/path");
    expect(serialized).not.toContain("grader-specific");
  });

  it("drops arbitrary literal-bearing fields for generated hostile traces", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (generated) => {
        const literal = `sensitive-literal-${generated}`;
        const summary = extractBehaviorSummary({
          elapsedMs: 1,
          planningTokens: 0,
          actionTokens: 0,
          totalTokens: 0,
          events: [
            {
              kind: "tool-call",
              category: literal,
              invocationValid: false,
              actionFingerprint: literal,
              command: literal,
              arguments: { literal },
              path: literal,
              url: literal,
            },
            { kind: "tool-result", exitCode: 2, stdout: literal, stderr: literal },
            { kind: "output-inspection", content: literal },
            { kind: "stop", reason: literal },
          ],
        });
        expect(JSON.stringify(summary)).not.toContain(literal);
      }),
    );
  });

  it("normalizes only internally consistent scalar grader outcomes", () => {
    const normalized = normalizeGraderOutcome({
      passed: true,
      boundedReward: 1,
      infrastructureInvalidClass: null,
      integrityStatus: "passed",
      elapsedMs: 65_000,
      cpuUtilizationPercent: 50,
      maxRssMb: 1_024,
      protocolHash: digest(1),
      environmentFingerprintHash: digest(2),
      oneUseAttemptDigest: digest(3),
    }, {
      createdAt: "2026-07-01T00:02:00.000Z",
      rawManifestHash: digest(4),
    });
    expect(normalized.outcome).toBe("pass");
    expect(normalized.boundedReward).toBe(1);
    expect(normalized.elapsedTimeBucket).toBe("1-5m");
    expect(normalized.cpuBucket).toBe("medium");
    expect(normalized.memoryBucket).toBe("medium");
    expect(normalized.derivationHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalized.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects out-of-range and internally inconsistent grader values", () => {
    expect(() =>
      normalizeGraderOutcome({
        passed: true,
        boundedReward: 1.4,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedMs: 1,
        cpuUtilizationPercent: null,
        maxRssMb: 1,
        protocolHash: digest(1),
        environmentFingerprintHash: digest(2),
        oneUseAttemptDigest: digest(3),
      }, {
        createdAt: "2026-07-01T00:02:00.000Z",
        rawManifestHash: digest(4),
      }),
    ).toThrow(/unit interval/u);
    expect(() =>
      normalizeGraderOutcome({
        passed: false,
        boundedReward: 1,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedMs: 1,
        cpuUtilizationPercent: null,
        maxRssMb: 1,
        protocolHash: digest(1),
        environmentFingerprintHash: digest(2),
        oneUseAttemptDigest: digest(3),
      }, {
        createdAt: "2026-07-01T00:02:00.000Z",
        rawManifestHash: digest(4),
      }),
    ).toThrow(/conflict/u);
  });

  it("refuses grader prose, test names, and any other non-allowlisted field", () => {
    expect(() =>
      normalizeGraderOutcome({
        passed: false,
        boundedReward: 0,
        infrastructureInvalidClass: null,
        integrityStatus: "passed",
        elapsedMs: 1,
        cpuUtilizationPercent: null,
        maxRssMb: 1,
        protocolHash: digest(1),
        environmentFingerprintHash: digest(2),
        oneUseAttemptDigest: digest(3),
        graderMessage: "expected secret answer",
      }, {
        createdAt: "2026-07-01T00:02:00.000Z",
        rawManifestHash: digest(4),
      }),
    ).toThrow(/non-allowlisted/u);
  });

  it("classifies infrastructure invalidity separately from task failure", () => {
    const normalized = normalizeGraderOutcome({
      passed: false,
      boundedReward: 0,
      infrastructureInvalidClass: "provider-capacity",
      integrityStatus: "not-run",
      elapsedMs: 1,
      cpuUtilizationPercent: null,
      maxRssMb: 1,
      protocolHash: digest(1),
      environmentFingerprintHash: digest(2),
      oneUseAttemptDigest: digest(3),
    }, {
      createdAt: "2026-07-01T00:02:00.000Z",
      rawManifestHash: digest(4),
    });
    expect(normalized.outcome).toBe("invalid");
  });
});
