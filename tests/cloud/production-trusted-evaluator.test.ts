import { describe, expect, it, vi } from "vitest";

import {
  ProductionMountedVolumeTrustedEvaluatorError,
  TrustedBehavioralReleaseArtifactOverlay,
} from "../../src/cloud/production-trusted-evaluator.js";
import type { TrustedCloudArtifactRef } from "../../src/cloud/types.js";
import type {
  BehavioralReleaseArtifact,
} from "../../src/evaluator/behavioral-release-producer.js";
import type {
  EvaluationReleaseArtifactPurpose,
  EvaluationReleaseArtifactQuery,
  TrustedEvaluationReleaseArtifactReader,
  TrustedEvaluationReleaseArtifactSource,
} from "../../src/evaluator/release-bundle-service.js";
import {
  canonicalHash,
  canonicalJson,
  sha256,
} from "../../src/schemas/canonical.js";

const HASH = "a".repeat(64);

function query(
  purpose: EvaluationReleaseArtifactPurpose,
  contentHash = HASH,
): EvaluationReleaseArtifactQuery {
  const unsigned = {
    schemaVersion: 1 as const,
    domain:
      "dark-factory.evaluation-release-artifact-query.v1" as const,
    purpose,
    contentHash,
  };
  return {
    ...unsigned,
    queryHash: canonicalHash(unsigned),
  };
}

function fallback(input?: {
  readonly locate?: TrustedEvaluationReleaseArtifactSource["locate"];
  readonly readUtf8?: TrustedEvaluationReleaseArtifactReader["readUtf8"];
}): {
  readonly source: TrustedEvaluationReleaseArtifactSource;
  readonly reader: TrustedEvaluationReleaseArtifactReader;
} {
  return {
    source: {
      boundary: "trusted-cloud",
      locate: input?.locate ?? (async () => undefined),
    },
    reader: {
      boundary: "trusted-cloud",
      readUtf8:
        input?.readUtf8 ??
        (async () => {
          throw new Error("fallback reader was not expected");
        }),
    },
  };
}

function behavioralArtifact(): BehavioralReleaseArtifact {
  return {
    purpose: "behavioral-evidence",
    document: {
      schemaVersion: 1,
      kind: "behavioral-evidence",
      contentHash: HASH,
    },
  } as unknown as BehavioralReleaseArtifact;
}

describe("production trusted evaluator artifact overlay", () => {
  it("delegates only cache attestations to the governed fallback", async () => {
    const expected: TrustedCloudArtifactRef = {
      uri: "trusted://cache/attestation",
      sha256: "b".repeat(64),
      mediaType: "application/json",
      byteLength: 128,
    };
    const locate = vi.fn(async () => expected);
    const external = fallback({ locate });
    const resolveByContentHash = vi.fn(async () => undefined);
    const overlay = new TrustedBehavioralReleaseArtifactOverlay(
      { resolveByContentHash },
      external.source,
      external.reader,
    );

    await expect(
      overlay.source.locate(query("cache-attestation")),
    ).resolves.toEqual(expected);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(resolveByContentHash).not.toHaveBeenCalled();
  });

  it("never falls through when a behavioral hash is missing or orphaned", async () => {
    const locate = vi.fn(async () => {
      throw new Error("behavioral lookup escaped to fallback");
    });
    const external = fallback({ locate });
    const resolveByContentHash = vi.fn(async () => undefined);
    const overlay = new TrustedBehavioralReleaseArtifactOverlay(
      { resolveByContentHash },
      external.source,
      external.reader,
    );

    await expect(
      overlay.source.locate(query("behavioral-evidence")),
    ).resolves.toBeUndefined();
    expect(resolveByContentHash).toHaveBeenCalledWith({
      purpose: "behavioral-evidence",
      contentHash: HASH,
    });
    expect(locate).not.toHaveBeenCalled();
  });

  it("binds committed behavioral canonical bytes and rechecks them on read", async () => {
    let stored: BehavioralReleaseArtifact | undefined =
      behavioralArtifact();
    const resolveByContentHash = vi.fn(async () => stored);
    const external = fallback();
    const overlay = new TrustedBehavioralReleaseArtifactOverlay(
      { resolveByContentHash },
      external.source,
      external.reader,
    );
    const reference = await overlay.source.locate(
      query("behavioral-evidence"),
    );
    if (reference === undefined) {
      throw new Error("behavioral fixture was not resolved");
    }
    if (stored === undefined) {
      throw new Error("behavioral fixture disappeared");
    }
    const raw = `${canonicalJson(stored.document)}\n`;

    expect(reference).toEqual({
      uri: `trusted://behavioral-release/behavioral-evidence/${HASH}`,
      sha256: sha256(raw),
      mediaType: "application/json",
      byteLength: Buffer.byteLength(raw, "utf8"),
    });
    await expect(
      overlay.reader.readUtf8(reference, 1_024),
    ).resolves.toBe(raw);

    stored = undefined;
    await expect(
      overlay.reader.readUtf8(reference, 1_024),
    ).rejects.toBeInstanceOf(
      ProductionMountedVolumeTrustedEvaluatorError,
    );
  });

  it("reserves behavioral URIs against fallback namespace confusion", async () => {
    const external = fallback({
      locate: async () => ({
        uri: `trusted://behavioral-release/behavioral-evidence/${HASH}`,
        sha256: "b".repeat(64),
        mediaType: "application/json",
        byteLength: 128,
      }),
    });
    const overlay = new TrustedBehavioralReleaseArtifactOverlay(
      { resolveByContentHash: async () => undefined },
      external.source,
      external.reader,
    );

    await expect(
      overlay.source.locate(query("cache-attestation")),
    ).rejects.toBeInstanceOf(
      ProductionMountedVolumeTrustedEvaluatorError,
    );
  });

  it("rejects a store response detached from the requested purpose", async () => {
    const detached = {
      ...behavioralArtifact(),
      purpose: "failure-cards",
    } as unknown as BehavioralReleaseArtifact;
    const external = fallback();
    const overlay = new TrustedBehavioralReleaseArtifactOverlay(
      { resolveByContentHash: async () => detached },
      external.source,
      external.reader,
    );

    await expect(
      overlay.source.locate(query("behavioral-evidence")),
    ).rejects.toBeInstanceOf(
      ProductionMountedVolumeTrustedEvaluatorError,
    );
  });
});
