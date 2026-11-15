import { useCallback, useSyncExternalStore } from "react";

/**
 * Which coordinators' Workers panels this window has open. A view choice for
 * the session: the header's Workers button and the panel beside the transcript
 * both read it, and nothing about it reaches the host.
 */
const open = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function emit(): void {
  snapshot = new Set(open);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCoordinatorWorkersPanel(
  coordinatorThreadId: string,
): readonly [boolean, (next: boolean) => void] {
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  const set = useCallback(
    (next: boolean) => {
      if (next === open.has(coordinatorThreadId)) return;
      if (next) open.add(coordinatorThreadId);
      else open.delete(coordinatorThreadId);
      emit();
    },
    [coordinatorThreadId],
  );
  return [current.has(coordinatorThreadId), set];
}
