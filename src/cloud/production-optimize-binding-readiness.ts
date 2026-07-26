import {
  PRODUCTION_RUNTIME_PORT_IDS,
  type ProductionRuntimePortId,
} from "../orchestrator/production-runtime.js";
import { canonicalHash } from "../schemas/canonical.js";

const SHA256 = /^[a-f0-9]{64}$/u;

/**
 * This is the complete external surface that must be supplied before the
 * trusted control plane can ask the production runtime composer to verify a
 * runnable optimization loop. The identifiers and contract names are public,
 * task-free protocol metadata.
 */
const PRODUCTION_RUNTIME_PORT_CONTRACTS = {
  "control.campaign-state-store": "OptimizationCampaignStateStore",
  "control.optimization-input-factory": "TrustedOptimizationInputFactory",
  "control.optimization-resume-verifier": "TrustedOptimizationResumeVerifier",
  "control.optimization-completion-material": "TrustedOptimizationCompletionMaterialPort",
  "control.optimization-interruption-port": "TrustedOptimizationInterruptionPort",
  "control.experiment-journal": "ExperimentJournal",
  "optimizer.adapter": "OptimizerAdapter",
  "build.correctness-gate": "CorrectnessGateRunner",
  "evaluator.blind-broker": "BlindBroker",
} as const satisfies Readonly<Record<ProductionRuntimePortId, string>>;

const PRODUCTION_OPTIMIZE_BOOTSTRAP_BINDING_SPECIFICATIONS = [
  {
    bindingId: "composition.manifest",
    contract: "ProductionOptimizationCompositionManifest",
    boundary: "trusted-cloud",
  },
  {
    bindingId: "composition.attestation-verifier",
    contract: "TrustedProductionCompositionAttestationVerifier",
    boundary: "trusted-cloud",
  },
] as const;

const PRODUCTION_OPTIMIZE_RUNTIME_BINDING_SPECIFICATIONS = PRODUCTION_RUNTIME_PORT_IDS.map(
  (bindingId) => ({
    bindingId,
    contract: PRODUCTION_RUNTIME_PORT_CONTRACTS[bindingId],
    boundary: "trusted-cloud" as const,
  }),
);

const PRODUCTION_OPTIMIZE_BINDING_SPECIFICATION_VALUES = [
  ...PRODUCTION_OPTIMIZE_BOOTSTRAP_BINDING_SPECIFICATIONS,
  ...PRODUCTION_OPTIMIZE_RUNTIME_BINDING_SPECIFICATIONS,
] as const;

for (const specification of PRODUCTION_OPTIMIZE_BINDING_SPECIFICATION_VALUES) {
  Object.freeze(specification);
}

export const PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS = Object.freeze(
  PRODUCTION_OPTIMIZE_BINDING_SPECIFICATION_VALUES,
);

export type ProductionOptimizeBindingId =
  (typeof PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS)[number]["bindingId"];

export interface ProductionOptimizeExternalBinding {
  readonly bindingId: ProductionOptimizeBindingId;
  readonly boundary: "trusted-cloud";
  /**
   * The actual in-process object or function. It is checked only for presence
   * and is deliberately never inspected, serialized, hashed, or released.
   */
  readonly implementation: object | ((...arguments_: never[]) => unknown);
  /**
   * Commitment from the independent authority that supplied this binding.
   * This is not a substitute for the production composition verifier.
   */
  readonly attestationSha256: string;
}

export interface ProductionOptimizeSourceConfigurationReadiness {
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];
}

export interface InspectProductionOptimizeBindingReadinessInput {
  /**
   * Kept as unknown so malformed or attacker-extended registries fail closed
   * without their keys or values being reflected in release-safe output.
   */
  readonly bindings?: unknown;
  readonly piSourceConfiguration: ProductionOptimizeSourceConfigurationReadiness;
}

export type ProductionOptimizeSourceConfigurationStatus = "ready" | "missing" | "invalid";

export interface ProductionOptimizeBindingReadinessReceipt {
  readonly schemaVersion: 1;
  readonly domain: "dark-factory.production-optimize-binding-readiness.v1";
  readonly bindingSetHash: string;
  readonly sourceConfigurationStatus: ProductionOptimizeSourceConfigurationStatus;
  readonly bindingsReady: boolean;
  /**
   * A complete binding registry still cannot authorize execution. Only the
   * separate trusted production composer may change this fact.
   */
  readonly runtimeCompositionVerified: false;
  readonly runnable: false;
  readonly missingBindings: readonly ProductionOptimizeBindingId[];
  readonly invalidBindings: readonly ProductionOptimizeBindingId[];
  readonly registryMalformed: boolean;
  readonly unexpectedBindingsPresent: boolean;
  readonly bindingCommitmentHash: string;
  readonly receiptHash: string;
}

