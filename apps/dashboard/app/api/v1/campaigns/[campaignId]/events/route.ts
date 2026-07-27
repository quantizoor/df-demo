import { dashboardCampaignEventSnapshot } from "dark-factory/local-dashboard";
import { assertDashboardSession } from "@/lib/server/auth";
import { dashboardStateRoot } from "@/lib/server/config";
import { apiError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ campaignId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try {
    await assertDashboardSession(request);
    const { campaignId } = await context.params;
    const encoder = new TextEncoder();
    let cancelled = false;
    let lastRevision = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = async (): Promise<void> => {
          if (cancelled) return;
          try {
            const snapshot = await dashboardCampaignEventSnapshot(dashboardStateRoot, campaignId);
            if (snapshot.revision !== lastRevision) {
              lastRevision = snapshot.revision;
              controller.enqueue(
                encoder.encode(
                  `id: ${snapshot.revision}\nevent: campaign\ndata: ${JSON.stringify(snapshot.campaign)}\n\n`,
                ),
              );
            } else {
              controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
            }
          } catch {
            controller.enqueue(encoder.encode("event: refresh\ndata: {}\n\n"));
          }
          if (!cancelled) timer = setTimeout(emit, 2_000);
        };

        request.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            if (timer !== undefined) clearTimeout(timer);
            try {
              controller.close();
            } catch {
              // The browser may already have closed the stream.
            }
          },
          { once: true },
        );
        await emit();
      },
      cancel() {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
      },
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
