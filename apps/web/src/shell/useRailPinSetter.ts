import { useCallback, useEffect, useRef } from "react";
import { savedRailPins } from "./SidebarRail";

/**
 * Pins or unpins one Project and saves the list. The next list is built from
 * the latest one this setter produced, not from the value of the last render,
 * so two actions before a re-render both land. `completeProjectIds` is the
 * Project list only once it is loaded and complete; without it nothing is
 * pruned from the saved pins.
 */
export function useRailPinSetter<Id extends string>(
  saved: ReadonlyArray<Id>,
  completeProjectIds: ReadonlySet<string> | undefined,
  save: (next: ReadonlyArray<Id>) => void,
): (projectId: Id, pinned: boolean) => void {
  const latest = useRef(saved);
  const seen = useRef(saved);
  // Follow the host only when it hands back a different list: a render that
  // still shows the old one must not undo an action not yet reflected.
  useEffect(() => {
    if (seen.current !== saved) {
      seen.current = saved;
      latest.current = saved;
    }
  }, [saved]);
  const ids = useRef(completeProjectIds);
  ids.current = completeProjectIds;
  const persist = useRef(save);
  persist.current = save;
  return useCallback((projectId, pinned) => {
    const next = savedRailPins(latest.current, ids.current, projectId, pinned);
    latest.current = next;
    persist.current(next);
  }, []);
}
