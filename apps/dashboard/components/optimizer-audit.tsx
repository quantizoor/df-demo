"use client";

import {
  Bot,
  EyeOff,
  FileText,
  Fingerprint,
  FolderGit2,
  KeyRound,
  LockKeyhole,
  ShieldAlert,
  Terminal,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  formatCurrency,
  formatDate,
  formatDuration,
  humanize,
  shortRevision,
} from "../lib/client/format";
import type {
  ArtifactDescriptor,
  ExperimentDetail,
  OptimizerAuditAttempt,
  OptimizerAudit as OptimizerAuditData,
  OptimizerEnvironmentEntry,
} from "../lib/client/types";
import { ArtifactViewer } from "./artifact-viewer";
import { KeyValue, Section, StatusPill } from "./ui";

const SENSITIVE_ENVIRONMENT_NAME =
  /(api.?key|authorization|cookie|credential|password|secret|token)/iu;

const boundaryLabels = [
  ["taskCatalogVisible", "Task catalog"],
  ["panelVisible", "Selected task panel"],
  ["graderVisible", "Grader materials"],
  ["rawEvaluationVisible", "Raw evaluation data"],
] as const;

function protectedEnvironmentValue(entry: OptimizerEnvironmentEntry): string {
  if (
    entry.secret ||
    (SENSITIVE_ENVIRONMENT_NAME.test(entry.name) && !/_PRESENT$/u.test(entry.name))
  ) {
    return "Protected — value not retained";
  }
  return entry.value ?? "Not set";
}

function booleanLabel(value?: boolean): string {
  if (value === undefined) return "Not recorded";
  return value ? "Enabled" : "Disabled";
}

function protectedRepositoryOrigin(value?: string): string {
  if (!value) return "—";
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
    }
    return url.toString();
  } catch {
    return value.replace(/:\/\/[^/@\s]+@/u, "://[redacted]@");
  }
}

function attemptArtifacts(
  artifacts: ArtifactDescriptor[],
  attempts: OptimizerAuditAttempt[],
  selectedAttempt?: OptimizerAuditAttempt,
): ArtifactDescriptor[] {
  const safeIds = new Set(
    attempts.flatMap((attempt) =>
      [
        attempt.inputArtifactId,
        attempt.invocationArtifactId,
        attempt.transcriptArtifactId,
        attempt.stderrArtifactId,
      ].filter((id): id is string => Boolean(id)),
    ),
  );
  const selectedPriority = [
    selectedAttempt?.transcriptArtifactId,
    selectedAttempt?.inputArtifactId,
    selectedAttempt?.invocationArtifactId,
    selectedAttempt?.stderrArtifactId,
  ].filter((id): id is string => Boolean(id));

  return artifacts
    .filter((artifact) => safeIds.has(artifact.id) || artifact.category === "optimizer")
    .toSorted((left, right) => {
      const leftPriority = selectedPriority.indexOf(left.id);
      const rightPriority = selectedPriority.indexOf(right.id);
      if (leftPriority >= 0 || rightPriority >= 0) {
        return (
          (leftPriority < 0 ? Number.MAX_SAFE_INTEGER : leftPriority) -
          (rightPriority < 0 ? Number.MAX_SAFE_INTEGER : rightPriority)
        );
      }
      return left.label.localeCompare(right.label);
    });
}

function BoundaryValue({ value }: { value?: boolean | null }) {
  if (value === null || value === undefined) return <StatusPill status="not recorded" />;
  return <StatusPill status={value ? "exposed" : "not exposed"} />;
}

