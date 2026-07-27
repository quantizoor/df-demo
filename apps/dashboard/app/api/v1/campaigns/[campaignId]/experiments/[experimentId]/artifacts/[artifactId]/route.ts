import { readDashboardArtifactChunk } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import { apiJson, boundedInteger, withDashboardSession } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ campaignId: string; experimentId: string; artifactId: string }>;
};

export async function GET(request: Request, context: Context): Promise<Response> {
  return withDashboardSession(request, async () => {
    const { campaignId, experimentId, artifactId } = await context.params;
    const url = new URL(request.url);
    if (url.searchParams.get("download") === "1") {
      return artifactDownload(campaignId, experimentId, artifactId);
    }
    const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(url.searchParams.get("limit"), 65_536, 1, 262_144);
    const chunk = await readDashboardArtifactChunk({
      stateRoot: dashboardStateRoot,
      campaignId,
      experimentId,
      artifactId,
      offset,
      limit,
    });
    return apiJson(chunk);
  });
}

function artifactDownload(campaignId: string, experimentId: string, artifactId: string): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await readDashboardArtifactChunk({
          stateRoot: dashboardStateRoot,
          campaignId,
          experimentId,
          artifactId,
          offset,
          limit: 262_144,
        });
        if (chunk.content.length > 0) {
          controller.enqueue(new TextEncoder().encode(chunk.content));
        }
        offset = chunk.nextOffset;
        if (chunk.eof) controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="${safeDownloadName(artifactId)}.txt"`,
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function safeDownloadName(artifactId: string): string {
  const normalized = artifactId.replaceAll(/[^a-zA-Z0-9._-]/gu, "_").slice(0, 80);
  return normalized.length === 0 ? "artifact" : normalized;
}
