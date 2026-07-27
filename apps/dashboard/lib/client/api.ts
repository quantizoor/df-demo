"use client";

import useSWR, { mutate as globalMutate } from "swr";
import useSWRInfinite from "swr/infinite";
import type {
  ArtifactChunk,
  ArtifactDescriptor,
  CampaignDetail,
  CampaignSummary,
  ExperimentDetail,
  ExperimentSummary,
  PerformancePoint,
  ReadinessReport,
  TaskHealth,
  TaskLogChunk,
  TaskLogIndex,
} from "./types";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface ExperimentPage {
  items: ExperimentSummary[];
  nextCursor: string | null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      ...init,
      headers: {
        "Content-Type": "application/json",
        "x-df-dashboard-request": "1",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(
      "The local dashboard backend is offline. Restart it with pnpm dashboard:start, then retry.",
      0,
    );
  }

  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      const returnTo = `${window.location.pathname}${window.location.search}`;
      const bootstrap = new URL("/api/v1/session/bootstrap", window.location.origin);
      bootstrap.searchParams.set("returnTo", returnTo);
      window.location.replace(`${bootstrap.pathname}${bootstrap.search}`);
      return new Promise<never>(() => undefined);
    }

    const body = await response.json().catch(() => null);
    const message =
      body && typeof body === "object" && "error" in body
        ? typeof body.error === "string"
          ? body.error
          : body.error &&
              typeof body.error === "object" &&
              "message" in body.error &&
              typeof body.error.message === "string"
            ? body.error.message
            : `Request failed (${response.status})`
        : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

function arrayFrom<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return [];
}

function objectFrom<T>(value: unknown, key: string): T {
  if (
    value &&
    typeof value === "object" &&
    key in value &&
    (value as Record<string, unknown>)[key]
  ) {
    return (value as Record<string, unknown>)[key] as T;
  }
  return value as T;
}

function nullableObjectFrom<T>(value: unknown, key: string): T | null {
  if (value && typeof value === "object" && key in value) {
    return ((value as Record<string, unknown>)[key] ?? null) as T | null;
  }
  return null;
}

const swrOptions = {
  refreshInterval: 3_000,
  revalidateOnFocus: true,
  keepPreviousData: true,
};

export function useCampaigns() {
  const swr = useSWR("/api/v1/campaigns", request, swrOptions);
  return {
    ...swr,
    data: swr.data ? arrayFrom<CampaignSummary>(swr.data, ["campaigns", "items"]) : undefined,
  };
}

export function useCampaign(campaignId: string) {
  const key = campaignId ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}` : null;
  const swr = useSWR(key, request, swrOptions);
  return {
    ...swr,
    data: swr.data ? objectFrom<CampaignDetail>(swr.data, "campaign") : undefined,
  };
}

export function useExperiments(campaignId: string) {
  const swr = useSWRInfinite<ExperimentPage>(
    (pageIndex, previousPage) => {
      if (!campaignId || (pageIndex > 0 && previousPage?.nextCursor === null)) return null;
      const cursor =
        pageIndex > 0 && previousPage?.nextCursor
          ? `&cursor=${encodeURIComponent(previousPage.nextCursor)}`
          : "";
      return `/api/v1/campaigns/${encodeURIComponent(campaignId)}/experiments?limit=200${cursor}`;
    },
    async (url: string) => {
      const value = await request<unknown>(url);
      const items = arrayFrom<ExperimentSummary>(value, ["experiments", "items"]);
      const nextCursor =
        value && typeof value === "object" && "nextCursor" in value
          ? typeof value.nextCursor === "string"
            ? value.nextCursor
            : null
          : null;
      return { items, nextCursor };
    },
    {
      ...swrOptions,
      persistSize: true,
      revalidateAll: false,
    },
  );
  const pages = swr.data;
  const experiments = pages
    ? [
        ...new Map(
          pages
            .flatMap((page) => page.items)
            .map((experiment) => [experiment.experimentId, experiment]),
        ).values(),
      ]
    : undefined;
  const lastPage = pages?.at(-1);
  const isLoadingMore = swr.isValidating && Boolean(pages) && (pages?.length ?? 0) < swr.size;
  return {
    ...swr,
    data: experiments,
    nextCursor: lastPage?.nextCursor ?? null,
    hasMore: lastPage?.nextCursor != null,
    isLoadingMore,
    loadMore: async () => {
      if (lastPage?.nextCursor == null || isLoadingMore) return;
      await swr.setSize((size) => size + 1);
    },
  };
}

export function useExperiment(campaignId: string, experimentId: string) {
  const key =
    campaignId && experimentId
      ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experimentId)}`
      : null;
  const swr = useSWR(key, request, swrOptions);
  return {
    ...swr,
    data: swr.data ? objectFrom<ExperimentDetail>(swr.data, "experiment") : undefined,
  };
}

