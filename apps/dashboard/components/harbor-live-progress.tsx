"use client";

import { Activity, CircleDollarSign, Clock3, Cpu } from "lucide-react";
import { formatCurrency, formatDate, formatDuration, humanize } from "../lib/client/format";
import type { HarborProgress } from "../lib/client/types";
import { ProgressBar, StatusPill } from "./ui";

export function HarborLiveProgress({ progress }: { progress: HarborProgress }) {
  const finished = progress.completedTrials;
  const percent = progress.totalTrials === 0 ? 0 : (finished / progress.totalTrials) * 100;
  const totalTokens =
    progress.inputTokens === null && progress.outputTokens === null
      ? null
      : (progress.inputTokens ?? 0) + (progress.outputTokens ?? 0);

  return (
    <div className="harbor-live" aria-live="polite">
      <div className="harbor-live-head">
        <div>
          <span className="live-badge">
            <Activity size={13} />
            Harbor {humanize(progress.status)}
          </span>
          <strong>
            {humanize(progress.arm)} evaluation · panel attempt {progress.panelAttempt}
          </strong>
          <small>Updated {formatDate(progress.updatedAt)}</small>
        </div>
        <StatusPill status={progress.status} />
      </div>

      <div className="harbor-progress-row">
        <ProgressBar
          value={percent}
          tone={progress.erroredTrials > 0 ? "negative" : "positive"}
          label="Harbor trial completion"
        />
        <strong>
          {finished} / {progress.totalTrials}
        </strong>
      </div>

      <div className="harbor-live-metrics">
        <span>
          <Activity size={14} />
          <strong>{progress.runningTrials}</strong> running
        </span>
        <span>
          <Clock3 size={14} />
          <strong>{progress.pendingTrials}</strong> queued
        </span>
        <span>
          <Cpu size={14} />
          <strong>{totalTokens?.toLocaleString() ?? "—"}</strong> tokens
          {progress.cacheTokens === null
            ? null
            : ` · ${progress.cacheTokens.toLocaleString()} cached`}
        </span>
        <span>
          <CircleDollarSign size={14} />
          <strong>{formatCurrency(progress.costUsd)}</strong> spent
        </span>
      </div>

      <div className="table-wrap harbor-trial-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>Task / trial</th>
              <th>Status</th>
              <th>Reward</th>
              <th>Duration</th>
              <th>Tokens</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {progress.trials.map((trial, index) => {
              const trialTokens =
                trial.inputTokens === null && trial.outputTokens === null
                  ? null
                  : (trial.inputTokens ?? 0) + (trial.outputTokens ?? 0);
              return (
                <tr key={`${trial.taskName}-${trial.trialName ?? `pending-${index}`}`}>
                  <td className="harbor-task-cell">
                    <strong>{trial.taskName}</strong>
                    <small>{trial.trialName ?? "Waiting for Harbor"}</small>
                  </td>
                  <td>
                    <StatusPill status={trial.status} />
                  </td>
                  <td className="harbor-reward">
                    {trial.reward === null ? "—" : trial.reward.toFixed(3)}
                  </td>
                  <td>{formatDuration(trial.durationMs)}</td>
                  <td>{trialTokens?.toLocaleString() ?? "—"}</td>
                  <td>{formatCurrency(trial.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
