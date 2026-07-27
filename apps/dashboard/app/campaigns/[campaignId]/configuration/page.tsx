"use client";

import { Bot, Database, GitBranch, KeyRound, Server, ShieldCheck } from "lucide-react";
import { useParams } from "next/navigation";
import {
  ErrorState,
  KeyValue,
  LoadingState,
  PageHeader,
  Section,
  StatusPill,
} from "../../../../components/ui";
import { useCampaign } from "../../../../lib/client/api";
import { formatCurrency, shortRevision } from "../../../../lib/client/format";

export default function ConfigurationPage() {
  const { campaignId: encodedId } = useParams<{ campaignId: string }>();
  const campaignId = decodeURIComponent(encodedId);
  const campaign = useCampaign(campaignId);
  if (campaign.isLoading) return <LoadingState label="Loading effective configuration" />;
  if (campaign.error)
    return <ErrorState error={campaign.error} retry={() => void campaign.mutate()} />;
  const data = campaign.data;
  const config = data?.config;
  const flat = data?.configuration;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Effective configuration"
        title="Campaign configuration"
        description="A read-only, secret-safe projection of the durable settings used by the local runner."
      />
      <div className="config-grid">
        <Section title="Source & publication" description="Harness repository and champion lineage">
          <div className="config-icon">
            <GitBranch size={20} />
          </div>
          <KeyValue label="Origin" mono>
            {flat?.piOrigin || config?.piOrigin || "—"}
          </KeyValue>
          <KeyValue label="Baseline" mono>
            {shortRevision(data?.baselineRevision)}
          </KeyValue>
          <KeyValue label="Remote">
            {flat?.publicationRemote || config?.publication?.remoteName || "origin"}
          </KeyValue>
          <KeyValue label="Publication">
            <StatusPill
              status={
                (flat?.publicationEnabled ?? config?.publication?.enabled) === false
                  ? "disabled"
                  : "enabled"
              }
            />
          </KeyValue>
        </Section>
        <Section title="Optimizer" description="Candidate proposal agent">
          <div className="config-icon purple">
            <Bot size={20} />
          </div>
          <KeyValue label="Provider">{config?.optimizer?.provider || "microsoft-foundry"}</KeyValue>
          <KeyValue label="Deployment">
            {flat?.optimizerDeployment || config?.optimizer?.deployment || "claude-opus-5"}
          </KeyValue>
          <KeyValue label="Effort">{config?.optimizer?.effort || "high"}</KeyValue>
          <KeyValue label="Per-run limit">
            {formatCurrency(flat?.optimizerMaximumCostUsd ?? config?.optimizer?.maximumCostUsd)}
          </KeyValue>
          <KeyValue label="Maximum turns">
            {flat?.optimizerMaximumTurns || config?.optimizer?.maximumTurns || "—"}
          </KeyValue>
        </Section>
        <Section title="Evaluated agent" description="Pi task execution model">
          <div className="config-icon green">
            <Server size={20} />
          </div>
          <KeyValue label="Provider">
            {config?.evaluatedAgent?.provider || "microsoft-foundry"}
          </KeyValue>
          <KeyValue label="Deployment">
            {flat?.evaluatedDeployment || config?.evaluatedAgent?.deployment || "claude-opus-4-8"}
          </KeyValue>
          <KeyValue label="Thinking">{config?.evaluatedAgent?.thinking || "high"}</KeyValue>
          <KeyValue label="Credentials">
            <span className="secure-value">
              <ShieldCheck size={14} />
              Protected local file
            </span>
          </KeyValue>
        </Section>
        <Section title="Evaluation harness" description="Matched Terminal-Bench execution">
          <div className="config-icon cyan">
            <Database size={20} />
          </div>
          <KeyValue label="Harbor">{config?.evaluation?.harborVersion || "0.20.0"}</KeyValue>
          <KeyValue label="Dataset">
            {config?.evaluation?.datasetName || "terminal-bench"}{" "}
            {config?.evaluation?.datasetVersion || "2.0"}
          </KeyValue>
          <KeyValue label="Concurrency">
            {flat?.evaluationConcurrency || config?.evaluation?.concurrency || 5}
          </KeyValue>
          <KeyValue label="Panel attempts">
            {flat?.maximumPanelAttempts || config?.evaluation?.maximumPanelAttempts || "—"}
          </KeyValue>
          <KeyValue label="Infra retries">
            {config?.evaluation?.maximumInfrastructureRetries || "—"}
          </KeyValue>
        </Section>
      </div>
      <div className="privacy-note">
        <KeyRound size={18} />
        <p>
          The credential filename may be displayed, but its contents, API key, and authorization
          headers are excluded from all dashboard projections and artifacts.
        </p>
      </div>
    </div>
  );
}
