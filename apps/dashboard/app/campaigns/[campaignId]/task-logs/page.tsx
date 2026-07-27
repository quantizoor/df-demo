"use client";

import { Radio, ShieldCheck, Terminal } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { TaskLogViewer } from "../../../../components/task-log-viewer";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatusPill,
} from "../../../../components/ui";
import { useTaskLogs } from "../../../../lib/client/api";
import { formatDate, humanize } from "../../../../lib/client/format";
import type { TaskLogDescriptor } from "../../../../lib/client/types";

type TaskLogGroup = {
  key: string;
  taskName: string | null;
  trialName: string | null;
  status: TaskLogDescriptor["status"];
  reward: number | null;
  logs: TaskLogDescriptor[];
};

const statusOrder = new Map([
  ["running", 0],
  ["error", 1],
  ["cancelled", 2],
  ["completed", 3],
  ["pending", 4],
]);

const sourceOrder = new Map([
  ["agent", 0],
  ["trial", 1],
  ["trajectory", 2],
  ["verifier", 3],
  ["reward", 4],
  ["exception", 5],
  ["job", 6],
]);

function groupKey(log: TaskLogDescriptor): string {
  if (log.trialName !== null) return `trial:${log.trialName}`;
  if (log.taskName !== null) return `task:${log.taskName}`;
  return "job";
}

function preferredLog(logs: TaskLogDescriptor[]): TaskLogDescriptor | undefined {
  return [...logs].sort(
    (left, right) =>
      (left.status === "running" ? 0 : 1) - (right.status === "running" ? 0 : 1) ||
      (sourceOrder.get(left.source) ?? 9) - (sourceOrder.get(right.source) ?? 9) ||
      right.updatedAt.localeCompare(left.updatedAt),
  )[0];
}

function taskLogGroups(logs: TaskLogDescriptor[]): TaskLogGroup[] {
  const groups = new Map<string, TaskLogGroup>();
  for (const log of logs) {
    const key = groupKey(log);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        taskName: log.taskName,
        trialName: log.trialName,
        status: log.status,
        reward: log.reward,
        logs: [log],
      });
      continue;
    }
    existing.logs.push(log);
    if ((statusOrder.get(log.status) ?? 9) < (statusOrder.get(existing.status) ?? 9)) {
      existing.status = log.status;
    }
    if (log.reward !== null) existing.reward = log.reward;
  }
  return [...groups.values()].sort(
    (left, right) =>
      (left.key === "job" ? 1 : 0) - (right.key === "job" ? 1 : 0) ||
      (statusOrder.get(left.status) ?? 9) - (statusOrder.get(right.status) ?? 9) ||
      (left.taskName ?? "").localeCompare(right.taskName ?? "") ||
      (left.trialName ?? "").localeCompare(right.trialName ?? ""),
  );
}

export default function TaskLogsPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const taskLogs = useTaskLogs(campaignId);
  const logs = taskLogs.data?.logs || [];
  const groups = useMemo(() => taskLogGroups(logs), [logs]);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    if (selectedId && logs.some((log) => log.id === selectedId)) return;
    setSelectedId(preferredLog(logs)?.id || "");
  }, [logs, selectedId]);

  const selected = logs.find((log) => log.id === selectedId);
  const selectedGroup = groups.find((group) => group.key === (selected ? groupKey(selected) : ""));

  if (taskLogs.isLoading) return <LoadingState label="Connecting to task container streams" />;
  if (taskLogs.error)
    return <ErrorState error={taskLogs.error} retry={() => void taskLogs.mutate()} />;

  const data = taskLogs.data;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Harbor runtime"
        title="Task logs"
        description="Tail live agent, trial, and verifier output from the local task containers."
        actions={
          data?.status === "running" ? (
            <span className="live-badge">
              <Radio size={15} />
              Containers live
            </span>
          ) : (
            <StatusPill status={data?.status || "offline"} />
          )
        }
      />

      {data ? (
        <section className="task-log-context" aria-label="Harbor job context">
          <span>
            <small>Experiment</small>
            <strong>{data.experimentId}</strong>
          </span>
          <span>
            <small>Evaluation arm</small>
            <strong>{humanize(data.arm)}</strong>
          </span>
          <span>
            <small>Panel attempt</small>
            <strong>{data.panelAttempt}</strong>
          </span>
          <span>
            <small>Last activity</small>
            <strong>{formatDate(data.updatedAt)}</strong>
          </span>
        </section>
      ) : null}

      {!logs.length ? (
        <EmptyState
          icon={Terminal}
          title="No task container logs yet"
          description="Streams appear here as soon as Harbor starts the first task trial."
        />
      ) : (
        <div className="logs-layout task-logs-layout">
          <aside className="log-index task-log-index">
            <div className="log-index-header">
              <span>Task containers</span>
              <small>{groups.filter((group) => group.key !== "job").length}</small>
            </div>
            {groups.map((group) => {
              const active = group.key === selectedGroup?.key;
              return (
                <button
                  key={group.key}
                  type="button"
                  className={active ? "active" : ""}
                  onClick={() => {
                    const next = preferredLog(group.logs);
                    if (next !== undefined) setSelectedId(next.id);
                  }}
                >
                  <Terminal size={16} />
                  <span>
                    <strong>{group.taskName || "Harbor job"}</strong>
                    <small>{group.trialName || "Combined runner output"}</small>
                  </span>
                  <span className="task-log-row-state">
                    <StatusPill status={group.status} />
                    {group.reward === null ? null : <em>reward {group.reward.toFixed(3)}</em>}
                  </span>
                </button>
              );
            })}
          </aside>
          <Section
            className="log-console task-log-console"
            title={selectedGroup?.taskName || "Harbor job"}
            description={
              selectedGroup?.trialName
                ? `${selectedGroup.trialName} · ${selectedGroup.logs.length} streams`
                : "Combined Harbor runner output"
            }
            action={<StatusPill status={selectedGroup?.status || "unknown"} />}
          >
            <TaskLogViewer
              campaignId={campaignId}
              logs={selectedGroup?.logs || []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </Section>
        </div>
      )}

      <div className="privacy-note task-log-privacy">
        <ShieldCheck size={17} />
        <p>
          Streams are restricted to allowlisted task outputs and are credential-redacted before they
          leave the local control API.
        </p>
      </div>
    </div>
  );
}
