import type { SecretReference } from "../cloud/types.js";
import type {
  LeaderboardEligibility,
  RunMode,
} from "../domain/models.js";
import { LEADERBOARD_ELIGIBILITY, RUN_MODES } from "../domain/models.js";
import {
  TERMINAL_BENCH_21_DATASET,
  TERMINAL_BENCH_21_TASK_COUNT,
  type TerminalBench21Pin,
  assertTerminalBench21Pin,
} from "../terminal-bench/pin.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../terminal-bench/pi-agent.js";

export type CloudProviderName = "daytona" | "e2b" | "modal";

export interface ImmutableCloudImage {
  readonly reference: string;
  readonly digest: `sha256:${string}`;
}

export interface BootstrapConfiguration {
  readonly cloudProvider: CloudProviderName;
  readonly cloudCredentialVariable: string;
  readonly cloudRegionClass: string;
  readonly trustedVolumeRoot: string;
  readonly images: {
    readonly control: ImmutableCloudImage;
    readonly optimizer: ImmutableCloudImage;
    readonly build: ImmutableCloudImage;
    readonly evaluator: ImmutableCloudImage;
  };
  readonly optimizer: {
    readonly model: string;
    readonly deploymentName: string;
    readonly foundryResourceName: string;
    readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
    readonly claudeCodeVersion: string;
    readonly secretReference: SecretReference;
  };
  readonly evaluated: {
    readonly provider: string;
    readonly model: string;
    readonly deploymentName: string;
    readonly reasoning: string;
    readonly foundryResourceName: string;
    readonly secretReferences: readonly SecretReference[];
  };
  readonly githubSecretReference: SecretReference;
  readonly harborSecretReferences: readonly SecretReference[];
  readonly mode: RunMode;
  readonly leaderboardEligibility: LeaderboardEligibility;
  readonly trustedZone: string;
  readonly signingKeyId: string;
  readonly terminalBench: TerminalBench21Pin;
  readonly budget: {
    readonly maximumUsd: number;
    readonly maximumTokens: number;
    readonly maximumWallTimeMs: number;
    readonly maximumAttempts: number;
    readonly maximumPrivacyReleases: number;
    readonly maximumPromotionLooks: number;
    readonly maximumOnlineError: number;
  };
}

export interface BootstrapReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly configuration: BootstrapConfiguration | null;
}

const PROVIDER_CREDENTIALS: Readonly<Record<CloudProviderName, string>> = {
  daytona: "DAYTONA_API_KEY",
  e2b: "E2B_API_KEY",
  modal: "MODAL_TOKEN_SECRET",
};

const IMAGE_ROLES = ["CONTROL", "OPTIMIZER", "BUILD", "EVALUATOR"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const OPTIMIZER_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const OPTIMIZER_SECRET_TARGETS = new Set([
  "ANTHROPIC_FOUNDRY_API_KEY",
]);
const SAFE_FOUNDRY_RESOURCE =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

const BASE_REQUIRED = [
  "DF_CLOUD_PROVIDER",
  "DF_CLOUD_REGION_CLASS",
  "DF_TRUSTED_CONTROL_PLANE",
  "DF_TRUSTED_VOLUME_ROOT",
  "DF_OPTIMIZER_MODEL",
  "DF_OPTIMIZER_DEPLOYMENT_NAME",
  "DF_FOUNDRY_RESOURCE_NAME",
  "DF_OPTIMIZER_EFFORT",
  "DF_CLAUDE_CODE_VERSION",
  "DF_OPTIMIZER_SECRET_SOURCE",
  "DF_OPTIMIZER_SECRET_TARGET",
  "DF_EVALUATED_PROVIDER",
  "DF_EVALUATED_MODEL",
  "DF_EVALUATED_DEPLOYMENT_NAME",
  "DF_EVALUATED_REASONING",
  "DF_EVALUATED_SECRET_BINDINGS_JSON",
  "DF_GITHUB_SECRET_SOURCE",
  "DF_HARBOR_SECRET_BINDINGS_JSON",
  "DF_MODE",
  "DF_LEADERBOARD_ELIGIBILITY",
  "DF_TRUSTED_ZONE",
  "DF_SIGNING_KEY_ID",
  "DF_HARBOR_VERSION",
  "DF_TBENCH_REGISTRY_REVISION",
  "DF_TBENCH_DATASET_CONTENT_SHA256",
  "DF_TBENCH_DATASET_MANIFEST_SHA256",
  "DF_HARBOR_PACKAGE_SHA256",
  "DF_HARBOR_EXECUTABLE_SHA256",
  "DF_PI_HARBOR_ADAPTER_SHA256",
  "DF_BUDGET_USD",
  "DF_BUDGET_TOKENS",
  "DF_BUDGET_WALL_TIME_MINUTES",
  "DF_BUDGET_ATTEMPTS",
  "DF_BUDGET_PRIVACY_RELEASES",
  "DF_BUDGET_PROMOTION_LOOKS",
  "DF_BUDGET_ONLINE_ERROR",
  ...IMAGE_ROLES.flatMap((role) => [
    `DF_${role}_IMAGE_REFERENCE`,
    `DF_${role}_IMAGE_DIGEST`,
  ]),
] as const;

function present(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim();
  return value ? value : null;
}

function parsePositive(
  environment: NodeJS.ProcessEnv,
  name: string,
  invalid: string[],
  options: { integer?: boolean } = {},
): number | null {
  const raw = present(environment, name);
  if (raw === null) {
    return null;
  }
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (options.integer === true && !Number.isSafeInteger(value))
  ) {
    invalid.push(name);
    return null;
  }
  return value;
}

