import {
  assertDashboardMutation,
  assertDashboardSession,
  DashboardForbiddenError,
  DashboardUnauthorizedError,
} from "./auth";

export const API_NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
} as const;

export function apiJson(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, headerValue] of Object.entries(API_NO_STORE_HEADERS)) {
    if (!headers.has(key)) headers.set(key, headerValue);
  }
  return Response.json(value, { ...init, headers });
}

export async function withDashboardSession(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    await assertDashboardSession(request);
    return await handler();
  } catch (error) {
    return apiError(error);
  }
}

export async function withDashboardMutation(
  request: Request,
  handler: () => Promise<Response>,
): Promise<Response> {
  try {
    await assertDashboardMutation(request);
    return await handler();
  } catch (error) {
    return apiError(error);
  }
}

export function apiError(error: unknown): Response {
  if (error instanceof DashboardUnauthorizedError) {
    return apiJson({ error: { code: "UNAUTHORIZED", message: error.message } }, { status: 401 });
  }
  if (error instanceof DashboardForbiddenError) {
    return apiJson({ error: { code: "FORBIDDEN", message: error.message } }, { status: 403 });
  }

  const status = errorStatus(error);
  const message =
    status >= 500
      ? "The dashboard could not complete this request"
      : safeErrorMessage(error, "The requested resource is unavailable");
  return apiJson(
    {
      error: {
        code: status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "REQUEST_FAILED",
        message,
      },
    },
    { status },
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 400 });
  }
  const value: unknown = await request.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Request body must be a JSON object"), { status: 400 });
  }
  return value as Record<string, unknown>;
}

export function boundedInteger(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw Object.assign(new Error(`Value must be an integer from ${minimum} to ${maximum}`), {
      status: 400,
    });
  }
  return parsed;
}

function errorStatus(error: unknown): number {
  if (
    error !== null &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status <= 599
  ) {
    return error.status;
  }
  const message = safeErrorMessage(error, "").toLowerCase();
  if (message.includes("not found") || message.includes("does not exist")) return 404;
  if (
    message.includes("already running") ||
    message.includes("conflict") ||
    message.includes("locked")
  ) {
    return 409;
  }
  if (message.includes("invalid") || message.includes("must be")) return 400;
  return 500;
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const firstLine = error.message.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.length === 0 ? fallback : firstLine.slice(0, 300);
}
