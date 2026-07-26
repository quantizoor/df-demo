import { describe, expect, it } from "vitest";

import { withContentHash } from "../../src/schemas/canonical.js";
import {
  assertSchema,
  assertValidDocument,
  createValidator,
  type SchemaName,
  schemaRegistry,
} from "../../src/schemas/registry.js";
import {
  assertReleaseSafe,
  isForbiddenEvidenceField,
  UnsafeEvidenceError,
} from "../../src/schemas/safety.js";
import { schemaFixture } from "./fixtures.js";

function visitSchemas(
  value: unknown,
  path: string,
  visit: (schema: Readonly<Record<string, unknown>>, path: string) => void,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const schema = value as Readonly<Record<string, unknown>>;
  visit(schema, path);
  for (const [key, child] of Object.entries(schema)) {
    if (key !== "$id" && child !== undefined) {
      if (Array.isArray(child)) {
        child.forEach((item, index) => {
          visitSchemas(item, `${path}/${key}/${index}`, visit);
        });
      } else {
        visitSchemas(child, `${path}/${key}`, visit);
      }
    }
  }
}

describe("strict schema registry", () => {
  const schemaNames = Object.keys(schemaRegistry) as SchemaName[];

  it.each(schemaNames)("accepts a valid %s document and canonical hash", (name) => {
    expect(() => assertValidDocument(name, schemaFixture(name))).not.toThrow();
  });

  it.each(schemaNames)("rejects an extra top-level field in %s", (name) => {
    const fixture = schemaFixture(name);
    expect(fixture).toBeTypeOf("object");
    const withForbiddenExtra = withContentHash({
      ...(fixture as Readonly<Record<string, unknown>>),
      taskId: "hidden-task",
    });
    expect(() => assertValidDocument(name, withForbiddenExtra)).toThrow(/additional properties/u);
  });

  it("marks every object schema, including nested objects, as closed", () => {
    for (const [name, schema] of Object.entries(schemaRegistry)) {
      visitSchemas(schema, name, (node, path) => {
        if (node.type === "object") {
          expect(node.additionalProperties, path).toBe(false);
        }
      });
    }
  });

  it("declares the Draft 2020-12 dialect on every registered root schema", () => {
    for (const schema of Object.values(schemaRegistry)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    }
  });

  it("resolves both registry names and JSON Schema IDs", () => {
    const fixture = schemaFixture("analysis");
    expect(() => assertSchema("analysis", fixture)).not.toThrow();
    expect(() =>
      assertSchema("https://dark-factory.local/schemas/analysis-1.0.0.json", fixture),
    ).not.toThrow();
    const validator = createValidator();
    expect(validator.isValid("analysis", fixture)).toBe(true);
    expect(validator.schema("analysis").$id).toContain("analysis-1.0.0");
    expect(() => validator.assertSchema("missing-schema", fixture)).toThrow(/Unknown schema/u);
  });

  it("rejects a valid shape whose canonical content hash was mutated", () => {
    const fixture = schemaFixture("experiment") as Readonly<Record<string, unknown>>;
    expect(() =>
      assertValidDocument("experiment", { ...fixture, slug: "silently-mutated" }),
    ).toThrow(/contentHash/u);
  });

  it("rejects row-level task and raw grader channels", () => {
    const normalized = schemaFixture("normalizedGraderOutcome") as Readonly<
      Record<string, unknown>
    >;
    const graderLeak = withContentHash({ ...normalized, graderText: "expected secret" });
    expect(() => assertValidDocument("normalizedGraderOutcome", graderLeak)).toThrow();

    const evidence = schemaFixture("behavioralEvidence") as Readonly<Record<string, unknown>>;
    const taskRows = withContentHash({
      ...evidence,
      taskResults: [{ taskId: "hidden", outcome: "pass" }],
    });
    expect(() => assertValidDocument("behavioralEvidence", taskRows)).toThrow();
  });

  it("enforces release support thresholds", () => {
    const evidence = structuredClone(schemaFixture("behavioralEvidence")) as Record<
      string,
      unknown
    >;
    const window = evidence.analysisWindow as Record<string, unknown>;
    window.support = {
      distinctTaskCountBand: "1-4",
      trajectoryCountBand: "1-19",
      minimumComparedGroupSizeBand: "1-4",
      complementaryCountSuppressionPassed: true,
      differencingBudgetPassed: true,
    };
    expect(() => assertValidDocument("behavioralEvidence", withContentHash(evidence))).toThrow();
  });

  it("rejects internally inconsistent aggregate evidence", () => {
    const results = structuredClone(schemaFixture("results")) as Record<string, unknown>;
    const validation = results.validation as Record<string, unknown>;
    validation.outcomes = {
      bothPass: 12,
      challengerOnlyPass: 12,
      championOnlyPass: 0,
      bothFail: 0,
    };
    expect(() => assertValidDocument("results", withContentHash(results))).toThrow(
      /sum to matchedTaskCount/u,
    );

    const candidate = structuredClone(schemaFixture("candidate")) as Record<string, unknown>;
    candidate.allGatesPassed = false;
    expect(() => assertValidDocument("candidate", withContentHash(candidate))).toThrow(
      /must agree/u,
    );
  });

  it("reproduces signed validation dispositions from the frozen gate inputs", () => {
    const envelope = structuredClone(schemaFixture("signedResultEnvelope")) as Record<
      string,
      unknown
    >;
    envelope.payload = {
      kind: "validation",
      disposition: "promote",
      matchedTaskCount: 12,
      validFreshArmCount: 24,
      invalidArmTotal: 0,
      stratumCount: 2,
      pairOutcomeTotals: {
        bothPass: 4,
        challengerOnlyPass: 4,
        championOnlyPass: 1,
        bothFail: 3,
      },
      weightedAccuracy: {
        medianDelta: 0.04,
        credibleInterval: { lower: -0.1, upper: 0.2 },
        probabilityPositive: 0.9,
      },
      requiredPosteriorProbability: 0.98,
      onlineGateAuthorized: true,
      onlineErrorBudget: {
        policyVersion: "online-alpha-spending-v1",
        maximumOnlineError: 0.05,
        gateOrdinal: 1,
        alphaSpent: 0.02,
        cumulativeSpentBefore: 0,
        cumulativeSpentAfter: 0.02,
        remainingAfter: 0.03,
        reservationHash: "3".repeat(64),
        priorStateHash: "4".repeat(64),
        resultingStateHash: "5".repeat(64),
      },
      stratumRegressionVeto: false,
      integrityVeto: false,
      correctnessVeto: false,
      capabilityVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      aggregateCost: {
        inputTokens: 10,
        outputTokens: 20,
        modelUsd: 0.1,
        sandboxUsd: 0.2,
        totalUsd: 0.3,
        wallTimeMs: 1_000,
      },
    };
    expect(() => assertValidDocument("signedResultEnvelope", withContentHash(envelope))).toThrow(
      /reproduce exactly/u,
    );
  });

  it("fails closed when submission mode leaves an adaptive channel enabled", () => {
    const manifest = structuredClone(schemaFixture("complianceManifest")) as Record<
      string,
      unknown
    >;
    manifest.mode = "submission";
    const channels = manifest.enabledChannels as Record<string, unknown>;
    channels.officialEvaluation = true;
    expect(() => assertValidDocument("complianceManifest", withContentHash(manifest))).toThrow(
      /disable every adaptive feedback channel/u,
    );
  });
});

