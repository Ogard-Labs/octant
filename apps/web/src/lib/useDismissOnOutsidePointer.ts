import { useEffect, type RefObject } from "react";

/**
 * Closes a transient disclosure when the pointer goes down outside it.
 *
 * A menu that only closes on its own trigger or on Escape stays open over
 * whatever the reader turns to next, so the next click is spent dismissing it
 * rather than doing the thing they clicked. Deliberately does not restore focus
 * to the trigger: the reader has already chosen where to go.
 */
export function useDismissOnOutsidePointer(
  open: boolean,
  onDismiss: () => void,
  ...regions: ReadonlyArray<RefObject<HTMLElement | null>>
): void {
  useEffect(() => {
    if (!open) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // A region that has gone away cannot contain the pointer, so it does not
      // hold the disclosure open.
      if (regions.some((region) => region.current?.contains(target) === true)) return;
      onDismiss();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
    // The region refs are stable for the life of the component that owns them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss]);
}
