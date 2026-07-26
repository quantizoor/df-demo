import type {
  CloudSandboxProvider,
  RemoteExecutionReceipt,
  SandboxCreateRequest,
  SandboxLease,
  SecretReference,
  TrustedCloudArtifactRef,
} from "../cloud/types.js";
import { requireCompatibleProvider } from "../cloud/probe.js";
import {
  assertRawArtifactManifest,
  assertRawDestructionReceipt,
  assertRawDestructionReceiptVerifier,
  assertRawRetentionPolicy,
  type TrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../evaluator/retention.js";
import { canonicalHash } from "../schemas/canonical.js";
import {
  HARBOR_AGENT_ISOLATION_POLICY,
  assertTrustedHarborJobArtifact,
  createHarborInvocationSpec,
  createHarborOutputPackageSpec,
  type TrustedHarborJobArtifact,
} from "./harbor.js";
import type { PiHarborAgentSpec } from "./pi-agent.js";
import {
  assertTerminalBench21Pin,
  hashTerminalBench21Pin,
  type TerminalBench21Pin,
} from "./pin.js";
import type { TrustedMatchedArmSchedule, TrustedMatchedPanel } from "./trusted.js";

export interface TrustedHarborJobBuildRequest {
  readonly sensitivity: "hidden-harbor-build-request";
  readonly pin: TerminalBench21Pin;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly agent: PiHarborAgentSpec;
  readonly isolationPolicy: typeof HARBOR_AGENT_ISOLATION_POLICY;
}

export interface TrustedHarborJobBuilder {
  build(request: TrustedHarborJobBuildRequest): Promise<TrustedHarborJobArtifact>;
}

export interface TrustedRuntimeVerificationReceipt {
  readonly sensitivity: "trusted-runtime-verification";
  readonly sandboxId: string;
  readonly pinHash: string;
  readonly checkedAt: string;
  readonly harborPackageSha256: string;
  readonly harborExecutableSha256: string;
  readonly datasetContentSha256: string;
  readonly datasetManifestSha256: string;
  readonly piHarborAdapterSha256: string;
  readonly passed: true;
}

export interface TrustedTerminalBenchRuntimeVerifier {
  verify(
    provider: CloudSandboxProvider,
    lease: SandboxLease,
    pin: TerminalBench21Pin,
  ): Promise<TrustedRuntimeVerificationReceipt>;
}

export interface TrustedRawRun {
  readonly sensitivity: "raw-terminal-bench-run";
  readonly requestId: string;
  readonly pinHash: string;
  readonly jobSha256: string;
  readonly runtimeAttestationHash: string;
  readonly executions: readonly RemoteExecutionReceipt[];
  readonly rawBundles: readonly TrustedCloudArtifactRef[];
  readonly manifest: TrustedRawArtifactManifest;
}

export interface TrustedRawRunIngress {
  persist(input: {
    readonly requestId: string;
    readonly job: TrustedHarborJobArtifact;
    /**
     * Hidden task identities are required only inside the trusted ingress to
     * bind Harbor task names to the presealed matched schedule. They must
     * never be copied into an optimizer-visible artifact.
     */
    readonly panel: TrustedMatchedPanel;
    readonly schedule: TrustedMatchedArmSchedule;
    readonly executions: readonly RemoteExecutionReceipt[];
    readonly downloadedBundles: readonly TrustedCloudArtifactRef[];
    readonly retentionPolicy: TrustedRawRetentionPolicy;
    readonly runtimeVerification: TrustedRuntimeVerificationReceipt;
  }): Promise<TrustedRawRun>;

  /**
   * Idempotently destroys a persisted raw run when the runner cannot hand it
   * to the broker (for example, when sandbox teardown fails after ingestion).
   */
  discard(rawRun: TrustedRawRun): Promise<TrustedRawDestructionReceipt>;
}

export interface TerminalBenchRunnerOptions {
  readonly provider: CloudSandboxProvider;
  readonly pin: TerminalBench21Pin;
  readonly sandbox: SandboxCreateRequest;
  readonly harborExecutable: string;
  readonly harborWorkingDirectory: string;
  readonly harborTimeoutMs: number;
  readonly outputPackagerNodeExecutable: string;
  readonly outputPackagerTimeoutMs: number;
  readonly remoteUploadRoot: string;
  readonly remoteOutputRoot: string;
  /**
   * Exact cloud-environment credentials required by Harbor itself (for
   * example DAYTONA_API_KEY). These reach the trusted Harbor control process
   * but are never included in the Pi adapter's credential grant.
   */
  readonly harborSecretReferences: readonly SecretReference[];
  /**
   * Least-privilege subset forwarded to Harbor and the evaluated Pi process.
   * Cloud-provider, storage, signing, and optimizer credentials must never
   * appear here.
   */
  readonly modelSecretReferences: readonly SecretReference[];
  readonly jobBuilder: TrustedHarborJobBuilder;
  readonly runtimeVerifier: TrustedTerminalBenchRuntimeVerifier;
  readonly rawIngress: TrustedRawRunIngress;
  readonly retentionPolicy: TrustedRawRetentionPolicy;
  readonly destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier;
}

export interface TrustedTerminalBenchRunRequest {
  readonly sensitivity: "hidden-terminal-bench-run-request";
  readonly requestId: string;
  readonly panel: TrustedMatchedPanel;
  readonly schedule: TrustedMatchedArmSchedule;
  readonly agent: PiHarborAgentSpec;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;

export class TerminalBenchRunnerError extends Error {
  override readonly name = "TerminalBenchRunnerError";
}

function secretBindingKey(reference: SecretReference): string {
  return `${reference.sourceEnvironmentName}\u0000${reference.targetEnvironmentName}`;
}

function assertModelSecretReferences(
  sandbox: SandboxCreateRequest,
  references: readonly SecretReference[],
): void {
  const sandboxBindings = new Set(
    sandbox.secretReferences.map(secretBindingKey),
  );
  const targets = new Set<string>();
  if (
    references.length === 0 ||
    references.some(
      (reference) =>
        !SAFE_ENVIRONMENT_NAME.test(
          reference.sourceEnvironmentName,
        ) ||
        !SAFE_ENVIRONMENT_NAME.test(
          reference.targetEnvironmentName,
        ) ||
        !sandboxBindings.has(secretBindingKey(reference)) ||
        targets.has(reference.targetEnvironmentName),
    )
  ) {
    throw new TerminalBenchRunnerError(
      "Evaluated-model secret grants must be a unique explicit subset of the sandbox grant.",
    );
  }
  for (const reference of references) {
    targets.add(reference.targetEnvironmentName);
  }
}

function assertSeparatedHarborSecretReferences(
  sandbox: SandboxCreateRequest,
  harborReferences: readonly SecretReference[],
  modelReferences: readonly SecretReference[],
): void {
  assertModelSecretReferences(sandbox, harborReferences);
  const modelTargets = new Set(
    modelReferences.map(
      (reference) => reference.targetEnvironmentName,
    ),
  );
  if (
    harborReferences.some((reference) =>
      modelTargets.has(reference.targetEnvironmentName),
    )
  ) {
    throw new TerminalBenchRunnerError(
      "Harbor infrastructure and evaluated-model secret targets must be disjoint.",
    );
  }
}

function assertRuntimeVerification(
  receipt: TrustedRuntimeVerificationReceipt,
  lease: SandboxLease,
  pin: TerminalBench21Pin,
): void {
  if (
    receipt.sensitivity !== "trusted-runtime-verification" ||
    receipt.passed !== true ||
    receipt.sandboxId !== lease.sandboxId ||
    receipt.pinHash !== hashTerminalBench21Pin(pin) ||
    receipt.harborPackageSha256 !== pin.harborPackageSha256 ||
    receipt.harborExecutableSha256 !== pin.harborExecutableSha256 ||
    receipt.datasetContentSha256 !== pin.datasetContentSha256 ||
    receipt.datasetManifestSha256 !== pin.datasetManifestSha256 ||
    receipt.piHarborAdapterSha256 !== pin.piHarborAdapterSha256 ||
    !Number.isFinite(Date.parse(receipt.checkedAt))
  ) {
    throw new TerminalBenchRunnerError(
      "Cloud runtime does not attest the exact Terminal-Bench, Harbor, and Pi adapter pin.",
    );
  }
}

function assertRawRun(
  run: TrustedRawRun,
  request: TrustedTerminalBenchRunRequest,
  job: TrustedHarborJobArtifact,
  receipts: readonly RemoteExecutionReceipt[],
  downloadedBundles: readonly TrustedCloudArtifactRef[],
  retentionPolicy: TrustedRawRetentionPolicy,
  runtimeAttestationHash: string,
): void {
  assertRawArtifactManifest(retentionPolicy, run.manifest);
  const expectedExecutionIds = receipts.map((receipt) => receipt.executionId);
  const actualExecutionIds = run.executions.map((receipt) => receipt.executionId);
  const expectedBundleDigests = downloadedBundles.map((bundle) => bundle.sha256);
  const actualBundleDigests = run.rawBundles.map((bundle) => bundle.sha256);
  if (
    run.sensitivity !== "raw-terminal-bench-run" ||
    run.requestId !== request.requestId ||
    run.pinHash !== job.pinHash ||
    run.jobSha256 !== job.jobSha256 ||
    receipts.length !== job.invocations.length ||
    new Set(expectedExecutionIds).size !== expectedExecutionIds.length ||
    run.executions.length !== receipts.length ||
    actualExecutionIds.some(
      (executionId, index) => executionId !== expectedExecutionIds[index],
    ) ||
    downloadedBundles.length !== job.invocations.length ||
    new Set(downloadedBundles.map((bundle) => bundle.uri)).size !==
      downloadedBundles.length ||
    run.rawBundles.length !== downloadedBundles.length ||
    actualBundleDigests.some(
      (digest, index) => digest !== expectedBundleDigests[index],
    ) ||
    run.rawBundles.some(
      (bundle, index) =>
        bundle.uri !== downloadedBundles[index]?.uri ||
        bundle.byteLength !== downloadedBundles[index]?.byteLength,
    ) ||
    run.manifest.policyHash !== retentionPolicy.policyHash ||
    run.manifest.localExportAllowed !== false ||
    run.runtimeAttestationHash !== runtimeAttestationHash ||
    !SHA256.test(run.runtimeAttestationHash)
  ) {
    throw new TerminalBenchRunnerError(
      "Trusted raw ingress returned material from another job or retention policy.",
    );
  }
}

/**
 * This runner only emits command specifications through an injected cloud
 * provider. It has no local subprocess, Docker, Harbor, or filesystem fallback.
 */
export class TerminalBenchCloudRunner {
  readonly #options: TerminalBenchRunnerOptions;

  constructor(options: TerminalBenchRunnerOptions) {
    assertTerminalBench21Pin(options.pin);
    assertRawRetentionPolicy(options.retentionPolicy);
    assertRawDestructionReceiptVerifier(options.destructionReceiptVerifier);
    assertModelSecretReferences(
      options.sandbox,
      options.modelSecretReferences,
    );
    assertSeparatedHarborSecretReferences(
      options.sandbox,
      options.harborSecretReferences,
      options.modelSecretReferences,
    );
    if (
      options.sandbox.requestId.length === 0 ||
      options.sandbox.imageDigest.length === 0 ||
      options.sandbox.network.defaultAction !== "deny" ||
      !isValidRemoteRoot(options.remoteUploadRoot) ||
      !isValidRemoteRoot(options.remoteOutputRoot) ||
      options.remoteUploadRoot === options.remoteOutputRoot ||
      !isValidRemotePath(options.outputPackagerNodeExecutable) ||
      !Number.isSafeInteger(options.outputPackagerTimeoutMs) ||
      options.outputPackagerTimeoutMs <= 0 ||
      options.outputPackagerTimeoutMs > 60 * 60_000
    ) {
      throw new TerminalBenchRunnerError(
        "Cloud sandbox request and trusted remote roots must be immutable and fail closed.",
      );
    }
    this.#options = options;
  }

  async run(request: TrustedTerminalBenchRunRequest): Promise<TrustedRawRun> {
    if (
      request.sensitivity !== "hidden-terminal-bench-run-request" ||
      request.requestId !== request.panel.requestId ||
      request.requestId !== request.schedule.requestId ||
      request.panel.stage !== request.schedule.stage ||
      request.schedule.cellCount !== request.panel.cells.length ||
      request.schedule.armCount !==
        (request.panel.stage === "repair"
          ? request.panel.cells.length
          : request.panel.cells.length * 2) ||
      request.schedule.candidateArmCount !== request.panel.cells.length ||
      request.schedule.championArmCount !==
        (request.panel.stage === "repair" ? 0 : request.panel.cells.length) ||
      request.agent.adapterSha256 !==
        this.#options.pin.piHarborAdapterSha256 ||
      canonicalHash(
        [...request.agent.credentialEnvironmentNames].sort(),
      ) !==
        canonicalHash(
          this.#options.modelSecretReferences
            .map((reference) => reference.targetEnvironmentName)
            .sort(),
        )
    ) {
      throw new TerminalBenchRunnerError(
        "Matched schedule, hidden panel, agent adapter, and request do not correlate.",
      );
    }

    await requireCompatibleProvider(this.#options.provider, {
      requestId: `probe-${canonicalHash(request.requestId).slice(0, 32)}`,
      imageDigest: this.#options.sandbox.imageDigest,
      regionClass: this.#options.sandbox.regionClass,
      resources: this.#options.sandbox.resources,
      requireDockerInDocker: false,
      requireGpu: this.#options.sandbox.resources.gpuClass !== undefined,
    });

    let lease: SandboxLease | undefined;
    let persistedRawRun: TrustedRawRun | undefined;
    let persistedRawDiscarded = false;
    try {
      lease = await this.#options.provider.create({
        ...this.#options.sandbox,
        requestId: request.requestId,
      });
      const runtimeVerification = await this.#options.runtimeVerifier.verify(
        this.#options.provider,
        lease,
        this.#options.pin,
      );
      assertRuntimeVerification(runtimeVerification, lease, this.#options.pin);
      const runtimeAttestationHash = hashRuntimeVerification(runtimeVerification);

      const job = await this.#options.jobBuilder.build({
        sensitivity: "hidden-harbor-build-request",
        pin: this.#options.pin,
        panel: request.panel,
        schedule: request.schedule,
        agent: request.agent,
        isolationPolicy: HARBOR_AGENT_ISOLATION_POLICY,
      });
      assertTrustedHarborJobArtifact(job, hashTerminalBench21Pin(this.#options.pin));
      if (
        job.requestId !== request.requestId ||
        job.stage !== request.schedule.stage ||
        job.cellCount !== request.schedule.cellCount ||
        job.armCount !== request.schedule.armCount ||
        job.uploads.some(
          (upload) =>
            !isWithinRemoteRoot(upload.remotePath, this.#options.remoteUploadRoot),
        ) ||
        job.invocations.some(
          (invocation) =>
            !isWithinRemoteRoot(
              invocation.remoteHarborJobPath,
              this.#options.remoteOutputRoot,
            ) ||
            !isWithinRemoteRoot(
              invocation.remoteOutputPath,
              this.#options.remoteOutputRoot,
            ),
        )
      ) {
        throw new TerminalBenchRunnerError(
          "Trusted Harbor job changed its presealed roots, stage, or arm cardinality.",
        );
      }

      for (const upload of job.uploads) {
        await this.#options.provider.upload(lease, upload.artifact, upload.remotePath);
      }

      const executions: RemoteExecutionReceipt[] = [];
      for (const invocation of job.invocations) {
        const execution = await this.#options.provider.execute(
          lease,
          createHarborInvocationSpec({
            harborExecutable: this.#options.harborExecutable,
            workingDirectory: this.#options.harborWorkingDirectory,
            timeoutMs: this.#options.harborTimeoutMs,
            pin: this.#options.pin,
            job,
            invocation,
            secretReferences:
              [
                ...this.#options.harborSecretReferences,
                ...this.#options.modelSecretReferences,
              ],
          }),
        );
        if (
          execution.exitCode !== 0 ||
          execution.timedOut ||
          execution.cancelled
        ) {
          throw new TerminalBenchRunnerError(
            "Harbor failed or was interrupted; no evaluation result is releasable.",
          );
        }
        executions.push(execution);
      }

      for (const [index, invocation] of job.invocations.entries()) {
        const harborExecution = executions[index];
        if (harborExecution === undefined) {
          throw new TerminalBenchRunnerError(
            "A Harbor invocation has no execution receipt to bind its output.",
          );
        }
        const packaging = await this.#options.provider.execute(
          lease,
          createHarborOutputPackageSpec({
            nodeExecutable:
              this.#options.outputPackagerNodeExecutable,
            workingDirectory: this.#options.harborWorkingDirectory,
            timeoutMs: this.#options.outputPackagerTimeoutMs,
            pin: this.#options.pin,
            job,
            invocation,
            executionId: harborExecution.executionId,
          }),
        );
        if (
          packaging.exitCode !== 0 ||
          packaging.timedOut ||
          packaging.cancelled
        ) {
          throw new TerminalBenchRunnerError(
            "Harbor output packaging failed; no raw result is releasable.",
          );
        }
      }

      const downloadedBundles: TrustedCloudArtifactRef[] = [];
      for (const invocation of job.invocations) {
        const bundle = await this.#options.provider.download(
          lease,
          invocation.remoteOutputPath,
          {
            mediaType: "application/x-tar",
            maximumByteLength: 2_304 * 1024 * 1024,
          },
        );
        if (
          bundle.mediaType !== "application/x-tar" ||
          bundle.byteLength <= 0 ||
          bundle.byteLength > 2_304 * 1024 * 1024
        ) {
          throw new TerminalBenchRunnerError(
            "Harbor output bundle is not a bounded deterministic tar artifact.",
          );
        }
        downloadedBundles.push(bundle);
      }
      persistedRawRun = await this.#options.rawIngress.persist({
        requestId: request.requestId,
        job,
        panel: request.panel,
        schedule: request.schedule,
        executions,
        downloadedBundles,
        retentionPolicy: this.#options.retentionPolicy,
        runtimeVerification,
      });
      assertRawRun(
        persistedRawRun,
        request,
        job,
        executions,
        downloadedBundles,
        this.#options.retentionPolicy,
        runtimeAttestationHash,
      );
      return persistedRawRun;
    } catch {
      if (persistedRawRun !== undefined) {
        persistedRawDiscarded = await discardRawRun(
          this.#options.rawIngress,
          this.#options.retentionPolicy,
          persistedRawRun,
          this.#options.destructionReceiptVerifier,
        );
      }
      throw new TerminalBenchRunnerError(
        "Trusted Terminal-Bench execution failed closed without a releasable result.",
      );
    } finally {
      if (lease !== undefined) {
        try {
          await this.#options.provider.destroy(lease);
        } catch {
          if (
            persistedRawRun !== undefined &&
            !persistedRawDiscarded
          ) {
            await discardRawRun(
              this.#options.rawIngress,
              this.#options.retentionPolicy,
              persistedRawRun,
              this.#options.destructionReceiptVerifier,
            );
          }
          throw new TerminalBenchRunnerError(
            "Cloud sandbox teardown failed; the evaluation was discarded.",
          );
        }
      }
    }
  }
}

