"use client";

import {
  Activity,
  ArrowRight,
  Beaker,
  CircleDollarSign,
  GitBranch,
  Plus,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { ErrorState, LoadingState, PageHeader, StatusPill } from "../../components/ui";
import { useCampaigns } from "../../lib/client/api";
import { formatCurrency, formatDate, formatPercent, shortRevision } from "../../lib/client/format";

export default function CampaignsPage() {
  const { data, error, isLoading, mutate } = useCampaigns();

  if (isLoading) return <LoadingState label="Discovering local campaigns" />;
  if (error) return <ErrorState error={error} retry={() => void mutate()} />;

  const campaigns = data || [];
  const running = campaigns.filter((campaign) =>
    ["running", "starting", "stopping", "stop-requested"].includes(campaign.operationalStatus),
  ).length;
  const totalExperiments = campaigns.reduce(
    (total, campaign) => total + (campaign.completedExperiments || 0),
    0,
  );
  const totalPromotions = campaigns.reduce(
    (total, campaign) => total + (campaign.promotions || 0),
    0,
  );
  const totalSpend = campaigns.reduce((total, campaign) => total + (campaign.totalCostUsd || 0), 0);

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Portfolio"
        title="Optimization campaigns"
        description="Operate local optimization loops and inspect the evidence behind every decision."
        actions={
          <Link className="button button-primary" href="/campaigns/new">
            <Plus size={16} />
            New campaign
          </Link>
        }
      />

      {campaigns.length === 0 ? (
        <section className="hero-empty">
          <div className="hero-grid" />
          <div className="hero-empty-copy">
            <div className="hero-kicker">
              <Sparkles size={15} />
              Local-first agent optimization
            </div>
            <h2>Turn the optimizer on—with every decision visible.</h2>
            <p>
              Create your first campaign to track hypotheses, matched evaluations, code
              modifications, cost, and champion promotions from one secure console.
            </p>
            <Link className="button button-primary button-large" href="/campaigns/new">
              Create first campaign
              <ArrowRight size={17} />
            </Link>
            <div className="hero-assurances">
              <span>Explicit start</span>
              <span>Local artifacts</span>
              <span>Two-level stop</span>
            </div>
          </div>
          <div className="hero-signal" aria-hidden="true">
            <span className="preview-label">Illustrative preview</span>
            <div className="signal-card">
              <span>Matched delta</span>
              <strong>+8.4 pp</strong>
              <i className="signal-line" />
            </div>
            <div className="signal-card signal-card-secondary">
              <span>Decision</span>
              <strong>Promote</strong>
              <i className="signal-glow" />
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="portfolio-strip">
            <div>
              <Activity size={18} />
              <span>Active</span>
              <strong>{running}</strong>
            </div>
            <div>
              <Beaker size={18} />
              <span>Experiments</span>
              <strong>{totalExperiments}</strong>
            </div>
            <div>
              <GitBranch size={18} />
              <span>Promotions</span>
              <strong>{totalPromotions}</strong>
            </div>
            <div>
              <CircleDollarSign size={18} />
              <span>Lifetime spend</span>
              <strong>{formatCurrency(totalSpend)}</strong>
            </div>
          </section>

          <section className="campaign-grid">
            {campaigns.map((campaign) => {
              const budgetUsed =
                campaign.maximumCampaignCostUsd && campaign.maximumCampaignCostUsd > 0
                  ? (campaign.totalCostUsd || 0) / campaign.maximumCampaignCostUsd
                  : null;
              return (
                <Link
                  className="campaign-card"
                  href={`/campaigns/${encodeURIComponent(campaign.campaignId)}`}
                  key={campaign.campaignId}
                >
                  <div className="campaign-card-top">
                    <div className="campaign-glyph">
                      {campaign.campaignId.slice(0, 2).toUpperCase()}
                    </div>
                    <StatusPill status={campaign.operationalStatus} />
                  </div>
                  <h2>{campaign.campaignId}</h2>
                  <p className="campaign-revision">
                    Champion <code>{shortRevision(campaign.championRevision)}</code>
                  </p>
                  {campaign.activeExperiment ? (
                    <div className="campaign-now">
                      <span className="pulse" />
                      <span>
                        Experiment {campaign.activeExperiment.experimentNumber || "—"} ·{" "}
                        {campaign.activeExperiment.phase || "working"}
                      </span>
                    </div>
                  ) : (
                    <div className="campaign-now muted">No active experiment</div>
                  )}
                  <div className="campaign-stats">
                    <div>
                      <span>Experiments</span>
                      <strong>{campaign.completedExperiments || 0}</strong>
                    </div>
                    <div>
                      <span>Promotions</span>
                      <strong>{campaign.promotions || 0}</strong>
                    </div>
                    <div>
                      <span>Saturation</span>
                      <strong>{formatPercent(campaign.saturationRate)}</strong>
                    </div>
                  </div>
                  <div className="campaign-budget">
                    <div>
                      <span>Campaign spend</span>
                      <strong>
                        {formatCurrency(campaign.totalCostUsd)}
                        {campaign.maximumCampaignCostUsd
                          ? ` / ${formatCurrency(campaign.maximumCampaignCostUsd)}`
                          : " · unbounded"}
                      </strong>
                    </div>
                    <div className="progress">
                      <span
                        style={{
                          width: `${Math.min(100, Math.max(2, (budgetUsed || 0) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="campaign-card-footer">
                    <span>Updated {formatDate(campaign.updatedAt)}</span>
                    <ArrowRight size={17} />
                  </div>
                </Link>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
