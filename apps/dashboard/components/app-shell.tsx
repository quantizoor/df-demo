"use client";

import {
  Activity,
  BarChart3,
  Beaker,
  Boxes,
  ChevronDown,
  Command,
  Gauge,
  Menu,
  Plus,
  ScrollText,
  Settings2,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { mutate } from "swr";
import { useCampaigns } from "../lib/client/api";
import { StatusPill } from "./ui";

type NavItem = {
  label: string;
  icon: typeof Gauge;
  suffix: string;
};

const campaignNavigation: NavItem[] = [
  { label: "Overview", icon: Gauge, suffix: "" },
  { label: "Experiments", icon: Beaker, suffix: "/experiments" },
  { label: "Performance", icon: BarChart3, suffix: "/performance" },
  { label: "Live logs", icon: ScrollText, suffix: "/logs" },
  { label: "Task logs", icon: Terminal, suffix: "/task-logs" },
  { label: "Task health", icon: Activity, suffix: "/tasks" },
  { label: "Configuration", icon: Settings2, suffix: "/configuration" },
];

function campaignFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/campaigns\/([^/]+)/);
  if (!match || match[1] === "new") return null;
  return decodeURIComponent(match[1]);
}

function NavLink({
  href,
  label,
  icon: Icon,
  exact = false,
  onClick,
}: {
  href: string;
  label: string;
  icon: typeof Gauge;
  exact?: boolean;
  onClick?: () => void;
}) {
  const pathname = usePathname();
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link className={`nav-link ${active ? "active" : ""}`} href={href} onClick={onClick}>
      <Icon size={18} />
      <span>{label}</span>
      {active ? <i /> : null}
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const campaignId = campaignFromPath(pathname);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const campaigns = useCampaigns();
  const current = campaigns.data?.find((campaign) => campaign.campaignId === campaignId);

  useEffect(() => {
    if (!campaignId) return;
    const source = new EventSource(`/api/v1/campaigns/${encodeURIComponent(campaignId)}/events`);
    const refresh = () => {
      void mutate((key) => typeof key === "string" && key.includes(campaignId));
    };
    source.addEventListener("campaign", refresh);
    source.addEventListener("experiment", refresh);
    source.onerror = () => {
      // SWR polling remains the fallback if the stream is unavailable.
    };
    return () => source.close();
  }, [campaignId]);

  useEffect(() => setMobileOpen(false), []);

  const crumbs = useMemo(() => {
    const parts = pathname.split("/").filter(Boolean);
    return parts.map((part, index) => ({
      label:
        part === campaignId
          ? campaignId
          : part === "campaigns"
            ? "Campaigns"
            : part.replaceAll("-", " "),
      href: `/${parts.slice(0, index + 1).join("/")}`,
    }));
  }, [campaignId, pathname]);

  const closeMobile = () => setMobileOpen(false);
  return (
    <div className="app-shell">
      <button
        className="mobile-menu button-icon"
        type="button"
        onClick={() => setMobileOpen(true)}
        aria-label="Open navigation"
      >
        <Menu size={20} />
      </button>
      {mobileOpen ? (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close navigation"
          onClick={closeMobile}
        />
      ) : null}
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="brand">
          <div className="brand-mark">
            <Command size={20} strokeWidth={2.3} />
          </div>
          <div>
            <strong>Dark Factory</strong>
            <span>Control Console</span>
          </div>
          <button
            type="button"
            className="mobile-close"
            aria-label="Close navigation"
            onClick={closeMobile}
          >
            <X size={19} />
          </button>
        </div>

        <div className="sidebar-content">
          <div className="nav-section">
            <div className="nav-label">Portfolio</div>
            <NavLink exact href="/campaigns" label="Campaigns" icon={Boxes} onClick={closeMobile} />
          </div>

          {campaignId ? (
            <>
              <div className="campaign-switcher">
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((open) => !open)}
                  aria-expanded={switcherOpen}
                >
                  <span>
                    <small>Active campaign</small>
                    <strong>{campaignId}</strong>
                  </span>
                  <ChevronDown size={16} />
                </button>
                {switcherOpen ? (
                  <div className="switcher-menu">
                    {(campaigns.data || []).map((campaign) => (
                      <Link
                        href={`/campaigns/${encodeURIComponent(campaign.campaignId)}`}
                        key={campaign.campaignId}
                        onClick={() => setSwitcherOpen(false)}
                      >
                        <span>{campaign.campaignId}</span>
                        <StatusPill status={campaign.operationalStatus} />
                      </Link>
                    ))}
                    <Link href="/campaigns/new" onClick={() => setSwitcherOpen(false)}>
                      <Plus size={15} />
                      <span>New campaign</span>
                    </Link>
                  </div>
                ) : null}
              </div>
              <div className="nav-section">
                <div className="nav-label">Campaign operations</div>
                {campaignNavigation.map((item) => (
                  <NavLink
                    key={item.label}
                    exact={item.suffix === ""}
                    href={`/campaigns/${encodeURIComponent(campaignId)}${item.suffix}`}
                    label={item.label}
                    icon={item.icon}
                    onClick={closeMobile}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="sidebar-prompt">
              <ShieldCheck size={19} />
              <strong>Local control plane</strong>
              <p>Select a campaign to inspect its operational evidence.</p>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <span className="local-indicator">
            <i />
            Local machine
          </span>
        </div>
      </aside>

      <div className="workspace">
        <div className="topbar">
          <nav className="breadcrumbs" aria-label="Breadcrumb">
            {crumbs.length === 0 ? <span>Control console</span> : null}
            {crumbs.map((crumb, index) => (
              <span key={crumb.href}>
                {index > 0 ? <b>/</b> : null}
                {index === crumbs.length - 1 ? (
                  <em>{crumb.label}</em>
                ) : (
                  <Link href={crumb.href}>{crumb.label}</Link>
                )}
              </span>
            ))}
          </nav>
          <div className="topbar-status">
            {current ? <StatusPill status={current.operationalStatus} /> : null}
            <span className="secure-badge">
              <ShieldCheck size={14} />
              Loopback secured
            </span>
          </div>
        </div>
        <main className="main-content">{children}</main>
      </div>
    </div>
  );
}
