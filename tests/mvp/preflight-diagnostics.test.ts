import { describe, expect, it } from "vitest";

import {
  discoveryPhaseDiagnosticCode,
  formatMvpPreflightCliFailure,
  formatMvpPreflightWorkerFailure,
  MVP_DISCOVERY_FAILURE_PHASES,
  MVP_PREFLIGHT_DIAGNOSTIC_CODES,
  parseMvpDiscoveryFailurePhase,
  parseMvpPreflightWorkerFailure,
} from "../../src/mvp/preflight-diagnostics.js";

describe("MVP task-free preflight diagnostics", () => {
  it("round-trips only the fixed worker diagnostic allowlist", () => {
    for (const code of MVP_PREFLIGHT_DIAGNOSTIC_CODES) {
      expect(parseMvpPreflightWorkerFailure(formatMvpPreflightWorkerFailure(code))).toBe(code);
      expect(formatMvpPreflightCliFailure(code)).toBe(`MVP_PREFLIGHT_FAILED_CLOSED:${code}\n`);
    }
  });

  it("exposes artifact verification only through fixed artifact-class phases", () => {
    expect(
      MVP_PREFLIGHT_DIAGNOSTIC_CODES.filter((code) => code.startsWith("bootstrap-artifacts")),
    ).toEqual([
      "bootstrap-artifacts-pins",
      "bootstrap-artifacts-harbor",
      "bootstrap-artifacts-bun",
      "bootstrap-artifacts-adapter",
    ]);
    expect(
      parseMvpPreflightWorkerFailure("MVP_PREFLIGHT_FAILURE:bootstrap-artifacts\n"),
    ).toBeNull();
  });

  it.each([
    "",
    "MVP_PREFLIGHT_FAILURE:bootstrap-state",
    "MVP_PREFLIGHT_FAILURE:not-allowlisted\n",
    "MVP_PREFLIGHT_FAILURE:bootstrap-state\nextra\n",
    "prefix MVP_PREFLIGHT_FAILURE:bootstrap-state\n",
    "MVP_PREFLIGHT_FAILURE:bootstrap-state\r\n",
  ])("rejects malformed or extended worker output", (raw) => {
    expect(parseMvpPreflightWorkerFailure(raw)).toBeNull();
  });

  it("extracts only an allowlisted final discovery phase line", () => {
    for (const phase of MVP_DISCOVERY_FAILURE_PHASES) {
      expect(
        parseMvpDiscoveryFailurePhase(`private library output\nMVP_DISCOVERY_FAILURE:${phase}\n`),
      ).toBe(phase);
      expect(discoveryPhaseDiagnosticCode(phase)).toBe(`bootstrap-discovery-${phase}`);
    }
    expect(parseMvpDiscoveryFailurePhase("MVP_DISCOVERY_FAILURE:not-allowlisted\n")).toBeNull();
    expect(
      parseMvpDiscoveryFailurePhase("MVP_DISCOVERY_FAILURE:download\nprivate trailing output\n"),
    ).toBeNull();
  });
});
