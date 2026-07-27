import { describe, expect, it } from "vitest";

import { dashboardReturnDestination } from "./session";

const origin = "http://127.0.0.1:3217";

describe("dashboardReturnDestination", () => {
  it("preserves a safe dashboard path and query on the configured origin", () => {
    expect(dashboardReturnDestination("/campaigns/campaign-1?tab=logs#ignored", origin).href).toBe(
      "http://127.0.0.1:3217/campaigns/campaign-1?tab=logs",
    );
  });

  it.each([
    null,
    "",
    "campaigns",
    "//example.com/campaigns",
    "/\\example.com/campaigns",
    "https://example.com/campaigns",
    "/api",
    "/api/v1/campaigns",
  ])("falls back for an unsafe return path: %s", (returnTo) => {
    expect(dashboardReturnDestination(returnTo, origin).href).toBe(
      "http://127.0.0.1:3217/campaigns",
    );
  });
});
