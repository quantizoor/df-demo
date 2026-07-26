import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CampaignConflictError,
  CampaignIntegrityError,
  CampaignStateStore,
  CampaignTransitionError,
  HarnessRegistrationError,
  HarnessRegistrationStore,
  assertCampaignStateTransition,
  campaignReconstructionInputs,
} from "../../src/campaign/index.js";
import {
  canonicalJson,
  withContentHash,
} from "../../src/schemas/canonical.js";
import type { CampaignState } from "../../src/schemas/control.js";
import { assertValidDocument } from "../../src/schemas/registry.js";
import {
  COMMIT_B,
  HASH_A,
  HASH_B,
  HASH_C,
  HASH_D,
  HASH_E,
  LATER,
  campaignSeed,
  harnessRegistrationFixture,
  initialCampaignStateFixture,
} from "./fixtures.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "df-campaign-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function initializedStore(): Promise<{
  readonly root: string;
  readonly store: CampaignStateStore;
}> {
  const root = await temporaryRoot();
  const store = new CampaignStateStore(root, "campaign-001", {
    now: () => new Date(LATER),
    ledgerTransitionVerifier: {
      verify: async () => undefined,
    },
    decisionAttestationVerifier: {
      verify: async () => undefined,
    },
    controlAttestationVerifier: {
      verify: async () => undefined,
    },
  });
  await store.initialize(campaignSeed());
  return { root, store };
}

