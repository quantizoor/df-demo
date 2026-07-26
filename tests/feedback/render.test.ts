import { describe, expect, it } from "vitest";
import {
  renderFeedbackDocument,
  renderFeedbackEntry,
  type FeedbackEntry,
} from "../../src/feedback/render.js";

const entry: FeedbackEntry = {
  experimentNumber: 1,
  slug: "generic-recovery",
  hypothesis: "Inspecting failed tool results improves generic recovery.",
  mutation: "Added a generic recovery instruction.",
  candidateCommit: "a".repeat(40),
  sourceBriefHash: null,
  repair: {
    disposition: "not-run",
    attemptOrdinal: null,
    integrity: "passed",
    cacheStatus: "not-used",
    aggregateCostUsd: 0,
    attestationHash: null,
  },
  validation: {
    medianDelta: 0.08,
    probabilityPositive: 0.96,
    validPairs: 12,
    provenance: "fresh-matched-v1",
  },
  historicalPrevious: null,
  historicalBaseline: null,
  cards: [],
  cardsSuppressed: true,
  activeChampionBefore: "b".repeat(40),
  activeChampionAfter: "a".repeat(40),
  certifiedChampionAfter: null,
  disposition: "promoted",
  integrity: "passed",
  panelDisposition: "consumed and rotated",
  totalCostUsd: 12.5,
  totalTokens: 1000,
  totalWallTimeMs: 10000,
  policyVersions: { privacy: "1", statistics: "1" },
  nextDirection: "Wait for a new released brief.",
  feedbackEntryHash: "c".repeat(64),
};

describe("feedback rendering", () => {
  it("labels matched validation and zero positive repair weight", () => {
    const markdown = renderFeedbackEntry(entry);
    expect(markdown).toContain("12 fresh matched pairs");
    expect(markdown).toContain("zero positive promotion weight");
    expect(markdown).toContain("suppressed");
  });

  it("is deterministic regardless of input entry order", () => {
    const second = { ...entry, experimentNumber: 2, slug: "second" };
    expect(renderFeedbackDocument("# Feedback", [second, entry])).toBe(
      renderFeedbackDocument("# Feedback", [entry, second]),
    );
  });

  it("rejects duplicate experiment numbers", () => {
    expect(() => renderFeedbackDocument("# Feedback", [entry, entry])).toThrow(/unique/u);
  });
});

