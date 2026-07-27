import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { dashboardOrigin, dashboardTokenFile } from "./config";

export const DASHBOARD_SESSION_COOKIE = "df_dashboard_session";

export class DashboardUnauthorizedError extends Error {
  public constructor() {
    super("Dashboard session is required");
    this.name = "DashboardUnauthorizedError";
  }
}

export class DashboardForbiddenError extends Error {
  public constructor(message = "Request origin is not allowed") {
    super(message);
    this.name = "DashboardForbiddenError";
  }
}

export async function readDashboardToken(): Promise<string> {
  const token = (await readFile(dashboardTokenFile, "utf8")).trim();
  if (token.length < 32) throw new DashboardUnauthorizedError();
  return token;
}

export async function assertDashboardSession(request: Request): Promise<void> {
  const expected = await readDashboardToken();
  const actual = readCookie(request.headers.get("cookie"), DASHBOARD_SESSION_COOKIE);
  if (actual === undefined || !safeEqual(actual, expected)) {
    throw new DashboardUnauthorizedError();
  }
}

export async function assertDashboardMutation(request: Request): Promise<void> {
  await assertDashboardSession(request);
  if (request.headers.get("x-df-dashboard-request") !== "1") {
    throw new DashboardForbiddenError("Dashboard request header is required");
  }
  if (!isAllowedDashboardOrigin(request.headers.get("origin"))) {
    throw new DashboardForbiddenError();
  }
}

export function isAllowedDashboardOrigin(
  origin: string | null,
  expectedOrigin = dashboardOrigin,
): boolean {
  return origin !== null && origin === expectedOrigin;
}

export function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key !== name) continue;
    const value = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