export function usePerformance(campaignId: string) {
  const key = campaignId ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/performance` : null;
  const swr = useSWR(key, request, swrOptions);
  return {
    ...swr,
    data: swr.data ? arrayFrom<PerformancePoint>(swr.data, ["points", "performance"]) : undefined,
  };
}

export function useTaskHealth(campaignId: string) {
  const key = campaignId ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/tasks` : null;
  const swr = useSWR(key, request, swrOptions);
  return {
    ...swr,
    data: swr.data ? arrayFrom<TaskHealth>(swr.data, ["tasks", "items"]) : undefined,
  };
}

export function useTaskLogs(campaignId: string) {
  const key = campaignId ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/task-logs` : null;
  const swr = useSWR(key, request, { ...swrOptions, refreshInterval: 2_000 });
  return {
    ...swr,
    data:
      swr.data === undefined ? undefined : nullableObjectFrom<TaskLogIndex>(swr.data, "taskLogs"),
  };
}

export function getTaskLogChunk(
  campaignId: string,
  logId: string,
  options: { readonly offset?: number; readonly tail?: boolean } = {},
): Promise<TaskLogChunk> {
  const query = new URLSearchParams({ limit: "262144" });
  if (options.tail === true) query.set("tail", "1");
  else if (options.offset !== undefined) query.set("offset", String(options.offset));
  return request(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/task-logs/${encodeURIComponent(logId)}?${query}`,
  );
}

export function useArtifacts(campaignId: string, experimentId: string) {
  const key =
    campaignId && experimentId
      ? `/api/v1/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experimentId)}/artifacts`
      : null;
  const swr = useSWR(key, request, swrOptions);
  return {
    ...swr,
    data: swr.data ? arrayFrom<ArtifactDescriptor>(swr.data, ["artifacts", "items"]) : undefined,
  };
}

export function getArtifactChunk(
  campaignId: string,
  experimentId: string,
  artifactId: string,
  offset = 0,
): Promise<ArtifactChunk> {
  return request(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/experiments/${encodeURIComponent(experimentId)}/artifacts/${encodeURIComponent(artifactId)}?offset=${offset}&limit=262144`,
  );
}

export async function createCampaign(input: {
  campaignId: string;
  budget: { type: "capped"; maximumUsd: number } | { type: "unbounded"; explicitlyConfirmed: true };
  piRepository?: string;
  credentialsFile?: string;
  claudeExecutable?: string;
}) {
  const result = await request<unknown>("/api/v1/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });
  await globalMutate("/api/v1/campaigns");
  return result;
}

export async function checkCampaignReadiness(input: {
  piRepository?: string;
  credentialsFile?: string;
  claudeExecutable?: string;
}): Promise<ReadinessReport> {
  const result = await request<unknown>("/api/v1/readiness", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return objectFrom<ReadinessReport>(result, "readiness");
}

export async function startCampaign(campaignId: string, mode: "continuous" | "once") {
  const result = await request<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/start`,
    { method: "POST", body: JSON.stringify({ mode }) },
  );
  await globalMutate((key) => typeof key === "string" && key.includes(campaignId));
  return result;
}

export async function stopCampaign(campaignId: string, mode: "after-phase" | "cancel-active") {
  const result = await request<unknown>(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/stop`,
    { method: "POST", body: JSON.stringify({ mode }) },
  );
  await globalMutate((key) => typeof key === "string" && key.includes(campaignId));
  return result;
}
