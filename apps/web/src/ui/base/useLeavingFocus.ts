import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * True when focus is somewhere the surface did not leave it: on a control the
 * person pressed, or one a command they ran from the surface moved it to.
 */
function focusHasMovedOn(popup: HTMLElement | null): boolean {
  const focused = document.activeElement;
  return focused !== null && focused !== document.body && popup?.contains(focused) !== true;
}

/**
 * Hands focus back the moment a dialog or a sheet starts to leave.
 *
 * The library hands it back only once the exit has finished, which left the
 * keyboard pointing at nothing while the surface faded and then took focus
 * away from wherever the person, or the command they ran, had put it in the
 * meantime. Focus moves when the effect runs and not in a cleanup: React puts
 * focus back on the element that held it before a commit, and a cleanup runs
 * inside one.
 *
 * `popup` goes on the popup; `finalFocus` is the library's own question, asked
 * once the exit has finished: focus is already back unless its target could
 * not take it then, and it stays where it has moved to since.
 */
export function useLeavingFocus(options: {
  readonly open: boolean;
  readonly restoreFocus: RefObject<HTMLElement | null> | undefined;
  /** Runs as the exit starts, with the popup if it ever mounted. */
  readonly onLeave?: (popup: HTMLElement | null) => void;
}): {
  readonly popup: RefObject<HTMLDivElement | null>;
  readonly finalFocus: () => HTMLElement | boolean;
} {
  const popup = useRef<HTMLDivElement>(null);
  const focusedBefore = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  const { open } = options;
  useLayoutEffect(() => {
    if (open) {
      const before = document.activeElement;
      focusedBefore.current = before instanceof HTMLElement ? before : null;
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    latest.current.onLeave?.(popup.current);
    if (focusHasMovedOn(popup.current)) return;
    (latest.current.restoreFocus?.current ?? focusedBefore.current)?.focus({ preventScroll: true });
  }, [open]);
  return {
    popup,
    finalFocus: () =>
      focusHasMovedOn(popup.current) ? false : (latest.current.restoreFocus?.current ?? true),
  };
}
