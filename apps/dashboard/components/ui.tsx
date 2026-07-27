import type { LucideIcon } from "lucide-react";
import { AlertTriangle, ArrowRight, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { humanize } from "../lib/client/format";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function StatusPill({ status }: { status?: string | null }) {
  const value = status || "unknown";
  return (
    <span className={`status-pill status-${value.toLowerCase().replaceAll(" ", "-")}`}>
      <span className="status-dot" />
      {humanize(value)}
    </span>
  );
}

export function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "positive" | "warning" | "negative";
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-label">
        <span>{label}</span>
        {Icon ? <Icon size={17} aria-hidden="true" /> : null}
      </div>
      <div className="metric-value">{value}</div>
      {detail ? <div className="metric-detail">{detail}</div> : null}
    </article>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title || action ? (
        <div className="panel-header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function LoadingState({ label = "Loading operational data" }: { label?: string }) {
  return (
    <div className="state-card state-loading" role="status">
      <LoaderCircle className="spin" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="state-card state-error" role="alert">
      <AlertTriangle size={24} />
      <div>
        <strong>We couldn’t load this view</strong>
        <p>{error instanceof Error ? error.message : "The local control API did not respond."}</p>
      </div>
      {retry ? (
        <button className="button button-secondary" type="button" onClick={retry}>
          <RefreshCw size={15} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
  icon: Icon = Inbox,
}: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={25} />
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      {actionHref && actionLabel ? (
        <Link className="button button-primary" href={actionHref}>
          {actionLabel}
          <ArrowRight size={16} />
        </Link>
      ) : null}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = "default",
  label,
}: {
  value: number;
  tone?: "default" | "positive" | "warning" | "negative";
  label?: string;
}) {
  const bounded = Math.min(100, Math.max(0, value));
  return (
    <div
      className={`progress progress-${tone}`}
      role="progressbar"
      aria-valuenow={bounded}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${bounded}%` }} />
    </div>
  );
}

export function KeyValue({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined}>{children}</strong>
    </div>
  );
}
