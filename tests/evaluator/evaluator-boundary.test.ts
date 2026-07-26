import {
  createHash,
  generateKeyPairSync,
  sign as signPayload,
  type KeyObject,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertEvaluationRequest,
  hashEvaluationRequest,
  type AggregateResultBody,
  type SignedAggregateEnvelope,
  type TrustedEvaluationRequest,
} from "../../src/evaluator/contracts.js";
import {
  TrustedEvaluatorClient,
  type TrustedEvaluatorTransport,
} from "../../src/evaluator/client.js";
import {
  canonicalJson,
  type EnvelopeKeyring,
  parseSignedAggregateEnvelope,
  verifySignedAggregateEnvelope,
} from "../../src/evaluator/signature.js";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const CANDIDATE_COMMIT = "c".repeat(40);
const CHAMPION_COMMIT = "d".repeat(40);

function validationRequest(): TrustedEvaluationRequest {
  return {
    schemaVersion: 1,
    requestId: "request-001",
    experimentId: "001-improve-recovery",
    runMode: "research",
    stage: "validation",
    submittedAt: "2026-07-01T00:00:00.000Z",
    deadlineAt: "2026-07-01T06:00:00.000Z",
    protocolHash: HASH,
    complianceManifestHash: SECOND_HASH,
    candidate: {
      uri: "trusted://harness/candidate",
      commitSha: CANDIDATE_COMMIT,
      treeSha: CANDIDATE_COMMIT,
      archiveSha256: HASH,
    },
    champion: {
      uri: "trusted://harness/champion",
      commitSha: CHAMPION_COMMIT,
      treeSha: CHAMPION_COMMIT,
      archiveSha256: SECOND_HASH,
    },
    selection: {
      kind: "fresh-matched-validation",
      taskCount: 12,
      attemptsPerArm: 1,
      pairOrder: "balanced-6-ab-6-ba",
      weightingPolicyHash: HASH,
      frozenHypothesisHash: SECOND_HASH,
      hypothesisExclusionAttestationHash: SECOND_HASH,
    },
    executionProfile: {
      provider: "daytona",
      imageDigest: `sha256:${HASH}`,
      regionClass: "eu-standard",
      resources: {
        architecture: "x86_64",
        cpuCores: 4,
        memoryMiB: 8192,
        diskMiB: 20_000,
      },
      networkPolicyHash: HASH,
      protocolHash: HASH,
    },
    evaluatedModel: {
      provider: "openai",
      modelId: "gpt-5.6",
      thinkingLevel: "high",
    },
  };
}

function resultBody(request: TrustedEvaluationRequest): AggregateResultBody {
  return {
    schemaVersion: 1,
    requestId: request.requestId,
    requestHash: hashEvaluationRequest(request),
    dispositionAttestationHash: HASH,
    reuseProhibited: true,
    experimentId: request.experimentId,
    runMode: request.runMode,
    stage: request.stage,
    protocolHash: request.protocolHash,
    environmentFingerprintHash: SECOND_HASH,
    sealedAt: "2026-07-01T01:00:00.000Z",
    gateDecision: "pass",
    attempts: {
      requestedArms: 24,
      startedArms: 24,
      validArms: 24,
      infrastructureInvalidArms: 0,
    },
    score: {
      candidate: { validArms: 12, successRate: 0.75, meanReward: 0.75 },
      champion: { validArms: 12, successRate: 0.5, meanReward: 0.5 },
      delta: 0.25,
      confidenceInterval95: [0.05, 0.45],
    },
    cost: {
      totalUsd: 1.5,
      modelUsd: 1,
      sandboxUsd: 0.5,
      wallTimeSeconds: 1200,
    },
    integrity: {
      status: "passed",
      reasonCodes: ["clean"],
      canaryMatchCount: 0,
    },
    privacy: {
      releaseEligible: true,
      everyComparedGroupAtLeastFive: true,
      complementarySuppressionPassed: true,
      differencingBudgetStatus: "available",
      suppressedCardCountBand: "0",
    },
    cache: {
      usedForRepair: false,
      usedForDecision: false,
      promotionEvidence: "fresh-only",
      driftAnchorsPassed: true,
    },
    diagnostics: [
      {
        cardId: "card-01",
        pattern: "nonzero-exit-without-inspection",
        toolCategory: "execute",
        association: "more-common-in-failures",
        effectSizeBand: "medium",
        uncertaintyBand: "medium",
        distinctTasksBand: "10-19",
        trajectoryCountBand: "20-39",
        recommendation: "inspect-before-retry",
      },
    ],
    rawArtifacts: {
      exported: false,
      retentionPolicyHash: HASH,
    },
    leaderboardEligibility: "ineligible-research",
  };
}

