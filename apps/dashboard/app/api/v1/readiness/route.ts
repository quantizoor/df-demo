import { inspectDashboardReadiness } from "dark-factory/local-dashboard";

import { dashboardProjectRoot, dashboardStateRoot } from "@/lib/server/config";
import { apiJson, readJsonObject, withDashboardMutation } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_FIELDS = new Set(["piRepository", "credentialsFile", "claudeExecutable"]);

export async function POST(request: Request): Promise<Response> {
  return withDashboardMutation(request, async () => {
    const body = await readJsonObject(request);
    if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) {
      throw Object.assign(new Error("Readiness request contains an unsupported field"), {
        status: 400,
      });
    }
    const readiness = await inspectDashboardReadiness({
      stateRoot: dashboardStateRoot,
      projectRoot: dashboardProjectRoot,
      ...optionalPath(body.piRepository, "piRepository"),
      ...optionalPath(body.credentialsFile, "credentialsFile"),
      ...optionalPath(body.claudeExecutable, "claudeExecutable"),
    });
    return apiJson({ readiness });
  });
}

function optionalPath(value: unknown, name: string): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 4_096 ||
    value.includes("\0")
  ) {
    throw Object.assign(new Error(`${name} must be a valid path string`), { status: 400 });
  }
  return { [name]: value.trim() };
}
