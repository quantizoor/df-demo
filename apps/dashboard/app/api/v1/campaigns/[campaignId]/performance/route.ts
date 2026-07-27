import { getDashboardPerformance } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, withDashboardSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withDashboardSession(request, async () => {
    const { campaignId } = await context.params;
    const points = await getDashboardPerformance(dashboardStateRoot, campaignId);
    return apiJson({ points });
  });
}
