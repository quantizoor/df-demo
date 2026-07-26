import { describe, expect, it, vi } from "vitest";

import {
  ClosedVocabularyLlmSanitizer,
  FoundryMessagesDiagnosticClassifier,
  MVP_SCHEMA_VERSION,
  type PrivateEvaluationObservation,
} from "../../src/mvp/index.js";

describe("MVP trusted diagnostic sanitizer", () => {
  it("releases only a task-free closed-vocabulary result", async () => {
    const sanitizer = new ClosedVocabularyLlmSanitizer({
      classify: vi.fn(async () => safeBrief()),
    });

    await expect(
      sanitizer.sanitize({
        candidate: [observation("candidate")],
        champion: [observation("champion")],
      }),
    ).resolves.toEqual(safeBrief());
  });

  it("fails closed when the classifier returns an arbitrary field", async () => {
    const sanitizer = new ClosedVocabularyLlmSanitizer({
      classify: vi.fn(async () => ({
        ...safeBrief(),
        leakedTask: "secret-task-name",
      })),
    });

    await expect(
      sanitizer.sanitize({
        candidate: [observation("candidate")],
        champion: [observation("champion")],
      }),
    ).rejects.toThrow(/additional properties/u);
  });

  it("calls only the existing Foundry Messages endpoint and never returns the key", async () => {
    const request = vi.fn(async () =>
      new Response(JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(safeBrief()) }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const classifier = new FoundryMessagesDiagnosticClassifier({
      baseUrl:
        "https://existing-resource.services.ai.azure.com/anthropic",
      deployment: "existing-sanitizer-deployment",
      apiKey: "protected-api-key",
      fetch: request,
    });

    await expect(
      classifier.classify({
        candidate: [observation("candidate")],
        champion: [observation("champion")],
      }),
    ).resolves.toEqual(safeBrief());
    expect(request).toHaveBeenCalledWith(
      "https://existing-resource.services.ai.azure.com/anthropic/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      JSON.stringify(await classifier.classify({
        candidate: [observation("candidate")],
        champion: [observation("champion")],
      })),
    ).not.toContain("protected-api-key");
  });
});

function safeBrief() {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    policyVersion: "closed-vocabulary-task-free-v1" as const,
    cards: [
      {
        category: "error-recovery" as const,
        toolClass: "shell" as const,
        cause: "nonzero-exit-not-inspected" as const,
        intervention: "inspect-before-retry" as const,
        affectedArm: "candidate" as const,
        direction: "candidate-worse" as const,
        supportBand: "medium" as const,
        confidenceBand: "medium" as const,
      },
    ],
    containsTaskIdentifiers: false as const,
    containsTaskLiterals: false as const,
    containsGraderSecrets: false as const,
    containsPerTaskOutcomes: false as const,
  };
}

function observation(
  arm: "candidate" | "champion",
): PrivateEvaluationObservation {
  return {
    schemaVersion: MVP_SCHEMA_VERSION,
    experimentId: "001-change-system-prompt",
    cellId: "1".repeat(64),
    taskHandle: "2".repeat(64) as PrivateEvaluationObservation["taskHandle"],
    taskRevisionDigest: "3".repeat(64),
    repetition: 1,
    arm,
    harnessRevision: arm === "candidate"
      ? "4".repeat(40)
      : "5".repeat(40),
    environmentDigest: "6".repeat(64),
    source: "fresh",
    passed: false,
    reward: 0,
    infrastructureValid: true,
    durationMs: 100,
    evaluatedAt: "2026-07-26T10:00:00.000Z",
    traceArtifactRefs: ["private/trace.json"],
    rawDiagnostics: [
      {
        kind: "tool",
        code: "tool-failed",
        toolName: "shell",
        message: "secret-task-name failed after private command",
        evidenceRefs: ["private/raw.json"],
      },
    ],
  };
}
