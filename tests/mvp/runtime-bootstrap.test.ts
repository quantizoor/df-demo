import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/mvp/contracts.js";
import {
  assertMvpEvaluatorRuntimePin,
  MVP_EVALUATOR_RUNTIME_PIN_PATH,
  mvpEvaluatorEligibilityPolicyDigest,
} from "../../src/mvp/evaluator-runtime.js";
import { writeJsonAtomic } from "../../src/mvp/mounted-files.js";
import {
  bootstrapMvpEvaluatorRuntime,
  MVP_RUNTIME_ADAPTER_PATH,
  MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS,
  MVP_RUNTIME_BUN_EXECUTABLE,
  MVP_RUNTIME_HARBOR_EXECUTABLE,
  MVP_RUNTIME_PINS_PATH,
  type MvpRuntimeBootstrapArtifact,
  type MvpRuntimeBootstrapArtifactPort,
  type MvpRuntimeBootstrapDiscoveryPort,
  type MvpRuntimeBootstrapDiscoveryRequest,
  runMvpPrivateDiscoveryProcess,
} from "../../src/mvp/runtime-bootstrap.js";

const sourceCommit = "a".repeat(40);
const imageReference = `ghcr.io/parallaxai/dark-factory@sha256:${digest("image")}`;
const bunSha256 = digest("bun-executable");
const harborSha256 = digest("harbor-executable");
const adapterSha256 = digest("adapter");

describe("MVP evaluator-private runtime bootstrap", () => {
  it("writes the private catalog before its V2 pin and returns only task-free evidence", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "df-mvp-bootstrap-"));
    const discovery = new StubDiscovery(discoveryManifest());

    const result = await bootstrapMvpEvaluatorRuntime({
      stateRoot,
      sourceCommit,
      imageReference,
      discovery,
      artifacts: new StubArtifacts(),
    });

    expect(discovery.calls).toBe(1);
    expect(Object.keys(result.evidence).sort()).toEqual(
      [
        "runtimePinSha256",
        "catalogSha256",
        "inventoryDigest",
        "compatibleTaskCount",
        "sourceTaskCount",
        "allStepVerifierEnvironmentModesSeparate",
        "runtimeCompatibilityProven",
        "officialResourcesFit",
      ].sort(),
    );
    expect(result.evidence).toMatchObject({
      compatibleTaskCount: 5,
      sourceTaskCount: 89,
      allStepVerifierEnvironmentModesSeparate: true,
      runtimeCompatibilityProven: true,
      officialResourcesFit: true,
    });
    expect(result.sandboxAccounting).toEqual({
      created: 5,
      destroyed: 5,
      allDestroyed: true,
    });
    expect(JSON.stringify(result)).not.toContain("terminal-bench/task-");

    const pin = JSON.parse(
      await readFile(join(stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH), "utf8"),
    ) as unknown;
    assertMvpEvaluatorRuntimePin(pin);
    expect(pin.sourceCommit).toBe(sourceCommit);
    expect(pin.imageReference).toBe(imageReference);
    await expect(
      access(join(stateRoot, "private", "hidden-task-catalog.json")),
    ).resolves.toBeUndefined();
  });

  it("is idempotent without repeating discovery and refuses source or image drift", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "df-mvp-bootstrap-"));
    const discovery = new StubDiscovery(discoveryManifest());
    const artifacts = new StubArtifacts();
    const first = await bootstrapMvpEvaluatorRuntime({
      stateRoot,
      sourceCommit,
      imageReference,
      discovery,
      artifacts,
    });
    const pinPath = join(stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH);
    const before = await readFile(pinPath, "utf8");

    const second = await bootstrapMvpEvaluatorRuntime({
      stateRoot,
      sourceCommit,
      imageReference,
      discovery,
      artifacts,
    });

    expect(discovery.calls).toBe(1);
    expect(second.evidence).toEqual(first.evidence);
    expect(second.sandboxAccounting).toEqual({
      created: 0,
      destroyed: 0,
      allDestroyed: true,
    });
    await expect(
      bootstrapMvpEvaluatorRuntime({
        stateRoot,
        sourceCommit: "b".repeat(40),
        imageReference,
        discovery,
        artifacts,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-state",
    });
    await expect(
      bootstrapMvpEvaluatorRuntime({
        stateRoot,
        sourceCommit,
        imageReference: `ghcr.io/parallaxai/dark-factory@sha256:${digest("other-image")}`,
        discovery,
        artifacts,
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-state",
    });
    expect(await readFile(pinPath, "utf8")).toBe(before);
  });

  it("rejects a discovery proof with an unbound difficulty prior before writing a pin", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "df-mvp-bootstrap-"));
    const discovery = new StubDiscovery(
      discoveryManifest({ priorPolicyDigest: digest("different-policy") }),
    );

    await expect(
      bootstrapMvpEvaluatorRuntime({
        stateRoot,
        sourceCommit,
        imageReference,
        discovery,
        artifacts: new StubArtifacts(),
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-validation",
    });
    await expect(access(join(stateRoot, MVP_EVALUATOR_RUNTIME_PIN_PATH))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    ["runtime pins", { pins: { mode: 0o666 } }, "bootstrap-artifacts-pins"],
    ["Harbor executable", { harbor: { mode: 0o666 } }, "bootstrap-artifacts-harbor"],
    ["Bun executable", { bun: { mode: 0o666 } }, "bootstrap-artifacts-bun"],
    ["Pi adapter", { adapter: { mode: 0o666 } }, "bootstrap-artifacts-adapter"],
  ] as const)(
    "classifies %s drift before invoking private discovery",
    async (_label, overrides, expectedCode) => {
      const stateRoot = await mkdtemp(join(tmpdir(), "df-mvp-bootstrap-"));
      const discovery = new StubDiscovery(discoveryManifest());
      const artifacts = new StubArtifacts(overrides);

      await expect(
        bootstrapMvpEvaluatorRuntime({
          stateRoot,
          sourceCommit,
          imageReference,
          discovery,
          artifacts,
        }),
      ).rejects.toMatchObject({
        name: "MvpPreflightDiagnosticError",
        code: expectedCode,
      });
      expect(discovery.calls).toBe(0);
    },
  );

  it("classifies a pre-existing mounted bootstrap lock without exposing its contents", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "df-mvp-bootstrap-"));
    await mkdir(join(stateRoot, "private", ".mvp-runtime-bootstrap.lock"), {
      recursive: true,
    });

    await expect(
      bootstrapMvpEvaluatorRuntime({
        stateRoot,
        sourceCommit,
        imageReference,
        discovery: new StubDiscovery(discoveryManifest()),
        artifacts: new StubArtifacts(),
      }),
    ).rejects.toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-lock",
    });
  });

  it("propagates only the Python phase marker across the private subprocess boundary", async () => {
    const privateDetail = "private provider detail and task material";
    const failure = await runMvpPrivateDiscoveryProcess({
      executable: process.execPath,
      arguments: [
        "-e",
        `process.stderr.write(${JSON.stringify(
          `${privateDetail}\nMVP_DISCOVERY_FAILURE:download\n`,
        )}); process.exit(1);`,
      ],
      environment: {},
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "MvpPreflightDiagnosticError",
      code: "bootstrap-discovery-download",
    });
    expect(String(failure)).not.toContain(privateDetail);
  });
});

