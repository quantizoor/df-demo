import type { CloudProviderName, ImmutableCloudImage } from "../config/environment.js";

export type ControlConfigurationStage = "offline" | "probe";

export interface StagedControlConfiguration {
  readonly cloudProvider: CloudProviderName;
  readonly cloudRegionClass: string;
  readonly images: {
    readonly control: ImmutableCloudImage;
    readonly build: ImmutableCloudImage | null;
    readonly evaluator: ImmutableCloudImage | null;
  };
}

export interface StagedControlConfigurationReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
  readonly configuration: StagedControlConfiguration | null;
}

const SHA256_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REGION_CLASS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function present(environment: NodeJS.ProcessEnv, name: string): string | null {
  const value = environment[name]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function parseImage(
  environment: NodeJS.ProcessEnv,
  role: "CONTROL" | "BUILD" | "EVALUATOR",
  missing: string[],
  invalid: string[],
): ImmutableCloudImage | null {
  const referenceName = `DF_${role}_IMAGE_REFERENCE`;
  const digestName = `DF_${role}_IMAGE_DIGEST`;
  const reference = present(environment, referenceName);
  const digest = present(environment, digestName);
  if (reference === null) missing.push(referenceName);
  if (digest === null) missing.push(digestName);
  if (reference === null || digest === null) return null;
  if (
    !SHA256_IMAGE.test(reference) ||
    !IMAGE_DIGEST.test(digest) ||
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

/**
 * Parses only the configuration needed by a free control-plane stage.
 *
 * Offline commands need one immutable control image. A live provider probe
 * additionally needs immutable build and evaluator images. Optimizer,
 * evaluated-model, Git, benchmark, budget, and signing inputs are deliberately
 * outside this parser.
 */
export function inspectStagedControlEnvironment(
  environment: NodeJS.ProcessEnv,
  stage: ControlConfigurationStage,
): StagedControlConfigurationReadiness {
  const missing: string[] = [];
  const invalid: string[] = [];
  const providerValue = present(environment, "DF_CLOUD_PROVIDER");
  if (providerValue === null) missing.push("DF_CLOUD_PROVIDER");
  const provider =
    providerValue === "daytona" || providerValue === "e2b" || providerValue === "modal"
      ? providerValue
      : null;
  if (providerValue !== null && provider === null) {
    invalid.push("DF_CLOUD_PROVIDER");
  }

  const cloudRegionClass = present(environment, "DF_CLOUD_REGION_CLASS");
  if (cloudRegionClass === null) {
    missing.push("DF_CLOUD_REGION_CLASS");
  } else if (!REGION_CLASS.test(cloudRegionClass)) {
    invalid.push("DF_CLOUD_REGION_CLASS");
  }

  const control = parseImage(environment, "CONTROL", missing, invalid);
  const build = stage === "probe" ? parseImage(environment, "BUILD", missing, invalid) : null;
  const evaluator =
    stage === "probe" ? parseImage(environment, "EVALUATOR", missing, invalid) : null;
  const uniqueMissing = unique(missing);
  const uniqueInvalid = unique(invalid);
  if (
    uniqueMissing.length > 0 ||
    uniqueInvalid.length > 0 ||
    provider === null ||
    cloudRegionClass === null ||
    control === null ||
    (stage === "probe" && (build === null || evaluator === null))
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
      cloudRegionClass,
      images: {
        control,
        build,
        evaluator,
      },
    },
  };
}
