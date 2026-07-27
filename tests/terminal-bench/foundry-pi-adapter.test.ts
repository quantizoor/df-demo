import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const adapterUrl = new URL("../../src/terminal-bench/assets/dark_factory_pi.py", import.meta.url);
const execFileAsync = promisify(execFile);

describe("Microsoft Foundry Pi adapter source contract", () => {
  it("derives one Azure endpoint and writes root-owned Foundry config", async () => {
    const source = await readFile(adapterUrl, "utf8");
    expect(source).toContain('f"https://{resource_name}.services.ai.azure.com/anthropic"');
    expect(source).toContain('"apiKey": "$ANTHROPIC_FOUNDRY_API_KEY"');
    expect(source).toContain('"api": "anthropic-messages"');
    expect(source).toContain('"forceAdaptiveThinking": True');
    expect(source).toContain('"baseDelayMs": 60_000');
    expect(source).toContain('"maxRetries": 3');
    expect(source).toContain('"chown root:root "');
    expect(source).toContain('"chmod 0644 "');
    expect(source).toContain('"/installed-agent/foundry-config/models.json; "');
    expect(source).toContain('"/installed-agent/foundry-config/settings.json; "');
    expect(source).toContain('if provider == "microsoft-foundry"');
    expect(source).toContain('[ -n "${ANTHROPIC_FOUNDRY_API_KEY:-}" ]');
    expect(source).toContain(
      "# Daytona secret placeholders are scoped to the sandbox where they were",
    );
    expect(source).toContain("--no-extensions");
    expect(source).toContain('"tool result",\n                            allow_images=True,');
    expect(source).toContain('output.append("[image omitted from trajectory]")');
    expect(source).toContain('event["attempt"] != pending_auto_retry_attempt + 1');
    expect(source).toContain("if pending_failed_assistant_messages == 1:");
    expect(source).toContain('r"^[A-Za-z0-9._@-]+(?:/[A-Za-z0-9._@-]+)*$"');
    expect(source).not.toContain("ANTHROPIC_FOUNDRY_BASE_URL");
  });

  it("records image tool results without embedding image bytes", async () => {
    const probe = `
import ast
import json
import sys

source = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(source)
function = next(
    node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name == "_content_text"
)
module = ast.Module(body=[function], type_ignores=[])
ast.fix_missing_locations(module)
namespace = {}
exec(compile(module, sys.argv[1], "exec"), namespace)
content_text = namespace["_content_text"]
image_data = "sensitive-image-bytes"
converted = content_text(
    [
        {"type": "text", "text": "tool output"},
        {"type": "image", "mimeType": "image/png", "data": image_data},
    ],
    "tool result",
    allow_images=True,
)
try:
    content_text(
        [{"type": "image", "mimeType": "image/png", "data": image_data}],
        "user message",
    )
except RuntimeError as error:
    user_error = str(error)
else:
    user_error = None
print(json.dumps({"converted": converted, "user_error": user_error}))
`;
    const result = await execFileAsync("python3", ["-c", probe, fileURLToPath(adapterUrl)]);
    const output = JSON.parse(String(result.stdout)) as {
      readonly converted: string;
      readonly user_error: string | null;
    };
    expect(output.converted).toBe("tool output\n[image omitted from trajectory]");
    expect(output.converted).not.toContain("sensitive-image-bytes");
    expect(output.user_error).toBe(
      "Pi trajectory user message contains unsupported multimodal content",
    );
  });
});