export interface ReleaseSafeProductionOptimizeBindingReport {
  readonly code:
    | "DF_PRODUCTION_OPTIMIZE_BINDINGS_INCOMPLETE"
    | "DF_PRODUCTION_OPTIMIZE_COMPOSITION_UNVERIFIED";
  readonly releaseSafe: true;
  readonly sourceConfigurationStatus: ProductionOptimizeSourceConfigurationStatus;
  readonly bindingsReady: boolean;
  readonly runtimeCompositionVerified: false;
  readonly runnable: false;
  readonly missingBindings: readonly ProductionOptimizeBindingId[];
  readonly invalidBindings: readonly ProductionOptimizeBindingId[];
  readonly registryMalformed: boolean;
  readonly unexpectedBindingsPresent: boolean;
  readonly bindingSetHash: string;
  readonly bindingCommitmentHash: string;
  readonly readinessReceiptHash: string;
}

export class ProductionOptimizeBindingReadinessError extends Error {
  override readonly name = "ProductionOptimizeBindingReadinessError";

  public constructor() {
    super("Production optimize binding readiness failed closed.");
  }
}

type BindingStatus = "bound" | "invalid" | "missing";

interface BindingCommitment {
  readonly bindingId: ProductionOptimizeBindingId;
  readonly status: BindingStatus;
  readonly attestationSha256: string | null;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isImplementation(value: unknown): value is object | ((...arguments_: never[]) => unknown) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function exactBinding(
  value: unknown,
  bindingId: ProductionOptimizeBindingId,
): value is ProductionOptimizeExternalBinding {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    keys.includes("bindingId") &&
    keys.includes("boundary") &&
    keys.includes("implementation") &&
    keys.includes("attestationSha256") &&
    value["bindingId"] === bindingId &&
    value["boundary"] === "trusted-cloud" &&
    isImplementation(value["implementation"]) &&
    typeof value["attestationSha256"] === "string" &&
    SHA256.test(value["attestationSha256"])
  );
}

function sourceConfigurationStatus(
  readiness: ProductionOptimizeSourceConfigurationReadiness,
): ProductionOptimizeSourceConfigurationStatus {
  if (readiness.invalid.length > 0) return "invalid";
  if (!readiness.ready || readiness.missing.length > 0) return "missing";
  return "ready";
}

const BINDING_SET_HASH = canonicalHash({
  schemaVersion: 1,
  domain: "dark-factory.production-optimize-binding-set.v1",
  bindings: PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS,
});

export function inspectProductionOptimizeBindingReadiness(
  input: InspectProductionOptimizeBindingReadinessInput,
): ProductionOptimizeBindingReadinessReceipt {
  const registryProvided = input.bindings !== undefined;
  const registry: Readonly<Record<string, unknown>> = isPlainRecord(input.bindings)
    ? input.bindings
    : {};
  const registryMalformed = registryProvided && !isPlainRecord(input.bindings);
  const requiredIds = new Set<string>(
    PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.map((specification) => specification.bindingId),
  );
  const unexpectedBindingsPresent =
    !registryMalformed && Object.keys(registry).some((key) => !requiredIds.has(key));

  const commitments: BindingCommitment[] = PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.map(
    (specification): BindingCommitment => {
      if (!Object.hasOwn(registry, specification.bindingId)) {
        return {
          bindingId: specification.bindingId,
          status: "missing",
          attestationSha256: null,
        };
      }
      const value = registry[specification.bindingId];
      if (!exactBinding(value, specification.bindingId)) {
        return {
          bindingId: specification.bindingId,
          status: "invalid",
          attestationSha256: null,
        };
      }
      return {
        bindingId: specification.bindingId,
        status: "bound",
        attestationSha256: value.attestationSha256,
      };
    },
  );
  const missingBindings = commitments
    .filter((commitment) => commitment.status === "missing")
    .map((commitment) => commitment.bindingId);
  const invalidBindings = commitments
    .filter((commitment) => commitment.status === "invalid")
    .map((commitment) => commitment.bindingId);
  const configurationStatus = sourceConfigurationStatus(input.piSourceConfiguration);
  const bindingCommitmentHash = canonicalHash({
    schemaVersion: 1,
    domain: "dark-factory.production-optimize-binding-commitment.v1",
    bindingSetHash: BINDING_SET_HASH,
    commitments,
  });
  const bindingsReady =
    configurationStatus === "ready" &&
    missingBindings.length === 0 &&
    invalidBindings.length === 0 &&
    !registryMalformed &&
    !unexpectedBindingsPresent;
  const unsigned = {
    schemaVersion: 1 as const,
    domain: "dark-factory.production-optimize-binding-readiness.v1" as const,
    bindingSetHash: BINDING_SET_HASH,
    sourceConfigurationStatus: configurationStatus,
    bindingsReady,
    runtimeCompositionVerified: false as const,
    runnable: false as const,
    missingBindings,
    invalidBindings,
    registryMalformed,
    unexpectedBindingsPresent,
    bindingCommitmentHash,
  };
  return {
    ...unsigned,
    receiptHash: canonicalHash(unsigned),
  };
}

