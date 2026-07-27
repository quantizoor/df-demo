import { describe, expect, it } from "vitest";

import { apiJson, boundedInteger, readJsonObject } from "./http";

describe("dashboard HTTP helpers", () => {
  it("marks JSON responses as private and non-cacheable", async () => {
    const response = apiJson({ ok: true }, { status: 202 });

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("accepts bounded pagination values and rejects oversized input", () => {
    expect(boundedInteger("256", 64, 1, 1024)).toBe(256);
    expect(boundedInteger(null, 64, 1, 1024)).toBe(64);
    expect(() => boundedInteger("1025", 64, 1, 1024)).toThrow(
      "Value must be an integer from 1 to 1024",
    );
  });

  it("rejects non-JSON request bodies before parsing them", async () => {
    const request = new Request("http://127.0.0.1/api", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });

    await expect(readJsonObject(request)).rejects.toThrow("Content-Type must be application/json");
  });
});
