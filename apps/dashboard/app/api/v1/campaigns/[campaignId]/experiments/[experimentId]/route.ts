import { getDashboardExperiment } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, withDashboardSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string; experimentId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withDashboardSession(request, async () => {
    const { campaignId, experimentId } = await context.params;
    const experiment = await getDashboardExperiment(dashboardStateRoot, campaignId, experimentId);
    return apiJson({ experiment });
  });
}