class StubDiscovery implements MvpRuntimeBootstrapDiscoveryPort {
  public calls = 0;

  public constructor(private readonly manifest: unknown) {}

  public async discover(request: MvpRuntimeBootstrapDiscoveryRequest): Promise<void> {
    this.calls += 1;
    await writeJsonAtomic(request.outputPath, this.manifest);
  }
}

class StubArtifacts implements MvpRuntimeBootstrapArtifactPort {
  readonly #overrides: {
    readonly pins?: Partial<MvpRuntimeBootstrapArtifact>;
    readonly harbor?: Partial<MvpRuntimeBootstrapArtifact>;
    readonly bun?: Partial<MvpRuntimeBootstrapArtifact>;
    readonly adapter?: Partial<MvpRuntimeBootstrapArtifact>;
  };

  public constructor(
    overrides: {
      readonly pins?: Partial<MvpRuntimeBootstrapArtifact>;
      readonly harbor?: Partial<MvpRuntimeBootstrapArtifact>;
      readonly bun?: Partial<MvpRuntimeBootstrapArtifact>;
      readonly adapter?: Partial<MvpRuntimeBootstrapArtifact>;
    } = {},
  ) {
    this.#overrides = overrides;
  }

  public async readJson(path: string): Promise<{
    readonly value: unknown;
    readonly sha256: string;
    readonly byteLength: number;
    readonly uid: number;
    readonly gid: number;
    readonly mode: number;
  }> {
    expect(path).toBe(MVP_RUNTIME_PINS_PATH);
    const bytes = await readFile(
      new URL("../../containers/mvp-runtime-pins.json", import.meta.url),
    );
    return {
      value: JSON.parse(bytes.toString("utf8")) as unknown,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      uid: 0,
      gid: 0,
      mode: 0o444,
      ...this.#overrides.pins,
    };
  }

  public async inspectFile(path: string): Promise<MvpRuntimeBootstrapArtifact> {
    const common = {
      byteLength: 1_024,
      uid: 0,
      gid: 0,
    };
    if (path === MVP_RUNTIME_HARBOR_EXECUTABLE) {
      return {
        ...common,
        sha256: harborSha256,
        mode: 0o755,
        ...this.#overrides.harbor,
      };
    }
    if (path === MVP_RUNTIME_BUN_EXECUTABLE) {
      return {
        ...common,
        sha256: bunSha256,
        mode: 0o755,
        ...this.#overrides.bun,
      };
    }
    if (path === MVP_RUNTIME_ADAPTER_PATH) {
      return {
        ...common,
        sha256: adapterSha256,
        mode: 0o444,
        ...this.#overrides.adapter,
      };
    }
    throw new Error(`Unexpected artifact path: ${path}`);
  }
}

