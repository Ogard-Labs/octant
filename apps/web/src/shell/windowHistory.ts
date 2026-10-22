import type { OctantMode } from "@octant/contracts/modes";
import type { PaneId, WorkspaceTabId } from "@octant/contracts/shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidebarNavigationDescriptorId } from "./navigationModel";

/**
 * One place this window showed: a page opened from the sidebar or rail, or the
 * tab a pane was showing (a thread, a draft, a canvas). Places belong to the
 * window, not the host, and are never persisted: a window's back and forward
 * step through what that window opened since it started.
 */
/** A sidebar destination, or one of the reader pages opened from elsewhere. */
export type WindowPage = SidebarNavigationDescriptorId | "review" | "archive";

export type WindowPlace =
  | {
      readonly kind: "page";
      readonly mode: OctantMode;
      readonly destination: WindowPage;
    }
  | {
      readonly kind: "tab";
      readonly mode: OctantMode;
      readonly paneId: PaneId;
      readonly tabId: WorkspaceTabId;
    };

export interface WindowHistoryState {
  readonly entries: ReadonlyArray<WindowPlace>;
  /** The entry the window is on; -1 before anything was recorded. */
  readonly index: number;
}

/** Enough steps for a working session without growing for the window's life. */
export const WINDOW_HISTORY_LIMIT = 50;

export const EMPTY_WINDOW_HISTORY: WindowHistoryState = { entries: [], index: -1 };

const ARRIVAL_GRACE_MS = 1_000;

export function samePlace(a: WindowPlace, b: WindowPlace): boolean {
  if (a.kind !== b.kind || a.mode !== b.mode) return false;
  if (a.kind === "page" && b.kind === "page") return a.destination === b.destination;
  if (a.kind === "tab" && b.kind === "tab") {
    return String(a.paneId) === String(b.paneId) && String(a.tabId) === String(b.tabId);
  }
  return false;
}

/**
 * Records a place the window moved to by any means other than back or
 * forward. Like a browser, a new place drops the steps ahead of the current
 * one; the same place twice in a row is one step.
 */
export function recordPlace(state: WindowHistoryState, place: WindowPlace): WindowHistoryState {
  const current = state.entries[state.index];
  if (current !== undefined && samePlace(current, place)) return state;
  const kept = [...state.entries.slice(0, state.index + 1), place];
  const trimmed = kept.slice(Math.max(0, kept.length - WINDOW_HISTORY_LIMIT));
  return { entries: trimmed, index: trimmed.length - 1 };
}

/** Removes an entry that can no longer be restored, keeping the index on the same place. */
export function forgetPlace(state: WindowHistoryState, index: number): WindowHistoryState {
  if (index < 0 || index >= state.entries.length) return state;
  const entries = state.entries.filter((_, position) => position !== index);
  return { entries, index: index < state.index ? state.index - 1 : state.index };
}

export interface WindowHistory {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly goBack: () => void;
  readonly goForward: () => void;
}

/**
 * Back and forward for one window. `current` is the place the window shows
 * now; every change of it that back or forward did not cause is recorded.
 * `restore` reopens a place and says whether it could: a step whose tab was
 * closed since is skipped, and the next one in the same direction is tried.
 */
export function useWindowHistory(
  current: WindowPlace | undefined,
  restore: (place: WindowPlace) => Promise<boolean>,
): WindowHistory {
  const [state, setState] = useState<WindowHistoryState>(EMPTY_WINDOW_HISTORY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  // The place a back or forward is moving to. While it is pending, the window
  // arriving there is the step itself, not a new place to record.
  const arriving = useRef<WindowPlace | undefined>(undefined);
  const moving = useRef(false);

  useEffect(() => {
    if (current === undefined) return;
    const target = arriving.current;
    if (target !== undefined) {
      if (samePlace(target, current)) arriving.current = undefined;
      return;
    }
    setState((previous) => recordPlace(previous, current));
  }, [current]);

  const step = useCallback(async (direction: -1 | 1) => {
    if (moving.current) return;
    moving.current = true;
    try {
      let working = stateRef.current;
      let index = working.index + direction;
      while (index >= 0 && index < working.entries.length) {
        const place = working.entries[index];
        if (place === undefined) break;
        arriving.current = place;
        if (await restoreRef.current(place)) {
          const settled = working;
          setState({ entries: settled.entries, index });
          // A restore that settles on a place described a little differently
          // (a mode switch that lands first) must not hold recording off for
          // good; once the move has had time to land, new places count again.
          setTimeout(() => {
            if (arriving.current === place) arriving.current = undefined;
          }, ARRIVAL_GRACE_MS);
          return;
        }
        arriving.current = undefined;
        working = forgetPlace(working, index);
        // Moving back, the next candidate shifted down into this index's
        // place; moving forward, it now sits at the same index.
        if (direction === -1) index -= 1;
        setState(working);
      }
    } finally {
      moving.current = false;
    }
  }, []);

  const canGoBack = state.index > 0;
  const canGoForward = state.index >= 0 && state.index < state.entries.length - 1;
  // Stable between moves, so the memoized chrome and sidebar that show the
  // buttons re-render only when an end of the history is reached or left.
  return useMemo(
    () => ({
      canGoBack,
      canGoForward,
      goBack: () => void step(-1),
      goForward: () => void step(1),
    }),
    [canGoBack, canGoForward, step],
  );
}
