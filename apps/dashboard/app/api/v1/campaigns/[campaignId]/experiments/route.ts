import { listDashboardExperiments } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, boundedInteger, withDashboardSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withDashboardSession(request, async () => {
    const { campaignId } = await context.params;
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const limit = boundedInteger(url.searchParams.get("limit"), 50, 1, 200);
    const page = await listDashboardExperiments(dashboardStateRoot, campaignId, {
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    return apiJson(page);
  });
}
