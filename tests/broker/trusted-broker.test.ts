import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  Ed25519ResultEnvelopeIssuer,
  Ed25519ResultEnvelopeVerifier,
} from "../../src/broker/issuer.js";
import {
  DurableOneUseRequestLedger,
  emptyOneUseLedgerState,
  type AtomicOneUseLedgerStore,
  type BrokerFailureCode,
  type OneUseClaim,
  type OneUseLedgerState,
  type OneUseRequestLedger,
} from "../../src/broker/ledger.js";
import {
  TrustedEvaluationBroker,
  type TrustedCanonicalAggregate,
} from "../../src/broker/service.js";
import {
  hashEvaluationRequest,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  createSignedRawDestructionReceipt,
  createTrustedRawArtifactManifest,
  type TrustedRawDestructionReceipt,
  type TrustedRawDestructionReceiptVerifier,
  type TrustedRawRetentionPolicy,
} from "../../src/evaluator/retention.js";
import { hashNetworkPolicy } from "../../src/cloud/provider.js";
import { hiddenTaskId } from "../../src/evaluation/types.js";
import {
  DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
  createPiHarborAgentSpec,
} from "../../src/terminal-bench/pi-agent.js";
import type { TrustedRawRun } from "../../src/terminal-bench/runner.js";
import type { TrustedMatchedPanel } from "../../src/terminal-bench/trusted.js";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);

const retentionPolicy: TrustedRawRetentionPolicy = {
  policyHash: "c".repeat(64),
  storageRoot: "trusted://raw/evaluator/",
  maximumRetentionMinutes: 60,
  destruction: "crypto-shred",
  encryptionRequired: true,
  localExportAllowed: false,
};
const rawDestructionKey = generateKeyPairSync("ed25519");
const destructionReceiptVerifier: TrustedRawDestructionReceiptVerifier = {
  trustedKeyId: "raw-destruction-key-1",
  publicKey: rawDestructionKey.publicKey,
};

function request(): TrustedEvaluationRequest {
  const networkPolicyHash = hashNetworkPolicy({
    defaultAction: "deny",
    allowDomains: ["api.model.example.test"],
  });
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH,
    complianceManifestHash: SECOND_HASH,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: "1".repeat(40),
      treeSha: "1".repeat(40),
      archiveSha256: "1".repeat(64),
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: "2".repeat(40),
      treeSha: "2".repeat(40),
      archiveSha256: "2".repeat(64),
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: "3".repeat(64),
      hypothesisExclusionAttestationHash: "4".repeat(64),
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${"5".repeat(64)}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 8,
        memoryMiB: 16_384,
        diskMiB: 100_000,
      },
      networkPolicyHash,
      protocolHash: HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function panel(): TrustedMatchedPanel {
  return {
    sensitivity: "hidden-benchmark-panel",
    leaseId: "lease-001",
    requestId: "request-001",
    stage: "validation",
    sealedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-07-01T06:00:00.000Z",
    dispositionAttestationHash: "6".repeat(64),
    cells: Array.from({ length: 12 }, (_, index) => ({
      sensitivity: "hidden-benchmark-cell" as const,
      taskId: hiddenTaskId((index + 1).toString(16).padStart(64, "0")),
      taskRevisionDigest: (index + 30).toString(16).padStart(64, "0"),
      capabilityStratum: `stratum-${(index % 3) + 1}`,
      replicateOrdinal: 1,
      order: index % 2 === 0 ? ("AB" as const) : ("BA" as const),
    })),
  };
}

function rawRun(): TrustedRawRun {
  const manifest = createTrustedRawArtifactManifest(retentionPolicy, {
    manifestId: "manifest-001",
    createdAt: "2026-07-01T00:03:00.000Z",
    destroyBy: "2026-07-01T00:30:00.000Z",
    artifacts: [
      {
        kind: "atif",
        uri: "trusted://raw/evaluator/atif.json.enc",
        sha256: "1".repeat(64),
        byteLength: 1_024,
        encrypted: true,
      },
      {
        kind: "grader-output",
        uri: "trusted://raw/evaluator/grader.json.enc",
        sha256: "2".repeat(64),
        byteLength: 2_048,
        encrypted: true,
      },
      {
        kind: "harbor-output",
        uri: "trusted://raw/evaluator/harbor.tar.enc",
        sha256: "0".repeat(64),
        byteLength: 4_096,
        encrypted: true,
      },
    ],
  });
  return {
    sensitivity: "raw-terminal-bench-run",
    requestId: "request-001",
    pinHash: "7".repeat(64),
    jobSha256: "8".repeat(64),
    runtimeAttestationHash: "9".repeat(64),
    executions: [
      {
        provider: "daytona",
        sandboxId: "sandbox-001",
        executionId: "execution-001",
        startedAt: "2026-07-01T00:01:00.000Z",
        finishedAt: "2026-07-01T00:02:00.000Z",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        resourceReport: { peakMemoryMiB: 1024, cpuTimeMs: 30_000 },
      },
    ],
    rawBundles: [
      {
        uri: "trusted://raw/evaluator/bundle",
        sha256: "0".repeat(64),
        mediaType: "application/gzip",
        byteLength: 4_096,
      },
    ],
    manifest,
  };
}

