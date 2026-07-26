import {
  serializeTrustedPiPrompt,
  type PiThinkingLevel,
} from "../harness/pi-rpc.js";

export const DARK_FACTORY_PI_HARBOR_IMPORT_PATH =
  "dark_factory_pi:DarkFactoryPi" as const;

export interface PiHarborAgentOptions {
  readonly adapterImportPath: typeof DARK_FACTORY_PI_HARBOR_IMPORT_PATH;
  readonly adapterSha256: string;
  readonly provider: string;
  /**
   * Exact existing provider deployment name. It may differ from the public
   * model identity and is the value sent in Foundry API requests.
   */
  readonly modelId: string;
  readonly modelFamily?: string;
  /**
   * Public Microsoft Foundry resource name. The trusted adapter derives the
   * only permitted API hostname from this DNS label; callers cannot inject a
   * URL. It is required only for the `microsoft-foundry` provider.
   */
  readonly foundryResourceName?: string;
  readonly thinkingLevel: PiThinkingLevel;
  readonly enabledTools: readonly string[];
  /**
   * Exact environment targets granted to the evaluated model. Source secret
   * names remain a cloud-provider concern and are never serialized here.
   */
  readonly credentialEnvironmentNames: readonly string[];
  readonly timeoutMs: number;
}

export interface PiHarborAgentSpec {
  readonly boundary: "trusted-harbor-adapter";
  readonly adapterImportPath: typeof DARK_FACTORY_PI_HARBOR_IMPORT_PATH;
  readonly adapterSha256: string;
  readonly evaluatedModel: {
    readonly provider: string;
    readonly modelId: string;
    readonly modelFamily?: string;
    readonly thinkingLevel: PiThinkingLevel;
    readonly foundryResourceName?: string;
  };
  readonly promptTransport: "harbor-pi-json-events-v1";
  readonly rawEventRetention: "trusted-only";
  readonly enabledTools: readonly string[];
  readonly credentialEnvironmentNames: readonly string[];
  readonly timeoutMs: number;
}

export interface TrustedTerminalBenchInstruction {
  readonly sensitivity: "terminal-bench-instruction-trusted-only";
  readonly source: "harbor-task-instruction";
  readonly graderMaterialAttached: false;
  readonly requestId: string;
  readonly instruction: string;
}

const IMPORT_PATH =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_TOOL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_FOUNDRY_RESOURCE =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PI_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface ProviderEnvironmentPolicy {
  readonly authentication: readonly string[];
  readonly optionalConfiguration: readonly string[];
}

/**
 * Synchronized to the pinned private Pi fork's provider environment contract.
 * File-backed ambient credentials are deliberately excluded: evaluated runs
 * receive only explicit one-use cloud secret bindings.
 */
const PROVIDER_ENVIRONMENT_POLICIES: Readonly<
  Record<string, ProviderEnvironmentPolicy>