export function OptimizerAudit({
  campaignId,
  experimentId,
  audit,
  optimizer,
  artifacts,
}: {
  campaignId: string;
  experimentId: string;
  audit?: OptimizerAuditData | null;
  optimizer?: ExperimentDetail["optimizer"];
  artifacts: ArtifactDescriptor[];
}) {
  const attempts = audit?.attempts ?? [];
  const latestOrdinal = audit?.latestAttemptOrdinal ?? attempts.at(-1)?.ordinal ?? null;
  const [selectedOrdinal, setSelectedOrdinal] = useState<number | null>(latestOrdinal);

  useEffect(() => {
    if (
      selectedOrdinal === null ||
      !attempts.some((attempt) => attempt.ordinal === selectedOrdinal)
    ) {
      setSelectedOrdinal(latestOrdinal);
    }
  }, [attempts, latestOrdinal, selectedOrdinal]);

  const selectedAttempt =
    attempts.find((attempt) => attempt.ordinal === selectedOrdinal) ??
    attempts.find((attempt) => attempt.ordinal === latestOrdinal) ??
    attempts.at(-1);
  const visibleArtifacts = useMemo(
    () => attemptArtifacts(artifacts, attempts, selectedAttempt),
    [artifacts, attempts, selectedAttempt],
  );

  if (!selectedAttempt) {
    return (
      <Section
        title="Optimizer audit"
        description="Exact task-blind inputs, execution policy, and model actions"
      >
        <div className="inline-empty optimizer-audit-pending">
          <Bot size={22} />
          <div>
            <strong>Optimizer attempt pending</strong>
            <p>
              The audit trail starts when the campaign enters the optimizer phase. No optimizer
              process has received a prompt for this experiment yet.
            </p>
          </div>
        </div>
      </Section>
    );
  }

  const contract = selectedAttempt.executionContract;
  const source = selectedAttempt.sourceContext;
  const promptEnforced = source?.restrictionsEnforcedBy?.toLowerCase().includes("prompt") ?? true;
  const promptDigest = selectedAttempt.promptSha256 || "Not recorded";
  const environment = selectedAttempt.environment ?? [];
  const disclosureNotes = audit?.disclosureNotes ?? [];
  const enforcementNote = disclosureNotes.find((note) => note.toLowerCase().includes("filesystem"));

  return (
    <div className="optimizer-audit-stack">
      <Section
        title="Optimizer audit"
        description="Exact non-secret context and capabilities recorded for this model invocation"
        action={
          <div className="optimizer-attempt-picker">
            <label htmlFor="optimizer-attempt">Attempt</label>
            <select
              id="optimizer-attempt"
              value={selectedAttempt.ordinal}
              onChange={(event) => setSelectedOrdinal(Number(event.target.value))}
            >
              {attempts
                .toSorted((left, right) => right.ordinal - left.ordinal)
                .map((attempt) => (
                  <option key={attempt.ordinal} value={attempt.ordinal}>
                    {String(attempt.ordinal).padStart(3, "0")} · {humanize(attempt.status)}
                  </option>
                ))}
            </select>
            <StatusPill status={selectedAttempt.status || "unknown"} />
          </div>
        }
      >
        <div className="optimizer-audit-summary">
          <article>
            <Fingerprint size={18} />
            <span>Prompt fingerprint</span>
            <strong title={promptDigest}>{promptDigest.slice(0, 16)}</strong>
          </article>
          <article>
            <Bot size={18} />
            <span>Model</span>
            <strong>{contract?.model || optimizer?.model || "Not recorded"}</strong>
          </article>
          <article>
            <Terminal size={18} />
            <span>Turns used</span>
            <strong>
              {optimizer?.turns ?? "—"}
              {contract?.maximumTurns !== undefined ? ` / ${contract.maximumTurns}` : ""}
            </strong>
          </article>
          <article>
            <KeyRound size={18} />
            <span>Credential handling</span>
            <strong>{audit?.credentialValuesRedacted === false ? "Unverified" : "Redacted"}</strong>
          </article>
        </div>
      </Section>

      <div className={`alert-banner ${promptEnforced ? "warning" : "subtle"}`}>
        <ShieldAlert size={19} />
        <div>
          <strong>Enforcement boundary is explicit</strong>
          <span>
            {enforcementNote ??
              (promptEnforced
                ? "Read and search restrictions are instructions to the optimizer, not a separate OS filesystem sandbox. Candidate writes are checked after the run."
                : `Restrictions are recorded as ${humanize(source?.restrictionsEnforcedBy)}.`)}
          </span>
        </div>
      </div>

      <div className="optimizer-audit-grid">
        <Section
          title="Exact optimizer prompt"
          description={`SHA-256 ${promptDigest}`}
          className="optimizer-prompt-panel"
        >
          <pre className="optimizer-prompt">
            {selectedAttempt.prompt || "Prompt content was not recorded for this attempt."}
          </pre>
        </Section>

        <Section title="Invocation receipt" description="Model usage and lifecycle metadata">
          <div className="optimizer-key-values">
            <KeyValue label="Attempt">{selectedAttempt.ordinal}</KeyValue>
            <KeyValue label="Status">
              <StatusPill status={selectedAttempt.status || "unknown"} />
            </KeyValue>
            <KeyValue label="Started">{formatDate(selectedAttempt.startedAt)}</KeyValue>
            <KeyValue label="Completed">{formatDate(selectedAttempt.completedAt)}</KeyValue>
            <KeyValue label="Champion" mono>
              {shortRevision(selectedAttempt.championRevision)}
            </KeyValue>
            <KeyValue label="Candidate tree" mono>
              {shortRevision(source?.candidateTree)}
            </KeyValue>
            <KeyValue label="Model">{contract?.model || optimizer?.model || "—"}</KeyValue>
            <KeyValue label="Effort">{contract?.effort || "—"}</KeyValue>
            <KeyValue label="Turns">
              {optimizer?.turns ?? "—"} used · {contract?.maximumTurns ?? "—"} maximum
            </KeyValue>
            <KeyValue label="Model cost">
              {formatCurrency(optimizer?.costUsd)} · {formatCurrency(contract?.maximumCostUsd)} cap
            </KeyValue>
            <KeyValue label="Timeout">{formatDuration(contract?.timeoutMs)}</KeyValue>
            <KeyValue label="Permission mode">{contract?.permissionMode || "—"}</KeyValue>
            <KeyValue label="Output">{contract?.outputFormat || "—"}</KeyValue>
          </div>
        </Section>

        <Section
          title="Previous decision"
          description="Task-free aggregate feedback included in the optimizer input"
        >
          {selectedAttempt.previousDecision ? (
            <pre className="optimizer-json">
              {JSON.stringify(selectedAttempt.previousDecision, null, 2)}
            </pre>
          ) : (
            <div className="inline-empty">
              <FileText size={21} />
              <div>
                <strong>No previous decision supplied</strong>
                <p>This is the first optimizer attempt or no prior matched decision exists.</p>
              </div>
            </div>
          )}
        </Section>

        <Section title="Source scope" description="Repository state available to the optimizer">
          <div className="optimizer-source">
            <div className="optimizer-key-values">
              <KeyValue label="Checkout">{humanize(source?.kind)}</KeyValue>
              <KeyValue label="Repository">
                {protectedRepositoryOrigin(source?.repositoryOrigin)}
              </KeyValue>
              <KeyValue label="Champion" mono>
                {shortRevision(source?.championRevision || selectedAttempt.championRevision)}
              </KeyValue>
              <KeyValue label="Readable scope">{source?.readableScope || "—"}</KeyValue>
              <KeyValue label="Read restrictions">{source?.restrictionsEnforcedBy || "—"}</KeyValue>
              <KeyValue label="Post-run change validation">
                {source?.postRunChangeValidation || "—"}
              </KeyValue>
            </div>
            <div className="audit-list-block">
              <span>
                <FolderGit2 size={14} />
                Editable roots
              </span>
              <div className="audit-code-chips">
                {source?.editableRoots?.length ? (
                  source.editableRoots.map((root) => <code key={root}>{root}</code>)
                ) : (
                  <em>Not recorded</em>
                )}
              </div>
            </div>
            <div className="audit-list-block">
              <span>
                <FileText size={14} />
                Instruction files
              </span>
              <div className="audit-code-chips">
                {source?.instructionFiles?.length ? (
                  source.instructionFiles.map((file) => {
                    const digest = source.instructionFileSha256?.[file];
                    return (
                      <code key={file} title={digest ? `SHA-256 ${digest}` : undefined}>
                        {file}
                        {digest ? ` · ${digest.slice(0, 12)}` : ""}
                      </code>
                    );
                  })
                ) : (
                  <em>None recorded</em>
                )}
              </div>
            </div>
          </div>
        </Section>

        <Section title="Access boundary" description="What the optimizer could and could not use">
          {disclosureNotes.length ? (
            <div className="optimizer-disclosures">
              {disclosureNotes.map((note) => (
                <div key={note}>
                  <ShieldAlert size={15} />
                  <span>{note}</span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="optimizer-boundary-list">
            {boundaryLabels.map(([field, label]) => (
              <div key={field}>
                <span>
                  <EyeOff size={14} />
                  {label}
                </span>
                <BoundaryValue value={selectedAttempt.boundary?.[field]} />
              </div>
            ))}
          </div>
          <div className="optimizer-runtime-flags">
            <KeyValue label="Shell">{booleanLabel(contract?.shellEnabled)}</KeyValue>
            <KeyValue label="Network tools">{booleanLabel(contract?.networkToolsEnabled)}</KeyValue>
            <KeyValue label="Provider API network">
              {booleanLabel(contract?.providerApiNetworkRequired)}
            </KeyValue>
            <KeyValue label="Browser">{booleanLabel(contract?.browserEnabled)}</KeyValue>
            <KeyValue label="Session persistence">
              {booleanLabel(contract?.sessionPersistence)}
            </KeyValue>
          </div>
        </Section>

        <Section title="Tool policy" description="Claude tools explicitly enabled or denied">
          <div className="optimizer-tool-groups">
            <div>
              <span>Allowed</span>
              <div className="audit-tool-chips allowed">
                {contract?.allowedTools?.length ? (
                  contract.allowedTools.map((tool) => <code key={tool}>{tool}</code>)
                ) : (
                  <em>None recorded</em>
                )}
              </div>
            </div>
            <div>
              <span>Disallowed</span>
              <div className="audit-tool-chips denied">
                {contract?.disallowedTools?.length ? (
                  contract.disallowedTools.map((tool) => <code key={tool}>{tool}</code>)
                ) : (
                  <em>None recorded</em>
                )}
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Sanitized environment"
          description="Credential names may be shown; credential values are never rendered"
          className="span-2"
        >
          {environment.length ? (
            <div className="table-wrap">
              <table className="data-table optimizer-environment-table">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Value supplied</th>
                    <th>Purpose</th>
                  </tr>
                </thead>
                <tbody>
                  {environment.map((entry) => (
                    <tr key={entry.name}>
                      <td>
                        <code>{entry.name}</code>
                      </td>
                      <td className={entry.secret ? "protected-value" : undefined}>
                        {entry.secret ? <LockKeyhole size={13} /> : null}
                        <code>{protectedEnvironmentValue(entry)}</code>
                      </td>
                      <td>{entry.description || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="inline-empty">
              <KeyRound size={21} />
              <div>
                <strong>Environment receipt pending</strong>
                <p>No sanitized environment metadata was recorded for this attempt.</p>
              </div>
            </div>
          )}
        </Section>

        <Section
          title="Raw optimizer evidence"
          description="Sanitized input, invocation, transcript, and stderr artifacts"
          className="span-2"
        >
          <ArtifactViewer
            key={selectedAttempt.ordinal}
            campaignId={campaignId}
            experimentId={experimentId}
            artifacts={visibleArtifacts}
            initiallyFollow={selectedAttempt.status === "running"}
          />
        </Section>
      </div>
    </div>
  );
}