function ledgersFor(
  state: Awaited<ReturnType<CampaignStateStore["read"]>>,
) {
  const reconstruction = state.reconstruction;
  if (
    reconstruction.brokerExposureStateAttestationHash === null ||
    reconstruction.repeatedTestingLedgerHash === null ||
    reconstruction.privacyLedgerHash === null
  ) {
    throw new Error("Campaign fixture is missing required reconstruction ledgers");
  }
  return {
    brokerExposureStateAttestationHash:
      reconstruction.brokerExposureStateAttestationHash,
    repeatedTestingLedgerHash: reconstruction.repeatedTestingLedgerHash,
    privacyLedgerHash: reconstruction.privacyLedgerHash,
    cacheStateAttestationHash: reconstruction.cacheStateAttestationHash,
    publicationQueueHash: reconstruction.publicationQueueHash,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("HarnessRegistrationStore", () => {
  it("fails closed when no trusted repository verifier is installed", async () => {
    const root = await temporaryRoot();
    const store = new HarnessRegistrationStore(root);

    await expect(
      store.register(harnessRegistrationFixture()),
    ).rejects.toBeInstanceOf(HarnessRegistrationError);
  });

  it("writes one canonical registration with an idempotent exact retry", async () => {
    const root = await temporaryRoot();
    const store = new HarnessRegistrationStore(root, {
      verifier: { verify: async () => undefined },
    });
    const registration = harnessRegistrationFixture();

    await store.register(registration);
    await expect(store.register(registration)).resolves.toBeUndefined();
    await expect(store.read(registration.registrationId)).resolves.toEqual(registration);
    expect(await readFile(join(root, "pi-private-fork.json"), "utf8")).toBe(
      `${canonicalJson(registration)}\n`,
    );
  });

  it("rejects a conflicting registration under the same id", async () => {
    const root = await temporaryRoot();
    const store = new HarnessRegistrationStore(root, {
      verifier: { verify: async () => undefined },
    });
    const registration = harnessRegistrationFixture();
    await store.register(registration);

    const conflict = harnessRegistrationFixture("repository-policy-v2");
    await expect(store.register(conflict)).rejects.toBeInstanceOf(
      HarnessRegistrationError,
    );
    await expect(store.read(registration.registrationId)).resolves.toEqual(registration);
  });

  it("rejects non-canonical registration bytes", async () => {
    const root = await temporaryRoot();
    const store = new HarnessRegistrationStore(root, {
      verifier: { verify: async () => undefined },
    });
    await store.initialize();
    const registration = harnessRegistrationFixture();
    await writeFile(
      join(root, "pi-private-fork.json"),
      `${JSON.stringify(registration, null, 2)}\n`,
    );

    await expect(store.read("pi-private-fork")).rejects.toBeInstanceOf(
      HarnessRegistrationError,
    );
  });
});

describe("CampaignStateStore", () => {
  it("fails closed when no trusted genesis/control verifier is installed", async () => {
    const root = await temporaryRoot();
    const store = new CampaignStateStore(root, "campaign-001");

    await expect(store.initialize(campaignSeed())).rejects.toBeInstanceOf(
      CampaignTransitionError,
    );
  });

  it("rejects campaign path traversal and a symlinked campaign directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    expect(() => new CampaignStateStore(root, "../escape")).toThrow(
      CampaignIntegrityError,
    );

    await symlink(outside, join(root, "campaign-001"));
    const store = new CampaignStateStore(root, "campaign-001");
    await expect(store.initialize(campaignSeed())).rejects.toBeInstanceOf(
      CampaignIntegrityError,
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("persists revision zero and exposes bounded reconstruction inputs", async () => {
    const { root, store } = await initializedStore();
    const history = await store.reconstruct();
    const inputs = campaignReconstructionInputs(history.current);

    expect(history.states).toHaveLength(1);
    expect(history.current.revision).toBe(0);
    expect(inputs).toMatchObject({
      campaignId: "campaign-001",
      nextExperimentNumber: 1,
      inFlightExperimentNumber: null,
      lastFullySealedExperimentNumber: 0,
      experimentSealChainHead: HASH_A,
    });

    const stateFiles = await readdir(join(root, "campaign-001", "states"));
    expect(stateFiles).toEqual([
      `0000000000000000-${history.current.contentHash}.json`,
    ]);
  });

  it("performs content-hash compare-and-swap and rejects a stale writer", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const updated = await store.recordBudgetUsage(
      initial.contentHash,
      {
        ...initial.budget.usage,
        spentUsd: 1,
        attempts: 2,
      },
      HASH_A,
    );

    expect(updated.revision).toBe(1);
    expect(updated.previousStateHash).toBe(initial.contentHash);
    expect(updated.budget.usage.spentUsd).toBe(1);
    await expect(
      store.recordBudgetUsage(initial.contentHash, updated.budget.usage, HASH_B),
    ).rejects.toBeInstanceOf(CampaignConflictError);
  });

  it("persists the exact input snapshot that its trusted verifier observed", async () => {
    const root = await temporaryRoot();
    let signalVerifierEntered: (() => void) | undefined;
    let releaseVerifier: (() => void) | undefined;
    const verifierEntered = new Promise<void>((resolve) => {
      signalVerifierEntered = () => resolve();
    });
    const verifierRelease = new Promise<void>((resolve) => {
      releaseVerifier = () => resolve();
    });
    const store = new CampaignStateStore(root, "campaign-001", {
      now: () => new Date(LATER),
      ledgerTransitionVerifier: {
        verify: async (transition) => {
          if (transition.reason === "checkpoint") {
            signalVerifierEntered?.();
            await verifierRelease;
          }
        },
      },
      decisionAttestationVerifier: {
        verify: async () => undefined,
      },
      controlAttestationVerifier: {
        verify: async () => undefined,
      },
    });
    const initial = await store.initialize(campaignSeed());
    const mutableLedgers = {
      ...ledgersFor(initial),
      cacheStateAttestationHash: HASH_B,
    };
    const pending = store.recordLedgerCheckpoint(
      initial.contentHash,
      mutableLedgers,
    );
    await verifierEntered;
    mutableLedgers.cacheStateAttestationHash = HASH_A;
    releaseVerifier?.();

    await expect(pending).resolves.toMatchObject({
      reconstruction: { cacheStateAttestationHash: HASH_B },
    });
  });

  it("blocks recovery from crossing the final lock-ownership check and state commit", async () => {
    const root = await temporaryRoot();
    let signalVerifierEntered: (() => void) | undefined;
    let releaseVerifier: (() => void) | undefined;
    const verifierEntered = new Promise<void>((resolve) => {
      signalVerifierEntered = () => resolve();
    });
    const verifierRelease = new Promise<void>((resolve) => {
      releaseVerifier = () => resolve();
    });
    const store = new CampaignStateStore(root, "campaign-001", {
      now: () => new Date(LATER),
      lockWaitMs: 20,
      lockRetryMs: 1,
      ledgerTransitionVerifier: {
        verify: async (transition) => {
          if (transition.reason === "checkpoint") {
            signalVerifierEntered?.();
            await verifierRelease;
          }
        },
      },
      decisionAttestationVerifier: {
        verify: async () => undefined,
      },
      controlAttestationVerifier: {
        verify: async () => undefined,
      },
    });
    const initial = await store.initialize(campaignSeed());
    const pending = store.recordLedgerCheckpoint(initial.contentHash, {
      ...ledgersFor(initial),
      cacheStateAttestationHash: HASH_B,
    });
    await verifierEntered;
    await writeFile(
      join(root, "campaign-001", ".recovery.lock"),
      `${canonicalJson({
        acquiredAt: LATER,
        ownerToken: "e".repeat(32),
        processId: 99_998,
      })}\n`,
    );
    releaseVerifier?.();

    await expect(pending).rejects.toThrow(/lock is held/u);
    await expect(store.read()).resolves.toMatchObject({
      contentHash: initial.contentHash,
      revision: 0,
    });
  });

  it("rejects a history entry that marks one experiment sealed and interrupted", () => {
    const initial = initialCampaignStateFixture();
    const allocatedValue: unknown = withContentHash({
      ...initial,
      provenanceRefs: [
        {
          artifactName: "harness-registration",
          contentHash: initial.harnessRegistrationHash,
        },
        {
          artifactName: "campaign-state",
          contentHash: initial.contentHash,
        },
      ],
      revision: 1,
      previousStateHash: initial.contentHash,
      numbering: {
        ...initial.numbering,
        nextExperimentNumber: 2,
        inFlightExperimentNumber: 1,
        inFlightKind: "optimization",
      },
    });
    assertValidDocument("campaignState", allocatedValue);
    const allocated: CampaignState = allocatedValue;
    const terminalValue: unknown = withContentHash({
      ...allocated,
      createdAt: LATER,
      provenanceRefs: [
        {
          artifactName: "harness-registration",
          contentHash: allocated.harnessRegistrationHash,
        },
        {
          artifactName: "campaign-state",
          contentHash: allocated.contentHash,
        },
      ],
      revision: 2,
      previousStateHash: allocated.contentHash,
      numbering: {
        ...allocated.numbering,
        inFlightExperimentNumber: null,
        inFlightKind: null,
        lastInterruptedExperimentNumber: 1,
      },
      reconstruction: {
        ...allocated.reconstruction,
        lastFullySealedExperimentNumber: 1,
        experimentSealChainHead: HASH_B,
        lastSealedDecision: {
          experimentNumber: 1,
          stage: "pre-validation",
          disposition: "rejected",
          decisionAttestationHash: HASH_C,
          sealedAt: LATER,
        },
        brokerExposureStateAttestationHash: HASH_E,
      },
    });
    assertValidDocument("campaignState", terminalValue);

    expect(() =>
      assertCampaignStateTransition(allocated, terminalValue),
    ).toThrow(/both fully sealed and interrupted/u);
  });

  it("makes repeated stop, acknowledgement, and resume requests idempotent", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const requested = await store.requestStop(initial.contentHash, "operator");
    const repeatedRequest = await store.requestStop(initial.contentHash, "operator");
    expect(repeatedRequest.contentHash).toBe(requested.contentHash);

    const stopped = await store.acknowledgeStopped(requested.contentHash);
    const repeatedAcknowledgement = await store.acknowledgeStopped(
      requested.contentHash,
    );
    expect(repeatedAcknowledgement.contentHash).toBe(stopped.contentHash);

    const resumed = await store.resume(stopped.contentHash, HASH_B);
    const repeatedResume = await store.resume(stopped.contentHash, HASH_B);
    expect(repeatedResume.contentHash).toBe(resumed.contentHash);
    expect(resumed.control).toMatchObject({ status: "running", runEpoch: 1 });
    expect((await store.reconstruct()).states).toHaveLength(4);
  });

  it("accepts only an immediate exact resume retry and rejects authorization replay", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const firstRequest = await store.requestStop(initial.contentHash, "operator");
    const firstStop = await store.acknowledgeStopped(firstRequest.contentHash);
    const firstResume = await store.resume(firstStop.contentHash, HASH_B);
    const secondRequest = await store.requestStop(
      firstResume.contentHash,
      "operator",
    );
    const secondStop = await store.acknowledgeStopped(secondRequest.contentHash);

    await expect(
      store.resume(secondStop.contentHash, HASH_B),
    ).rejects.toBeInstanceOf(CampaignTransitionError);
  });

  it("replays trusted authorization verification while reconstructing history", async () => {
    const root = await temporaryRoot();
    let rejectPersistedResume = false;
    const store = new CampaignStateStore(root, "campaign-001", {
      now: () => new Date(LATER),
      ledgerTransitionVerifier: {
        verify: async () => undefined,
      },
      decisionAttestationVerifier: {
        verify: async () => undefined,
      },
      controlAttestationVerifier: {
        verify: async (attestation) => {
          if (attestation.kind === "resume" && rejectPersistedResume) {
            throw new Error("revoked trusted authorization");
          }
        },
      },
    });
    const initial = await store.initialize(campaignSeed());
    const requested = await store.requestStop(initial.contentHash, "operator");
    const stopped = await store.acknowledgeStopped(requested.contentHash);
    await store.resume(stopped.contentHash, HASH_B);

    rejectPersistedResume = true;
    await expect(store.reconstruct()).rejects.toThrow(
      "revoked trusted authorization",
    );
  });

  it("coalesces concurrent repeated stop signals under the campaign lock", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const [first, second] = await Promise.all([
      store.requestStop(initial.contentHash, "sigint"),
      store.requestStop(initial.contentHash, "sigint"),
    ]);

    expect(first.contentHash).toBe(second.contentHash);
    expect((await store.reconstruct()).states).toHaveLength(2);
  });

  it("archives interrupted work before stop and never reuses its experiment number", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const allocation = await store.allocateExperiment(
      initial.contentHash,
      "optimization",
    );
    expect(allocation.experimentNumber).toBe(1);

    const requested = await store.requestStop(
      allocation.state.contentHash,
      "sigterm",
    );
    await expect(
      store.acknowledgeStopped(requested.contentHash),
    ).rejects.toBeInstanceOf(CampaignTransitionError);

    const archived = await store.archiveInterruptedExperiment(
      requested.contentHash,
      1,
      HASH_D,
    );
    const repeatedArchive = await store.archiveInterruptedExperiment(
      requested.contentHash,
      1,
      HASH_D,
    );
    expect(repeatedArchive.contentHash).toBe(archived.contentHash);
    const repeatedStop = await store.requestStop(
      allocation.state.contentHash,
      "sigterm",
    );
    expect(repeatedStop.contentHash).toBe(archived.contentHash);

    const stopped = await store.acknowledgeStopped(archived.contentHash);
    const resumed = await store.resume(stopped.contentHash, HASH_B);
    const nextAllocation = await store.allocateExperiment(
      resumed.contentHash,
      "optimization",
    );
    expect(nextAllocation.experimentNumber).toBe(2);
    expect(nextAllocation.state.numbering.lastInterruptedExperimentNumber).toBe(1);
  });

  it("pauses durably and requires a fresh authorization to resume", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const paused = await store.pause(initial.contentHash, "infrastructure", HASH_A);
    expect(paused.control.status).toBe("paused");

    const resumed = await store.resume(paused.contentHash, HASH_B);
    expect(resumed.control.status).toBe("running");
    expect(resumed.control.lastResumeAuthorizationHash).toBe(HASH_B);
    expect(resumed.control.runEpoch).toBe(1);
  });

  it("keeps an exhausted campaign paused until its spend ceiling is extended", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const exhausted = await store.recordBudgetUsage(
      initial.contentHash,
      {
        ...initial.budget.usage,
        spentUsd: initial.budget.limits.maximumUsd,
      },
      HASH_A,
    );
    await expect(
      store.allocateExperiment(exhausted.contentHash, "optimization"),
    ).rejects.toBeInstanceOf(CampaignTransitionError);
    const paused = await store.pause(
      exhausted.contentHash,
      "budget-exhausted",
      HASH_B,
    );
    await expect(store.resume(paused.contentHash, HASH_C)).rejects.toBeInstanceOf(
      CampaignTransitionError,
    );

    const extended = await store.extendSpendBudget(
      paused.contentHash,
      {
        maximumUsd: paused.budget.limits.maximumUsd + 50,
        maximumTokens: paused.budget.limits.maximumTokens,
        maximumWallTimeMs: paused.budget.limits.maximumWallTimeMs,
        maximumAttempts: paused.budget.limits.maximumAttempts,
      },
      HASH_E,
    );
    await expect(store.resume(extended.contentHash, HASH_C)).resolves.toMatchObject({
      control: { status: "running", runEpoch: 1 },
    });
  });

  it("rejects budget rollback and unattested accounting changes", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    await expect(
      store.recordBudgetUsage(
        initial.contentHash,
        { ...initial.budget.usage, attempts: 1 },
        initial.budget.accountingAttestationHash,
      ),
    ).rejects.toBeInstanceOf(CampaignTransitionError);

    const spent = await store.recordBudgetUsage(
      initial.contentHash,
      { ...initial.budget.usage, attempts: 1 },
      HASH_A,
    );
    await expect(
      store.recordBudgetUsage(
        spent.contentHash,
        { ...spent.budget.usage, attempts: 0 },
        HASH_B,
      ),
    ).rejects.toBeInstanceOf(CampaignTransitionError);
  });

  it("allows spend extension but rejects no-op authorization rotation", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const extended = await store.extendSpendBudget(
      initial.contentHash,
      {
        maximumUsd: initial.budget.limits.maximumUsd + 50,
        maximumTokens: initial.budget.limits.maximumTokens,
        maximumWallTimeMs: initial.budget.limits.maximumWallTimeMs,
        maximumAttempts: initial.budget.limits.maximumAttempts,
      },
      HASH_A,
    );
    expect(extended.budget.limits.maximumUsd).toBe(150);

    await expect(
      store.extendSpendBudget(
        extended.contentHash,
        {
          maximumUsd: extended.budget.limits.maximumUsd,
          maximumTokens: extended.budget.limits.maximumTokens,
          maximumWallTimeMs: extended.budget.limits.maximumWallTimeMs,
          maximumAttempts: extended.budget.limits.maximumAttempts,
        },
        HASH_B,
      ),
    ).rejects.toBeInstanceOf(CampaignTransitionError);
  });

  it("consumes holdout capacity monotonically and gates replenishment", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const allocation = await store.allocateExperiment(
      initial.contentHash,
      "optimization",
    );
    const consumed = await store.sealExperiment(allocation.state.contentHash, {
      experimentNumber: 1,
      stage: "validation",
      disposition: "rejected",
      candidateCommit: null,
      sealHash: HASH_C,
      decisionAttestationHash: HASH_D,
      holdoutAvailabilityAttestationHash: HASH_A,
      sealedAt: LATER,
      ledgers: ledgersFor(allocation.state),
    });
    expect(consumed.holdout.freshValidationSetsRemaining).toBe(5);
    const paused = await store.pause(
      consumed.contentHash,
      "infrastructure",
      HASH_E,
    );

    await expect(
      store.replenishHoldout(
        paused.contentHash,
        7,
        2,
        HASH_B,
        HASH_C,
      ),
    ).resolves.toMatchObject({
      holdout: { freshValidationSetsRemaining: 7, generation: 1 },
    });

    const replenished = await store.read();
    await expect(
      store.replenishHoldout(
        replenished.contentHash,
        8,
        2,
        HASH_D,
        HASH_C,
      ),
    ).rejects.toBeInstanceOf(CampaignTransitionError);
  });

  it("moves the active champion only with the matching sealed pointer", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const allocated = await store.allocateExperiment(
      initial.contentHash,
      "optimization",
    );

    await expect(
      store.sealExperiment(allocated.state.contentHash, {
        experimentNumber: 1,
        stage: "validation",
        disposition: "promoted",
        candidateCommit: null,
        sealHash: HASH_C,
        decisionAttestationHash: HASH_D,
        holdoutAvailabilityAttestationHash: HASH_A,
        sealedAt: LATER,
        ledgers: ledgersFor(allocated.state),
      }),
    ).rejects.toBeInstanceOf(CampaignTransitionError);

    const promoted = await store.sealExperiment(allocated.state.contentHash, {
      experimentNumber: 1,
      stage: "validation",
      disposition: "promoted",
      candidateCommit: COMMIT_B,
      sealHash: HASH_C,
      decisionAttestationHash: HASH_D,
      holdoutAvailabilityAttestationHash: HASH_A,
      sealedAt: LATER,
      ledgers: ledgersFor(allocated.state),
    });
    expect(promoted.champions.active.commit).toBe(COMMIT_B);
  });

  it("certifies only the active commit through a later feedback-dark sealed audit", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const candidate = await store.allocateExperiment(
      initial.contentHash,
      "optimization",
    );
    const promoted = await store.sealExperiment(candidate.state.contentHash, {
      experimentNumber: 1,
      stage: "validation",
      disposition: "promoted",
      candidateCommit: COMMIT_B,
      sealHash: HASH_C,
      decisionAttestationHash: HASH_D,
      holdoutAvailabilityAttestationHash: HASH_A,
      sealedAt: LATER,
      ledgers: ledgersFor(candidate.state),
    });
    const audit = await store.allocateExperiment(promoted.contentHash, "shadow");
    const certified = await store.sealExperiment(audit.state.contentHash, {
      experimentNumber: 2,
      stage: "shadow",
      disposition: "certified",
      candidateCommit: null,
      sealHash: HASH_D,
      decisionAttestationHash: HASH_E,
      holdoutAvailabilityAttestationHash: HASH_B,
      sealedAt: LATER,
      ledgers: ledgersFor(audit.state),
    });

    expect(certified.champions.certified).toMatchObject({
      experimentNumber: 1,
      commit: COMMIT_B,
      sourceSealHash: HASH_D,
    });
    expect(certified.holdout.shadowSlicesRemaining).toBe(1);
  });

  it("consumes a shadow slice even when the sealed audit does not certify", async () => {
    const { store } = await initializedStore();
    const initial = await store.read();
    const audit = await store.allocateExperiment(initial.contentHash, "shadow");
    const notCertified = await store.sealExperiment(audit.state.contentHash, {
      experimentNumber: audit.experimentNumber,
      stage: "shadow",
      disposition: "not-certified",
      candidateCommit: null,
      sealHash: HASH_C,
      decisionAttestationHash: HASH_D,
      holdoutAvailabilityAttestationHash: HASH_A,
      sealedAt: LATER,
      ledgers: ledgersFor(audit.state),
    });

    expect(notCertified.holdout.shadowSlicesRemaining).toBe(1);
    expect(notCertified.champions.certified).toBeNull();
  });

  it("fails closed when no trusted decision-attestation verifier is installed", async () => {
    const root = await temporaryRoot();
    const store = new CampaignStateStore(root, "campaign-001", {
      now: () => new Date(LATER),
      ledgerTransitionVerifier: {
        verify: async () => undefined,
      },
      controlAttestationVerifier: {
        verify: async () => undefined,
      },
    });
    const initial = await store.initialize(campaignSeed());
    const allocation = await store.allocateExperiment(
      initial.contentHash,
      "optimization",
    );

    await expect(
      store.sealExperiment(allocation.state.contentHash, {
        experimentNumber: allocation.experimentNumber,
        stage: "validation",
        disposition: "rejected",
        candidateCommit: null,
        sealHash: HASH_C,
        decisionAttestationHash: HASH_D,
        holdoutAvailabilityAttestationHash: HASH_A,
        sealedAt: LATER,
        ledgers: ledgersFor(allocation.state),
      }),
    ).rejects.toBeInstanceOf(CampaignTransitionError);

    await expect(store.read()).resolves.toMatchObject({
      contentHash: allocation.state.contentHash,
      numbering: { inFlightExperimentNumber: allocation.experimentNumber },
      holdout: { freshValidationSetsRemaining: 6 },
    });
  });

  it("fails closed on a missing revision or content-address mismatch", async () => {
    const { root, store } = await initializedStore();
    const initial = await store.read();
    await store.requestStop(initial.contentHash, "sigterm");
    const statesPath = join(root, "campaign-001", "states");
    const files = (await readdir(statesPath)).sort();
    const second = files[1];
    expect(second).toBeDefined();
    if (second === undefined) {
      throw new Error("Expected a second campaign revision");
    }
    const contents = await readFile(join(statesPath, second), "utf8");
    await writeFile(join(statesPath, second), contents.replace('"revision":1', '"revision":2'));

    await expect(store.reconstruct()).rejects.toBeInstanceOf(CampaignIntegrityError);
  });

  it("ignores an atomic temporary and explicitly quarantines an abandoned owner lock", async () => {
    const { root, store } = await initializedStore();
    const initial = await store.read();
    const campaignPath = join(root, "campaign-001");
    const statesPath = join(campaignPath, "states");
    await writeFile(
      join(
        statesPath,
        `.0000000000000001-${HASH_D}.json.${"a".repeat(32)}.tmp`,
      ),
      "partial",
    );
    await writeFile(
      join(campaignPath, ".update.lock"),
      `${canonicalJson({
        acquiredAt: LATER,
        ownerToken: "f".repeat(32),
        processId: 99_999,
      })}\n`,
    );

    const recovered = await store.recoverAbandonedLock(initial.contentHash, HASH_E);
    const requested = await store.requestStop(recovered.contentHash, "sigint");
    expect(requested.control.status).toBe("stop-requested");
    expect(await readdir(join(campaignPath, "abandoned-locks"))).toHaveLength(1);
  });
});
