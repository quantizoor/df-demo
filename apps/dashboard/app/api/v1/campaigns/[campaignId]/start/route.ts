import { startDashboardCampaign } from "dark-factory/local-dashboard";

import { dashboardProjectRoot, dashboardStateRoot } from "@/lib/server/config";
import { apiJson, readJsonObject, withDashboardMutation } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withDashboardMutation(request, async () => {
    const { campaignId } = await context.params;
    const body = await readJsonObject(request);
    const mode = body.mode ?? "continuous";
    if (mode !== "continuous" && mode !== "once") {
      throw Object.assign(new Error("mode must be continuous or once"), { status: 400 });
    }
    const result = await startDashboardCampaign({
      stateRoot: dashboardStateRoot,
      projectRoot: dashboardProjectRoot,
      campaignId,
      mode,
    });
    return apiJson(result, { status: 202 });
  });
}
