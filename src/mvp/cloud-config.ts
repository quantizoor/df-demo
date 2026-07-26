import { createHash } from "node:crypto";

import { isMvpModelDeploymentAlias } from "./model-deployment.js";

export interface MvpCloudConfiguration {
  readonly campaignId: string;
  readonly maximumIterations: number;
  readonly daytona: {
    readonly apiUrl: string;
    readonly target: string;
    readonly image: string;
    readonly volumeId: string;
    readonly volumeSubpath: string;
    readonly apiKeyEnvironmentName: "DAYTONA_API_KEY";
    readonly harborApiSecretSource: string;
    readonly outerSandboxResources: {
      readonly optimizer: MvpOuterSandboxResources;
      readonly evaluator: MvpOuterSandboxResources;
    };
  };
  readonly foundry: {
    readonly baseUrl: string;
    readonly apiHost: string;
    readonly optimizerDeployment: string;
    readonly evaluatedDeployment: string;
    readonly optimizerModelFamily: "claude-opus-5";
    readonly evaluatedModelFamily: "claude-opus-4-8";
    readonly evaluatedReasoningEffort: "high";
    readonly optimizerSecretSource: string;
    readonly evaluatedSecretSource: string;
  };
  readonly pi: {
    readonly owner: string;
    readonly repository: string;
    readonly branch: string;
    readonly baselineCommit: string;
    readonly baselineTree: string;
    readonly packageLockSha256: string;
    readonly githubSecretSource: string;
  };
  readonly protocol: {
    readonly taskCount: 5;
    readonly repetitions: 3;
    readonly matchedTrialCount: 30;
  };
  readonly configurationHash: string;
}

export interface MvpOuterSandboxResources {
  readonly cpu: 4;
  readonly memoryGiB: 8;
  readonly diskGiB: 10;
}

export interface MvpCloudConfigurationReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly configuration: MvpCloudConfiguration | null;
}

const SAFE_CAMPAIGN =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const SAFE_IDENTIFIER =
  /^[A-Za-z0-9](?:[A-Za-z0-9._/@+-]{0,253}[A-Za-z0-9])?$/u;
const SAFE_GIT_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const SAFE_GIT_REF =
  /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,238}[A-Za-z0-9])?$/u;
const SAFE_SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SAFE_VOLUME_SUBPATH =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){0,7}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const MVP_OUTER_SANDBOX_RESOURCES = {
  cpu: 4,
  memoryGiB: 8,
  diskGiB: 10,
} as const satisfies MvpOuterSandboxResources;

const REQUIRED = [
  "DF_MVP_CAMPAIGN_ID",
  "DF_MVP_MAX_ITERATIONS",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_TARGET",
  "DF_MVP_DAYTONA_IMAGE",
  "DF_DAYTONA_VOLUME_ID",
  "DF_DAYTONA_VOLUME_SUBPATH",
  "DF_HARBOR_DAYTONA_SECRET_SOURCE",
  "DF_FOUNDRY_BASE_URL",
  "DF_OPTIMIZER_DEPLOYMENT",
  "DF_EVALUATED_DEPLOYMENT",
  "DF_OPTIMIZER_SECRET_SOURCE",
  "DF_EVALUATED_SECRET_SOURCE",
  "DF_PI_GITHUB_OWNER",
  "DF_PI_GITHUB_REPOSITORY",
  "DF_PI_BRANCH",
  "DF_PI_BASELINE_COMMIT",
  "DF_PI_BASELINE_TREE",
  "DF_PI_PACKAGE_LOCK_SHA256",
  "DF_GITHUB_SECRET_SOURCE",
] as const;

function present(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function normalizedHttpsUrl(
  value: string,
  label: string,
  invalid: string[],
): URL | null {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      invalid.push(label);
      return null;
    }
    return parsed;
  } catch {
    invalid.push(label);
    return null;
  }
}

function configurationHash(
  configuration: Omit<MvpCloudConfiguration, "configurationHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(configuration))
    .digest("hex");
}

/**
 * Parses only references to already-existing cloud resources. This function
 * cannot create, deploy, resize, or otherwise configure an Azure resource.
 * Plaintext Foundry and Git credentials are deliberately absent from the
 * returned configuration; child sandboxes receive governed Daytona Secret
 * references instead.
 */
