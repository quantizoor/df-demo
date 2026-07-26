import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const adapterUrl = new URL("../../src/terminal-bench/assets/dark_factory_pi.py", import.meta.url);

describe("Microsoft Foundry Pi adapter source contract", () => {
  it("derives one Azure endpoint and writes a root-owned models.json", async () => {
    const source = await readFile(adapterUrl, "utf8");
    expect(source).toContain('f"https://{resource_name}.services.ai.azure.com/anthropic"');
    expect(source).toContain('"apiKey": "$ANTHROPIC_FOUNDRY_API_KEY"');
    expect(source).toContain('"api": "anthropic-messages"');
    expect(source).toContain('"forceAdaptiveThinking": True');
    expect(source).toContain('"chown root:root "');
    expect(source).toContain('"chmod 0644 "');
    expect(source).toContain('"/installed-agent/foundry-config/models.json; "');
    expect(source).toContain('if provider == "microsoft-foundry"');
    expect(source).toContain('[ -n "${ANTHROPIC_FOUNDRY_API_KEY:-}" ]');
    expect(source).toContain(
      "# Daytona secret placeholders are scoped to the sandbox where they were",
    );
    expect(source).toContain("--no-extensions");
    expect(source).not.toContain("ANTHROPIC_FOUNDRY_BASE_URL");
  });
});
