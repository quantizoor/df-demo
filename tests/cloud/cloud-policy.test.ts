import { describe, expect, it } from "vitest";
import {
  assertCloudExecutionEnvironment,
  assertLeaseMatchesRuntime,
  isCloudExecutionEnvironment,
} from "../../src/cloud/runtime-marker.js";
import {
  loadProviderConfiguration,
  providerCredentialValues,
} from "../../src/cloud/config.js";

describe("cloud execution marker", () => {
  it.each([
    ["daytona", "DAYTONA_WORKSPACE_ID"],
    ["e2b", "E2B_SANDBOX_ID"],
    ["modal", "MODAL_TASK_ID"],
  ] as const)("accepts an attested %s runtime", (provider, markerName) => {
    const environment = {
      DF_CLOUD_EXECUTION: "1",
      [markerName]: "sandbox-123",
    };
    expect(assertCloudExecutionEnvironment(provider, environment)).toEqual({
      provider,
      sandboxId: "sandbox-123",
      markerEnvironmentName: markerName,
    });
    expect(isCloudExecutionEnvironment(provider, environment)).toBe(true);
  });

  it("fails closed when only the opt-in flag is present", () => {
    expect(() =>
      assertCloudExecutionEnvironment("daytona", { DF_CLOUD_EXECUTION: "1" }),
    ).toThrow(/runtime marker/u);
    expect(isCloudExecutionEnvironment("daytona", { DF_CLOUD_EXECUTION: "1" })).toBe(false);
  });

  it("fails closed when only a provider marker is present", () => {
    expect(() =>
      assertCloudExecutionEnvironment("e2b", { E2B_SANDBOX_ID: "sandbox-123" }),
    ).toThrow(/DF_CLOUD_EXECUTION/u);
  });

  it("rejects a lease copied into a different sandbox", () => {
    const lease = {
      provider: "modal" as const,
      sandboxId: "modal-a",
      createdAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-07-01T01:00:00.000Z",
      imageReference: `ghcr.io/parallaxai/dark-factory@sha256:${"a".repeat(64)}`,
      imageDigest: `sha256:${"a".repeat(64)}`,
      regionClass: "eu",
      resources: {
        architecture: "arm64" as const,
        cpuCores: 4,
        memoryMiB: 8192,
        diskMiB: 16_384,
      },
      networkPolicyHash: "b".repeat(64),
      marker: {
        provider: "modal" as const,
        sandboxId: "modal-a",
        markerEnvironmentName: "MODAL_TASK_ID",
      },
    };
    expect(() =>
      assertLeaseMatchesRuntime(lease, {
        DF_CLOUD_EXECUTION: "1",
        MODAL_TASK_ID: "modal-b",
      }),
    ).toThrow(/does not match/u);
  });
});

describe("provider configuration", () => {
  it("returns credential references without retaining credential values", () => {
    const configuration = loadProviderConfiguration("daytona", {
      DAYTONA_API_KEY: "super-secret-value",
      DAYTONA_TARGET: "eu",
    });
    expect(configuration).toMatchObject({
      provider: "daytona",
      endpoint: "https://app.daytona.io/api",
      credentialEnvironmentNames: ["DAYTONA_API_KEY"],
      target: "eu",
    });
    expect(JSON.stringify(configuration)).not.toContain("super-secret-value");
    expect(configuration.configFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires every Modal credential by environment name", () => {
    expect(() =>
      loadProviderConfiguration("modal", { MODAL_TOKEN_ID: "id-only" }),
    ).toThrow(/MODAL_TOKEN_SECRET/u);
  });

  it("rejects endpoints that embed credentials or query data", () => {
    expect(() =>
      loadProviderConfiguration("e2b", {
        E2B_API_KEY: "secret",
        E2B_API_URL: "https://user:secret@example.test/api?token=secret",
      }),
    ).toThrow(/credential/u);
  });

  it("resolves credential values only at the transport edge", () => {
    const configuration = loadProviderConfiguration("e2b", { E2B_API_KEY: "secret" });
    expect(providerCredentialValues(configuration, { E2B_API_KEY: "secret" })).toEqual({
      E2B_API_KEY: "secret",
    });
    expect(() => providerCredentialValues(configuration, {})).toThrow(/no longer available/u);
  });
});
