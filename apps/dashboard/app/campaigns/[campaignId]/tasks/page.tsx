"use client";

import { Search, SlidersHorizontal, Target } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  ProgressBar,
  Section,
  StatusPill,
} from "../../../../components/ui";
import { useCampaign } from "../../../../lib/client/api";
import { formatPercent } from "../../../../lib/client/format";

export default function TasksPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const campaign = useCampaign(campaignId);
  const [query, setQuery] = useState("");
  const sourceTasks = campaign.data?.taskHealth || campaign.data?.tasks || [];
  const totalSelections = sourceTasks.reduce((total, task) => total + (task.selections ?? 0), 0);
  const tasks = useMemo(
    () => sourceTasks.filter((task) => task.name.toLowerCase().includes(query.toLowerCase())),
    [sourceTasks, query],
  );
  if (campaign.isLoading) return <LoadingState label="Loading task catalog health" />;
  if (campaign.error)
    return <ErrorState error={campaign.error} retry={() => void campaign.mutate()} />;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Adaptive sampling"
        title="Task health"
        description="Auditable task difficulty, selection counts, and empirical failure evidence from the durable catalog."
      />
      <Section>
        <div className="table-controls">
          <label className="search-field">
            <Search size={16} />
            <input
              placeholder="Search task…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <span className="result-count">{tasks.length} tasks</span>
        </div>
        {!sourceTasks.length ? (
          <EmptyState
            icon={Target}
            title="Task catalog evidence unavailable"
            description="Task-level health appears after catalog initialization and is derived from durable selections and empirical failure rates."
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Difficulty</th>
                  <th>Selections</th>
                  <th>Selection share</th>
                  <th>Empirical failure</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.name}>
                    <td>
                      <strong>{task.name}</strong>
                    </td>
                    <td>
                      <StatusPill status={task.difficulty} />
                    </td>
                    <td>{task.selections ?? 0}</td>
                    <td>
                      {totalSelections > 0
                        ? formatPercent((task.selections ?? 0) / totalSelections)
                        : "Not selected yet"}
                    </td>
                    <td>
                      <div className="cell-progress">
                        <ProgressBar
                          value={(task.empiricalFailureRate ?? 0) * 100}
                          tone={(task.empiricalFailureRate ?? 0) > 0.5 ? "warning" : "default"}
                        />
                        <span>{formatPercent(task.empiricalFailureRate)}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <div className="info-banner">
        <SlidersHorizontal size={18} />
        <span>
          When panels are repeatedly perfect, sampling pressure shifts toward harder tasks. Every
          selected panel remains frozen for its matched candidate-versus-champion evaluation.
        </span>
      </div>
    </div>
  );
}
