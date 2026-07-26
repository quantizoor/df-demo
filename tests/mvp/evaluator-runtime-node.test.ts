import { describe, expect, it } from "vitest";

import { mvpPiBuildRuntimeDigest } from "../../src/mvp/evaluator-runtime-node.js";

const digest = (value: string): string => value.repeat(64).slice(0, 64);

describe("MVP Pi build-runtime cache identity", () => {
  it("invalidates when a pinned build-runtime input changes", () => {
    const identity = {
      architecture: "x86_64" as const,
      bunExecutableSha256: digest("a"),
      imageDigest: digest("b"),
      packagerByteLength: 1_024,
      packagerSha256: digest("c"),
    };
    const baseline = mvpPiBuildRuntimeDigest(identity);

    expect(baseline).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      mvpPiBuildRuntimeDigest({
        ...identity,
        bunExecutableSha256: digest("d"),
      }),
    ).not.toBe(baseline);
    expect(
      mvpPiBuildRuntimeDigest({
        ...identity,
        imageDigest: digest("e"),
      }),
    ).not.toBe(baseline);
    expect(
      mvpPiBuildRuntimeDigest({
        ...identity,
        packagerSha256: digest("f"),
      }),
    ).not.toBe(baseline);
    expect(
      mvpPiBuildRuntimeDigest({
        ...identity,
        packagerByteLength: identity.packagerByteLength + 1,
      }),
    ).not.toBe(baseline);
  });
});
