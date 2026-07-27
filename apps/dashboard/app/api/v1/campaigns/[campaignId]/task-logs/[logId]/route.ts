import { readDashboardTaskLogChunk } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, boundedInteger, withDashboardSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string; logId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withDashboardSession(request, async () => {
    const { campaignId, logId } = await context.params;
    const url = new URL(request.url);
    const rawTail = url.searchParams.get("tail");
    if (rawTail !== null && rawTail !== "1") {
      throw Object.assign(new Error("Tail must be 1 when provided"), { status: 400 });
    }
    const rawOffset = url.searchParams.get("offset");
    if (rawTail === "1" && rawOffset !== null) {
      throw Object.assign(new Error("Tail and offset cannot be combined"), { status: 400 });
    }
    const limit = boundedInteger(url.searchParams.get("limit"), 262_144, 1, 262_144);
    const chunk = await readDashboardTaskLogChunk({
      stateRoot: dashboardStateRoot,
      campaignId,
      logId,
      limit,
      ...(rawTail === "1"
        ? { tail: true }
        : rawOffset === null
          ? {}
          : { offset: boundedInteger(rawOffset, 0, 0, Number.MAX_SAFE_INTEGER) }),
    });
    return apiJson(chunk);
  });
}
