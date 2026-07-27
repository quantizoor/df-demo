import { ArrowUpRight, CheckCircle2, CircleMinus, Clock3, XCircle } from "lucide-react";
import Link from "next/link";
import { formatCurrency, formatDate, formatDelta, formatDuration } from "../lib/client/format";
import type { ExperimentSummary } from "../lib/client/types";
import { StatusPill } from "./ui";

function DecisionIcon({ disposition }: { disposition?: string | null }) {
  if (disposition === "promote") return <CheckCircle2 className="text-positive" size={17} />;
  if (disposition === "reject") return <XCircle className="text-negative" size={17} />;
  return <CircleMinus className="text-muted" size={17} />;
}

export function ExperimentsTable({
  campaignId,
  experiments,
  compact = false,
}: {
  campaignId: string;
  experiments: ExperimentSummary[];
  compact?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Experiment</th>
            <th>State</th>
            <th>Decision</th>
            <th>Matched delta</th>
            {!compact ? <th>Confidence</th> : null}
            <th>Cost</th>
            {!compact ? <th>Duration</th> : null}
            <th>Updated</th>
            <th aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {experiments.map((experiment) => (
            <tr key={experiment.experimentId}>
              <td>
                <Link
                  className="table-primary"
                  href={`/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experiment.experimentId)}`}
                >
                  <span className="experiment-number">
                    {experiment.experimentNumber
                      ? String(experiment.experimentNumber).padStart(3, "0")
                      : "—"}
                  </span>
                  <span>
                    <strong>{experiment.experimentId}</strong>
                    <small>{experiment.hypothesisSummary || "Hypothesis pending"}</small>
                  </span>
                </Link>
              </td>
              <td>
                <StatusPill status={experiment.phase || "unknown"} />
              </td>
              <td>
                <span className="decision-cell">
                  <DecisionIcon disposition={experiment.disposition} />
                  {experiment.disposition || "Pending"}
                </span>
              </td>
              <td>
                <span
                  className={
                    (experiment.meanRewardDelta ?? 0) > 0
                      ? "delta-positive"
                      : (experiment.meanRewardDelta ?? 0) < 0
                        ? "delta-negative"
                        : ""
                  }
                >
                  {formatDelta(experiment.meanRewardDelta)}
                </span>
              </td>
              {!compact ? (
                <td>
                  {experiment.confidenceCandidateBetter == null
                    ? "—"
                    : `${(experiment.confidenceCandidateBetter * 100).toFixed(1)}%`}
                </td>
              ) : null}
              <td>{formatCurrency(experiment.costUsd)}</td>
              {!compact ? (
                <td>
                  <span className="icon-value">
                    <Clock3 size={14} />
                    {formatDuration(experiment.durationMs)}
                  </span>
                </td>
              ) : null}
              <td>{formatDate(experiment.completedAt || experiment.startedAt)}</td>
              <td>
                <Link
                  className="row-action"
                  aria-label={`Open ${experiment.experimentId}`}
                  href={`/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experiment.experimentId)}`}
                >
                  <ArrowUpRight size={16} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
