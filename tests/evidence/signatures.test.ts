import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createEd25519Signature,
  verifyEd25519Signature,
} from "../../src/evidence/signatures.js";
import { withContentHash } from "../../src/schemas/canonical.js";
import { NOW } from "../schemas/fixtures.js";

describe("Ed25519 evidence signatures", () => {
  it("verifies a canonical document and rejects payload mutation", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const unsigned = {
      schemaVersion: "1.0.0",
      createdAt: NOW,
      aggregateDisposition: "passed",
      signature: null,
    };
    const signature = createEd25519Signature(
      unsigned,
      privateKey,
      "test-key-1",
      NOW,
    );
    const signed = withContentHash({ ...unsigned, signature });

    expect(verifyEd25519Signature(signed, publicKey)).toBe(true);
    expect(
      verifyEd25519Signature({ ...signed, aggregateDisposition: "failed" }, publicKey),
    ).toBe(false);
  });

  it("fails closed for a missing or malformed signature", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(verifyEd25519Signature({ result: "passed" }, publicKey)).toBe(false);
    expect(
      verifyEd25519Signature(
        { result: "passed", signature: { algorithm: "other", signature: "x" } },
        publicKey,
      ),
    ).toBe(false);
  });
});
