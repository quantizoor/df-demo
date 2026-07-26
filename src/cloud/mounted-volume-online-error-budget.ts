import type { OnlineErrorBudgetState } from "../evaluation/statistics.js";
import {
  assertDurableOnlineErrorBudgetState,
  createDurableOnlineErrorBudgetState,
  onlineErrorBudgetCampaignIdHash,
  type DurableOnlineErrorBudgetState,
  type TrustedOnlineErrorBudgetCasStore,
} from "../evaluator/online-error-authority.js";
import { canonicalJson } from "../schemas/canonical.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

export interface MountedVolumeOnlineErrorBudgetStoreOptions {
  readonly durableState: MountedVolumeDurableStateOptions;
  readonly campaignId: string;
  readonly initialBudget: OnlineErrorBudgetState;
}

/**
 * Provider-mounted, fenced CAS port for the evaluator-owned sequential-error
 * ledger. No workstation path can satisfy MountedVolumeDurableStateOptions'
 * trusted runtime guard.
 */
export class MountedVolumeOnlineErrorBudgetCasStore
  implements TrustedOnlineErrorBudgetCasStore
{
  readonly boundary = "trusted-cloud" as const;
  readonly #store: MountedVolumeTransactionalJsonStore<
    DurableOnlineErrorBudgetState
  >;

  constructor(options: MountedVolumeOnlineErrorBudgetStoreOptions) {
    const initial = createDurableOnlineErrorBudgetState({
      campaignIdHash: onlineErrorBudgetCampaignIdHash(
        options.campaignId,
      ),
      initialBudget: options.initialBudget,
    });
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableOnlineErrorBudgetState>(
        options.durableState,
        `online-error-budget-${options.durableState.storeId}`,
        {
          domain: "dark-factory.online-error-budget-durable-state.v1",
          initialState: () => initial,
          assertState: assertDurableOnlineErrorBudgetState,
          revision: (state) => state.revision,
        },
      );
  }

  read(): Promise<DurableOnlineErrorBudgetState> {
    return this.#store.transact((state) => ({
      next: state,
      result: state,
    }));
  }

  compareAndSwap(input: {
    readonly expectedRevision: number;
    readonly next: DurableOnlineErrorBudgetState;
  }): Promise<boolean> {
    assertDurableOnlineErrorBudgetState(input.next);
    return this.#store.transact((state) => {
      if (state.revision !== input.expectedRevision) {
        return { next: state, result: false };
      }
      if (input.next.revision !== input.expectedRevision + 1) {
        return { next: state, result: false };
      }
      if (
        input.next.campaignIdHash !== state.campaignIdHash ||
        input.next.current.initialAlpha !==
          state.current.initialAlpha ||
        input.next.current.nullCalibrationId !==
          state.current.nullCalibrationId ||
        Object.keys(input.next.reservations).length !==
          Object.keys(state.reservations).length + 1 ||
        Object.entries(state.reservations).some(
          ([requestHash, reservation]) => {
            const successor =
              input.next.reservations[requestHash];
            return (
              successor === undefined ||
              canonicalJson(successor) !==
                canonicalJson(reservation)
            );
          },
        )
      ) {
        return { next: state, result: false };
      }
      return { next: input.next, result: true };
    });
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}
