"use client";

import {
  Beaker,
  CheckCircle2,
  CircleDollarSign,
  Code2,
  FileCode2,
  Fingerprint,
  FlaskConical,
  GitCommitHorizontal,
  Lightbulb,
  ListChecks,
  ScrollText,
  ShieldCheck,
  Target,
  XCircle,
} from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactViewer } from "../../../../../components/artifact-viewer";
import { HarborLiveProgress } from "../../../../../components/harbor-live-progress";
import { OptimizerAudit } from "../../../../../components/optimizer-audit";
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
} from "../../../../../components/ui";
import { useArtifacts, useExperiment } from "../../../../../lib/client/api";
import {
  formatCurrency,
  formatDate,
  formatDelta,
  formatDuration,
  formatPercent,
  humanize,
  shortRevision,
} from "../../../../../lib/client/format";

const tabs = [
  ["overview", "Overview", Beaker],
  ["optimizer", "Optimizer audit", Fingerprint],
  ["panel", "Panel", Target],
  ["runs", "Runs", FlaskConical],
  ["changes", "Changes", Code2],
  ["validation", "Validation", ListChecks],
  ["logs", "Logs", ScrollText],
  ["publication", "Publication", GitCommitHorizontal],
] as const;

type TabId = (typeof tabs)[number][0];

function isTabId(value: string | null): value is TabId {
  return tabs.some(([id]) => id === value);
}

