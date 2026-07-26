import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";

import { canonicalJson } from "./contracts.js";
import {
  assertMvpEvaluatorRuntimePin,
  MVP_EVALUATOR_CATALOG_NAMESPACE_PATH,
  MVP_EVALUATOR_ELIGIBILITY_POLICY,
  MVP_EVALUATOR_RUNTIME_PIN_PATH,
  type MvpDaytonaProviderLimits,
  type MvpEligibleHarborTaskDefinition,
  type MvpEvaluatorRuntimePin,
  mvpEvaluatorEligibilityPolicyDigest,
} from "./evaluator-runtime.js";
import { withMountedLock, writeJsonAtomic } from "./mounted-files.js";
import { MountedHiddenTaskCatalog } from "./mounted-hidden-task-catalog.js";
import { selectFailureWeightedTasks } from "./selection.js";

export const MVP_RUNTIME_PINS_PATH = "/usr/local/share/dark-factory/mvp-runtime-pins.json" as const;
export const MVP_RUNTIME_HARBOR_EXECUTABLE = "/usr/local/bin/harbor" as const;
export const MVP_RUNTIME_BUN_EXECUTABLE = "/usr/local/bin/bun" as const;
export const MVP_RUNTIME_ADAPTER_PATH =
  "/tmp/df-mvp-controller/src/terminal-bench/assets/dark_factory_pi.py" as const;
export const MVP_RUNTIME_DISCOVERY_SCRIPT =
  "/tmp/df-mvp-controller/scripts/mvp-bootstrap-discovery.py" as const;
export const MVP_RUNTIME_PINS_SHA256 =
  "73d89648b29cae6c52541a12ed024803e60183f5e65c71da7c5d6b3e117adcca" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,446}@sha256:[a-f0-9]{64}$/u;
const MAXIMUM_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAXIMUM_RUNTIME_PINS_BYTES = 1024 * 1024;
const MAXIMUM_DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAXIMUM_DISCOVERY_OUTPUT_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 135 * 60 * 1_000;
const PRIVATE_DISCOVERY_RELATIVE_PATH = "private/bootstrap/discovery.json";
const PRIVATE_CATALOG_RELATIVE_PATH = "private/hidden-task-catalog.json";

export const MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS: MvpDaytonaProviderLimits = {
  perSandbox: {
    cpu: 4,
    memoryMiB: 8 * 1_024,
    storageMiB: 10 * 1_024,
    gpus: 0,
  },
  organization: {
    cpu: 100,
    memoryMiB: 200 * 1_024,
    storageMiB: 300 * 1_024,
  },
  outerEvaluator: {
    cpu: 4,
    memoryMiB: 8 * 1_024,
    storageMiB: 10 * 1_024,
    gpus: 0,
  },
  harborMaxConcurrentTrials: 5,
  maximumOverlappingChildSandboxes: 10,
};

export interface MvpRuntimeBootstrapEvidence {
  readonly runtimePinSha256: string;
  readonly catalogSha256: string;
  readonly inventoryDigest: string;
  readonly compatibleTaskCount: number;
  readonly sourceTaskCount: 89;
  readonly allStepVerifierEnvironmentModesSeparate: true;
  readonly runtimeCompatibilityProven: true;
  readonly officialResourcesFit: true;
}

export interface MvpRuntimeBootstrapSandboxAccounting {
  readonly created: number;
  readonly destroyed: number;
  readonly allDestroyed: true;
}

export interface MvpRuntimeBootstrapResult {
  readonly evidence: MvpRuntimeBootstrapEvidence;
  readonly sandboxAccounting: MvpRuntimeBootstrapSandboxAccounting;
}

