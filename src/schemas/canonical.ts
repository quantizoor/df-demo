import { createHash } from "node:crypto";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalJsonError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("Canonical JSON cannot contain non-finite numbers");
  }

  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializeArray(value: readonly unknown[], ancestors: ReadonlySet<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError("Canonical JSON cannot contain cycles");
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  return `[${value.map((item) => serialize(item, nextAncestors)).join(",")}]`;
}

function serializeObject(
  value: Readonly<Record<string, unknown>>,
  ancestors: ReadonlySet<object>,
): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError("Canonical JSON cannot contain cycles");
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  const keys = Object.keys(value).sort();
  const members = keys.map((key) => {
    const item = value[key];
    if (item === undefined) {
      throw new CanonicalJsonError(`Canonical JSON cannot contain undefined at key "${key}"`);
    }
    return `${serializeString(key)}:${serialize(item, nextAncestors)}`;
  });
  return `{${members.join(",")}}`;
}

function serialize(value: unknown, ancestors: ReadonlySet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "object":
      if (Array.isArray(value)) {
        return serializeArray(value, ancestors);
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        throw new CanonicalJsonError("Canonical JSON accepts only plain objects and arrays");
      }
      return serializeObject(value as Readonly<Record<string, unknown>>, ancestors);
    default:
      throw new CanonicalJsonError(`Canonical JSON cannot contain ${typeof value}`);
  }
}

/**
 * Produces deterministic JSON with recursively sorted object keys.
 *
 * This follows the JSON-compatible portion of RFC 8785. Inputs are deliberately
 * restricted to plain JSON values so hashes never depend on class serializers.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export const canonicalize = canonicalJson;

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

export const sha256Canonical = canonicalHash;

function withoutTopLevelContentHash(value: unknown): unknown {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new CanonicalJsonError("A content-addressed document must be a plain object");
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new CanonicalJsonError("A content-addressed document must be a plain object");
  }

  const document = value as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(document)) {
    if (key !== "contentHash") {
      result[key] = document[key];
    }
  }
  return result;
}

/**
 * Computes a document's hash over every top-level property except contentHash.
 * Excluding exactly that field avoids a self-referential digest while binding
 * all other metadata and payload fields.
 */
export function computeContentHash(value: unknown): string {
  return canonicalHash(withoutTopLevelContentHash(value));
}

export function withContentHash<T extends Readonly<Record<string, unknown>>>(
  value: T,
): T & { readonly contentHash: string } {
  const document = { ...value, contentHash: "" };
  return { ...value, contentHash: computeContentHash(document) };
}

export function hasValidContentHash(value: unknown): boolean {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const document = value as Readonly<Record<string, unknown>>;
  return (
    typeof document.contentHash === "string" &&
    document.contentHash.length === 64 &&
    document.contentHash === computeContentHash(document)
  );
}
