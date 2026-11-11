import { useCallback, useEffect, useRef } from "react";
import { savedRailPins } from "./SidebarRail";

/**
 * Pins or unpins one Project and saves the list. The next list is built from
 * the latest one this setter produced, not from the value of the last render,
 * so two actions before a re-render both land. `completeProjectIds` is the
 * Project list only once it is loaded and complete; without it nothing is
 * pruned from the saved pins.
 *
 * `save` resolves when the host has answered: `false` or a rejection means the
 * write was refused.
 */
export function useRailPinSetter<Id extends string>(
  saved: ReadonlyArray<Id>,
  completeProjectIds: ReadonlySet<string> | undefined,
  save: (next: ReadonlyArray<Id>) => Promise<boolean | void> | boolean | void,
): (projectId: Id, pinned: boolean) => void {
  const latest = useRef(saved);
  const rendered = useRef(saved);
  rendered.current = saved;
  const inFlight = useRef(0);
  // Follow the host only while no write of this setter is in flight. Saves are
  // queued, and each one is published when it is sent and again when the host
  // answers, so a list that arrives mid-queue is an earlier write of this
  // setter and not the latest intent: adopting it dropped the pin made after
  // it (pin B, pin C, the first write is published, pin D saved A, B, D).
  useEffect(() => {
    if (inFlight.current === 0) latest.current = saved;
  }, [saved]);
  const ids = useRef(completeProjectIds);
  ids.current = completeProjectIds;
  const persist = useRef(save);
  persist.current = save;
  return useCallback((projectId, pinned) => {
    const next = savedRailPins(latest.current, ids.current, projectId, pinned);
    latest.current = next;
    inFlight.current += 1;
    // The save is sent now, in the action's own tick; only its answer is
    // awaited.
    let answer: Promise<boolean | void> | boolean | void;
    try {
      answer = persist.current(next);
    } catch {
      answer = false;
    }
    void Promise.resolve(answer)
      .then(
        (answer) => answer !== false,
        () => false,
      )
      .then((accepted) => {
        inFlight.current -= 1;
        // A refused write leaves a pin that was never saved. Once nothing else
        // is in flight, fall back to what the host last showed.
        if (!accepted && inFlight.current === 0) latest.current = rendered.current;
      });
  }, []);
}