function aggregate(): TrustedCanonicalAggregate {
  const evaluationRequest = request();
  return {
    sensitivity: "trusted-canonical-aggregate",
    requestHash: hashEvaluationRequest(evaluationRequest),
    protocolHash: HASH,
    rawManifestId: "manifest-001",
    payload: {
      kind: "validation",
      disposition: "inconclusive",
      matchedTaskCount: 12,
      validFreshArmCount: 24,
      invalidArmTotal: 0,
      stratumCount: 3,
      pairOutcomeTotals: {
        bothPass: 3,
        challengerOnlyPass: 3,
        championOnlyPass: 3,
        bothFail: 3,
      },
      weightedAccuracy: {
        medianDelta: 0,
        credibleInterval: { lower: -0.2, upper: 0.2 },
        probabilityPositive: 0.5,
      },
      requiredPosteriorProbability: 0.95,
      onlineGateAuthorized: true,
      stratumRegressionVeto: false,
      integrityVeto: false,
      correctnessVeto: false,
      capabilityVeto: false,
      costWithinGuardrail: true,
      latencyWithinGuardrail: true,
      accuracyTradeoffPredeclared: false,
      aggregateCost: {
        inputTokens: 100,
        outputTokens: 50,
        modelUsd: 1,
        sandboxUsd: 0.5,
        totalUsd: 1.5,
        wallTimeMs: 60_000,
      },
    },
    normalizedOutcomeSetHash: "d".repeat(64),
    cacheAttestationHash: "e".repeat(64),
    behavioralAggregateHash: null,
    derivedAt: "2026-07-01T00:04:00.000Z",
    releaseChecks: {
      graderCanaryScanPassed: true,
      contentFingerprintScanPassed: true,
      taskIdentityScanPassed: true,
      privacyThresholdPassed: true,
    },
  };
}

class FakeLedger implements OneUseRequestLedger {
  claimResult: OneUseClaim = {
    state: "acquired",
    claimToken: "claim-001",
  };
  consumed: BrokerFailureCode | undefined;

  claim(): Promise<OneUseClaim> {
    return Promise.resolve(this.claimResult);
  }

  bindDispositionAttestation(): Promise<boolean> {
    return Promise.resolve(true);
  }

  complete(): Promise<void> {
    return Promise.resolve();
  }

  consumeFailure(
    _claimToken: string,
    _requestHash: string,
    failureCode: BrokerFailureCode,
  ): Promise<void> {
    this.consumed = failureCode;
    return Promise.resolve();
  }
}

class AtomicMemoryStore implements AtomicOneUseLedgerStore {
  state: OneUseLedgerState = emptyOneUseLedgerState();

  transact<Result>(
    operation: (state: OneUseLedgerState) => {
      readonly next: OneUseLedgerState;
      readonly result: Result;
    },
  ): Promise<Result> {
    const transaction = operation(this.state);
    this.state = transaction.next;
    return Promise.resolve(transaction.result);
  }
}

function destructionReceipt(
  manifest = rawRun().manifest,
  privateKey = rawDestructionKey.privateKey,
): TrustedRawDestructionReceipt {
  return createSignedRawDestructionReceipt({
    policy: retentionPolicy,
    manifest,
    destroyedAt: "2026-07-01T00:10:00.000Z",
    privateKey,
    keyId: destructionReceiptVerifier.trustedKeyId,
    signedAt: "2026-07-01T00:10:00.000Z",
  });
}