describe("release safety scanner", () => {
  it.each([
    ["taskId", "hidden"],
    ["taskResults", []],
    ["raw_atif", {}],
    ["trialHandle", "stable"],
    ["stdout", "secret"],
    ["verifierOutput", "secret"],
  ])("rejects the forbidden field %s", (field, value) => {
    expect(() => assertReleaseSafe({ [field]: value })).toThrow(UnsafeEvidenceError);
    expect(isForbiddenEvidenceField(field)).toBe(true);
  });

  it.each([
    "See https://private.example.invalid/result",
    "Fetch git@github.com:private/repository.git",
    "Inspect /workspace/secret/answer.txt",
    "Inspect /var",
    "Inspect '/private/evaluator/result.json'",
    "Inspect /root/grader/result.json",
    "Use C:\\private\\grader\\answer.txt",
    "Run `task-specific-command`",
    "Read ${SECRET_TOKEN}",
    "The result came from task 42",
    "Read %2Froot%2Fgrader.txt",
    Buffer.from("/private/grader/answer.txt", "utf8").toString("base64url"),
    Buffer.from("/var/private/grader.txt", "utf8").toString("base64"),
    Buffer.from("/root/grader.txt", "utf8").toString("hex"),
    "safe\u202esecret",
  ])("rejects a task-identifying or literal-bearing release string", (text) => {
    expect(() => assertReleaseSafe({ summary: text })).toThrow(UnsafeEvidenceError);
  });

  it("permits generic behavioral language", () => {
    expect(() =>
      assertReleaseSafe({
        summary: "Nonzero executions were often retried before output inspection or replanning.",
        distinctTaskCountBand: "10-19",
      }),
    ).not.toThrow();
  });

  it("applies the scanner after structural validation", () => {
    const brief = structuredClone(schemaFixture("diagnosticBrief")) as Record<string, unknown>;
    brief.limitations = ["See https://private.example.invalid/grader"];
    expect(() => assertValidDocument("diagnosticBrief", withContentHash(brief))).toThrow(
      UnsafeEvidenceError,
    );
  });
});