function isOrderedKnownBindingList(
  value: unknown,
): value is readonly ProductionOptimizeBindingId[] {
  if (!Array.isArray(value)) return false;
  const order = new Map<string, number>(
    PRODUCTION_OPTIMIZE_BINDING_SPECIFICATIONS.map((specification, index) => [
      specification.bindingId,
      index,
    ]),
  );
  let previous = -1;
  for (const item of value) {
    if (typeof item !== "string") return false;
    const index = order.get(item);
    if (index === undefined || index <= previous) return false;
    previous = index;
  }
  return true;
}

function assertReleaseSafeReceipt(
  value: unknown,
): asserts value is ProductionOptimizeBindingReadinessReceipt {
  if (!isPlainRecord(value)) {
    throw new ProductionOptimizeBindingReadinessError();
  }
  const expectedKeys = [
    "schemaVersion",
    "domain",
    "bindingSetHash",
    "sourceConfigurationStatus",
    "bindingsReady",
    "runtimeCompositionVerified",
    "runnable",
    "missingBindings",
    "invalidBindings",
    "registryMalformed",
    "unexpectedBindingsPresent",
    "bindingCommitmentHash",
    "receiptHash",
  ];
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key)) ||
    value["schemaVersion"] !== 1 ||
    value["domain"] !== "dark-factory.production-optimize-binding-readiness.v1" ||
    value["bindingSetHash"] !== BINDING_SET_HASH ||
    !["ready", "missing", "invalid"].includes(value["sourceConfigurationStatus"] as string) ||
    typeof value["bindingsReady"] !== "boolean" ||
    value["runtimeCompositionVerified"] !== false ||
    value["runnable"] !== false ||
    !isOrderedKnownBindingList(value["missingBindings"]) ||
    !isOrderedKnownBindingList(value["invalidBindings"]) ||
    typeof value["registryMalformed"] !== "boolean" ||
    typeof value["unexpectedBindingsPresent"] !== "boolean" ||
    typeof value["bindingCommitmentHash"] !== "string" ||
    !SHA256.test(value["bindingCommitmentHash"]) ||
    typeof value["receiptHash"] !== "string" ||
    !SHA256.test(value["receiptHash"])
  ) {
    throw new ProductionOptimizeBindingReadinessError();
  }
  const missing = value["missingBindings"] as readonly ProductionOptimizeBindingId[];
  const invalid = value["invalidBindings"] as readonly ProductionOptimizeBindingId[];
  if (
    invalid.some((bindingId) => missing.includes(bindingId)) ||
    value["bindingsReady"] !==
      (value["sourceConfigurationStatus"] === "ready" &&
        missing.length === 0 &&
        invalid.length === 0 &&
        value["registryMalformed"] === false &&
        value["unexpectedBindingsPresent"] === false)
  ) {
    throw new ProductionOptimizeBindingReadinessError();
  }
  const { receiptHash, ...unsigned } =
    value as unknown as ProductionOptimizeBindingReadinessReceipt;
  if (canonicalHash(unsigned) !== receiptHash) {
    throw new ProductionOptimizeBindingReadinessError();
  }
}

/**
 * Narrows a readiness receipt to the exact fields permitted in public control
 * output. No source environment name, implementation value, provider
 * credential, model identifier, task identity, or arbitrary registry key can
 * enter this report.
 */
export function releaseSafeProductionOptimizeBindingReport(
  readiness: ProductionOptimizeBindingReadinessReceipt,
): ReleaseSafeProductionOptimizeBindingReport {
  assertReleaseSafeReceipt(readiness);
  return {
    code: readiness.bindingsReady
      ? "DF_PRODUCTION_OPTIMIZE_COMPOSITION_UNVERIFIED"
      : "DF_PRODUCTION_OPTIMIZE_BINDINGS_INCOMPLETE",
    releaseSafe: true,
    sourceConfigurationStatus: readiness.sourceConfigurationStatus,
    bindingsReady: readiness.bindingsReady,
    runtimeCompositionVerified: false,
    runnable: false,
    missingBindings: readiness.missingBindings,
    invalidBindings: readiness.invalidBindings,
    registryMalformed: readiness.registryMalformed,
    unexpectedBindingsPresent: readiness.unexpectedBindingsPresent,
    bindingSetHash: readiness.bindingSetHash,
    bindingCommitmentHash: readiness.bindingCommitmentHash,
    readinessReceiptHash: readiness.receiptHash,
  };
}