function agent() {
  return createPiHarborAgentSpec({
    adapterImportPath: DARK_FACTORY_PI_HARBOR_IMPORT_PATH,
    adapterSha256: "a".repeat(64),
    provider: "openai",
    modelId: "gpt-5.6",
    thinkingLevel: "high",
    enabledTools: ["read", "write", "bash"],
    credentialEnvironmentNames: ["OPENAI_API_KEY"],
    timeoutMs: 3_600_000,
  });
}

describe("trusted evaluation broker fail-closed lifecycle", () => {
  it("returns the same signed result on replay without rerunning hidden cells", async () => {
    const evaluationRequest = request();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const runner = vi.fn(() => Promise.resolve(rawRun()));
    const issuer = new Ed25519ResultEnvelopeIssuer({
      privateKey,
      keyId: "evaluator-key-1",
      now: () => new Date("2026-07-01T00:11:00.000Z"),
    });
    const verifier = new Ed25519ResultEnvelopeVerifier({
      getVerificationKey: () => Promise.resolve(publicKey),
    });
    const broker = new TrustedEvaluationBroker({
      ledger: new DurableOneUseRequestLedger({
        store: new AtomicMemoryStore(),
        claimTokenFactory: () => "claim-001",
      }),
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: runner },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) => Promise.resolve(destructionReceipt(run.manifest)),
      },
      issuer,
      verifier,
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    const first = await broker.evaluate(evaluationRequest);
    const replay = await broker.evaluate(evaluationRequest);
    expect(replay).toEqual(first);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it(
    "destroys raw material and consumes the request when canonical normalization fails",
    async () => {
      const ledger = new FakeLedger();
      const destroy = vi.fn((run: TrustedRawRun) =>
        Promise.resolve(destructionReceipt(run.manifest)),
      );
      const broker = new TrustedEvaluationBroker({
        ledger,
        panels: { allocateAndConsume: () => Promise.resolve(panel()) },
        runner: { run: () => Promise.resolve(rawRun()) },
        deriver: {
          derive: () =>
            Promise.reject(new Error("sensitive hidden task failure detail")),
        },
        custodian: { destroy },
        issuer: {
          issue: () => Promise.reject(new Error("issuer must not be called")),
        },
        verifier: { verify: () => Promise.resolve(true) },
        agent: agent(),
        retentionPolicy,
        destructionReceiptVerifier,
      });
      const outcome = broker.evaluate(request());
      await expect(outcome).rejects.toMatchObject({
        code: "normalization-failed",
      });
      await expect(outcome).rejects.not.toThrow(/hidden task failure detail/u);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(ledger.consumed).toBe("normalization-failed");
    },
  );

  it("releases nothing when raw destruction cannot be attested", async () => {
    const ledger = new FakeLedger();
    const issue = vi.fn(() => Promise.reject(new Error("must not issue")));
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: {
        derive: () => Promise.resolve(aggregate()),
      },
      custodian: {
        destroy: () => Promise.reject(new Error("storage-specific secret")),
      },
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "raw-destruction-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(ledger.consumed).toBe("raw-destruction-failed");
  });

  it("releases nothing when destruction is signed by an untrusted key", async () => {
    const ledger = new FakeLedger();
    const issue = vi.fn(() => Promise.reject(new Error("must not issue")));
    const untrustedKey = generateKeyPairSync("ed25519");
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: () => Promise.resolve(panel()) },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) =>
          Promise.resolve(
            destructionReceipt(run.manifest, untrustedKey.privateKey),
          ),
      },
      issuer: { issue },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });

    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "raw-destruction-failed",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(ledger.consumed).toBe("raw-destruction-failed");
  });

  it("rejects replay mutation before allocating any hidden panel", async () => {
    const ledger = new FakeLedger();
    ledger.claimResult = { state: "conflict" };
    const allocate = vi.fn(() => Promise.resolve(panel()));
    const broker = new TrustedEvaluationBroker({
      ledger,
      panels: { allocateAndConsume: allocate },
      runner: { run: () => Promise.resolve(rawRun()) },
      deriver: { derive: () => Promise.resolve(aggregate()) },
      custodian: {
        destroy: (run) => Promise.resolve(destructionReceipt(run.manifest)),
      },
      issuer: {
        issue: () => Promise.reject(new Error("must not issue")),
      },
      verifier: { verify: () => Promise.resolve(true) },
      agent: agent(),
      retentionPolicy,
      destructionReceiptVerifier,
    });
    await expect(broker.evaluate(request())).rejects.toMatchObject({
      code: "request-conflict",
    });
    expect(allocate).not.toHaveBeenCalled();
  });
});
