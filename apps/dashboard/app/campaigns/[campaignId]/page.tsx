"use client";

import {
  Activity,
  ArrowRight,
  Beaker,
  CircleDollarSign,
  Clock3,
  Gauge,
  GitBranch,
  Info,
  ShieldAlert,
  Sparkles,
  Target,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CampaignControls } from "../../../components/campaign-controls";
import { ExperimentsTable } from "../../../components/experiments-table";
import { HarborLiveProgress } from "../../../components/harbor-live-progress";
import {
  EmptyState,
  ErrorState,
  KeyValue,
  LoadingState,
  MetricCard,
  PageHeader,
  ProgressBar,
  Section,
  StatusPill,
} from "../../../components/ui";
import { useCampaign, useExperiments } from "../../../lib/client/api";
import {
  formatCurrency,
  formatDate,
  formatPercent,
  humanize,
  shortRevision,
} from "../../../lib/client/format";

export default function CampaignOverviewPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const campaign = useCampaign(campaignId);
  const experiments = useExperiments(campaignId);

  if (campaign.isLoading) return <LoadingState label="Loading campaign control state" />;
  if (campaign.error)
    return <ErrorState error={campaign.error} retry={() => void campaign.mutate()} />;
  if (!campaign.data)
    return (
      <EmptyState
        title="Campaign not found"
        description="This campaign may have been removed or its local state is unavailable."
        actionHref="/campaigns"
        actionLabel="Return to campaigns"
      />
    );

  const data = campaign.data;
  const budget =
    data.maximumCampaignCostUsd && data.maximumCampaignCostUsd > 0
      ? {
          ratio: (data.totalCostUsd || 0) / data.maximumCampaignCostUsd,
          label: `${formatCurrency(data.totalCostUsd)} of ${formatCurrency(data.maximumCampaignCostUsd)}`,
        }
      : null;
  const isRunning = ["running", "starting", "stopping", "stop-requested"].includes(
    data.operationalStatus,
  );
  const optimizerActive = data.activeExperiment?.phase === "optimizer";
  const activeEvidenceHref = optimizerActive
    ? `/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(data.activeExperiment?.experimentId ?? "")}?tab=optimizer`
    : `/campaigns/${encodeURIComponent(campaignId)}/logs`;
  const recent = (experiments.data || data.recentExperiments || []).slice(0, 5);
  const idleTitle =
    data.operationalStatus === "blocked"
      ? "Campaign blocked"
      : data.operationalStatus === "interrupted"
        ? "Runner interrupted"
        : data.stopReason
          ? "Campaign stopped"
          : "Campaign ready";
  const idleDescription =
    data.operationalStatus === "blocked"
      ? "Resolve the blocking condition before resuming"
      : data.operationalStatus === "interrupted"
        ? "Review durable evidence before resuming"
        : data.stopReason
          ? humanize(data.stopReason)
          : "Start continuously or run one controlled experiment";

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Campaign control"
        title={data.campaignId}
        description={`Champion ${shortRevision(data.championRevision)} · updated ${formatDate(data.updatedAt)}`}
        actions={<CampaignControls campaign={data} />}
      />

      {data.operationalStatus === "interrupted" ? (
        <div className="alert-banner warning">
          <ShieldAlert size={19} />
          <div>
            <strong>The runner is not live</strong>
            <span>
              Durable state says this campaign was running, but no live owner process was found.
              Review logs, then resume when ready.
            </span>
          </div>
        </div>
      ) : null}
      {data.operationalStatus === "blocked" ? (
        <div className="alert-banner danger">
          <ShieldAlert size={19} />
          <div>
            <strong>Campaign blocked</strong>
            <span>
              {data.blockedReason || "The runner requires intervention before it can resume."}
            </span>
          </div>
        </div>
      ) : null}
      {data.stopReason && !isRunning ? (
        <div className="alert-banner subtle">
          <Info size={18} />
          <div>
            <strong>Campaign stopped</strong>
            <span>{humanize(data.stopReason)}</span>
          </div>
        </div>
      ) : null}

      <section className="metrics-grid metrics-grid-4">
        <MetricCard
          label="Operational state"
          value={<StatusPill status={data.operationalStatus} />}
          detail={isRunning ? "Runner process is supervised" : "No active model usage"}
          icon={Activity}
        />
        <MetricCard
          label="Completed experiments"
          value={data.completedExperiments || 0}
          detail={`${data.promotions || 0} champion promotions`}
          icon={Beaker}
        />
        <MetricCard
          label="Campaign spend"
          value={formatCurrency(data.totalCostUsd)}
          detail={
            data.maximumCampaignCostUsd
              ? `${formatCurrency(Math.max(0, data.maximumCampaignCostUsd - (data.totalCostUsd || 0)))} remaining`
              : "Unbounded budget"
          }
          icon={CircleDollarSign}
          tone={!data.maximumCampaignCostUsd ? "warning" : "default"}
        />
        <MetricCard
          label="Panel saturation"
          value={formatPercent(data.saturationRate)}
          detail="Recent panel attempts"
          icon={Target}
          tone={(data.saturationRate || 0) > 0.5 ? "warning" : "default"}
        />
      </section>

      <div className="overview-grid">
        <Section
          className="active-run-card"
          title={data.activeExperiment ? "Active experiment" : idleTitle}
          description={
            data.activeExperiment ? "Current phase and durable progress" : idleDescription
          }
        >
          {data.activeExperiment ? (
            <div className="active-run">
              <div className="active-run-head">
                <div className="run-orbit">
                  <span />
                  <Sparkles size={22} />
                </div>
                <div>
                  <span>Experiment {data.activeExperiment.experimentNumber || "—"}</span>
                  <strong>{data.activeExperiment.experimentId}</strong>
                </div>
                <StatusPill status={data.activeExperiment.phase || "working"} />
              </div>
              <div className="phase-track">
                {[
                  "panel-screening",
                  "optimizer",
                  "candidate-validation",
                  "candidate-evaluation",
                  "decision",
                  "publication",
                  "advance",
                ].map((phase) => {
                  const phases = [
                    "panel-screening",
                    "optimizer",
                    "candidate-validation",
                    "candidate-evaluation",
                    "decision",
                    "publication",
                    "advance",
                  ];
                  const current = phases.indexOf(data.activeExperiment?.phase || "");
                  const index = phases.indexOf(phase);
                  return (
                    <div
                      className={index === current ? "current" : index < current ? "complete" : ""}
                      key={phase}
                    >
                      <i>{index < current ? "✓" : index + 1}</i>
                      <span>{humanize(phase)}</span>
                    </div>
                  );
                })}
              </div>
              {data.harborProgress ? <HarborLiveProgress progress={data.harborProgress} /> : null}
              <div className="active-run-footer">
                <span>
                  <Clock3 size={15} />
                  Started {formatDate(data.activeExperiment.startedAt)}
                </span>
                <Link href={activeEvidenceHref}>
                  {optimizerActive ? "Track optimizer live" : "Follow live logs"}{" "}
                  <ArrowRight size={15} />
                </Link>
              </div>
            </div>
          ) : (
            <div className="ready-state">
              <div className="ready-symbol">
                <Gauge size={29} />
              </div>
              <div>
                <h3>The control loop is idle</h3>
                <p>
                  Starting launches a detached runner. You can close this browser without stopping
                  the campaign.
                </p>
              </div>
            </div>
          )}
        </Section>

        <Section title="Champion lineage" description="Current harness reference">
          <div className="champion-card">
            <div className="champion-revision">
              <GitBranch size={19} />
              <code>{shortRevision(data.championRevision)}</code>
              <span>current champion</span>
            </div>
            <div className="lineage-line">
              <i />
              <i />
              <i />
            </div>
            <KeyValue label="Baseline" mono>
              {shortRevision(data.baselineRevision)}
            </KeyValue>
            <KeyValue label="Promotions">{data.promotions || 0}</KeyValue>
            <KeyValue label="Publication">
              {(data.configuration?.publicationEnabled ?? data.config?.publication?.enabled) ===
              false
                ? "Disabled"
                : `Enabled · ${data.configuration?.publicationRemote || data.config?.publication?.remoteName || "origin"}`}
            </KeyValue>
          </div>
        </Section>
      </div>

      {budget ? (
        <Section title="Budget envelope" description="Hard ceiling checked before each experiment">
          <div className="budget-row">
            <div>
              <strong>{budget.label}</strong>
              <span>{formatPercent(budget.ratio)} consumed</span>
            </div>
            <ProgressBar
              value={budget.ratio * 100}
              tone={budget.ratio > 0.9 ? "negative" : budget.ratio > 0.7 ? "warning" : "positive"}
              label="Campaign budget consumed"
            />
          </div>
        </Section>
      ) : (
        <div className="alert-banner subtle">
          <Info size={18} />
          <div>
            <strong>Unbounded budget</strong>
            <span>This campaign continues until you stop it manually.</span>
          </div>
        </div>
      )}

      <Section
        title="Recent experiments"
        description="Matched candidate-versus-champion evidence"
        action={
          <Link
            className="text-link"
            href={`/campaigns/${encodeURIComponent(campaignId)}/experiments`}
          >
            View all <ArrowRight size={15} />
          </Link>
        }
      >
        {experiments.isLoading ? (
          <LoadingState label="Loading experiment history" />
        ) : recent.length ? (
          <ExperimentsTable campaignId={campaignId} experiments={recent} compact />
        ) : (
          <div className="inline-empty">
            <Beaker size={22} />
            <div>
              <strong>No experiment evidence yet</strong>
              <p>Start the campaign to create the first matched evaluation.</p>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
