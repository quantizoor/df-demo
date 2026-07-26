import { type Static, type TSchema, Type } from "@sinclair/typebox";

export const SCHEMA_VERSION = "1.0.0" as const;
export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

export const HashSchema = Type.String({
  pattern: "^[a-f0-9]{64}$",
  description: "Lowercase SHA-256 digest.",
});

export const TimestampSchema = Type.String({ format: "date-time" });

export const SafeIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 96,
  pattern: "^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$",
});

export const VersionIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$",
});

export const GitReferenceSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^(?!.*\\.\\.)(?!.*//)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});

export const SafeSummarySchema = Type.String({
  minLength: 1,
  maxLength: 1_000,
});

export const CommitShaSchema = Type.String({ pattern: "^[a-f0-9]{40,64}$" });

export const SchemaVersionSchema = Type.Literal(SCHEMA_VERSION);

export const ProvenanceReferenceSchema = Type.Object(
  {
    artifactName: SafeIdentifierSchema,
    contentHash: HashSchema,
  },
  { additionalProperties: false },
);

export const ArtifactMetadataProperties = {
  schemaVersion: SchemaVersionSchema,
  createdAt: TimestampSchema,
  provenanceRefs: Type.Array(ProvenanceReferenceSchema, { maxItems: 64 }),
  contentHash: HashSchema,
} satisfies Record<string, TSchema>;

export const AggregateCostSchema = Type.Object(
  {
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    modelUsd: Type.Number({ minimum: 0 }),
    sandboxUsd: Type.Number({ minimum: 0 }),
    totalUsd: Type.Number({ minimum: 0 }),
    wallTimeMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const IntervalSchema = Type.Object(
  {
    lower: Type.Number(),
    upper: Type.Number(),
  },
  { additionalProperties: false },
);

export const ProbabilitySchema = Type.Number({ minimum: 0, maximum: 1 });
export const UnitIntervalSchema = Type.Number({ minimum: 0, maximum: 1 });

export const PrivacySupportSchema = Type.Object(
  {
    distinctTaskCountBand: Type.Union([
      Type.Literal("5-9"),
      Type.Literal("10-19"),
      Type.Literal("20+"),
    ]),
    trajectoryCountBand: Type.Union([
      Type.Literal("20-39"),
      Type.Literal("40-79"),
      Type.Literal("80+"),
    ]),
    minimumComparedGroupSizeBand: Type.Union([
      Type.Literal("5-9"),
      Type.Literal("10-19"),
      Type.Literal("20+"),
    ]),
    complementaryCountSuppressionPassed: Type.Boolean(),
    differencingBudgetPassed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const PolicyVersionsSchema = Type.Object(
  {
    protocol: SafeIdentifierSchema,
    broker: SafeIdentifierSchema,
    extraction: SafeIdentifierSchema,
    statistics: SafeIdentifierSchema,
    privacy: SafeIdentifierSchema,
    weighting: SafeIdentifierSchema,
    cache: SafeIdentifierSchema,
    repeatedTesting: SafeIdentifierSchema,
    leakScanner: SafeIdentifierSchema,
  },
  { additionalProperties: false },
);

export const IntegrityStatusSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("not-run"),
]);

export const SignatureSchema = Type.Object(
  {
    algorithm: Type.Literal("ed25519"),
    keyId: SafeIdentifierSchema,
    signedAt: TimestampSchema,
    signature: Type.String({
      minLength: 86,
      maxLength: 128,
      pattern: "^[A-Za-z0-9_-]+={0,2}$",
    }),
  },
  { additionalProperties: false },
);

export type Signature = Static<typeof SignatureSchema>;
export type PolicyVersions = Static<typeof PolicyVersionsSchema>;
export type PrivacySupport = Static<typeof PrivacySupportSchema>;

export const CountBandSchema = Type.Union([
  Type.Literal("0"),
  Type.Literal("1-4"),
  Type.Literal("5-9"),
  Type.Literal("10-19"),
  Type.Literal("20+"),
]);

export const DispositionSchema = Type.Union([
  Type.Literal("passed"),
  Type.Literal("failed"),
  Type.Literal("inconclusive"),
  Type.Literal("not-run"),
]);

export const RunModeSchema = Type.Union([Type.Literal("research"), Type.Literal("submission")]);

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
