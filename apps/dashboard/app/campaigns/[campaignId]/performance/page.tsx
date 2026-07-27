"use client";

import { BarChart3, CircleDollarSign, GitBranch, Target, TrendingUp } from "lucide-react";
import { useParams } from "next/navigation";
import {
  CostChart,
  ImprovementChart,
  PairedRewardsChart,
} from "../../../../components/performance-charts";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  Section,
} from "../../../../components/ui";
import { useCampaign, usePerformance } from "../../../../lib/client/api";
import { formatCurrency, formatDelta, formatPercent } from "../../../../lib/client/format";

export default function PerformancePage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const performance = usePerformance(campaignId);
  const campaign = useCampaign(campaignId);
  if (performance.isLoading) return <LoadingState label="Building matched performance history" />;
  if (performance.error)
    return <ErrorState error={performance.error} retry={() => void performance.mutate()} />;
  const points = performance.data || [];
  const comparable = points.filter((point) => point.meanRewardDelta != null);
  const latest = comparable.at(-1);
  const promotions = points.filter((point) => point.promoted).length;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Matched evidence"
        title="Harness performance"
        description="Improvement is shown only within each experiment’s identical task panel—never as a misleading cross-panel score."
      />
      {!points.length ? (
        <EmptyState
          icon={BarChart3}
          title="No comparable performance yet"
          description="Performance charts appear after the first candidate and champion complete the same accepted panel."
        />
      ) : (
        <>
          <section className="metrics-grid metrics-grid-4">
            <MetricCard
              label="Latest matched delta"
              value={formatDelta(latest?.meanRewardDelta)}
              detail={latest ? `Experiment ${latest.experimentNumber || "—"}` : "No matched result"}
              icon={TrendingUp}
              tone={(latest?.meanRewardDelta || 0) > 0 ? "positive" : "default"}
            />
            <MetricCard
              label="Latest candidate mean"
              value={
                latest?.candidateMeanReward == null ? "—" : latest.candidateMeanReward.toFixed(3)
              }
              detail={
                latest
                  ? `Same-panel reward · experiment ${latest.experimentNumber || "—"}`
                  : "No matched result"
              }
              icon={Target}
            />
            <MetricCard
              label="Champion promotions"
              value={promotions}
              detail={`${formatPercent(points.length ? promotions / points.length : 0)} of experiments`}
              icon={GitBranch}
            />
            <MetricCard
              label="Cumulative spend"
              value={formatCurrency(
                points.at(-1)?.cumulativeCostUsd ?? campaign.data?.totalCostUsd,
              )}
              detail="Optimizer + validation + evaluation"
              icon={CircleDollarSign}
            />
          </section>
          <Section
            title="Matched reward delta"
            description="Candidate minus champion on the same five tasks and repetitions. Green-ring markers denote promotions."
          >
            <ImprovementChart points={points} />
            <div className="chart-footnote">
              <span>
                <i className="legend-line cyan" />
                Matched delta
              </span>
              <span>
                <i className="legend-dot green" />
                Promoted
              </span>
              <span>Panel changes create a new comparison context.</span>
            </div>
          </Section>
          <div className="chart-grid">
            <Section
              title="Paired mean rewards"
              description="Within-experiment candidate and champion means"
            >
              <PairedRewardsChart points={points} />
            </Section>
            <Section
              title="Cumulative model spend"
              description="Persisted cost ledger across completed experiments"
            >
              <CostChart points={points} />
            </Section>
          </div>
        </>
      )}
    </div>
  );
}
