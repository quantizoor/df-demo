import { NextResponse } from "next/server";

import { DASHBOARD_SESSION_COOKIE, readDashboardToken, safeEqual } from "@/lib/server/auth";
import { dashboardOrigin } from "@/lib/server/config";
import { dashboardReturnDestination } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return new Response("Dashboard is available only on this machine", { status: 403 });
  }

  const supplied = url.searchParams.get("token");
  const expected = await readDashboardToken().catch(() => undefined);
  if (expected === undefined || (supplied !== null && !safeEqual(supplied, expected))) {
    return new Response("Invalid dashboard bootstrap token", { status: 401 });
  }

  const destination = dashboardReturnDestination(url.searchParams.get("returnTo"), dashboardOrigin);
  const response = NextResponse.redirect(destination, 303);
  response.cookies.set(DASHBOARD_SESSION_COOKIE, expected, {
    httpOnly: true,
    sameSite: "strict",
    secure: destination.protocol === "https:",
    path: "/",
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
