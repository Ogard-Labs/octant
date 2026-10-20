import { createRequestGuard } from "../requestGuard";

/**
 * Outcome of work that started for one thread. `stale` means the selection
 * moved on while the work was in flight, so the caller must not paint it.
 */
export type GuardedResult<T> =
  | { readonly status: "stale" }
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "failed"; readonly cause: unknown };

export interface SelectedThreadGuard {
  /** Record which thread is on screen; a different identity invalidates all in-flight work. */
  readonly select: (identity: string | undefined) => void;
  readonly isSelected: (identity: string) => boolean;
  /**
   * Run `run` for `identity` and report its result only if that thread is still
   * the selected one. Switching threads during a send used to paint the old
   * thread's reply over the new one.
   */
  readonly guarded: <T>(identity: string, run: () => Promise<T>) => Promise<GuardedResult<T>>;
}

export function createSelectedThreadGuard(): SelectedThreadGuard {
  const generations = createRequestGuard();
  let selected: string | undefined;
  let generation = generations.begin();

  const isSelected = (identity: string) => selected === identity;

  return {
    select: (identity) => {
      if (identity === selected) return;
      selected = identity;
      generation = generations.begin();
    },
    isSelected,
    guarded: async (identity, run) => {
      // Work for the same thread may overlap (a quiet poll beside a send), so
      // capture the generation without starting a new one.
      const started = generation;
      const current = () => isSelected(identity) && generations.isCurrent(started);
      try {
        const value = await run();
        return current() ? { status: "done", value } : { status: "stale" };
      } catch (cause) {
        return current() ? { status: "failed", cause } : { status: "stale" };
      }
    },
  };
}
