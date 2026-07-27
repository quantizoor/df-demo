"use client";

import { Ban, CircleStop, Play, PlayCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { startCampaign, stopCampaign } from "../lib/client/api";
import type { CampaignSummary } from "../lib/client/types";

export function CampaignControls({ campaign }: { campaign: CampaignSummary }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelTriggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRunningRef = useRef<HTMLButtonElement>(null);
  const cancelTitleId = useId();
  const cancelDescriptionId = useId();
  const running = ["running", "starting", "stopping", "stop-requested"].includes(
    campaign.operationalStatus,
  );
  const budgetExhausted =
    campaign.maximumCampaignCostUsd != null &&
    campaign.maximumCampaignCostUsd > 0 &&
    (campaign.totalCostUsd ?? 0) >= campaign.maximumCampaignCostUsd;

  const act = async (name: string, operation: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The operation failed.");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!cancelOpen) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : cancelTriggerRef.current;
    const focusFrame = window.requestAnimationFrame(() => keepRunningRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setCancelOpen(false);
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [cancelOpen]);

  if (!running) {
    return (
      <div className="control-stack">
        <div className="control-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={busy !== null || campaign.operationalStatus === "blocked" || budgetExhausted}
            onClick={() =>
              void act("start", () => startCampaign(campaign.campaignId, "continuous"))
            }
          >
            <Play size={16} fill="currentColor" />
            {busy === "start" ? "Starting…" : "Start campaign"}
          </button>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy !== null || campaign.operationalStatus === "blocked" || budgetExhausted}
            onClick={() => void act("once", () => startCampaign(campaign.campaignId, "once"))}
          >
            <PlayCircle size={16} />
            Run one experiment
          </button>
        </div>
        {budgetExhausted ? (
          <p className="inline-error">
            The campaign has reached its hard cost ceiling. Increase the budget in durable
            configuration before starting another experiment.
          </p>
        ) : null}
        {error ? <p className="inline-error">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="control-stack">
      <div className="control-actions">
        <button
          className="button button-secondary"
          type="button"
          disabled={busy !== null || campaign.operationalStatus === "stopping"}
          onClick={() => void act("stop", () => stopCampaign(campaign.campaignId, "after-phase"))}
        >
          <CircleStop size={16} />
          {busy === "stop" ? "Requesting…" : "Stop after phase"}
        </button>
        <button
          ref={cancelTriggerRef}
          className="button button-danger-ghost"
          type="button"
          disabled={busy !== null}
          onClick={() => setCancelOpen(true)}
        >
          <Ban size={16} />
          Cancel now
        </button>
      </div>
      {error ? <p className="inline-error">{error}</p> : null}
      {cancelOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div
            ref={dialogRef}
            className="modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={cancelTitleId}
            aria-describedby={cancelDescriptionId}
          >
            <div className="modal-icon danger">
              <TriangleAlert aria-hidden="true" size={22} />
            </div>
            <h2 id={cancelTitleId}>Cancel the active process?</h2>
            <p id={cancelDescriptionId}>
              The current optimizer or evaluator process will be terminated. Partial artifacts will
              be preserved, but in-flight model spend may not be recoverable.
            </p>
            <div className="modal-actions">
              <button
                ref={keepRunningRef}
                className="button button-secondary"
                type="button"
                onClick={() => setCancelOpen(false)}
              >
                Keep running
              </button>
              <button
                className="button button-danger"
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setCancelOpen(false);
                  void act("cancel", () => stopCampaign(campaign.campaignId, "cancel-active"));
                }}
              >
                Cancel active process
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
