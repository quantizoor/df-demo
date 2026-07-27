import { resolve } from "node:path";

const inferredProjectRoot = resolve(process.cwd(), "../..");

export const dashboardProjectRoot = resolve(
  process.env.DF_DASHBOARD_PROJECT_ROOT ?? inferredProjectRoot,
);

export const dashboardStateRoot = resolve(
  process.env.DF_DASHBOARD_STATE_ROOT ?? resolve(dashboardProjectRoot, ".df/local"),
);

export const dashboardTokenFile = resolve(
  process.env.DF_DASHBOARD_TOKEN_FILE ?? resolve(dashboardStateRoot, "dashboard/session-token"),
);

export const dashboardOrigin = configuredDashboardOrigin(
  process.env.DF_DASHBOARD_ORIGIN ?? "http://127.0.0.1:3000",
);

function configuredDashboardOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Dashboard origin must be an HTTP loopback origin");
  }
  return url.origin;
}
