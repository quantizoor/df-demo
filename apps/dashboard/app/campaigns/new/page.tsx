"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleCheck,
  CircleDollarSign,
  CircleX,
  FolderGit2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { PageHeader } from "../../../components/ui";
import { checkCampaignReadiness, createCampaign } from "../../../lib/client/api";
import type { ReadinessReport } from "../../../lib/client/types";

const steps = ["Identity", "Budget", "Runtime", "Review"];

export default function NewCampaignPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [campaignId, setCampaignId] = useState("");
  const [budgetType, setBudgetType] = useState<"capped" | "unbounded">("capped");
  const [maximumUsd, setMaximumUsd] = useState("");
  const [unboundedConfirmed, setUnboundedConfirmed] = useState(false);
  const [piRepository, setPiRepository] = useState("");
  const [credentialsFile, setCredentialsFile] = useState("");
  const [claudeExecutable, setClaudeExecutable] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [checking, setChecking] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slugValid = /^[a-z0-9][a-z0-9-]{1,62}$/.test(campaignId);
  const canContinue = useMemo(() => {
    if (step === 0) return slugValid;
    if (step === 1) return budgetType === "capped" ? Number(maximumUsd) > 0 : unboundedConfirmed;
    if (step === 2) return !checking;
    return readiness?.ready === true;
  }, [budgetType, checking, maximumUsd, readiness?.ready, slugValid, step, unboundedConfirmed]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (step < 2) {
      setStep((value) => value + 1);
      return;
    }
    if (step === 2) {
      setChecking(true);
      setError(null);
      try {
        const report = await checkCampaignReadiness({
          ...(piRepository.trim() ? { piRepository: piRepository.trim() } : {}),
          ...(advanced && credentialsFile.trim()
            ? { credentialsFile: credentialsFile.trim() }
            : {}),
          ...(advanced && claudeExecutable.trim()
            ? { claudeExecutable: claudeExecutable.trim() }
            : {}),
        });
        setReadiness(report);
        if (report.ready) setStep(3);
        else setError("Resolve the failed readiness checks before initialization.");
      } catch (cause) {
        setReadiness(null);
        setError(cause instanceof Error ? cause.message : "Readiness check failed.");
      } finally {
        setChecking(false);
      }
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createCampaign({
        campaignId,
        budget:
          budgetType === "capped"
            ? { type: "capped", maximumUsd: Number(maximumUsd) }
            : { type: "unbounded", explicitlyConfirmed: true },
        ...(piRepository.trim() ? { piRepository: piRepository.trim() } : {}),
        ...(advanced && credentialsFile.trim() ? { credentialsFile: credentialsFile.trim() } : {}),
        ...(advanced && claudeExecutable.trim()
          ? { claudeExecutable: claudeExecutable.trim() }
          : {}),
      });
      router.push(`/campaigns/${encodeURIComponent(campaignId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Campaign initialization failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-stack wizard-page">
      <PageHeader
        eyebrow="Campaign setup"
        title="Initialize a new campaign"
        description="Configure the local loop. Nothing will run—and no model spend will occur—until you explicitly start it."
      />

      <div className="wizard-shell">
        <aside className="wizard-rail">
          <div className="wizard-progress">
            {steps.map((label, index) => (
              <button
                type="button"
                key={label}
                className={index === step ? "active" : index < step ? "complete" : ""}
                onClick={() => index < step && setStep(index)}
                disabled={index > step}
              >
                <span>{index < step ? <Check size={14} /> : index + 1}</span>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {index === 0
                      ? "Name the local loop"
                      : index === 1
                        ? "Define spend limits"
                        : index === 2
                          ? "Verify local paths"
                          : "Initialize safely"}
                  </small>
                </div>
              </button>
            ))}
          </div>
          <div className="wizard-safety">
            <ShieldCheck size={20} />
            <div>
              <strong>Safe by default</strong>
              <p>Campaign creation initializes state only. Starting is always separate.</p>
            </div>
          </div>
        </aside>

        <form className="wizard-form" onSubmit={submit}>
          {step === 0 ? (
            <div className="wizard-step">
              <div className="step-icon">
                <FolderGit2 size={23} />
              </div>
              <div className="eyebrow">Step 1 of 4</div>
              <h2>Give this optimization loop an identity</h2>
              <p>Use a short, durable name. It becomes the local campaign directory.</p>
              <label className="field">
                <span>Campaign ID</span>
                <input
                  value={campaignId}
                  onChange={(event) =>
                    setCampaignId(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
                  }
                  placeholder="pi-harness-main"
                  aria-describedby="campaign-id-hint"
                />
                <small id="campaign-id-hint">
                  Lowercase letters, numbers, and hyphens · 2–63 characters
                </small>
              </label>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="wizard-step">
              <div className="step-icon">
                <CircleDollarSign size={23} />
              </div>
              <div className="eyebrow">Step 2 of 4</div>
              <h2>Set the campaign budget policy</h2>
              <p>The runner checks this limit before it begins each new experiment.</p>
              <div className="choice-grid">
                <button
                  className={`choice-card ${budgetType === "capped" ? "selected" : ""}`}
                  type="button"
                  onClick={() => setBudgetType("capped")}
                >
                  <span className="choice-radio" />
                  <strong>Capped budget</strong>
                  <p>Stop starting experiments when cumulative spend reaches a hard USD limit.</p>
                  <span className="recommended">Recommended</span>
                </button>
                <button
                  className={`choice-card ${budgetType === "unbounded" ? "selected warning" : ""}`}
                  type="button"
                  onClick={() => setBudgetType("unbounded")}
                >
                  <span className="choice-radio" />
                  <strong>Unbounded</strong>
                  <p>Continue until manually stopped. Model usage can accumulate indefinitely.</p>
                </button>
              </div>
              {budgetType === "capped" ? (
                <label className="field money-field">
                  <span>Maximum campaign spend</span>
                  <div>
                    <b>$</b>
                    <input
                      inputMode="decimal"
                      value={maximumUsd}
                      onChange={(event) => setMaximumUsd(event.target.value)}
                      placeholder="100.00"
                    />
                  </div>
                </label>
              ) : (
                <label className="confirm-box">
                  <input
                    type="checkbox"
                    checked={unboundedConfirmed}
                    onChange={(event) => setUnboundedConfirmed(event.target.checked)}
                  />
                  <span>
                    <strong>I understand this campaign has no automatic spend ceiling.</strong>
                    <small>I will monitor it and stop it manually.</small>
                  </span>
                </label>
              )}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="wizard-step">
              <div className="step-icon">
                <KeyRound size={23} />
              </div>
              <div className="eyebrow">Step 3 of 4</div>
              <h2>Confirm the local runtime</h2>
              <p>Credentials stay in the protected environment file and are never shown here.</p>
              <label className="field">
                <span>Pi repository</span>
                <input
                  value={piRepository}
                  onChange={(event) => {
                    setPiRepository(event.target.value);
                    setReadiness(null);
                  }}
                  placeholder="Use the detected sibling df-pi-tbench repository"
                />
                <small>Leave empty to use the locally detected Pi repository.</small>
              </label>
              <button
                className="text-button"
                type="button"
                onClick={() => setAdvanced((value) => !value)}
              >
                {advanced ? "Hide advanced paths" : "Show advanced paths"}
              </button>
              {advanced ? (
                <div className="advanced-fields">
                  <label className="field">
                    <span>Credentials file</span>
                    <input
                      value={credentialsFile}
                      onChange={(event) => {
                        setCredentialsFile(event.target.value);
                        setReadiness(null);
                      }}
                      placeholder="Absolute path · default is the protected local config"
                    />
                  </label>
                  <label className="field">
                    <span>Claude executable</span>
                    <input
                      value={claudeExecutable}
                      onChange={(event) => {
                        setClaudeExecutable(event.target.value);
                        setReadiness(null);
                      }}
                      placeholder="Absolute path · default is the managed local executable"
                    />
                  </label>
                </div>
              ) : null}
              <div className="runtime-summary">
                <div>
                  <span>Optimizer</span>
                  <strong>Claude Opus 5 · high effort</strong>
                </div>
                <div>
                  <span>Evaluated agent</span>
                  <strong>Claude Opus 4.8 · high thinking</strong>
                </div>
                <div>
                  <span>Evaluation</span>
                  <strong>Terminal-Bench 2.0 · Harbor</strong>
                </div>
              </div>
              {checking ? (
                <div className="readiness-running" role="status">
                  <LoaderCircle className="spin" size={18} />
                  <div>
                    <strong>Checking the complete local runtime</strong>
                    <span>
                      Verifying Git, Docker, toolchains, credentials, and the Terminal-Bench
                      catalog. This can take up to 30 seconds.
                    </span>
                  </div>
                </div>
              ) : null}
              {readiness && !readiness.ready ? (
                <div className="readiness-results failed" role="alert">
                  <div className="readiness-results-head">
                    <CircleX size={18} />
                    <div>
                      <strong>Runtime needs attention</strong>
                      <span>
                        {readiness.checks.filter((check) => check.status === "fail").length} of{" "}
                        {readiness.checks.length} checks failed
                      </span>
                    </div>
                  </div>
                  <ul>
                    {readiness.checks
                      .filter((check) => check.status === "fail")
                      .map((check) => (
                        <li key={check.id}>
                          <strong>{check.label}</strong>
                          <span>{check.detail}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
              {error ? <p className="inline-error">{error}</p> : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="wizard-step">
              <div className="step-icon success">
                <Check size={23} />
              </div>
              <div className="eyebrow">Step 4 of 4</div>
              <h2>Review before initialization</h2>
              <p>This creates durable local campaign state. It does not launch an experiment.</p>
              <div className="review-card">
                <div>
                  <span>Campaign</span>
                  <strong>{campaignId}</strong>
                </div>
                <div>
                  <span>Budget</span>
                  <strong>
                    {budgetType === "capped"
                      ? `$${Number(maximumUsd).toFixed(2)} hard cap`
                      : "Unbounded · confirmed"}
                  </strong>
                </div>
                <div>
                  <span>Repository</span>
                  <strong className="mono">{piRepository || "Detected local default"}</strong>
                </div>
                <div>
                  <span>Optimizer</span>
                  <strong>claude-opus-5</strong>
                </div>
                <div>
                  <span>Evaluator</span>
                  <strong>claude-opus-4-8</strong>
                </div>
                <div>
                  <span>Start behavior</span>
                  <strong>Manual, after initialization</strong>
                </div>
              </div>
              <div className="info-banner">
                <ShieldCheck size={18} />
                <span>
                  Secrets are read server-side from the protected file and never returned to the
                  browser.
                </span>
              </div>
              {readiness?.ready ? (
                <details className="readiness-results passed">
                  <summary>
                    <CircleCheck size={18} />
                    <span>
                      <strong>Local runtime ready</strong>
                      <small>{readiness.checks.length} checks passed</small>
                    </span>
                  </summary>
                  <ul>
                    {readiness.checks.map((check) => (
                      <li key={check.id}>
                        <strong>{check.label}</strong>
                        <span>{check.detail}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {error ? <p className="inline-error">{error}</p> : null}
            </div>
          ) : null}

          <div className="wizard-actions">
            {step === 0 ? (
              <Link className="button button-ghost" href="/campaigns">
                <ArrowLeft size={16} />
                Cancel
              </Link>
            ) : (
              <button
                className="button button-ghost"
                type="button"
                onClick={() => setStep((value) => value - 1)}
              >
                <ArrowLeft size={16} />
                Back
              </button>
            )}
            <button
              className="button button-primary"
              type="submit"
              disabled={!canContinue || submitting}
            >
              {checking
                ? "Checking readiness…"
                : step === steps.length - 1
                  ? submitting
                    ? "Initializing…"
                    : "Initialize campaign"
                  : "Continue"}
              {checking ? (
                <LoaderCircle className="spin" size={16} />
              ) : step < steps.length - 1 ? (
                <ArrowRight size={16} />
              ) : (
                <Check size={16} />
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
