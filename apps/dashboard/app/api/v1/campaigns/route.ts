import { createDashboardCampaign, listDashboardCampaigns } from "dark-factory/local-dashboard";

import { dashboardStateRoot } from "@/lib/server/config";
import {
  apiJson,
  readJsonObject,
  withDashboardMutation,
  withDashboardSession,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withDashboardSession(request, async () => {
    const campaigns = await listDashboardCampaigns(dashboardStateRoot);
    return apiJson({ campaigns });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withDashboardMutation(request, async () => {
    const body = await readJsonObject(request);
    const campaignId = requiredString(body.campaignId, "campaignId");
    const budget = parseBudget(body.budget);
    const campaign = await createDashboardCampaign({
      stateRoot: dashboardStateRoot,
      campaignId,
      budget,
      ...optionalString(body.piRepository, "piRepository"),
      ...optionalString(body.credentialsFile, "credentialsFile"),
      ...optionalString(body.claudeExecutable, "claudeExecutable"),
    });
    return apiJson({ campaign }, { status: 201 });
  });
}

function parseBudget(
  value: unknown,
): { type: "capped"; maximumUsd: number } | { type: "unbounded"; explicitlyConfirmed: true } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("budget must be an object"), { status: 400 });
  }
  const budget = value as Record<string, unknown>;
  if (budget.type === "capped") {
    const maximumUsd = budget.maximumUsd;
    if (typeof maximumUsd !== "number" || !Number.isFinite(maximumUsd) || maximumUsd <= 0) {
      throw Object.assign(new Error("budget.maximumUsd must be a positive number"), {
        status: 400,
      });
    }
    return { type: "capped", maximumUsd };
  }
  if (budget.type === "unbounded" && budget.explicitlyConfirmed === true) {
    return { type: "unbounded", explicitlyConfirmed: true };
  }
  throw Object.assign(new Error("budget must be capped or explicitly confirmed as unbounded"), {
    status: 400,
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw Object.assign(new Error(`${name} must be a non-empty string`), { status: 400 });
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): Record<string, string> {
  if (value === undefined || value === null || value === "") return {};
  return { [name]: requiredString(value, name) };
}