function isCloudProvider(value: string): value is CloudProviderName {
  return value === "daytona" || value === "e2b" || value === "modal";
}

function isRunMode(value: string): value is RunMode {
  return (RUN_MODES as readonly string[]).includes(value);
}

function isEligibility(value: string): value is LeaderboardEligibility {
  return (LEADERBOARD_ELIGIBILITY as readonly string[]).includes(value);
}

function parseImage(
  environment: NodeJS.ProcessEnv,
  role: (typeof IMAGE_ROLES)[number],
  invalid: string[],
): ImmutableCloudImage | null {
  const referenceName = `DF_${role}_IMAGE_REFERENCE`;
  const digestName = `DF_${role}_IMAGE_DIGEST`;
  const reference = present(environment, referenceName);
  const digest = present(environment, digestName);
  if (reference === null || digest === null) return null;
  if (
    !IMMUTABLE_IMAGE.test(reference) ||
    !/^sha256:[a-f0-9]{64}$/u.test(digest) ||
    !reference.endsWith(`@${digest}`)
  ) {
    invalid.push(referenceName, digestName);
    return null;
  }
  return {
    reference,
    digest: digest as `sha256:${string}`,
  };
}

function parseSecretReference(
  source: string | null,
  target: string | null,
  sourceName: string,
  targetName: string,
  invalid: string[],
): SecretReference | null {
  if (source === null || target === null) return null;
  if (
    !SAFE_ENVIRONMENT_NAME.test(source) ||
    !SAFE_ENVIRONMENT_NAME.test(target) ||
    target === "PATH"
  ) {
    invalid.push(sourceName, targetName);
    return null;
  }
  return {
    sourceEnvironmentName: source,
    targetEnvironmentName: target,
  };
}

