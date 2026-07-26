import { describe, expect, it } from "vitest";
import {
  allowedPiProviderEnvironmentNames,
  createPiHarborAgentSpec,
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  PiHarborAgentError,
} from "../../src/terminal-bench/pi-agent.js";

function base() {
  return {
    adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
    adapterSha256: "a".repeat(64),
    provider: "openai",
    modelId: "gpt-5.6",
    thinkingLevel: "high" as const,
    enabledTools: ["read", "write", "bash"],
    credentialEnvironmentNames: ["OPENAI_API_KEY"],
    timeoutMs: 3_600_000,
  };
}

describe("evaluated Pi credential grants", () => {
  it("seals the exact provider-specific environment target list", () => {
    const spec = createPiHarborAgentSpec(base());
    expect(spec.credentialEnvironmentNames).toEqual([
      "OPENAI_API_KEY",
    ]);
    expect(
      allowedPiProviderEnvironmentNames("github-copilot"),
    ).toEqual(["COPILOT_GITHUB_TOKEN"]);
  });

  it("rejects cloud, optimizer, unrelated-provider, and duplicate secret targets", () => {
    for (const credentialEnvironmentNames of [
      ["DAYTONA_API_KEY"],
      ["ANTHROPIC_API_KEY"],
      ["OPENAI_API_KEY", "OPENAI_API_KEY"],
    ]) {
      expect(() =>
        createPiHarborAgentSpec({
          ...base(),
          credentialEnvironmentNames,
        }),
      ).toThrow(PiHarborAgentError);
    }
  });

  it("requires authentication even when optional Azure configuration is granted", () => {
    expect(() =>
      createPiHarborAgentSpec({
        ...base(),
        provider: "azure-openai-responses",
        credentialEnvironmentNames: [
          "AZURE_OPENAI_BASE_URL",
          "AZURE_OPENAI_API_VERSION",
        ],
      }),
    ).toThrow(PiHarborAgentError);

    expect(
      createPiHarborAgentSpec({
        ...base(),
        provider: "azure-openai-responses",
        credentialEnvironmentNames: [
          "AZURE_OPENAI_API_KEY",
          "AZURE_OPENAI_BASE_URL",
        ],
      }).credentialEnvironmentNames,
    ).toEqual([
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
    ]);
  });
});
