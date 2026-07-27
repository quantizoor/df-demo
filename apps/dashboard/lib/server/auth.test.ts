import { describe, expect, it } from "vitest";

import { isAllowedDashboardOrigin, safeEqual } from "./auth";

describe("dashboard session comparison", () => {
  it("compares equal tokens without accepting prefixes or suffixes", () => {
    const token = "a".repeat(64);

    expect(safeEqual(token, token)).toBe(true);
    expect(safeEqual(token.slice(1), token)).toBe(false);
    expect(safeEqual(`${token}a`, token)).toBe(false);
    expect(safeEqual("b".repeat(64), token)).toBe(false);
  });

  it("compares mutations with the configured browser-facing loopback origin", () => {
    const configured = "http://127.0.0.1:3217";

    expect(isAllowedDashboardOrigin(configured, configured)).toBe(true);
    expect(isAllowedDashboardOrigin("http://localhost:3217", configured)).toBe(false);
    expect(isAllowedDashboardOrigin(null, configured)).toBe(false);
  });
});
