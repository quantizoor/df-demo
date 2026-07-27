import { stopDashboardCampaign } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, readJsonObject, withDashboardMutation } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withDashboardMutation(request, async () => {
    const { campaignId } = await context.params;
    const body = await readJsonObject(request);
    const mode = body.mode ?? "after-phase";
    if (mode !== "after-phase" && mode !== "cancel-active") {
      throw Object.assign(new Error("mode must be after-phase or cancel-active"), { status: 400 });
    }
    const result = await stopDashboardCampaign({
      stateRoot: dashboardStateRoot,
      campaignId,
      mode,
    });
    return apiJson(result, { status: 202 });
  });
}
