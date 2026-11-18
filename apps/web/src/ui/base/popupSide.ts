import { useCallback, useRef, useState, type RefObject } from "react";

export type PopupSide = "top" | "bottom";

/**
 * The side a popup opens on. One that prefers to open upward (the composer's
 * popups, whose button usually stands at the foot of a thread) opens downward
 * when its button stands in the upper half of the window, as on a start
 * screen: there the room is below, and an upward popup ran into the title
 * bar while the popup beside it, too tall to fit above, opened downward. The
 * library turns a popup over only when it cannot fit at all.
 *
 * A button that has not been laid out (a test without layout) keeps the
 * preferred side.
 */
export function sideWithRoom(preferred: PopupSide, trigger: Element | null): PopupSide {
  if (preferred !== "top" || trigger === null || typeof window === "undefined") return preferred;
  const box = trigger.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return preferred;
  return box.top + box.height / 2 < window.innerHeight / 2 ? "bottom" : "top";
}

/** Settles the side when the popup opens, so it does not change while open. */
export function useSideWithRoom<T extends Element>(
  preferred: PopupSide,
): {
  readonly side: PopupSide;
  readonly trigger: RefObject<T | null>;
  readonly settle: (open: boolean) => void;
} {
  const trigger = useRef<T>(null);
  const [side, setSide] = useState<PopupSide>(preferred);
  const settle = useCallback(
    (open: boolean) => {
      if (open) setSide(sideWithRoom(preferred, trigger.current));
    },
    [preferred],
  );
  return { side, trigger, settle };
}