function parseSecretBindings(
  environment: NodeJS.ProcessEnv,
  name: string,
  invalid: string[],
  options: { allowEmpty?: boolean } = {},
): readonly SecretReference[] | null {
  const raw = present(environment, name);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid.push(name);
    return null;
  }
  if (
    !Array.isArray(parsed) ||
    (parsed.length === 0 && options.allowEmpty !== true) ||
    parsed.length > 16
  ) {
    invalid.push(name);
    return null;
  }
  const targets = new Set<string>();
  const result: SecretReference[] = [];
  for (const value of parsed) {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "sourceEnvironmentName") ||
      !Object.hasOwn(value, "targetEnvironmentName")
    ) {
      invalid.push(name);
      return null;
    }
    const source = (value as { sourceEnvironmentName?: unknown })
      .sourceEnvironmentName;
    const target = (value as { targetEnvironmentName?: unknown })
      .targetEnvironmentName;
    if (
      typeof source !== "string" ||
      typeof target !== "string" ||
      !SAFE_ENVIRONMENT_NAME.test(source) ||
      !SAFE_ENVIRONMENT_NAME.test(target) ||
      target === "PATH" ||
      targets.has(target)
    ) {
      invalid.push(name);
      return null;
    }
    targets.add(target);
    result.push({
      sourceEnvironmentName: source,
      targetEnvironmentName: target,
    });
  }
  return result;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function inspectBootstrapEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): BootstrapReadiness {
  const missing = BASE_REQUIRED.filter((name) => present(environment, name) === null);
  const invalid: string[] = [];
  const providerValue = present(environment, "DF_CLOUD_PROVIDER");
  const provider =
    providerValue !== null && isCloudProvider(providerValue) ? providerValue : null;
  if (providerValue !== null && provider === null) {
    invalid.push("DF_CLOUD_PROVIDER");
  }

  const credentialVariable = provider === null ? null : PROVIDER_CREDENTIALS[provider];
  if (
    credentialVariable !== null &&
    present(environment, credentialVariable) === null
  ) {
    missing.push(credentialVariable);
  }

  const modeValue = present(environment, "DF_MODE");
  const mode = modeValue !== null && isRunMode(modeValue) ? modeValue : null;
  if (modeValue !== null && mode === null) {
    invalid.push("DF_MODE");
  }

  const eligibilityValue = present(environment, "DF_LEADERBOARD_ELIGIBILITY");
  const eligibility =
    eligibilityValue !== null && isEligibility(eligibilityValue)
      ? eligibilityValue
      : null;
  if (eligibilityValue !== null && eligibility === null) {
    invalid.push("DF_LEADERBOARD_ELIGIBILITY");
  }

  const images = Object.fromEntries(
    IMAGE_ROLES.map((role) => [role.toLowerCase(), parseImage(environment, role, invalid)]),
  ) as Record<Lowercase<(typeof IMAGE_ROLES)[number]>, ImmutableCloudImage | null>;

  const effortValue = present(environment, "DF_OPTIMIZER_EFFORT");
  const effort =
    effortValue !== null && OPTIMIZER_EFFORTS.has(effortValue)
      ? (effortValue as BootstrapConfiguration["optimizer"]["effort"])
      : null;
  if (effortValue !== null && effort === null) {
    invalid.push("DF_OPTIMIZER_EFFORT");
  }

  const optimizerSecret = parseSecretReference(
    present(environment, "DF_OPTIMIZER_SECRET_SOURCE"),
    present(environment, "DF_OPTIMIZER_SECRET_TARGET"),
    "DF_OPTIMIZER_SECRET_SOURCE",
    "DF_OPTIMIZER_SECRET_TARGET",
    invalid,
  );
  if (
    optimizerSecret !== null &&
    !OPTIMIZER_SECRET_TARGETS.has(optimizerSecret.targetEnvironmentName)
  ) {
    invalid.push("DF_OPTIMIZER_SECRET_TARGET");
  }

  const evaluatedSecrets = parseSecretBindings(
    environment,
    "DF_EVALUATED_SECRET_BINDINGS_JSON",
    invalid,
  );
  const harborSecrets = parseSecretBindings(
    environment,
    "DF_HARBOR_SECRET_BINDINGS_JSON",
    invalid,
  );
  const githubSecret = parseSecretReference(
    present(environment, "DF_GITHUB_SECRET_SOURCE"),
    "DF_GITHUB_TOKEN",
    "DF_GITHUB_SECRET_SOURCE",
    "DF_GITHUB_SECRET_TARGET",
    invalid,
  );

  const evaluatorSecretTargets = [
    ...(evaluatedSecrets ?? []).map((item) => item.targetEnvironmentName),
    ...(harborSecrets ?? []).map((item) => item.targetEnvironmentName),
  ];
  if (
    new Set(evaluatorSecretTargets).size !== evaluatorSecretTargets.length
  ) {
    invalid.push("DF_SECRET_TARGET_PLAN");
  }

  const optimizerModel = present(environment, "DF_OPTIMIZER_MODEL");
  const optimizerDeploymentName = present(
    environment,
    "DF_OPTIMIZER_DEPLOYMENT_NAME",
  );
  const foundryResourceName = present(
    environment,
    "DF_FOUNDRY_RESOURCE_NAME",
  );
  const evaluatedProvider = present(environment, "DF_EVALUATED_PROVIDER");
  const evaluatedModel = present(environment, "DF_EVALUATED_MODEL");
  const evaluatedDeploymentName = present(
    environment,
    "DF_EVALUATED_DEPLOYMENT_NAME",
  );
  const evaluatedReasoning = present(environment, "DF_EVALUATED_REASONING");
  const claudeCodeVersion = present(environment, "DF_CLAUDE_CODE_VERSION");
  for (const [name, value] of [
    ["DF_OPTIMIZER_MODEL", optimizerModel],
    ["DF_OPTIMIZER_DEPLOYMENT_NAME", optimizerDeploymentName],
    ["DF_EVALUATED_PROVIDER", evaluatedProvider],
    ["DF_EVALUATED_MODEL", evaluatedModel],
    ["DF_EVALUATED_DEPLOYMENT_NAME", evaluatedDeploymentName],
    ["DF_EVALUATED_REASONING", evaluatedReasoning],
  ] as const) {
    if (value !== null && !SAFE_IDENTIFIER.test(value)) invalid.push(name);
  }
  if (claudeCodeVersion !== null && !EXACT_SEMVER.test(claudeCodeVersion)) {
    invalid.push("DF_CLAUDE_CODE_VERSION");
  }
  if (
    foundryResourceName !== null &&
    !SAFE_FOUNDRY_RESOURCE.test(foundryResourceName)
  ) {
    invalid.push("DF_FOUNDRY_RESOURCE_NAME");
  }
  if (optimizerModel !== null && optimizerModel !== "claude-opus-5") {
    invalid.push("DF_OPTIMIZER_MODEL");
  }
  if (effortValue !== null && effortValue !== "high") {
    invalid.push("DF_OPTIMIZER_EFFORT");
  }
  if (
    evaluatedProvider !== null &&
    evaluatedProvider !== "microsoft-foundry"
  ) {
    invalid.push("DF_EVALUATED_PROVIDER");
  }
  if (
    evaluatedModel !== null &&
    evaluatedModel !== "claude-opus-4-8"
  ) {
    invalid.push("DF_EVALUATED_MODEL");
  }
  if (
    evaluatedReasoning !== null &&
    evaluatedReasoning !== "high"
  ) {
    invalid.push("DF_EVALUATED_REASONING");
  }
  if (
    evaluatedProvider !== null &&
    evaluatedModel !== null &&
    evaluatedDeploymentName !== null &&
    evaluatedReasoning !== null &&
    evaluatedSecrets !== null &&
    foundryResourceName !== null
  ) {
    try {
      createPiHarborAgentSpec({
        adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
        adapterSha256: "0".repeat(64),
        provider: evaluatedProvider,
        modelId: evaluatedDeploymentName,
        modelFamily: evaluatedModel,
        foundryResourceName,
        thinkingLevel: evaluatedReasoning as
          | "off"
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh"
          | "max",
        enabledTools: ["read", "write", "bash"],
        credentialEnvironmentNames: evaluatedSecrets.map(
          (reference) => reference.targetEnvironmentName,
        ),
        timeoutMs: 3_600_000,
      });
    } catch {
      invalid.push(
        "DF_EVALUATED_PROVIDER",
        "DF_EVALUATED_MODEL",
        "DF_EVALUATED_DEPLOYMENT_NAME",
        "DF_EVALUATED_REASONING",
        "DF_EVALUATED_SECRET_BINDINGS_JSON",
      );
    }
  }

  const registryRevision = parsePositive(
    environment,
    "DF_TBENCH_REGISTRY_REVISION",
    invalid,
    { integer: true },
  );
  const terminalBench =
    registryRevision === null
      ? null
      : {
          benchmark: "terminal-bench-2.1" as const,
          dataset: TERMINAL_BENCH_21_DATASET,
          registryRevision,
          taskCount: TERMINAL_BENCH_21_TASK_COUNT,
          datasetContentSha256:
            present(environment, "DF_TBENCH_DATASET_CONTENT_SHA256") ?? "",
          datasetManifestSha256:
            present(environment, "DF_TBENCH_DATASET_MANIFEST_SHA256") ?? "",
          harborVersion: present(environment, "DF_HARBOR_VERSION") ?? "",
          harborPackageSha256:
            present(environment, "DF_HARBOR_PACKAGE_SHA256") ?? "",
          harborExecutableSha256:
            present(environment, "DF_HARBOR_EXECUTABLE_SHA256") ?? "",
          piHarborAdapterSha256:
            present(environment, "DF_PI_HARBOR_ADAPTER_SHA256") ?? "",
        };
  if (terminalBench !== null) {
    try {
      assertTerminalBench21Pin(terminalBench);
    } catch {
      invalid.push(
        "DF_HARBOR_VERSION",
        "DF_TBENCH_DATASET_CONTENT_SHA256",
        "DF_TBENCH_DATASET_MANIFEST_SHA256",
        "DF_HARBOR_PACKAGE_SHA256",
        "DF_HARBOR_EXECUTABLE_SHA256",
        "DF_PI_HARBOR_ADAPTER_SHA256",
      );
    }
  }

  const maximumUsd = parsePositive(environment, "DF_BUDGET_USD", invalid);
  const maximumTokens = parsePositive(environment, "DF_BUDGET_TOKENS", invalid, {
    integer: true,
  });
  const wallMinutes = parsePositive(
    environment,
    "DF_BUDGET_WALL_TIME_MINUTES",
    invalid,
  );
  const maximumAttempts = parsePositive(
    environment,
    "DF_BUDGET_ATTEMPTS",
    invalid,
    { integer: true },
  );
  const maximumPrivacyReleases = parsePositive(
    environment,
    "DF_BUDGET_PRIVACY_RELEASES",
    invalid,
    { integer: true },
  );
  const maximumPromotionLooks = parsePositive(
    environment,
    "DF_BUDGET_PROMOTION_LOOKS",
    invalid,
    { integer: true },
  );
  let maximumOnlineError = parsePositive(
    environment,
    "DF_BUDGET_ONLINE_ERROR",
    invalid,
  );
  if (maximumOnlineError !== null && maximumOnlineError > 0.05) {
    invalid.push("DF_BUDGET_ONLINE_ERROR");
    maximumOnlineError = null;
  }

  const cloudRegionClass = present(environment, "DF_CLOUD_REGION_CLASS");
  if (
    cloudRegionClass !== null &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(cloudRegionClass)
  ) {
    invalid.push("DF_CLOUD_REGION_CLASS");
  }
  const trustedVolumeRoot = present(environment, "DF_TRUSTED_VOLUME_ROOT");
  if (
    trustedVolumeRoot !== null &&
    (!trustedVolumeRoot.startsWith("/") ||
      trustedVolumeRoot === "/" ||
      trustedVolumeRoot.includes("/../") ||
      trustedVolumeRoot.includes("\u0000"))
  ) {
    invalid.push("DF_TRUSTED_VOLUME_ROOT");
  }
  if (present(environment, "DF_TRUSTED_CONTROL_PLANE") !== "1") {
    invalid.push("DF_TRUSTED_CONTROL_PLANE");
  }

  const uniqueMissing = unique(missing);
  const uniqueInvalid = unique(invalid);
  if (
    uniqueMissing.length > 0 ||
    uniqueInvalid.length > 0 ||
    provider === null ||
    credentialVariable === null ||
    mode === null ||
    eligibility === null ||
    images.control === null ||
    images.optimizer === null ||
    images.build === null ||
    images.evaluator === null ||
    effort === null ||
    optimizerSecret === null ||
    evaluatedSecrets === null ||
    harborSecrets === null ||
    githubSecret === null ||
    optimizerModel === null ||
    optimizerDeploymentName === null ||
    foundryResourceName === null ||
    evaluatedProvider === null ||
    evaluatedModel === null ||
    evaluatedDeploymentName === null ||
    evaluatedReasoning === null ||
    claudeCodeVersion === null ||
    terminalBench === null ||
    cloudRegionClass === null ||
    trustedVolumeRoot === null ||
    maximumUsd === null ||
    maximumTokens === null ||
    wallMinutes === null ||
    maximumAttempts === null ||
    maximumPrivacyReleases === null ||
    maximumPromotionLooks === null ||
    maximumOnlineError === null
  ) {
    return {
      ready: false,
      missing: uniqueMissing,
      invalid: uniqueInvalid,
      configuration: null,
    };
  }

  return {
    ready: true,
    missing: [],
    invalid: [],
    configuration: {
      cloudProvider: provider,
      cloudCredentialVariable: credentialVariable,
      cloudRegionClass,
      trustedVolumeRoot,
      images: {
        control: images.control,
        optimizer: images.optimizer,
        build: images.build,
        evaluator: images.evaluator,
      },
      optimizer: {
        model: optimizerModel,
        deploymentName: optimizerDeploymentName,
        foundryResourceName,
        effort,
        claudeCodeVersion,
        secretReference: optimizerSecret,
      },
      evaluated: {
        provider: evaluatedProvider,
        model: evaluatedModel,
        deploymentName: evaluatedDeploymentName,
        reasoning: evaluatedReasoning,
        foundryResourceName,
        secretReferences: evaluatedSecrets,
      },
      githubSecretReference: githubSecret,
      harborSecretReferences: harborSecrets,
      mode,
      leaderboardEligibility: eligibility,
      trustedZone: present(environment, "DF_TRUSTED_ZONE")!,
      signingKeyId: present(environment, "DF_SIGNING_KEY_ID")!,
      terminalBench,
      budget: {
        maximumUsd,
        maximumTokens,
        maximumWallTimeMs: wallMinutes * 60_000,
        maximumAttempts,
        maximumPrivacyReleases,
        maximumPromotionLooks,
        maximumOnlineError,
      },
    },
  };
}

export function redactEnvironmentForDiagnostics(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, boolean>> {
  const names = [
    ...BASE_REQUIRED,
    ...Object.values(PROVIDER_CREDENTIALS),
    "DAYTONA_API_URL",
    "DAYTONA_TARGET",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DF_GITHUB_TOKEN",
  ];
  return Object.fromEntries(
    unique(names).map((name) => [name, present(environment, name) !== null]),
  );
}
