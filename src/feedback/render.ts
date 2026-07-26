export interface FeedbackMetric {
  readonly medianDelta: number;
  readonly probabilityPositive: number;
  readonly validPairs: number;
  readonly provenance: string;
}

export interface FeedbackCard {
  readonly id: string;
  readonly summary: string;
  readonly supportBand: string;
  readonly uncertainty: string;
}

export interface FeedbackEntry {
  readonly experimentNumber: number;
  readonly slug: string;
  readonly hypothesis: string;
  readonly mutation: string;
  readonly candidateCommit: string;
  readonly sourceBriefHash: string | null;
  readonly repair: {
    readonly disposition: "not-run" | "passed" | "rejected" | "inconclusive";
    readonly attemptOrdinal: number | null;
    readonly integrity: "passed" | "failed" | "not-run";
    readonly cacheStatus: string;
    readonly aggregateCostUsd: number;
    readonly attestationHash: string | null;
  };
  readonly validation: FeedbackMetric | null;
  readonly historicalPrevious: FeedbackMetric | null;
  readonly historicalBaseline: FeedbackMetric | null;
  readonly cards: readonly FeedbackCard[];
  readonly cardsSuppressed: boolean;
  readonly activeChampionBefore: string;
  readonly activeChampionAfter: string;
  readonly certifiedChampionAfter: string | null;
  readonly disposition: string;
  readonly integrity: string;
  readonly panelDisposition: string;
  readonly totalCostUsd: number;
  readonly totalTokens: number;
  readonly totalWallTimeMs: number;
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly nextDirection: string;
  readonly feedbackEntryHash: string;
}

function fixed(value: number, digits = 3): string {
  return value.toFixed(digits);
}

function metricLines(label: string, metric: FeedbackMetric | null): readonly string[] {
  if (metric === null) {
    return [`- ${label}: unavailable; no compatible matched intersection.`];
  }
  return [
    `- ${label}: median accuracy delta ${fixed(metric.medianDelta)}, ` +
      `P(delta > 0) ${fixed(metric.probabilityPositive)}, ${metric.validPairs} fresh matched pairs.`,
    `- ${label} provenance: \`${metric.provenance}\`.`,
  ];
}

export function renderFeedbackEntry(entry: FeedbackEntry): string {
  const lines: string[] = [
    `## Experiment ${String(entry.experimentNumber).padStart(3, "0")} — ${entry.slug}`,
    "",
    `- Hypothesis: ${entry.hypothesis}`,
    `- Mutation: ${entry.mutation}`,
    `- Candidate commit: \`${entry.candidateCommit}\`.`,
    `- Source diagnostic brief: ${
      entry.sourceBriefHash === null
        ? "none (source-only bootstrap)"
        : `\`${entry.sourceBriefHash}\``
    }.`,
    "",
    "### Repair result — prior feedback panel",
    "",
    `- Disposition: ${entry.repair.disposition}.`,
    `- Candidate attempt: ${entry.repair.attemptOrdinal ?? "not applicable"}.`,
    `- Integrity: ${entry.repair.integrity}.`,
    `- Cache: ${entry.repair.cacheStatus}.`,
    `- Aggregate cost: $${fixed(entry.repair.aggregateCostUsd, 4)}.`,
    `- Attestation: ${
      entry.repair.attestationHash === null
        ? "not applicable"
        : `\`${entry.repair.attestationHash}\``
    }.`,
    "- Repair and cache evidence had zero positive promotion weight.",
    "",
    "### Fresh validation comparison",
    "",
    ...metricLines("Current candidate versus active champion", entry.validation),
    ...metricLines("Compatible intersection with previous experiment", entry.historicalPrevious),
    ...metricLines("Compatible intersection with experiment 000", entry.historicalBaseline),
    "",
    "### Safe aggregate behavioral findings",
    "",
  ];

  if (entry.cards.length === 0) {
    lines.push(
      entry.cardsSuppressed
        ? "- Behavioral findings were suppressed by support or differencing policy."
        : "- No actionable aggregate behavioral finding was produced.",
    );
  } else {
    for (const card of [...entry.cards].sort((left, right) => left.id.localeCompare(right.id))) {
      lines.push(
        `- ${card.id}: ${card.summary} Support ${card.supportBand}; uncertainty ${card.uncertainty}.`,
      );
    }
  }

  lines.push(
    "",
    "### Decision and lineage",
    "",
    `- Decision: ${entry.disposition}.`,
    `- Integrity result: ${entry.integrity}.`,
    `- Active champion: \`${entry.activeChampionBefore}\` → \`${entry.activeChampionAfter}\`.`,
    `- Certified champion: ${
      entry.certifiedChampionAfter === null ? "none" : `\`${entry.certifiedChampionAfter}\``
    }.`,
    `- Panel lifecycle: ${entry.panelDisposition}.`,
    `- Cost: $${fixed(entry.totalCostUsd, 4)}; tokens: ${entry.totalTokens}; wall time: ${entry.totalWallTimeMs} ms.`,
    `- Policy versions: ${Object.entries(entry.policyVersions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `${name}=${version}`)
      .join(", ")}.`,
    `- Next direction: ${entry.nextDirection}`,
    `- Structured source: \`${entry.feedbackEntryHash}\`.`,
    "",
  );

  return `${lines.join("\n")}\n`;
}

export function renderFeedbackDocument(
  preamble: string,
  entries: readonly FeedbackEntry[],
): string {
  const ordered = [...entries].sort(
    (left, right) => left.experimentNumber - right.experimentNumber,
  );
  const uniqueNumbers = new Set(ordered.map((entry) => entry.experimentNumber));
  if (uniqueNumbers.size !== ordered.length) {
    throw new Error("Feedback entries must have unique experiment numbers");
  }
  return `${preamble.trimEnd()}\n\n${ordered.map(renderFeedbackEntry).join("\n")}`;
}