> = {
  anthropic: {
    authentication: [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
    ],
    optionalConfiguration: [],
  },
  "microsoft-foundry": {
    authentication: ["ANTHROPIC_FOUNDRY_API_KEY"],
    optionalConfiguration: [],
  },
  openai: {
    authentication: ["OPENAI_API_KEY"],
    optionalConfiguration: [],
  },
  "azure-openai-responses": {
    authentication: ["AZURE_OPENAI_API_KEY"],
    optionalConfiguration: [
      "AZURE_OPENAI_BASE_URL",
      "AZURE_OPENAI_RESOURCE_NAME",
      "AZURE_OPENAI_API_VERSION",
      "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    ],
  },
  "github-copilot": {
    authentication: ["COPILOT_GITHUB_TOKEN"],
    optionalConfiguration: [],
  },
  google: {
    authentication: ["GEMINI_API_KEY"],
    optionalConfiguration: [],
  },
  "google-vertex": {
    authentication: ["GOOGLE_CLOUD_API_KEY"],
    optionalConfiguration: [
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GOOGLE_CLOUD_LOCATION",
    ],
  },
  groq: {
    authentication: ["GROQ_API_KEY"],
    optionalConfiguration: [],
  },
  mistral: {
    authentication: ["MISTRAL_API_KEY"],
    optionalConfiguration: [],
  },
  openrouter: {
    authentication: ["OPENROUTER_API_KEY"],
    optionalConfiguration: [],
  },
  xai: {
    authentication: ["XAI_API_KEY"],
    optionalConfiguration: [],
  },
  deepseek: {
    authentication: ["DEEPSEEK_API_KEY"],
    optionalConfiguration: [],
  },
  cerebras: {
    authentication: ["CEREBRAS_API_KEY"],
    optionalConfiguration: [],
  },
  nvidia: {
    authentication: ["NVIDIA_API_KEY"],
    optionalConfiguration: [],
  },
  huggingface: {
    authentication: ["HF_TOKEN"],
    optionalConfiguration: [],
  },
  fireworks: {
    authentication: ["FIREWORKS_API_KEY"],
    optionalConfiguration: [],
  },
  together: {
    authentication: ["TOGETHER_API_KEY"],
    optionalConfiguration: [],
  },
  "vercel-ai-gateway": {
    authentication: ["AI_GATEWAY_API_KEY"],
    optionalConfiguration: [],
  },
  zai: {
    authentication: ["ZAI_API_KEY"],
    optionalConfiguration: [],
  },
  "zai-coding-cn": {
    authentication: ["ZAI_CODING_CN_API_KEY"],
    optionalConfiguration: [],
  },
  minimax: {
    authentication: ["MINIMAX_API_KEY"],
    optionalConfiguration: [],
  },
  "minimax-cn": {
    authentication: ["MINIMAX_CN_API_KEY"],
    optionalConfiguration: [],
  },
  moonshotai: {
    authentication: ["MOONSHOT_API_KEY"],
    optionalConfiguration: [],
  },
  "moonshotai-cn": {
    authentication: ["MOONSHOT_API_KEY"],
    optionalConfiguration: [],
  },
  "kimi-coding": {
    authentication: ["KIMI_API_KEY"],
    optionalConfiguration: [],
  },
  opencode: {
    authentication: ["OPENCODE_API_KEY"],
    optionalConfiguration: [],
  },
  "opencode-go": {
    authentication: ["OPENCODE_API_KEY"],
    optionalConfiguration: [],
  },
};

export class PiHarborAgentError extends Error {
  override readonly name = "PiHarborAgentError";
}

export function allowedPiProviderEnvironmentNames(
  provider: string,
): readonly string[] {
  const policy = PROVIDER_ENVIRONMENT_POLICIES[provider];
  if (policy === undefined) return [];
  return [
    ...policy.authentication,
    ...policy.optionalConfiguration,
  ];
}

export function createPiHarborAgentSpec(
  options: PiHarborAgentOptions,
): PiHarborAgentSpec {
  if (
    options.adapterImportPath !== DARK_FACTORY_PI_HARBOR_IMPORT_PATH ||
    !IMPORT_PATH.test(options.adapterImportPath) ||
    !SHA256.test(options.adapterSha256)
  ) {
    throw new PiHarborAgentError(
      "The trusted Harbor adapter must use an exact import path and source digest.",
    );
  }
  if (
    !SAFE_IDENTIFIER.test(options.provider) ||
    !SAFE_IDENTIFIER.test(options.modelId) ||
    !PI_THINKING_LEVELS.has(options.thinkingLevel) ||
    options.enabledTools.length === 0 ||
    options.enabledTools.some((tool) => !SAFE_TOOL.test(tool)) ||
    options.credentialEnvironmentNames.length === 0 ||
    options.credentialEnvironmentNames.some(
      (name) => !SAFE_ENVIRONMENT_NAME.test(name),
    ) ||
    new Set(options.credentialEnvironmentNames).size !==
      options.credentialEnvironmentNames.length ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 24 * 60 * 60_000
  ) {
    throw new PiHarborAgentError("The evaluated Pi model, tools, or timeout are malformed.");
  }
  const environmentPolicy =
    PROVIDER_ENVIRONMENT_POLICIES[options.provider];
  const allowedEnvironmentNames =
    allowedPiProviderEnvironmentNames(options.provider);
  if (
    environmentPolicy === undefined ||
    options.credentialEnvironmentNames.some(
      (name) => !allowedEnvironmentNames.includes(name),
    ) ||
    !options.credentialEnvironmentNames.some((name) =>
      environmentPolicy.authentication.includes(name),
    )
  ) {
    throw new PiHarborAgentError(
      "The evaluated Pi provider credential grant is unsupported or incomplete.",
    );
  }
  const usesMicrosoftFoundry = options.provider === "microsoft-foundry";
  if (
    (usesMicrosoftFoundry &&
      (options.modelFamily !== "claude-opus-4-8" ||
        options.thinkingLevel !== "high" ||
        options.foundryResourceName === undefined ||
        !SAFE_FOUNDRY_RESOURCE.test(options.foundryResourceName))) ||
    (!usesMicrosoftFoundry &&
      (options.foundryResourceName !== undefined ||
        options.modelFamily !== undefined))
  ) {
    throw new PiHarborAgentError(
      "The evaluated Microsoft Foundry deployment binding is malformed.",
    );
  }
  return {
    boundary: "trusted-harbor-adapter",
    adapterImportPath: options.adapterImportPath,
    adapterSha256: options.adapterSha256,
    evaluatedModel: {
      provider: options.provider,
      modelId: options.modelId,
      ...(options.modelFamily === undefined
        ? {}
        : { modelFamily: options.modelFamily }),
      thinkingLevel: options.thinkingLevel,
      ...(options.foundryResourceName === undefined
        ? {}
        : { foundryResourceName: options.foundryResourceName }),
    },
    promptTransport: "harbor-pi-json-events-v1",
    rawEventRetention: "trusted-only",
    enabledTools: [...new Set(options.enabledTools)].sort(),
    credentialEnvironmentNames: [
      ...options.credentialEnvironmentNames,
    ].sort(),
    timeoutMs: options.timeoutMs,
  };
}

export function serializeTrustedTerminalBenchInstruction(
  input: TrustedTerminalBenchInstruction,
): string {
  if (
    input.sensitivity !== "terminal-bench-instruction-trusted-only" ||
    input.source !== "harbor-task-instruction" ||
    input.graderMaterialAttached !== false
  ) {
    throw new PiHarborAgentError("Terminal-Bench instructions cannot cross the trusted boundary.");
  }
  return serializeTrustedPiPrompt({
    sensitivity: "benchmark-task-trusted-evaluator-only",
    requestId: input.requestId,
    message: input.instruction,
  });
}