function hashRuntimeVerification(receipt: TrustedRuntimeVerificationReceipt): string {
  return canonicalHash(receipt);
}

function isWithinRemoteRoot(path: string, root: string): boolean {
  return (
    root.startsWith("/") &&
    root.endsWith("/") &&
    !root.includes("/../") &&
    path.startsWith(root) &&
    path.length > root.length &&
    !path.includes("/../")
  );
}

function isValidRemoteRoot(root: string): boolean {
  return (
    root.startsWith("/") &&
    root.endsWith("/") &&
    root !== "/" &&
    !root.includes("/../") &&
    !root.includes("\u0000")
  );
}

function isValidRemotePath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("/../") &&
    !path.includes("\u0000")
  );
}

async function discardRawRun(
  ingress: TrustedRawRunIngress,
  policy: TrustedRawRetentionPolicy,
  rawRun: TrustedRawRun,
  verifier: TrustedRawDestructionReceiptVerifier,
): Promise<boolean> {
  try {
    const receipt = await ingress.discard(rawRun);
    assertRawDestructionReceipt(policy, rawRun.manifest, receipt, verifier);
    return true;
  } catch {
    // The encrypted, export-disabled retention policy still bounds lifetime.
    // The caller always fails closed and releases no evaluation result.
    return false;
  }
}
