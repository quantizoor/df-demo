import { canonicalHash } from "../schemas/canonical.js";
import type {
  TrustedBehavioralReleaseFinalization,
  TrustedBehavioralReleaseOrphanFinalizationReceipt,
} from "./behavioral-release-producer.js";
import type { TrustedPrivateBehavioralPreparation } from "./deriver.js";

export type TrustedBehavioralPreparationStoreBoundary =
  | "trusted-cloud"
  | "test-only-in-memory";

export interface TrustedBehavioralPreparationWriteReceipt {
  readonly status: "prepared" | "already-prepared";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly preparationHash: string;
}

export interface TrustedBehavioralPreparationFinalizationReceipt {
  readonly status: "finalized" | "already-finalized";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly preparationHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly finalizationHash: string;
}

export interface TrustedBehavioralPreparationAbandonmentReceipt {
  readonly status: "abandoned" | "already-abandoned";
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly preparationHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly finalizationHash: string;
  readonly orphanFinalizationHash: string;
  readonly abandonmentHash: string;
}

export type TrustedBehavioralPreparationConsumptionReceipt =
  | {
      readonly status: "consumed" | "already-consumed";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
    }
  | {
      readonly status: "already-finalized";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
    }
  | {
      readonly status: "already-abandoned";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
      readonly orphanFinalizationHash: string;
      readonly abandonmentHash: string;
    }
  | {
      readonly status: "missing";
      readonly requestHash: string;
      readonly protocolHash: string;
    };

export type TrustedBehavioralPreparationResolution =
  | {
      readonly status: "missing";
      readonly requestHash: string;
      readonly protocolHash: string;
    }
  | {
      readonly status: "prepared";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
      readonly preparation: TrustedPrivateBehavioralPreparation;
    }
  | {
      readonly status: "finalized";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
      readonly finalization: TrustedBehavioralReleaseFinalization;
    }
  | {
      readonly status: "abandoned";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
      readonly sourceResultEnvelopeHash: string;
      readonly finalizationHash: string;
      readonly orphanFinalizationHash: string;
      readonly abandonmentHash: string;
      readonly orphanFinalization: TrustedBehavioralReleaseOrphanFinalizationReceipt;
    }
  | {
      readonly status: "consumed";
      readonly requestHash: string;
      readonly protocolHash: string;
      readonly preparationHash: string;
    };

/**
 * Trusted evaluator-only store for task-private behavioral preparation.
 *
 * There is deliberately no list, scan, prefix, content-hash, or release-safe
 * artifact method. A caller must already possess the exact canonical request
 * and protocol hashes. Production composition accepts only the durable
 * `trusted-cloud` boundary.
 */
export interface TrustedBehavioralPreparationStore {
  readonly boundary: TrustedBehavioralPreparationStoreBoundary;

  prepare(
    preparation: TrustedPrivateBehavioralPreparation,
  ): Promise<TrustedBehavioralPreparationWriteReceipt>;

  resolve(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }): Promise<TrustedBehavioralPreparationResolution>;

  finalize(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly preparationHash: string;
    readonly sourceResultEnvelopeHash: string;
    readonly finalization: TrustedBehavioralReleaseFinalization;
  }): Promise<TrustedBehavioralPreparationFinalizationReceipt>;

  abandon(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
    readonly preparationHash: string;
    readonly sourceResultEnvelopeHash: string;
    readonly finalizationHash: string;
    readonly orphanFinalization:
      TrustedBehavioralReleaseOrphanFinalizationReceipt;
  }): Promise<TrustedBehavioralPreparationAbandonmentReceipt>;

  consume(input: {
    readonly requestHash: string;
    readonly protocolHash: string;
  }): Promise<TrustedBehavioralPreparationConsumptionReceipt>;
}

export function hashTrustedBehavioralPreparation(
  preparation: TrustedPrivateBehavioralPreparation,
): string {
  return canonicalHash({
    domain: "dark-factory.trusted-behavioral-preparation.v1",
    preparation,
  });
}

export function hashTrustedBehavioralPreparationFinalization(input: {
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly preparationHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly finalization: TrustedBehavioralReleaseFinalization;
}): string {
  return canonicalHash({
    domain:
      "dark-factory.trusted-behavioral-preparation-finalization.v1",
    ...input,
  });
}

export function hashTrustedBehavioralPreparationAbandonment(input: {
  readonly requestHash: string;
  readonly protocolHash: string;
  readonly preparationHash: string;
  readonly sourceResultEnvelopeHash: string;
  readonly finalizationHash: string;
  readonly orphanFinalizationHash: string;
}): string {
  return canonicalHash({
    domain:
      "dark-factory.trusted-behavioral-preparation-abandonment.v1",
    ...input,
  });
}