export default function ExperimentDetailPage() {
  const params = useParams<{ campaignId: string; experimentId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const campaignId = decodeURIComponent(params.campaignId);
  const experimentId = decodeURIComponent(params.experimentId);
  const requestedTab = search.get("tab");
  const [tab, setTab] = useState<TabId>(isTabId(requestedTab) ? requestedTab : "overview");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const experiment = useExperiment(campaignId, experimentId);
  const artifacts = useArtifacts(campaignId, experimentId);
  const data = experiment.data;
  const observations = useMemo(
    () => [
      ...(data?.championEvaluation?.observations || []).map((item) => ({
        ...item,
        arm: "champion" as const,
      })),
      ...(data?.candidateEvaluation?.observations || []).map((item) => ({
        ...item,
        arm: "candidate" as const,
      })),
    ],
    [data?.championEvaluation?.observations, data?.candidateEvaluation?.observations],
  );
  const taskNames = useMemo(
    () => [...new Set(observations.map((observation) => observation.taskName))],
    [observations],
  );

  useEffect(() => {
    setTab(isTabId(requestedTab) ? requestedTab : "overview");
  }, [requestedTab]);

  const selectTab = (nextTab: TabId) => {
    setTab(nextTab);
    const nextSearch = new URLSearchParams(search.toString());
    if (nextTab === "overview") nextSearch.delete("tab");
    else nextSearch.set("tab", nextTab);
    const query = nextSearch.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex]?.[0];
    if (nextTab === undefined) return;
    selectTab(nextTab);
    tabRefs.current[nextIndex]?.focus();
  };

  if (experiment.isLoading) return <LoadingState label="Loading experiment evidence" />;
  if (experiment.error)
    return <ErrorState error={experiment.error} retry={() => void experiment.mutate()} />;
  if (!data)
    return (
      <EmptyState title="Experiment not found" description="Its durable receipt is unavailable." />
    );

  const decision = data.decision;
  const delta = decision?.meanRewardDelta ?? data.meanRewardDelta;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`Experiment ${data.experimentNumber ? String(data.experimentNumber).padStart(3, "0") : ""}`}
        title={data.experimentId}
        description={`Started ${formatDate(data.startedAt)} · champion ${shortRevision(data.championRevision)}`}
        actions={<StatusPill status={data.phase || "unknown"} />}
      />
      <section className="metrics-grid metrics-grid-4">
        <MetricCard
          label="Matched delta"
          value={formatDelta(delta)}
          detail="Candidate minus champion"
          icon={Target}
          tone={(delta || 0) > 0 ? "positive" : (delta || 0) < 0 ? "negative" : "default"}
        />
        <MetricCard
          label="Decision"
          value={humanize(decision?.disposition || data.disposition || "pending")}
          detail={humanize(decision?.reason || "Awaiting evidence")}
          icon={
            decision?.disposition === "promote"
              ? CheckCircle2
              : decision?.disposition === "reject"
                ? XCircle
                : ShieldCheck
          }
          tone={
            decision?.disposition === "promote"
              ? "positive"
              : decision?.disposition === "reject"
                ? "negative"
                : "default"
          }
        />
        <MetricCard
          label="Confidence"
          value={formatPercent(
            decision?.confidenceCandidateBetter ?? data.confidenceCandidateBetter,
          )}
          detail={`${formatPercent(decision?.requiredConfidence)} required`}
          icon={ShieldCheck}
        />
        <MetricCard
          label="Experiment cost"
          value={formatCurrency(data.costUsd)}
          detail={formatDuration(data.durationMs)}
          icon={CircleDollarSign}
        />
      </section>

      <div className="tabs" role="tablist" aria-label="Experiment evidence">
        {tabs.map(([id, label, Icon], index) => (
          <button
            type="button"
            role="tab"
            id={`experiment-tab-${id}`}
            aria-controls="experiment-panel"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "active" : ""}
            onClick={() => selectTab(id)}
            onKeyDown={(event) => moveTabFocus(event, index)}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            key={id}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      <div id="experiment-panel" role="tabpanel" aria-labelledby={`experiment-tab-${tab}`}>
        {tab === "overview" ? (
          <div className="detail-grid">
            <Section
              title="Optimizer hypothesis"
              description={data.optimizer?.hypothesisId || "No optimizer receipt yet"}
              className="span-2"
            >
              {data.optimizer ? (
                <div className="hypothesis-card">
                  <Lightbulb size={22} />
                  <div>
                    <h3>{data.optimizer.hypothesisSummary || "Hypothesis summary unavailable"}</h3>
                    <p>
                      {data.optimizer.interventionSummary ||
                        "Intervention details will appear when the optimizer completes."}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="inline-empty">
                  <Lightbulb size={21} />
                  <div>
                    <strong>Optimizer phase pending</strong>
                    <p>The hypothesis is persisted after the optimizer returns.</p>
                  </div>
                </div>
              )}
            </Section>
            <Section title="Decision evidence">
              <div className="decision-summary">
                <KeyValue label="Champion mean">
                  {decision?.championMeanReward?.toFixed(3) ?? "—"}
                </KeyValue>
                <KeyValue label="Candidate mean">
                  {decision?.candidateMeanReward?.toFixed(3) ?? "—"}
                </KeyValue>
                <KeyValue label="Task W / L / T">
                  {decision
                    ? `${decision.taskWins || 0} / ${decision.taskLosses || 0} / ${decision.taskTies || 0}`
                    : "—"}
                </KeyValue>
                <ProgressBar
                  value={(decision?.confidenceCandidateBetter || 0) * 100}
                  tone={
                    (decision?.confidenceCandidateBetter || 0) >=
                    (decision?.requiredConfidence || 0.95)
                      ? "positive"
                      : "default"
                  }
                  label="Candidate superiority confidence"
                />
              </div>
            </Section>
            <Section title="Candidate" className="span-2">
              {data.candidate ? (
                <div className="candidate-summary">
                  <div
                    className={`candidate-validity ${data.candidate.valid ? "valid" : "invalid"}`}
                  >
                    {data.candidate.valid ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
                    <strong>
                      {data.candidate.valid ? "Validation passed" : "Candidate invalid"}
                    </strong>
                    <span>
                      {data.candidate.invalidReason ||
                        `${data.candidate.changedFiles?.length || 0} files changed`}
                    </span>
                  </div>
                  <div className="file-chips">
                    {data.candidate.changedFiles?.map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="inline-empty">
                  <FileCode2 size={21} />
                  <div>
                    <strong>No candidate yet</strong>
                    <p>Code evidence appears after the optimizer phase.</p>
                  </div>
                </div>
              )}
            </Section>
          </div>
        ) : null}

        {tab === "panel" ? (
          <Section
            title="Panel screening"
            description="Candidate tasks are accepted only when the champion leaves measurable headroom."
          >
            {data.harborProgress ? <HarborLiveProgress progress={data.harborProgress} /> : null}
            {data.panelAttempts?.length ? (
              <div className="panel-attempts">
                {data.panelAttempts.map((attempt) => (
                  <article key={attempt.ordinal} className="attempt-card">
                    <div>
                      <span>Attempt {attempt.ordinal}</span>
                      <StatusPill status={attempt.disposition} />
                    </div>
                    <strong>{attempt.championMeanReward?.toFixed(3) ?? "—"} champion mean</strong>
                    <p>Saturation pressure {formatPercent(attempt.saturationPressure)}</p>
                    <div className="task-chip-row">
                      {attempt.selectedTasks?.map((task) => (
                        <span key={task.name}>
                          {task.name}
                          <small>{task.difficulty}</small>
                        </span>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ) : data.harborProgress ? null : (
              <EmptyState
                title="Panel evidence pending"
                description="Screening attempts will appear as the runner searches for a surpassable task panel."
              />
            )}
          </Section>
        ) : null}

        {tab === "optimizer" ? (
          <OptimizerAudit
            campaignId={campaignId}
            experimentId={experimentId}
            audit={data.optimizerAudit}
            optimizer={data.optimizer}
            artifacts={artifacts.data || data.artifacts || []}
          />
        ) : null}

        {tab === "runs" ? (
          <Section
            title="Matched observations"
            description={`${observations.length} persisted trial observations across ${taskNames.length} tasks`}
          >
            {observations.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Arm</th>
                      <th>Rep</th>
                      <th>Reward</th>
                      <th>Duration</th>
                      <th>Tokens</th>
                      <th>Cost</th>
                      <th>Infra</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map((run) => (
                      <tr key={`${run.arm}-${run.taskName}-${run.repetition}`}>
                        <td>
                          <strong>{run.taskName}</strong>
                        </td>
                        <td>
                          <StatusPill status={run.arm} />
                        </td>
                        <td>{run.repetition}</td>
                        <td>{run.reward.toFixed(3)}</td>
                        <td>{formatDuration(run.durationMs)}</td>
                        <td>
                          {(
                            (run.inputTokens || 0) +
                            (run.cacheTokens || 0) +
                            (run.outputTokens || 0)
                          ).toLocaleString()}
                        </td>
                        <td>{formatCurrency(run.costUsd)}</td>
                        <td>
                          {run.infrastructureValid ? (
                            <span className="text-positive">Valid</span>
                          ) : (
                            <span className="text-negative">Invalid</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="Runs are not complete"
                description="Trial-level evidence appears after evaluator receipts are safely scrubbed."
              />
            )}
          </Section>
        ) : null}

        {tab === "changes" ? (
          <Section
            title="Code modifications"
            description={`${data.candidate?.changedFiles?.length || 0} changed files · sanitized patch`}
          >
            <ArtifactViewer
              campaignId={campaignId}
              experimentId={experimentId}
              artifacts={artifacts.data || data.artifacts || []}
              preferredCategory="code"
            />
          </Section>
        ) : null}
        {tab === "validation" ? (
          <Section
            title="Candidate validation"
            description="Commands executed before candidate evaluation"
          >
            {data.validationCommands?.length ? (
              <div className="validation-list">
                {data.validationCommands.map((command) => (
                  <div
                    key={`${command.command}-${command.exitCode}-${command.durationMs}-${command.logArtifactId || ""}`}
                  >
                    <span
                      className={
                        command.exitCode === 0 ? "validation-icon pass" : "validation-icon fail"
                      }
                    >
                      {command.exitCode === 0 ? <CheckCircle2 size={17} /> : <XCircle size={17} />}
                    </span>
                    <code>{command.command}</code>
                    <span>exit {command.exitCode}</span>
                    <span>{formatDuration(command.durationMs)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No validation receipt yet"
                description="Validation commands and logs appear after a candidate is produced."
              />
            )}
          </Section>
        ) : null}
        {tab === "logs" ? (
          <Section
            title="Experiment logs"
            description="Sanitized output streamed from protected local artifacts"
          >
            <ArtifactViewer
              campaignId={campaignId}
              experimentId={experimentId}
              artifacts={artifacts.data || data.artifacts || []}
              preferredCategory="evaluation"
            />
          </Section>
        ) : null}
        {tab === "publication" ? (
          <Section
            title="Champion publication"
            description="Git publication occurs only after a verified promotion decision."
          >
            {data.publication ? (
              <div className="publication-card">
                <GitCommitHorizontal size={26} />
                <div>
                  <StatusPill status={data.publication.status || "published"} />
                  <h3>Champion committed and pushed</h3>
                  <p>Publication receipt verified against the durable experiment decision.</p>
                </div>
                <div>
                  <KeyValue label="Commit" mono>
                    {shortRevision(data.publication.commit)}
                  </KeyValue>
                  <KeyValue label="Experiment ref" mono>
                    {data.publication.experimentRef || "—"}
                  </KeyValue>
                  <KeyValue label="Champion ref" mono>
                    {data.publication.championRef || "—"}
                  </KeyValue>
                </div>
              </div>
            ) : (
              <EmptyState
                title="No publication receipt"
                description={
                  decision?.disposition === "promote"
                    ? "The decision is promoted; publication may still be in progress."
                    : "Rejected and inconclusive candidates are never published."
                }
              />
            )}
          </Section>
        ) : null}
      </div>
    </div>
  );
}