export function inspectMvpCloudEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): MvpCloudConfigurationReadiness {
  const missing = REQUIRED.filter(
    (name) => present(environment, name) === null,
  );
  const invalid: string[] = [];

  if (
    environment["GITHUB_ACTIONS"] !== "true" ||
    environment["RUNNER_ENVIRONMENT"] !== "github-hosted" ||
    environment["DF_CLOUD_EXECUTION"] !== "1"
  ) {
    invalid.push("DF_CLOUD_EXECUTION");
  }

  const campaignId = present(environment, "DF_MVP_CAMPAIGN_ID");
  if (campaignId !== null && !SAFE_CAMPAIGN.test(campaignId)) {
    invalid.push("DF_MVP_CAMPAIGN_ID");
  }

  const maximumIterationsRaw = present(
    environment,
    "DF_MVP_MAX_ITERATIONS",
  );
  const maximumIterations =
    maximumIterationsRaw === null
      ? null
      : Number(maximumIterationsRaw);
  if (
    maximumIterations !== null &&
    (!Number.isSafeInteger(maximumIterations) ||
      maximumIterations < 1 ||
      maximumIterations > 10)
  ) {
    invalid.push("DF_MVP_MAX_ITERATIONS");
  }

  const apiUrlRaw = present(environment, "DAYTONA_API_URL");
  const apiUrl =
    apiUrlRaw === null
      ? null
      : normalizedHttpsUrl(
          apiUrlRaw,
          "DAYTONA_API_URL",
          invalid,
        );
  if (
    apiUrl !== null &&
    (apiUrl.hostname !== "app.daytona.io" ||
      apiUrl.pathname.replace(/\/+$/u, "") !== "/api")
  ) {
    invalid.push("DAYTONA_API_URL");
  }
  const target = present(environment, "DAYTONA_TARGET");
  if (
    target !== null &&
    (!SAFE_IDENTIFIER.test(target) ||
      !/(?:^|[-_.])eu(?:$|[-_.])/iu.test(target))
  ) {
    invalid.push("DAYTONA_TARGET");
  }

  const image = present(environment, "DF_MVP_DAYTONA_IMAGE");
  if (image !== null && !IMMUTABLE_IMAGE.test(image)) {
    invalid.push("DF_MVP_DAYTONA_IMAGE");
  }

  const volumeId = present(environment, "DF_DAYTONA_VOLUME_ID");
  if (volumeId !== null && !SAFE_IDENTIFIER.test(volumeId)) {
    invalid.push("DF_DAYTONA_VOLUME_ID");
  }
  const volumeSubpath = present(
    environment,
    "DF_DAYTONA_VOLUME_SUBPATH",
  );
  if (
    volumeSubpath !== null &&
    !SAFE_VOLUME_SUBPATH.test(volumeSubpath)
  ) {
    invalid.push("DF_DAYTONA_VOLUME_SUBPATH");
  }
  const harborApiSecretSource = present(
    environment,
    "DF_HARBOR_DAYTONA_SECRET_SOURCE",
  );
  if (
    harborApiSecretSource !== null &&
    !SAFE_SECRET_NAME.test(harborApiSecretSource)
  ) {
    invalid.push("DF_HARBOR_DAYTONA_SECRET_SOURCE");
  }

  const foundryBaseUrlRaw = present(
    environment,
    "DF_FOUNDRY_BASE_URL",
  );
  const foundryBaseUrl =
    foundryBaseUrlRaw === null
      ? null
      : normalizedHttpsUrl(
          foundryBaseUrlRaw,
          "DF_FOUNDRY_BASE_URL",
          invalid,
        );
  if (
    foundryBaseUrl !== null &&
    (!foundryBaseUrl.hostname.endsWith(
      ".services.ai.azure.com",
    ) ||
      foundryBaseUrl.pathname.replace(/\/+$/u, "") !==
        "/anthropic")
  ) {
    invalid.push("DF_FOUNDRY_BASE_URL");
  }

  const optimizerDeployment = present(
    environment,
    "DF_OPTIMIZER_DEPLOYMENT",
  );
  const evaluatedDeployment = present(
    environment,
    "DF_EVALUATED_DEPLOYMENT",
  );
  for (const [name, value] of [
    ["DF_OPTIMIZER_DEPLOYMENT", optimizerDeployment],
    ["DF_EVALUATED_DEPLOYMENT", evaluatedDeployment],
  ] as const) {
    if (
      value !== null &&
      !isMvpModelDeploymentAlias(value)
    ) {
      invalid.push(name);
    }
  }

  const optimizerSecretSource = present(
    environment,
    "DF_OPTIMIZER_SECRET_SOURCE",
  );
  const evaluatedSecretSource = present(
    environment,
    "DF_EVALUATED_SECRET_SOURCE",
  );
  const githubSecretSource = present(
    environment,
    "DF_GITHUB_SECRET_SOURCE",
  );
  for (const [name, value] of [
    ["DF_OPTIMIZER_SECRET_SOURCE", optimizerSecretSource],
    ["DF_EVALUATED_SECRET_SOURCE", evaluatedSecretSource],
    ["DF_GITHUB_SECRET_SOURCE", githubSecretSource],
  ] as const) {
    if (value !== null && !SAFE_SECRET_NAME.test(value)) {
      invalid.push(name);
    }
  }

  const piOwner = present(environment, "DF_PI_GITHUB_OWNER");
  const piRepository = present(
    environment,
    "DF_PI_GITHUB_REPOSITORY",
  );
  const piBranch = present(environment, "DF_PI_BRANCH");
  const baselineCommit = present(
    environment,
    "DF_PI_BASELINE_COMMIT",
  );
  const baselineTree = present(environment, "DF_PI_BASELINE_TREE");
  const packageLockSha256 = present(
    environment,
    "DF_PI_PACKAGE_LOCK_SHA256",
  );
  for (const [name, value] of [
    ["DF_PI_GITHUB_OWNER", piOwner],
    ["DF_PI_GITHUB_REPOSITORY", piRepository],
  ] as const) {
    if (value !== null && !SAFE_GIT_NAME.test(value)) {
      invalid.push(name);
    }
  }
  if (
    piBranch !== null &&
    (!SAFE_GIT_REF.test(piBranch) ||
      piBranch.includes("..") ||
      piBranch.includes("//") ||
      piBranch.startsWith("/") ||
      piBranch.endsWith("/"))
  ) {
    invalid.push("DF_PI_BRANCH");
  }
  if (baselineCommit !== null && !SHA1.test(baselineCommit)) {
    invalid.push("DF_PI_BASELINE_COMMIT");
  }
  if (baselineTree !== null && !SHA1.test(baselineTree)) {
    invalid.push("DF_PI_BASELINE_TREE");
  }
  if (
    packageLockSha256 !== null &&
    !SHA256.test(packageLockSha256)
  ) {
    invalid.push("DF_PI_PACKAGE_LOCK_SHA256");
  }

  if (missing.length > 0 || invalid.length > 0) {
    return {
      ready: false,
      missing: [...new Set(missing)].sort(),
      invalid: [...new Set(invalid)].sort(),
      configuration: null,
    };
  }

  if (
    campaignId === null ||
    maximumIterations === null ||
    apiUrl === null ||
    target === null ||
    image === null ||
    volumeId === null ||
    volumeSubpath === null ||
    harborApiSecretSource === null ||
    foundryBaseUrl === null ||
    optimizerDeployment === null ||
    evaluatedDeployment === null ||
    optimizerSecretSource === null ||
    evaluatedSecretSource === null ||
    piOwner === null ||
    piRepository === null ||
    piBranch === null ||
    baselineCommit === null ||
    baselineTree === null ||
    packageLockSha256 === null ||
    githubSecretSource === null
  ) {
    throw new Error(
      "MVP readiness became inconsistent after validation.",
    );
  }

  const unsigned: Omit<
    MvpCloudConfiguration,
    "configurationHash"
  > = {
    campaignId,
    maximumIterations,
    daytona: {
      apiUrl: apiUrl.toString().replace(/\/$/u, ""),
      target,
      image,
      volumeId,
      volumeSubpath,
      apiKeyEnvironmentName: "DAYTONA_API_KEY",
      harborApiSecretSource,
      outerSandboxResources: {
        optimizer: { ...MVP_OUTER_SANDBOX_RESOURCES },
        evaluator: { ...MVP_OUTER_SANDBOX_RESOURCES },
      },
    },
    foundry: {
      baseUrl: foundryBaseUrl
        .toString()
        .replace(/\/$/u, ""),
      apiHost: foundryBaseUrl.hostname,
      optimizerDeployment,
      evaluatedDeployment,
      optimizerModelFamily: "claude-opus-5",
      evaluatedModelFamily: "claude-opus-4-8",
      evaluatedReasoningEffort: "high",
      optimizerSecretSource,
      evaluatedSecretSource,
    },
    pi: {
      owner: piOwner,
      repository: piRepository,
      branch: piBranch,
      baselineCommit,
      baselineTree,
      packageLockSha256,
      githubSecretSource,
    },
    protocol: {
      taskCount: 5,
      repetitions: 3,
      matchedTrialCount: 30,
    },
  };
  return {
    ready: true,
    missing: [],
    invalid: [],
    configuration: {
      ...unsigned,
      configurationHash: configurationHash(unsigned),
    },
  };
}
