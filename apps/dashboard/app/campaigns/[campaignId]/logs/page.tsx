"use client";

import { FileText, Radio, ScrollText } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArtifactViewer } from "../../../../components/artifact-viewer";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Section,
  StatusPill,
} from "../../../../components/ui";
import { useArtifacts, useCampaign, useExperiments } from "../../../../lib/client/api";
import { formatDate } from "../../../../lib/client/format";

function LogConsole({ campaignId, experimentId }: { campaignId: string; experimentId: string }) {
  const artifacts = useArtifacts(campaignId, experimentId);
  if (artifacts.isLoading) return <LoadingState label="Discovering sanitized logs" />;
  if (artifacts.error)
    return <ErrorState error={artifacts.error} retry={() => void artifacts.mutate()} />;
  const logs = (artifacts.data || []).filter(
    (artifact) =>
      artifact.category === "optimizer" ||
      artifact.category === "validation" ||
      artifact.category === "evaluation" ||
      artifact.contentType === "text/plain",
  );
  return (
    <ArtifactViewer
      campaignId={campaignId}
      experimentId={experimentId}
      artifacts={logs}
      initiallyFollow
    />
  );
}

export default function LogsPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const campaign = useCampaign(campaignId);
  const experiments = useExperiments(campaignId);
  const defaultId =
    campaign.data?.activeExperiment?.experimentId || experiments.data?.[0]?.experimentId || "";
  const [selection, setSelection] = useState("");
  const selected = selection || defaultId;
  const chosen = useMemo(
    () => experiments.data?.find((item) => item.experimentId === selected),
    [experiments.data, selected],
  );

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Operational stream"
        title="Logs"
        description="Sanitized optimizer, validation, and evaluation output from protected local artifacts."
        actions={
          campaign.data?.runnerLive ? (
            <span className="live-badge">
              <Radio size={15} />
              Runner live
            </span>
          ) : (
            <StatusPill status={campaign.data?.operationalStatus || "offline"} />
          )
        }
      />
      {experiments.isLoading ? <LoadingState label="Loading log index" /> : null}
      {experiments.error ? (
        <ErrorState error={experiments.error} retry={() => void experiments.mutate()} />
      ) : null}
      {!experiments.isLoading && !experiments.data?.length ? (
        <EmptyState
          icon={ScrollText}
          title="No campaign logs yet"
          description="Runner output will appear here as soon as the first experiment starts."
        />
      ) : null}
      {experiments.data?.length ? (
        <div className="logs-layout">
          <aside className="log-index">
            <div className="log-index-header">
              <span>Experiment streams</span>
              <small>{experiments.data.length}</small>
            </div>
            {experiments.data.map((experiment) => (
              <button
                key={experiment.experimentId}
                type="button"
                className={selected === experiment.experimentId ? "active" : ""}
                onClick={() => setSelection(experiment.experimentId)}
              >
                <FileText size={16} />
                <span>
                  <strong>{experiment.experimentId}</strong>
                  <small>{formatDate(experiment.completedAt || experiment.startedAt)}</small>
                </span>
                <StatusPill status={experiment.phase || "unknown"} />
              </button>
            ))}
            {experiments.hasMore ? (
              <div className="log-index-footer">
                <button
                  type="button"
                  disabled={experiments.isLoadingMore}
                  onClick={() => void experiments.loadMore()}
                >
                  {experiments.isLoadingMore ? "Loading older…" : "Load older streams"}
                </button>
              </div>
            ) : null}
          </aside>
          <Section
            className="log-console"
            title={chosen?.experimentId || selected}
            description={chosen?.phase ? `Recorded phase: ${chosen.phase}` : "Experiment artifacts"}
          >
            <LogConsole campaignId={campaignId} experimentId={selected} />
          </Section>
        </div>
      ) : null}
      <div className="privacy-note">
        <span>REDACTED</span>
        <p>
          Credential values and raw provider configuration are never returned. Structured API
          responses omit worktree and evaluator-job paths; retained process logs are
          credential-redacted.
        </p>
      </div>
    </div>
  );
}