function signEnvelope(body: AggregateResultBody, privateKey: KeyObject): SignedAggregateEnvelope {
  const serialized = canonicalJson(body);
  return {
    body,
    signature: {
      algorithm: "Ed25519",
      keyId: "evaluator-key-1",
      issuedAt: body.sealedAt,
      signedBodySha256: createHash("sha256").update(serialized).digest("hex"),
      value: signPayload(null, Buffer.from(serialized), privateKey).toString("base64url"),
    },
  };
}

class StaticKeyring implements EnvelopeKeyring {
  readonly #key: KeyObject;

  constructor(key: KeyObject) {
    this.#key = key;
  }

  getVerificationKey(keyId: string): Promise<KeyObject | undefined> {
    return Promise.resolve(keyId === "evaluator-key-1" ? this.#key : undefined);
  }
}

class StaticTransport implements TrustedEvaluatorTransport {
  response: unknown;
  seenCredentialName: string | undefined;

  constructor(response: unknown) {
    this.response = response;
  }

  submit(
    _endpoint: string,
    _request: TrustedEvaluationRequest,
    credentialEnvironmentName: string,
  ): Promise<unknown> {
    this.seenCredentialName = credentialEnvironmentName;
    return Promise.resolve(this.response);
  }
}

describe("trusted evaluation request", () => {
  it("contains only opaque harness references and a broker-owned selection request", () => {
    const request = validationRequest();
    expect(() => assertEvaluationRequest(request)).not.toThrow();
    expect(hashEvaluationRequest(request)).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("taskId");
    expect(serialized).not.toContain("taskName");
    expect(serialized).not.toContain("grader");
  });

  it("rejects a matched validation without a distinct champion", () => {
    const request = validationRequest();
    expect(() =>
      assertEvaluationRequest({
        ...request,
        champion: { ...request.candidate },
      }),
    ).toThrow(/distinct/u);
  });

  it("rejects task identity smuggled as an additional request property", () => {
    const request = {
      ...validationRequest(),
      taskIds: ["hidden-task"],
    } as unknown as TrustedEvaluationRequest;
    expect(() => assertEvaluationRequest(request)).toThrow(/taskIds/u);
  });

  it("rejects repair selection at the validation stage", () => {
    const request = {
      ...validationRequest(),
      selection: {
        kind: "repair-reuse",
        sourceExperimentId: "000-baseline",
        taskCount: 5,
        attemptsPerTask: 1,
        candidateAttempt: 1,
        frozenHypothesisHash: SECOND_HASH,
      } as const,
    };
    expect(() => assertEvaluationRequest(request)).toThrow(/fresh matched/u);
  });

  it("admits an authorized feedback-dark official request only in submission mode", () => {
    const validation = validationRequest();
    const { champion: _champion, ...withoutChampion } = validation;
    const official: TrustedEvaluationRequest = {
      ...withoutChampion,
      runMode: "submission",
      stage: "official",
      selection: {
        kind: "official-full",
        expectedArmCount: 89,
        authorizationHash: HASH,
        feedback: "disabled",
      },
    };
    expect(() => assertEvaluationRequest(official)).not.toThrow();
    expect(() =>
      assertEvaluationRequest({ ...official, runMode: "research" }),
    ).toThrow(/adaptive research/u);
  });
});

describe("signed aggregate envelope", () => {
  it("parses, correlates, and verifies a minimal aggregate result", async () => {
    const request = validationRequest();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const envelope = signEnvelope(resultBody(request), privateKey);
    expect(parseSignedAggregateEnvelope(envelope)).toEqual(envelope);
    await expect(
      verifySignedAggregateEnvelope(
        envelope,
        request,
        hashEvaluationRequest(request),
        new StaticKeyring(publicKey),
      ),
    ).resolves.toEqual(envelope);
  });

  it("rejects a validly shaped envelope after body tampering", async () => {
    const request = validationRequest();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const envelope = signEnvelope(resultBody(request), privateKey);
    const tampered = {
      ...envelope,
      body: {
        ...envelope.body,
        gateDecision: "fail" as const,
      },
    };
    await expect(
      verifySignedAggregateEnvelope(
        tampered,
        request,
        hashEvaluationRequest(request),
        new StaticKeyring(publicKey),
      ),
    ).rejects.toThrow(/digest/u);
  });

  it("rejects additional fields, per-task rows, and cache-based promotion", () => {
    const request = validationRequest();
    const { privateKey } = generateKeyPairSync("ed25519");
    const envelope = signEnvelope(resultBody(request), privateKey);
    expect(() =>
      parseSignedAggregateEnvelope({
        ...envelope,
        body: { ...envelope.body, perTaskResults: [] },
      }),
    ).toThrow(/perTaskResults/u);
    expect(() =>
      parseSignedAggregateEnvelope({
        ...envelope,
        body: {
          ...envelope.body,
          cache: { ...envelope.body.cache, usedForDecision: true },
        },
      }),
    ).toThrow(/Cache/u);
  });

  it("forbids diagnostics in repair and feedback-dark stages", () => {
    const request = validationRequest();
    const body = {
      ...resultBody(request),
      stage: "shadow",
      attempts: {
        requestedArms: 12,
        startedArms: 12,
        validArms: 12,
        infrastructureInvalidArms: 0,
      },
      score: {
        candidate: { validArms: 12, successRate: 0.75, meanReward: 0.75 },
      },
      cache: {
        usedForRepair: false,
        usedForDecision: false,
        promotionEvidence: "not-a-promotion-stage",
        driftAnchorsPassed: true,
      },
      privacy: {
        releaseEligible: false,
        everyComparedGroupAtLeastFive: false,
        complementarySuppressionPassed: true,
        differencingBudgetStatus: "not-applicable",
        suppressedCardCountBand: "0",
      },
    };
    expect(() =>
      parseSignedAggregateEnvelope({
        body,
        signature: {
          algorithm: "Ed25519",
          keyId: "evaluator-key-1",
          issuedAt: body.sealedAt,
          signedBodySha256: HASH,
          value: "A".repeat(86),
        },
      }),
    ).toThrow(/Diagnostic release/u);
  });
});

describe("trusted evaluator client", () => {
  it("returns only a verified locally safe envelope", async () => {
    const request = validationRequest();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const transport = new StaticTransport(signEnvelope(resultBody(request), privateKey));
    const client = new TrustedEvaluatorClient({
      endpoint: "https://evaluator.example.test/v1",
      credentialEnvironmentName: "DF_EVALUATOR_TOKEN",
      transport,
      keyring: new StaticKeyring(publicKey),
    });
    await expect(client.evaluate(request)).resolves.toMatchObject({
      body: { gateDecision: "pass" },
    });
    expect(transport.seenCredentialName).toBe("DF_EVALUATOR_TOKEN");
  });

  it.each([
    "http://evaluator.example.test",
    "https://localhost:8443",
    "https://user:secret@evaluator.example.test",
  ])("rejects non-remote or credential-bearing endpoint %s", (endpoint) => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(
      () =>
        new TrustedEvaluatorClient({
          endpoint,
          credentialEnvironmentName: "DF_EVALUATOR_TOKEN",
          transport: new StaticTransport({}),
          keyring: new StaticKeyring(publicKey),
        }),
    ).toThrow();
  });
});
