import { dashboardOrigin } from "./config";

const DEFAULT_DASHBOARD_PATH = "/campaigns";

export function dashboardReturnDestination(returnTo: string | null, origin = dashboardOrigin): URL {
  const configuredOrigin = new URL(origin).origin;
  const fallback = new URL(DEFAULT_DASHBOARD_PATH, configuredOrigin);
  if (returnTo === null || !returnTo.startsWith("/") || returnTo.startsWith("//")) {
    return fallback;
  }

  try {
    const destination = new URL(returnTo, configuredOrigin);
    if (
      destination.origin !== configuredOrigin ||
      destination.pathname === "/api" ||
      destination.pathname.startsWith("/api/")
    ) {
      return fallback;
    }
    destination.hash = "";
    return destination;
  } catch {
    return fallback;
  }
}
