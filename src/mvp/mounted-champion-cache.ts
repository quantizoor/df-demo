import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import {
  type CachedChampionObservation,
  type ChampionCacheKey,
  type ChampionCachePort,
  canonicalJson,
  evaluationEnvironmentDigest,
  MVP_CACHE_POLICY,
  MVP_SCHEMA_VERSION,
  sha256,
} from "./contracts.js";
import {
  assertMountedRoot,
  isNodeError,
  readOptionalBoundedJson,
  writeJsonAtomic,
} from "./mounted-files.js";
import { EvaluationEnvironmentSchema } from "./schemas.js";

const DigestSchema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const RevisionSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });
const RawDiagnosticSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal("agent"),
      Type.Literal("tool"),
      Type.Literal("grader"),
      Type.Literal("infrastructure"),
    ]),
    code: Type.String({ minLength: 1, maxLength: 128 }),
    toolName: Type.Union([Type.String({ minLength: 1, maxLength: 256 }), Type.Null()]),
    message: Type.String({ maxLength: 16_384 }),
    evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
const CacheKeySchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    policyVersion: Type.Literal(MVP_CACHE_POLICY),
    taskHandle: DigestSchema,
    taskRevisionDigest: DigestSchema,
    championRevision: RevisionSchema,
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    environment: EvaluationEnvironmentSchema,
    environmentDigest: DigestSchema,
    keyDigest: DigestSchema,
  },
  { additionalProperties: false },
);
const CachedObservationSchema = Type.Object(
  {
    keyDigest: DigestSchema,
    taskHandle: DigestSchema,
    taskRevisionDigest: DigestSchema,
    championRevision: RevisionSchema,
    repetition: Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
    environmentDigest: DigestSchema,
    passed: Type.Boolean(),
    reward: Type.Number({ minimum: 0, maximum: 1 }),
    infrastructureValid: Type.Boolean(),
    durationMs: Type.Integer({ minimum: 0 }),
    evaluatedAt: Type.String({ format: "date-time" }),
    traceArtifactRefs: Type.Array(Type.String({ minLength: 1, maxLength: 2_048 }), {
      maxItems: 128,
      uniqueItems: true,
    }),
    rawDiagnostics: Type.Array(RawDiagnosticSchema, { maxItems: 128 }),
  },
  { additionalProperties: false },
);
const CacheDocumentSchema = Type.Object(
  {
    schemaVersion: Type.Literal(MVP_SCHEMA_VERSION),
    key: CacheKeySchema,
    observation: CachedObservationSchema,
  },
  { additionalProperties: false },
);

const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormatsModule.default(ajv);
const validateCacheKeySchema = ajv.compile(CacheKeySchema);
const validateCacheDocumentSchema = ajv.compile(CacheDocumentSchema);

interface CacheDocument {
  readonly schemaVersion: typeof MVP_SCHEMA_VERSION;
  readonly key: ChampionCacheKey;
  readonly observation: CachedChampionObservation;
}

export class MountedChampionCache implements ChampionCachePort {
  public constructor(private readonly root: string) {
    assertMountedRoot(root);
  }

  public async get(key: ChampionCacheKey): Promise<CachedChampionObservation | null> {
    assertCacheKey(key);
    const value = await readOptionalBoundedJson(this.entryPath(key));
    if (value === null) {
      return null;
    }
    const document = cacheDocument(value);
    assertDocumentMatchesKey(document, key);
    return document.observation;
  }

  public async put(key: ChampionCacheKey, observation: CachedChampionObservation): Promise<void> {
    assertCacheKey(key);
    const document: CacheDocument = {
      schemaVersion: MVP_SCHEMA_VERSION,
      key,
      observation,
    };
    const validated = cacheDocument(document);
    assertDocumentMatchesKey(validated, key);

    const parent = join(this.root, key.keyDigest.slice(0, 2));
    const finalDirectory = join(parent, key.keyDigest);
    const stagingDirectory = join(parent, `.${key.keyDigest}-${randomUUID()}.tmp`);
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeJsonAtomic(join(stagingDirectory, "entry.json"), document);
      await rename(stagingDirectory, finalDirectory);
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY")) {
        const existing = await this.get(key);
        if (existing !== null && canonicalJson(existing) === canonicalJson(observation)) {
          return;
        }
        throw new Error("Champion cache key already contains different evidence");
      }
      throw error;
    }
  }

  private entryPath(key: ChampionCacheKey): string {
    return join(this.root, key.keyDigest.slice(0, 2), key.keyDigest, "entry.json");
  }
}

function cacheDocument(value: unknown): CacheDocument {
  if (!validateCacheDocumentSchema(value)) {
    throw new Error(
      `Invalid champion cache document: ${(validateCacheDocumentSchema.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ")}`,
    );
  }
  return value as CacheDocument;
}

function assertCacheKey(key: ChampionCacheKey): void {
  if (!validateCacheKeySchema(key)) {
    throw new Error("Invalid full-environment champion cache key");
  }
  if (evaluationEnvironmentDigest(key.environment) !== key.environmentDigest) {
    throw new Error("Champion cache environment digest does not match its settings");
  }
  const material = {
    policyVersion: key.policyVersion,
    taskHandle: key.taskHandle,
    taskRevisionDigest: key.taskRevisionDigest,
    championRevision: key.championRevision,
    repetition: key.repetition,
    environment: key.environment,
    environmentDigest: key.environmentDigest,
  };
  if (sha256(canonicalJson(material)) !== key.keyDigest) {
    throw new Error("Champion cache key digest does not match its full environment");
  }
}

function assertDocumentMatchesKey(document: CacheDocument, key: ChampionCacheKey): void {
  if (canonicalJson(document.key) !== canonicalJson(key)) {
    throw new Error("Champion cache document key does not match the requested key");
  }
  const observation = document.observation;
  if (
    observation.keyDigest !== key.keyDigest ||
    observation.taskHandle !== key.taskHandle ||
    observation.taskRevisionDigest !== key.taskRevisionDigest ||
    observation.championRevision !== key.championRevision ||
    observation.repetition !== key.repetition ||
    observation.environmentDigest !== key.environmentDigest
  ) {
    throw new Error("Champion cache observation is detached from its key");
  }
}
