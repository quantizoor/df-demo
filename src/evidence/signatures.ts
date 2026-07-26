import {
  sign as nodeSign,
  verify as nodeVerify,
  type KeyLike,
} from "node:crypto";

import { canonicalJson } from "../schemas/canonical.js";
import type { Signature } from "../schemas/primitives.js";

function signingPayload(
  document: Readonly<Record<string, unknown>>,
  signatureField: "signature" | "signer",
  signatureMetadata: Omit<Signature, "signature">,
): string {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document)) {
    if (key !== "contentHash" && key !== signatureField) {
      payload[key] = value;
    }
  }
  payload[signatureField] = signatureMetadata;
  return canonicalJson(payload);
}

export function createEd25519Signature(
  document: Readonly<Record<string, unknown>>,
  privateKey: KeyLike,
  keyId: string,
  signedAt: string,
  signatureField: "signature" | "signer" = "signature",
): Signature {
  const signatureMetadata: Omit<Signature, "signature"> = {
    algorithm: "ed25519",
    keyId,
    signedAt,
  };
  const signature = nodeSign(
    null,
    Buffer.from(signingPayload(document, signatureField, signatureMetadata), "utf8"),
    privateKey,
  );
  return {
    ...signatureMetadata,
    signature: signature.toString("base64url"),
  };
}

export function verifyEd25519Signature(
  document: Readonly<Record<string, unknown>>,
  publicKey: KeyLike,
  signatureField: "signature" | "signer" = "signature",
): boolean {
  const signatureValue = document[signatureField];
  if (
    signatureValue === null ||
    typeof signatureValue !== "object" ||
    Array.isArray(signatureValue)
  ) {
    return false;
  }
  const signature = signatureValue as Readonly<Record<string, unknown>>;
  if (signature.algorithm !== "ed25519" || typeof signature.signature !== "string") {
    return false;
  }
  if (typeof signature.keyId !== "string" || typeof signature.signedAt !== "string") {
    return false;
  }

  try {
    const signatureMetadata: Omit<Signature, "signature"> = {
      algorithm: "ed25519",
      keyId: signature.keyId,
      signedAt: signature.signedAt,
    };
    return nodeVerify(
      null,
      Buffer.from(signingPayload(document, signatureField, signatureMetadata), "utf8"),
      publicKey,
      Buffer.from(signature.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
