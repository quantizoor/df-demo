import {
  assertDurableExperimentJournalState,
  emptyExperimentJournalState,
  type AtomicExperimentJournalStateStore,
  type DurableExperimentJournalState,
} from "../orchestrator/experiment-journal.js";
import {
  MountedVolumeTransactionalJsonStore,
  type MountedVolumeDurableStateOptions,
} from "./mounted-volume-state.js";

/**
 * Fenced, linearizable mounted-volume implementation of the production
 * experiment journal state port. Experiment artifacts remain in
 * ExperimentStore; this state is the crash-recovery transaction journal that
 * decides which immutable artifact operation may resume.
 */
export class MountedVolumeAtomicExperimentJournalStateStore
  implements AtomicExperimentJournalStateStore
{
  readonly #store: MountedVolumeTransactionalJsonStore<
    DurableExperimentJournalState
  >;

  public constructor(options: MountedVolumeDurableStateOptions) {
    this.#store =
      new MountedVolumeTransactionalJsonStore<DurableExperimentJournalState>(
        options,
        `experiment-journal-${options.storeId}`,
        {
          domain: "dark-factory.experiment-journal-state.v1",
          initialState: emptyExperimentJournalState,
          assertState: assertDurableExperimentJournalState,
          revision: (state) => state.revision,
        },
      );
  }

  public transact<Result>(
    operation: (state: DurableExperimentJournalState) => {
      readonly next: DurableExperimentJournalState;
      readonly result: Result;
    },
  ): Promise<Result> {
    return this.#store.transact(operation);
  }

  /**
   * A clean controller handoff releases the fenced mounted-volume lock before
   * a successor opens this namespace.
   */
  public close(): Promise<void> {
    return this.#store.close();
  }
}