export interface MvpRuntimeBootstrapArtifact {
  readonly sha256: string;
  readonly byteLength: number;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface MvpRuntimeBootstrapJsonArtifact extends MvpRuntimeBootstrapArtifact {
  readonly value: unknown;
}

export interface MvpRuntimeBootstrapArtifactPort {
  readJson(path: string, maximumBytes: number): Promise<MvpRuntimeBootstrapJsonArtifact>;
  inspectFile(path: string, maximumBytes: number): Promise<MvpRuntimeBootstrapArtifact>;
}

export interface MvpRuntimeBootstrapDiscoveryRequest {
  readonly outputPath: string;
  readonly bunExecutable: typeof MVP_RUNTIME_BUN_EXECUTABLE;
  readonly bunExecutableSha256: string;
  readonly providerLimits: MvpDaytonaProviderLimits;
  readonly providerLimitsDigest: string;
  readonly eligibilityPolicyDigest: string;
}

export interface MvpRuntimeBootstrapDiscoveryPort {
  discover(request: MvpRuntimeBootstrapDiscoveryRequest): Promise<void>;
}

export interface BootstrapMvpEvaluatorRuntimeInput {
  readonly stateRoot: string;
  readonly sourceCommit: string;
  readonly imageReference: string;
  readonly discovery?: MvpRuntimeBootstrapDiscoveryPort;
  readonly artifacts?: MvpRuntimeBootstrapArtifactPort;
}

interface MvpImageRuntimePins {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-runtime-pins.v1";
  readonly platform: "linux/amd64";
  readonly runtimeAbi: "linux-x64-glibc";
  readonly node: {
    readonly version: "24.18.0";
    readonly executable: "/usr/bin/node";
  };
  readonly claudeCode: {
    readonly version: "2.1.217";
    readonly executable: "/usr/local/bin/claude";
  };
  readonly bun: {
    readonly version: "1.3.14";
    readonly executable: typeof MVP_RUNTIME_BUN_EXECUTABLE;
    readonly variant: "bun-linux-x64-baseline";
    readonly target: "bun-linux-x64-baseline";
  };
  readonly harbor: {
    readonly version: "0.20.0";
    readonly wheelSha256: string;
    readonly executable: typeof MVP_RUNTIME_HARBOR_EXECUTABLE;
    readonly extra: "daytona";
  };
  readonly reservedIds: readonly [65532, 65533];
}

interface MvpPrivateBootstrapDiscovery {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.mvp-private-bootstrap-discovery.v1";
  readonly datasetName: "terminal-bench/terminal-bench-2-1";
  readonly datasetRef: string;
  readonly datasetRevision: string;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly registryRevision: 6;
  readonly sourceTaskCount: 89;
  readonly compatibleTaskCount: number;
  readonly compatibilitySandboxesCreated: number;
  readonly compatibilitySandboxesDestroyed: number;
  readonly allCompatibilitySandboxesDestroyed: true;
  readonly definitions: readonly MvpEligibleHarborTaskDefinition[];
}

interface VerifiedRuntimeArtifacts {
  readonly pins: MvpImageRuntimePins;
  readonly runtimePins: MvpRuntimeBootstrapArtifact;
  readonly harbor: MvpRuntimeBootstrapArtifact;
  readonly bun: MvpRuntimeBootstrapArtifact;
  readonly adapter: MvpRuntimeBootstrapArtifact;
}

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const ResourceProfileSchema = Type.Object(
  {
    cpu: Type.Integer({ minimum: 1, maximum: 4 }),
    memoryMiB: Type.Integer({ minimum: 1, maximum: 8 * 1_024 }),
    storageMiB: Type.Integer({ minimum: 1, maximum: 10 * 1_024 }),
    gpus: Type.Literal(0),
  },
  { additionalProperties: false },
);
const DiscoveredDefinitionSchema = Type.Object(
  {
    harborTaskLocator: Type.String({
      minLength: 3,
      maxLength: 257,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
    }),
    revisionDigest: DigestSchema,
    difficulty: Type.Union([Type.Literal("hard"), Type.Literal("medium"), Type.Literal("easy")]),
    easyCanary: Type.Boolean(),
    baselineFailureRate: Type.Number({ minimum: 0, maximum: 1 }),
    baselineProvenance: Type.Object(
      {
        kind: Type.Literal("dataset-declared-difficulty-prior"),
        sourceDigest: DigestSchema,
        policyDigest: DigestSchema,
        datasetRevision: Type.String({
          minLength: 3,
          maxLength: 128,
          pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
        }),
      },
      { additionalProperties: false },
    ),
    graderIsolation: Type.Object(
      {
        verifierEnvironmentMode: Type.Literal("separate"),
        allStepVerifierEnvironmentModesSeparate: Type.Literal(true),
        sourceDigest: DigestSchema,
      },
      { additionalProperties: false },
    ),
    leaderboard: Type.Object(
      {
        kind: Type.Literal("unknown"),
        reason: Type.Literal("not-published"),
      },
      { additionalProperties: false },
    ),
    initialFailureRate: Type.Number({ minimum: 0, maximum: 1 }),
    uncertainty: Type.Number({ minimum: 0, maximum: 1 }),
    normalizedCost: Type.Number({ minimum: 0, maximum: 1 }),
    sensitiveLiterals: Type.Array(Type.String({ minLength: 3, maxLength: 2_000 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    executionEligibility: Type.Object(
      {
        environmentType: Type.Literal("daytona"),
        sandboxMode: Type.Literal("direct"),
        compose: Type.Literal(false),
        officialResources: Type.Object(
          {
            agent: ResourceProfileSchema,
            verifiers: Type.Array(ResourceProfileSchema, {
              minItems: 1,
              maxItems: 64,
            }),
          },
          { additionalProperties: false },
        ),
        resourceSourceDigest: DigestSchema,
        providerLimitsDigest: DigestSchema,
        resourceFit: Type.Literal(true),
        runtimeCompatibility: Type.Object(
          {
            architecture: Type.Literal("x86_64"),
            runtimeAbi: Type.Literal("linux-x64-glibc"),
            bunExecutableSha256: DigestSchema,
            smokeEvidenceDigest: DigestSchema,
            compatible: Type.Literal(true),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const PrivateDiscoverySchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    domain: Type.Literal("dark-factory.mvp-private-bootstrap-discovery.v1"),
    datasetName: Type.Literal("terminal-bench/terminal-bench-2-1"),
    datasetRef: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    datasetRevision: Type.String({
      minLength: 3,
      maxLength: 128,
      pattern: "^[a-z0-9]+(?:[._-][a-z0-9]+)*$",
    }),
    datasetContentSha256: DigestSchema,
    datasetManifestSha256: DigestSchema,
    registryRevision: Type.Literal(6),
    sourceTaskCount: Type.Literal(89),
    compatibleTaskCount: Type.Integer({ minimum: 5, maximum: 12 }),
    compatibilitySandboxesCreated: Type.Integer({ minimum: 5, maximum: 24 }),
    compatibilitySandboxesDestroyed: Type.Integer({ minimum: 5, maximum: 24 }),
    allCompatibilitySandboxesDestroyed: Type.Literal(true),
    definitions: Type.Array(DiscoveredDefinitionSchema, {
      minItems: 5,
      maxItems: 12,
    }),
  },
  { additionalProperties: false },
);
const discoveryAjv = new Ajv2020({ allErrors: true, strict: true });
const validatePrivateDiscovery = discoveryAjv.compile(PrivateDiscoverySchema);

/**
 * Creates the private runtime pin and hidden catalog only after all immutable
 * image material and every retained task have been proven. The function
 * returns counts and digests only; task identities never cross this boundary.
 */
export async function bootstrapMvpEvaluatorRuntime(
  input: BootstrapMvpEvaluatorRuntimeInput,
): Promise<MvpRuntimeBootstrapResult> {
  assertBootstrapInput(input);
  const usesProductionDiscovery = input.discovery === undefined;
  if (usesProductionDiscovery) {
    assertProductionBootstrapBoundary(input);
  }
  const artifactsPort = input.artifacts ?? new NodeMvpRuntimeBootstrapArtifacts();
  const discoveryPort = input.discovery ?? new NodeMvpRuntimeBootstrapDiscovery();
  const artifacts = await verifyRuntimeArtifacts(artifactsPort);
  const providerLimitsDigest = digest(MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS);
  const eligibilityPolicyDigest = mvpEvaluatorEligibilityPolicyDigest();
  const privateRoot = join(input.stateRoot, "private");

  return withMountedLock(privateRoot, "mvp-runtime-bootstrap", async () => {
    const pinPath = join(input.stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH);
    const existing = await readOptionalPrivateJson(pinPath, MAXIMUM_DISCOVERY_BYTES);
    if (existing !== null) {
      return restoreCompletedBootstrap(input, existing, artifacts);
    }

    const discoveryPath = join(input.stateRoot, PRIVATE_DISCOVERY_RELATIVE_PATH);
    let discoveryValue = await readOptionalPrivateJson(discoveryPath, MAXIMUM_DISCOVERY_BYTES);
    if (discoveryValue === null) {
      await discoveryPort.discover({
        outputPath: discoveryPath,
        bunExecutable: MVP_RUNTIME_BUN_EXECUTABLE,
        bunExecutableSha256: artifacts.bun.sha256,
        providerLimits: MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS,
        providerLimitsDigest,
        eligibilityPolicyDigest,
      });
      discoveryValue = await readPrivateJson(discoveryPath, MAXIMUM_DISCOVERY_BYTES);
    }
    const discovery = assertPrivateBootstrapDiscovery(discoveryValue, {
      bunExecutableSha256: artifacts.bun.sha256,
      eligibilityPolicyDigest,
      providerLimitsDigest,
    });
    const pin = buildRuntimePin(input, artifacts, discovery);
    assertMvpEvaluatorRuntimePin(pin);

    const namespace = await loadOrCreateCatalogNamespace(input.stateRoot);
    const catalog = new MountedHiddenTaskCatalog(privateRoot, namespace);
    await catalog.initialize({
      datasetRevision: pin.datasetRevision,
      definitions: pin.hiddenTaskDefinitions,
    });
    const profiles = await catalog.list();
    selectFailureWeightedTasks(profiles);

    const catalogArtifact = await hashRegularFile(
      join(input.stateRoot, PRIVATE_CATALOG_RELATIVE_PATH),
      MAXIMUM_DISCOVERY_BYTES,
    );
    await writeJsonExclusiveAtomic(pinPath, pin);
    const runtimePinArtifact = await hashRegularFile(pinPath, MAXIMUM_DISCOVERY_BYTES);
    const persisted = await readPrivateJson(pinPath, MAXIMUM_DISCOVERY_BYTES);
    assertMvpEvaluatorRuntimePin(persisted);
    if (canonicalJson(persisted) !== canonicalJson(pin)) {
      throw new Error("Persisted evaluator runtime pin differs from its sealed input.");
    }

    return {
      evidence: bootstrapEvidence(
        pin,
        runtimePinArtifact.sha256,
        catalogArtifact.sha256,
        discovery.sourceTaskCount,
      ),
      sandboxAccounting: {
        created: discovery.compatibilitySandboxesCreated,
        destroyed: discovery.compatibilitySandboxesDestroyed,
        allDestroyed: true,
      },
    };
  });
}

export class NodeMvpRuntimeBootstrapArtifacts implements MvpRuntimeBootstrapArtifactPort {
  public async readJson(
    path: string,
    maximumBytes: number,
  ): Promise<MvpRuntimeBootstrapJsonArtifact> {
    const { bytes, artifact } = await readRegularFileArtifact(path, maximumBytes);
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    return { ...artifact, value };
  }

  public async inspectFile(
    path: string,
    maximumBytes: number,
  ): Promise<MvpRuntimeBootstrapArtifact> {
    return inspectRegularFile(path, maximumBytes);
  }
}

export class NodeMvpRuntimeBootstrapDiscovery implements MvpRuntimeBootstrapDiscoveryPort {
  public async discover(request: MvpRuntimeBootstrapDiscoveryRequest): Promise<void> {
    if (
      request.outputPath !== "/workspace/df-state/private/bootstrap/discovery.json" ||
      request.bunExecutable !== MVP_RUNTIME_BUN_EXECUTABLE ||
      !SHA256.test(request.bunExecutableSha256) ||
      request.providerLimitsDigest !== digest(request.providerLimits) ||
      request.eligibilityPolicyDigest !== mvpEvaluatorEligibilityPolicyDigest()
    ) {
      throw new Error("Private runtime discovery request is invalid.");
    }
    await mkdir(dirname(request.outputPath), { recursive: true, mode: 0o700 });
    await mkdir("/tmp/df-mvp-bootstrap-home", { recursive: true, mode: 0o700 });
    const environment = discoveryEnvironment();
    await runPrivateDiscovery({
      executable: "/usr/bin/python3",
      arguments: [
        MVP_RUNTIME_DISCOVERY_SCRIPT,
        "--output",
        request.outputPath,
        "--bun",
        request.bunExecutable,
        "--bun-sha256",
        request.bunExecutableSha256,
        "--provider-limits",
        canonicalJson(request.providerLimits),
        "--provider-limits-digest",
        request.providerLimitsDigest,
        "--eligibility-policy-digest",
        request.eligibilityPolicyDigest,
      ],
      environment,
    });
  }
}

async function restoreCompletedBootstrap(
  input: BootstrapMvpEvaluatorRuntimeInput,
  value: unknown,
  artifacts: VerifiedRuntimeArtifacts,
): Promise<MvpRuntimeBootstrapResult> {
  assertMvpEvaluatorRuntimePin(value);
  const pin = value;
  const discovery = assertPrivateBootstrapDiscovery(
    {
      schemaVersion: 1,
      domain: "dark-factory.mvp-private-bootstrap-discovery.v1",
      datasetName: "terminal-bench/terminal-bench-2-1",
      datasetRef: pin.datasetRef,
      datasetRevision: pin.datasetRevision,
      datasetContentSha256: pin.datasetContentSha256,
      datasetManifestSha256: pin.datasetManifestSha256,
      registryRevision: 6,
      sourceTaskCount: 89,
      compatibleTaskCount: pin.hiddenTaskDefinitions.length,
      compatibilitySandboxesCreated: pin.hiddenTaskDefinitions.length,
      compatibilitySandboxesDestroyed: pin.hiddenTaskDefinitions.length,
      allCompatibilitySandboxesDestroyed: true,
      definitions: pin.hiddenTaskDefinitions,
    },
    {
      bunExecutableSha256: artifacts.bun.sha256,
      eligibilityPolicyDigest: mvpEvaluatorEligibilityPolicyDigest(),
      providerLimitsDigest: digest(MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS),
    },
  );
  const rebuilt = buildRuntimePin(input, artifacts, discovery);
  if (canonicalJson(pin) !== canonicalJson(rebuilt)) {
    throw new Error("Existing evaluator runtime pin differs from the requested bootstrap.");
  }

  const namespace = await loadExistingCatalogNamespace(input.stateRoot);
  const catalog = new MountedHiddenTaskCatalog(join(input.stateRoot, "private"), namespace);
  await catalog.initialize({
    datasetRevision: pin.datasetRevision,
    definitions: pin.hiddenTaskDefinitions,
  });
  selectFailureWeightedTasks(await catalog.list());
  const runtimePinArtifact = await hashRegularFile(
    join(input.stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH),
    MAXIMUM_DISCOVERY_BYTES,
  );
  const catalogArtifact = await hashRegularFile(
    join(input.stateRoot, PRIVATE_CATALOG_RELATIVE_PATH),
    MAXIMUM_DISCOVERY_BYTES,
  );
  return {
    evidence: bootstrapEvidence(pin, runtimePinArtifact.sha256, catalogArtifact.sha256, 89),
    sandboxAccounting: {
      created: 0,
      destroyed: 0,
      allDestroyed: true,
    },
  };
}

function buildRuntimePin(
  input: BootstrapMvpEvaluatorRuntimeInput,
  artifacts: VerifiedRuntimeArtifacts,
  discovery: MvpPrivateBootstrapDiscovery,
): MvpEvaluatorRuntimePin {
  const definitions = discovery.definitions.map((definition) => structuredClone(definition));
  const providerLimits = structuredClone(MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS);
  const providerLimitsDigest = digest(providerLimits);
  const eligibilityPolicyDigest = mvpEvaluatorEligibilityPolicyDigest();
  const imageDigest = input.imageReference.slice(input.imageReference.lastIndexOf("@sha256:") + 8);
  const resourcesDigest = digest({
    providerLimits,
    tasks: definitions.map((definition) => ({
      revisionDigest: definition.revisionDigest,
      officialResources: definition.executionEligibility.officialResources,
      resourceSourceDigest: definition.executionEligibility.resourceSourceDigest,
    })),
  });
  const networkPolicyDigest = digest({
    policyVersion: "mvp-harbor-task-baseline-network-v1",
    environmentType: "daytona",
    sandboxMode: "direct",
    taskNetworkPolicySource: "task.environment.resolve_baseline",
    controlPlaneDomains: [
      "app.daytona.io",
      "ofhuhcpkvzjlejydnvyd.storage.supabase.co",
      "ofhuhcpkvzjlejydnvyd.supabase.co",
    ],
  });
  const samplingSettingsDigest = digest({
    policyVersion: "mvp-claude-code-sampling-v1",
    modelFamily: "claude-opus-4-8",
    reasoningEffort: "high",
    commandLineSamplingOverrides: [],
  });
  const contextSettingsDigest = digest({
    policyVersion: "mvp-pi-context-v1",
    enabledTools: ["read", "bash", "write", "edit"],
    piEntrypoint: "packages/coding-agent/dist/pi",
    timeoutSeconds: 7_200,
  });
  const harnessConfigDigest = digest({
    policyVersion: "mvp-harbor-harness-v2",
    harborVersion: "0.20.0",
    graderProtocolVersion: "harbor-0.20.0-separate-verifier",
    adapterSha256: artifacts.adapter.sha256,
    allStepVerifierEnvironmentModesSeparate: true,
  });
  const extraConfigDigest = digest({
    policyVersion: "mvp-evaluator-extra-config-v2",
    sourceCommit: input.sourceCommit,
    imageReference: input.imageReference,
    runtimePinsSha256: artifacts.runtimePins.sha256,
    harborPackageSha256: artifacts.pins.harbor.wheelSha256,
    datasetManifestSha256: discovery.datasetManifestSha256,
    eligibilityPolicyDigest,
    providerLimitsDigest,
  });

  return {
    schemaVersion: 2,
    domain: "dark-factory.mvp-evaluator-runtime-pin.v2",
    sourceCommit: input.sourceCommit,
    imageReference: input.imageReference,
    runtimePinsSha256: artifacts.runtimePins.sha256,
    harborVersion: "0.20.0",
    harborPackageSha256: artifacts.pins.harbor.wheelSha256,
    terminalBenchVersion: "2.1",
    datasetName: discovery.datasetName,
    datasetRef: discovery.datasetRef,
    datasetRevision: discovery.datasetRevision,
    datasetContentSha256: discovery.datasetContentSha256,
    datasetManifestSha256: discovery.datasetManifestSha256,
    graderProtocolVersion: "harbor-0.20.0-separate-verifier",
    evaluatorVersion: "mvp-2",
    harborExecutable: MVP_RUNTIME_HARBOR_EXECUTABLE,
    harborExecutableSha256: artifacts.harbor.sha256,
    bunExecutable: MVP_RUNTIME_BUN_EXECUTABLE,
    bunExecutableSha256: artifacts.bun.sha256,
    adapterPath: MVP_RUNTIME_ADAPTER_PATH,
    adapterSha256: artifacts.adapter.sha256,
    piEntrypoint: "packages/coding-agent/dist/pi",
    enabledTools: ["read", "bash", "write", "edit"],
    timeoutSeconds: 7_200,
    directSandboxEligibleTaskRevisionDigests: definitions.map(
      (definition) => definition.revisionDigest,
    ),
    hiddenTaskDefinitions: definitions,
    imageDigest,
    architecture: "x86_64",
    runtimeAbi: "linux-x64-glibc",
    providerLimits,
    providerLimitsDigest,
    eligibilityPolicyDigest,
    inventoryDigest: digest(definitions),
    resourcesDigest,
    networkPolicyDigest,
    samplingSettingsDigest,
    contextSettingsDigest,
    harnessConfigDigest,
    extraConfigDigest,
  };
}

function assertPrivateBootstrapDiscovery(
  value: unknown,
  expected: {
    readonly bunExecutableSha256: string;
    readonly eligibilityPolicyDigest: string;
    readonly providerLimitsDigest: string;
  },
): MvpPrivateBootstrapDiscovery {
  if (!validatePrivateDiscovery(value)) {
    throw new Error("Private runtime discovery manifest is invalid.");
  }
  const manifest = value as MvpPrivateBootstrapDiscovery;
  const definitions = manifest.definitions;
  const sorted = [...definitions].sort((left, right) =>
    left.revisionDigest.localeCompare(right.revisionDigest),
  );
  const profiles = definitions.flatMap((definition) => [
    definition.executionEligibility.officialResources.agent,
    ...definition.executionEligibility.officialResources.verifiers,
  ]);
  const maximum = {
    cpu: Math.max(...profiles.map((profile) => profile.cpu)),
    memoryMiB: Math.max(...profiles.map((profile) => profile.memoryMiB)),
    storageMiB: Math.max(...profiles.map((profile) => profile.storageMiB)),
  };
  const limits = MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS;
  const overlap = limits.maximumOverlappingChildSandboxes;
  const datasetRefDigest = manifest.datasetRef.slice("sha256:".length);
  if (
    manifest.compatibleTaskCount !== definitions.length ||
    manifest.compatibilitySandboxesDestroyed !== manifest.compatibilitySandboxesCreated ||
    manifest.datasetRevision !== `terminal-bench-2.1-r6-${datasetRefDigest.slice(0, 12)}` ||
    JSON.stringify(definitions) !== JSON.stringify(sorted) ||
    new Set(definitions.map((definition) => definition.revisionDigest)).size !==
      definitions.length ||
    new Set(definitions.map((definition) => definition.harborTaskLocator)).size !==
      definitions.length ||
    definitions.filter((definition) => !definition.easyCanary).length < 4 ||
    definitions.filter((definition) => definition.easyCanary).length < 1 ||
    definitions.some((definition) => {
      const prior = { hard: 0.8, medium: 0.6, easy: 0.3 }[definition.difficulty];
      const eligibility = definition.executionEligibility;
      const resourceProfiles = [
        eligibility.officialResources.agent,
        ...eligibility.officialResources.verifiers,
      ];
      const normalizedCost =
        Math.round(
          Math.max(
            ...resourceProfiles.map((profile) =>
              Math.max(
                profile.cpu / limits.perSandbox.cpu,
                profile.memoryMiB / limits.perSandbox.memoryMiB,
                profile.storageMiB / limits.perSandbox.storageMiB,
              ),
            ),
          ) * 1_000_000,
        ) / 1_000_000;
      return (
        definition.easyCanary !== (definition.difficulty === "easy") ||
        definition.baselineFailureRate !== prior ||
        definition.initialFailureRate !== prior ||
        definition.uncertainty !== 0.9 ||
        definition.normalizedCost !== normalizedCost ||
        !definition.sensitiveLiterals.includes(definition.harborTaskLocator) ||
        JSON.stringify(definition.sensitiveLiterals) !==
          JSON.stringify([...definition.sensitiveLiterals].sort()) ||
        definition.baselineProvenance.kind !== "dataset-declared-difficulty-prior" ||
        definition.baselineProvenance.datasetRevision !== manifest.datasetRevision ||
        (definition.baselineProvenance.kind === "dataset-declared-difficulty-prior" &&
          definition.baselineProvenance.policyDigest !== expected.eligibilityPolicyDigest) ||
        eligibility.providerLimitsDigest !== expected.providerLimitsDigest ||
        eligibility.runtimeCompatibility.bunExecutableSha256 !== expected.bunExecutableSha256 ||
        eligibility.runtimeCompatibility.smokeEvidenceDigest !==
          digest({
            policy: "direct-daytona-bun-exec-v1",
            revisionDigest: definition.revisionDigest,
            bunExecutableSha256: expected.bunExecutableSha256,
            reportedVersion: "1.3.14",
            exitCode: 0,
            destroyed: true,
          }) ||
        resourceProfiles.some(
          (profile) => profile.memoryMiB % 1_024 !== 0 || profile.storageMiB % 1_024 !== 0,
        ) ||
        eligibility.resourceSourceDigest !==
          digest({
            revisionDigest: definition.revisionDigest,
            agent: eligibility.officialResources.agent,
            verifiers: eligibility.officialResources.verifiers,
          })
      );
    }) ||
    manifest.compatibilitySandboxesCreated < definitions.length ||
    limits.outerEvaluator.cpu + maximum.cpu * overlap > limits.organization.cpu ||
    limits.outerEvaluator.memoryMiB + maximum.memoryMiB * overlap > limits.organization.memoryMiB ||
    limits.outerEvaluator.storageMiB + maximum.storageMiB * overlap > limits.organization.storageMiB
  ) {
    throw new Error("Private runtime discovery proof is inconsistent.");
  }
  return manifest;
}

async function verifyRuntimeArtifacts(
  port: MvpRuntimeBootstrapArtifactPort,
): Promise<VerifiedRuntimeArtifacts> {
  const runtimePins = await port.readJson(MVP_RUNTIME_PINS_PATH, MAXIMUM_RUNTIME_PINS_BYTES);
  assertImmutableFile(runtimePins, false);
  if (runtimePins.sha256 !== MVP_RUNTIME_PINS_SHA256) {
    throw new Error("Immutable MVP runtime pins differ from the reviewed source.");
  }
  const pins = assertImageRuntimePins(runtimePins.value);
  const [harbor, bun, adapter] = await Promise.all([
    port.inspectFile(MVP_RUNTIME_HARBOR_EXECUTABLE, MAXIMUM_ARTIFACT_BYTES),
    port.inspectFile(MVP_RUNTIME_BUN_EXECUTABLE, MAXIMUM_ARTIFACT_BYTES),
    port.inspectFile(MVP_RUNTIME_ADAPTER_PATH, MAXIMUM_ARTIFACT_BYTES),
  ]);
  assertImmutableFile(harbor, true);
  assertImmutableFile(bun, true);
  assertImmutableFile(adapter, false);
  return {
    pins,
    runtimePins,
    harbor,
    bun,
    adapter,
  };
}

function assertImageRuntimePins(value: unknown): MvpImageRuntimePins {
  if (!isPlainRecord(value)) {
    throw new Error("Immutable MVP runtime pins are invalid.");
  }
  const pins = value as Readonly<Record<string, unknown>>;
  const node = pins.node;
  const claudeCode = pins.claudeCode;
  const bun = pins.bun;
  const harbor = pins.harbor;
  if (
    !exactKeys(pins, [
      "schemaVersion",
      "domain",
      "platform",
      "runtimeAbi",
      "runtimeBaseImage",
      "debianSnapshot",
      "buildxVersion",
      "buildkitImage",
      "node",
      "claudeCode",
      "bun",
      "harbor",
      "requiredExecutables",
      "reservedIds",
      "defaultUser",
      "maximumUncompressedBytes",
    ]) ||
    pins.schemaVersion !== 1 ||
    pins.domain !== "dark-factory.mvp-runtime-pins.v1" ||
    pins.platform !== "linux/amd64" ||
    pins.runtimeAbi !== "linux-x64-glibc" ||
    !isPlainRecord(node) ||
    node.version !== "24.18.0" ||
    node.executable !== "/usr/bin/node" ||
    !isPlainRecord(claudeCode) ||
    claudeCode.version !== "2.1.217" ||
    claudeCode.executable !== "/usr/local/bin/claude" ||
    !isPlainRecord(bun) ||
    bun.version !== "1.3.14" ||
    bun.executable !== MVP_RUNTIME_BUN_EXECUTABLE ||
    bun.variant !== "bun-linux-x64-baseline" ||
    bun.target !== "bun-linux-x64-baseline" ||
    !isPlainRecord(harbor) ||
    harbor.version !== "0.20.0" ||
    harbor.executable !== MVP_RUNTIME_HARBOR_EXECUTABLE ||
    harbor.extra !== "daytona" ||
    !SHA256.test(String(harbor.wheelSha256)) ||
    JSON.stringify(pins.reservedIds) !== JSON.stringify([65532, 65533])
  ) {
    throw new Error("Immutable MVP runtime pins are invalid.");
  }
  return value as unknown as MvpImageRuntimePins;
}

function assertImmutableFile(artifact: MvpRuntimeBootstrapArtifact, executable: boolean): void {
  if (
    !SHA256.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 1 ||
    artifact.byteLength > MAXIMUM_ARTIFACT_BYTES ||
    artifact.uid !== 0 ||
    artifact.gid !== 0 ||
    (artifact.mode & 0o022) !== 0 ||
    (executable && (artifact.mode & 0o111) === 0)
  ) {
    throw new Error("An immutable evaluator artifact is unavailable.");
  }
}

function bootstrapEvidence(
  pin: MvpEvaluatorRuntimePin,
  runtimePinSha256: string,
  catalogSha256: string,
  sourceTaskCount: number,
): MvpRuntimeBootstrapEvidence {
  if (
    !SHA256.test(runtimePinSha256) ||
    !SHA256.test(catalogSha256) ||
    sourceTaskCount !== MVP_EVALUATOR_ELIGIBILITY_POLICY.expectedDatasetTaskCount
  ) {
    throw new Error("Runtime bootstrap evidence is invalid.");
  }
  return {
    runtimePinSha256,
    catalogSha256,
    inventoryDigest: pin.inventoryDigest,
    compatibleTaskCount: pin.hiddenTaskDefinitions.length,
    sourceTaskCount: 89,
    allStepVerifierEnvironmentModesSeparate: true,
    runtimeCompatibilityProven: true,
    officialResourcesFit: true,
  };
}

async function loadOrCreateCatalogNamespace(stateRoot: string): Promise<string> {
  const path = join(stateRoot, MVP_EVALUATOR_CATALOG_NAMESPACE_PATH);
  return withMountedLock(join(stateRoot, "private"), "catalog-namespace", async () => {
    const existing = await readOptionalPrivateJson(path, 2_048);
    if (existing !== null) {
      return catalogNamespace(existing);
    }
    const namespace = randomBytes(32).toString("hex");
    await writeJsonAtomic(path, {
      schemaVersion: 1,
      domain: "dark-factory.mvp-catalog-namespace.v1",
      namespace,
    });
    return namespace;
  });
}

async function loadExistingCatalogNamespace(stateRoot: string): Promise<string> {
  const value = await readPrivateJson(join(stateRoot, MVP_EVALUATOR_CATALOG_NAMESPACE_PATH), 2_048);
  return catalogNamespace(value);
}

function catalogNamespace(value: unknown): string {
  if (!isPlainRecord(value)) {
    throw new Error("Catalog namespace state is invalid.");
  }
  const namespace = value.namespace;
  if (
    !exactKeys(value, ["schemaVersion", "domain", "namespace"]) ||
    value.schemaVersion !== 1 ||
    value.domain !== "dark-factory.mvp-catalog-namespace.v1" ||
    typeof namespace !== "string" ||
    !SHA256.test(namespace)
  ) {
    throw new Error("Catalog namespace state is invalid.");
  }
  return namespace;
}

async function inspectRegularFile(
  path: string,
  maximumBytes: number,
): Promise<MvpRuntimeBootstrapArtifact> {
  return (await readRegularFileArtifact(path, maximumBytes)).artifact;
}

async function readPrivateJson(path: string, maximumBytes: number): Promise<unknown> {
  const { bytes } = await readRegularFileArtifact(path, maximumBytes);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

async function readOptionalPrivateJson(
  path: string,
  maximumBytes: number,
): Promise<unknown | null> {
  try {
    return await readPrivateJson(path, maximumBytes);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

async function readRegularFileArtifact(
  path: string,
  maximumBytes: number,
): Promise<{
  readonly artifact: MvpRuntimeBootstrapArtifact;
  readonly bytes: Buffer;
}> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("A required bootstrap artifact is not a regular file.");
  }
  const handle = await openNoFollow(path);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 1 ||
      metadata.size > maximumBytes ||
      metadata.dev !== before.dev ||
      metadata.ino !== before.ino
    ) {
      throw new Error("A required bootstrap artifact changed during inspection.");
    }
    const bytes = await handle.readFile();
    return {
      artifact: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteLength: bytes.byteLength,
        uid: metadata.uid,
        gid: metadata.gid,
        mode: metadata.mode & 0o7777,
      },
      bytes,
    };
  } finally {
    await handle.close();
  }
}

async function hashRegularFile(
  path: string,
  maximumBytes: number,
): Promise<{ readonly sha256: string; readonly byteLength: number }> {
  const artifact = await inspectRegularFile(path, maximumBytes);
  return {
    sha256: artifact.sha256,
    byteLength: artifact.byteLength,
  };
}

async function openNoFollow(path: string) {
  return open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
}

async function writeJsonExclusiveAtomic(path: string, value: unknown): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = join(parent, `.bootstrap-${randomUUID()}.json`);
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function runPrivateDiscovery(input: {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, [...input.arguments], {
      cwd: "/",
      env: { ...input.environment },
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let settled = false;
    const kill = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(new Error("Evaluator-private runtime discovery failed closed."));
    };
    const count = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_DISCOVERY_OUTPUT_BYTES) fail();
    };
    const timer = setTimeout(fail, DISCOVERY_TIMEOUT_MS);
    child.stdout?.on("data", count);
    child.stderr?.on("data", count);
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0 || outputBytes > MAXIMUM_DISCOVERY_OUTPUT_BYTES) {
        reject(new Error("Evaluator-private runtime discovery failed closed."));
      } else {
        resolve();
      }
    });
  });
}

function discoveryEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    CI: "true",
    DF_CLOUD_EXECUTION: "1",
    DF_MVP_ROLE: "evaluator",
    DAYTONA_API_KEY: requiredEnvironment("DAYTONA_API_KEY"),
    DAYTONA_API_URL: requiredEnvironment("DAYTONA_API_URL"),
    DAYTONA_TARGET: requiredEnvironment("DAYTONA_TARGET"),
    HOME: "/tmp/df-mvp-bootstrap-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PYTHONUNBUFFERED: "1",
  };
  for (const name of ["DAYTONA_SANDBOX_ID", "DAYTONA_WORKSPACE_ID"] as const) {
    const value = process.env[name]?.trim();
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  return environment;
}

function assertBootstrapInput(input: BootstrapMvpEvaluatorRuntimeInput): void {
  if (
    !input.stateRoot.startsWith("/") ||
    input.stateRoot === "/" ||
    !REVISION.test(input.sourceCommit) ||
    !IMMUTABLE_IMAGE.test(input.imageReference)
  ) {
    throw new Error("Evaluator runtime bootstrap input is invalid.");
  }
}

function assertProductionBootstrapBoundary(input: BootstrapMvpEvaluatorRuntimeInput): void {
  const report = process.report?.getReport() as
    | {
        readonly header?: {
          readonly glibcVersionRuntime?: unknown;
        };
      }
    | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  const identity = process.env.DAYTONA_SANDBOX_ID ?? process.env.DAYTONA_WORKSPACE_ID;
  if (
    input.stateRoot !== "/workspace/df-state" ||
    process.platform !== "linux" ||
    process.arch !== "x64" ||
    typeof glibc !== "string" ||
    process.env.CI !== "true" ||
    process.env.DF_CLOUD_EXECUTION !== "1" ||
    process.env.DF_MVP_ROLE !== "evaluator" ||
    identity === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(identity) ||
    requiredEnvironment("DF_MVP_SOURCE_COMMIT") !== input.sourceCommit ||
    requiredEnvironment("DF_MVP_IMAGE_REFERENCE") !== input.imageReference ||
    requiredEnvironment("DAYTONA_API_URL").replace(/\/+$/u, "") !== "https://app.daytona.io/api" ||
    !/(?:^|[-_.])eu(?:$|[-_.])/iu.test(requiredEnvironment("DAYTONA_TARGET"))
  ) {
    throw new Error("Evaluator-private bootstrap boundary is unavailable.");
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error("Evaluator-private bootstrap environment is incomplete.");
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    Object.keys(value).every((key) => expected.includes(key))
  );
}
