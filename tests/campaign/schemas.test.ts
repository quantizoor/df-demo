import { describe, expect, it } from "vitest";

import { withContentHash } from "../../src/schemas/canonical.js";
import { assertValidDocument } from "../../src/schemas/registry.js";
import { harnessRegistrationFixture, initialCampaignStateFixture } from "./fixtures.js";

function objectKeys(value: unknown, keys: string[] = []): readonly string[] {
  if (value === null || typeof value !== "object") {
    return keys;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      objectKeys(item, keys);
    }
    return keys;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    objectKeys(item, keys);
  }
  return keys;
}

describe("campaign control schemas", () => {
  it("accepts canonical content-hashed campaign and harness documents", () => {
    expect(() => assertValidDocument("campaignState", initialCampaignStateFixture())).not.toThrow();
    expect(() =>
      assertValidDocument("harnessRegistration", harnessRegistrationFixture()),
    ).not.toThrow();
  });

  it.each(["taskId", "panelId", "allocationHandle", "remoteUrl"])(
    "rejects the unregistered local field %s",
    (field) => {
      const state = initialCampaignStateFixture();
      expect(() =>
        assertValidDocument("campaignState", withContentHash({ ...state, [field]: "secret" })),
      ).toThrow(/additional properties/u);
    },
  );

  it("has no structural task, panel, allocation, grader, or trajectory identity field", () => {
    const keys = objectKeys(initialCampaignStateFixture());
    expect(
      keys.filter((key) =>
        /^(?:task|panel|allocation|grader|trajectory|trial)(?:id|key|name|handle)?$/iu.test(key),
      ),
    ).toEqual([]);
  });

  it("rejects an identity-bearing provenance channel", () => {
    const state = structuredClone(initialCampaignStateFixture()) as Record<string, unknown>;
    state.provenanceRefs = [
      {
        artifactName: "task-001",
        contentHash: "a".repeat(64),
      },
    ];
    expect(() => assertValidDocument("campaignState", withContentHash(state))).toThrow();
  });

  it("rejects credential-bearing remote properties even after rehashing", () => {
    const registration = structuredClone(harnessRegistrationFixture()) as Record<string, unknown>;
    const origin = registration.origin as Record<string, unknown>;
    origin.remoteUrl = "https://credential@example.invalid/private.git";
    expect(() => assertValidDocument("harnessRegistration", withContentHash(registration))).toThrow(
      /additional properties/u,
    );
  });

  it("rejects the public upstream when it fingerprints the private origin", () => {
    const registration = structuredClone(harnessRegistrationFixture()) as Record<string, unknown>;
    const origin = registration.origin as Record<string, unknown>;
    const upstream = registration.upstream as Record<string, unknown>;
    upstream.repositoryFingerprint = origin.repositoryFingerprint;
    expect(() => assertValidDocument("harnessRegistration", withContentHash(registration))).toThrow(
      /distinct fingerprints/u,
    );
  });

  it("requires both remote fingerprints to use one identified HMAC key", () => {
    const registration = structuredClone(harnessRegistrationFixture()) as Record<string, unknown>;
    const upstream = registration.upstream as Record<string, unknown>;
    upstream.fingerprintKeyId = "different-key";
    expect(() => assertValidDocument("harnessRegistration", withContentHash(registration))).toThrow(
      /same HMAC key/u,
    );
  });

  it("rejects traversal from the registered workspace-relative Pi path", () => {
    const registration = structuredClone(harnessRegistrationFixture()) as Record<string, unknown>;
    registration.workspaceRelativePath = "../pi";
    expect(() =>
      assertValidDocument("harnessRegistration", withContentHash(registration)),
    ).toThrow();
  });

  it("binds registration provenance in canonical authorization order", () => {
    const registration = structuredClone(harnessRegistrationFixture()) as Record<string, unknown>;
    registration.provenanceRefs = [
      {
        artifactName: "repository-verification",
        contentHash: "b".repeat(64),
      },
      {
        artifactName: "operator-authorization",
        contentHash: "a".repeat(64),
      },
    ];
    expect(() => assertValidDocument("harnessRegistration", withContentHash(registration))).toThrow(
      /bind operator authorization/u,
    );
  });

  it("requires control fields to agree with the durable status", () => {
    const state = structuredClone(initialCampaignStateFixture()) as Record<string, unknown>;
    const control = state.control as Record<string, unknown>;
    control.status = "stopped";
    expect(() => assertValidDocument("campaignState", withContentHash(state))).toThrow(
      /agree with status/u,
    );
  });

  it("rejects campaign counters outside JavaScript's safe-integer range", () => {
    const state = structuredClone(initialCampaignStateFixture()) as Record<string, unknown>;
    const numbering = state.numbering as Record<string, unknown>;
    numbering.nextExperimentNumber = Number.MAX_SAFE_INTEGER + 1;
    expect(() => assertValidDocument("campaignState", withContentHash(state))).toThrow();
  });

  it("rejects pre-1.1 control documents instead of silently reinterpreting them", () => {
    const state = structuredClone(initialCampaignStateFixture()) as Record<string, unknown>;
    state.schemaVersion = "1.0.0";
    expect(() => assertValidDocument("campaignState", withContentHash(state))).toThrow();
  });
});