function discoveryManifest(options: { readonly priorPolicyDigest?: string } = {}) {
  const eligibilityPolicyDigest =
    options.priorPolicyDigest ?? mvpEvaluatorEligibilityPolicyDigest();
  const providerLimitsDigest = digest(MVP_RUNTIME_BOOTSTRAP_PROVIDER_LIMITS);
  const datasetRefDigest = digest("dataset-ref");
  const datasetRevision = `terminal-bench-2.1-r6-${datasetRefDigest.slice(0, 12)}`;
  const definitions = Array.from({ length: 5 }, (_, index) => {
    const difficulty = index === 4 ? ("easy" as const) : ("hard" as const);
    const revisionDigest = digest(`revision-${index + 1}`);
    const agent = {
      cpu: 1,
      memoryMiB: 1_024,
      storageMiB: 1_024,
      gpus: 0 as const,
    };
    const verifiers = [{ ...agent }];
    const prior = difficulty === "easy" ? 0.3 : 0.8;
    return {
      harborTaskLocator: `terminal-bench/task-${index + 1}`,
      revisionDigest,
      difficulty,
      easyCanary: difficulty === "easy",
      baselineFailureRate: prior,
      baselineProvenance: {
        kind: "dataset-declared-difficulty-prior" as const,
        sourceDigest: digest(`prior-${index + 1}`),
        policyDigest: eligibilityPolicyDigest,
        datasetRevision,
      },
      graderIsolation: {
        verifierEnvironmentMode: "separate" as const,
        allStepVerifierEnvironmentModesSeparate: true as const,
        sourceDigest: digest(`isolation-${index + 1}`),
      },
      leaderboard: {
        kind: "unknown" as const,
        reason: "not-published" as const,
      },
      initialFailureRate: prior,
      uncertainty: 0.9,
      normalizedCost: 0.25,
      sensitiveLiterals: [`task-${index + 1}`, `terminal-bench/task-${index + 1}`],
      executionEligibility: {
        environmentType: "daytona" as const,
        sandboxMode: "direct" as const,
        compose: false as const,
        officialResources: {
          agent,
          verifiers,
        },
        resourceSourceDigest: digest({
          revisionDigest,
          agent,
          verifiers,
        }),
        providerLimitsDigest,
        resourceFit: true as const,
        runtimeCompatibility: {
          architecture: "x86_64" as const,
          runtimeAbi: "linux-x64-glibc" as const,
          bunExecutableSha256: bunSha256,
          smokeEvidenceDigest: digest({
            policy: "direct-daytona-bun-exec-v1",
            revisionDigest,
            bunExecutableSha256: bunSha256,
            reportedVersion: "1.3.14",
            exitCode: 0,
            destroyed: true,
          }),
          compatible: true as const,
        },
      },
    };
  }).sort((left, right) => left.revisionDigest.localeCompare(right.revisionDigest));
  return {
    schemaVersion: 1,
    domain: "dark-factory.mvp-private-bootstrap-discovery.v1",
    datasetName: "terminal-bench/terminal-bench-2-1",
    datasetRef: `sha256:${datasetRefDigest}`,
    datasetRevision,
    datasetContentSha256: digest("dataset-content"),
    datasetManifestSha256: digest("dataset-manifest"),
    registryRevision: 6,
    sourceTaskCount: 89,
    compatibleTaskCount: definitions.length,
    compatibilitySandboxesCreated: definitions.length,
    compatibilitySandboxesDestroyed: definitions.length,
    allCompatibilitySandboxesDestroyed: true,
    definitions,
  };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
