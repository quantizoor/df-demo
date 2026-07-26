import { describe, expect, it } from "vitest";

import {
  CanonicalJsonError,
  canonicalize,
  computeContentHash,
  hasValidContentHash,
  sha256Canonical,
  withContentHash,
} from "../../src/schemas/canonical.js";

describe("canonical JSON and hashes", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const first = { z: 1, nested: { b: true, a: null }, list: [3, 2, 1] };
    const second = { list: [3, 2, 1], nested: { a: null, b: true }, z: 1 };

    expect(canonicalize(first)).toBe('{"list":[3,2,1],"nested":{"a":null,"b":true},"z":1}');
    expect(canonicalize(second)).toBe(canonicalize(first));
    expect(sha256Canonical(second)).toBe(sha256Canonical(first));
  });

  it("normalizes negative zero and rejects non-JSON values", () => {
    expect(canonicalize({ value: -0 })).toBe('{"value":0}');
    expect(() => canonicalize({ value: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ value: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalize(new Date())).toThrow(CanonicalJsonError);
  });

  it("rejects cyclic structures", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalize(cyclic)).toThrow(/cycles/u);
  });

  it("binds every field other than the self-referential contentHash", () => {
    const document = withContentHash({ schemaVersion: "1.0.0", value: 1 });
    expect(document.contentHash).toBe(computeContentHash(document));
    expect(hasValidContentHash(document)).toBe(true);
    expect(hasValidContentHash({ ...document, value: 2 })).toBe(false);
    expect(computeContentHash({ ...document, contentHash: "f".repeat(64) })).toBe(
      document.contentHash,
    );
  });
});
