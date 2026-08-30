import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  readBottomPanelToolPresentation,
  readUtilityDockOpen,
  readUtilityDockPresentation,
  writeBottomPanelToolPresentation,
  writeUtilityDockPresentation,
  type ThreadUtilityDockState,
  type ThreadUtilityDockStates,
} from "./rightUtilityDockSelection";
import {
  readBottomPanelPresentation,
  writeBottomPanelPresentation,
  type BottomPanelPresentation,
} from "./useShellPresentation";

const EMPTY_DOCK_STATE: ThreadUtilityDockState = { tabs: [] };

export interface ThreadUtilityPresentation {
  readonly dockVisible: boolean;
  /** Records an explicit show or hide for this window. */
  readonly setDockVisible: (next: boolean) => void;
  readonly dockStatesByThread: ThreadUtilityDockStates;
  readonly setDockStatesByThread: Dispatch<SetStateAction<ThreadUtilityDockStates>>;
  readonly fallbackDockState: ThreadUtilityDockState;
  readonly setFallbackDockState: Dispatch<SetStateAction<ThreadUtilityDockState>>;
  readonly bottomPanelPresentation: BottomPanelPresentation;
  readonly persistBottomPanelPresentation: (next: BottomPanelPresentation) => void;
  readonly bottomPanelStatesByThread: ThreadUtilityDockStates;
  readonly setBottomPanelStatesByThread: Dispatch<SetStateAction<ThreadUtilityDockStates>>;
  readonly fallbackBottomPanelState: ThreadUtilityDockState;
  readonly setFallbackBottomPanelState: Dispatch<SetStateAction<ThreadUtilityDockState>>;
}

/**
 * Per-window dock and bottom-panel open-tool state. Tool processes stay
 * server-owned; this only restores which tools this window last showed.
 */
export function useThreadUtilityPresentation(
  windowId: string,
  scope: { readonly localStorage?: Storage } = globalThis,
  /**
   * What an unset window shows. A wide window shows the dock, so the workspace
   * arrives as sidebar, thread, and tools rather than a column in an empty
   * pane; a narrow window keeps it closed, because there the dock is a modal
   * drawer that would cover the app on launch. This is read live rather than
   * frozen at mount: an embedded window can report a zero-width viewport on its
   * first frame, and freezing that reading hid the dock for the whole session.
   */
  defaultOpen = true,
): ThreadUtilityPresentation {
  const [chosenDockOpen, setChosenDockOpen] = useState(() => readUtilityDockOpen(scope, windowId));
  const dockVisible = chosenDockOpen ?? defaultOpen;
  const setDockVisible = useCallback((next: boolean) => {
    setChosenDockOpen(next);
  }, []);
  const [dockStatesByThread, setDockStatesByThread] = useState<ThreadUtilityDockStates>(
    () => readUtilityDockPresentation(scope, windowId).threads,
  );
  const [fallbackDockState, setFallbackDockState] =
    useState<ThreadUtilityDockState>(EMPTY_DOCK_STATE);
  const [bottomPanelPresentation, setBottomPanelPresentation] = useState(() =>
    readBottomPanelPresentation(scope, windowId),
  );
  const [bottomPanelStatesByThread, setBottomPanelStatesByThread] =
    useState<ThreadUtilityDockStates>(() => readBottomPanelToolPresentation(scope, windowId));
  const [fallbackBottomPanelState, setFallbackBottomPanelState] =
    useState<ThreadUtilityDockState>(EMPTY_DOCK_STATE);

  // Only a window that has actually been shown or hidden records an open state.
  // Writing the default back on mount turned "not chosen yet" into a choice.
  useEffect(() => {
    if (chosenDockOpen === undefined) return;
    writeUtilityDockPresentation(scope, windowId, {
      open: chosenDockOpen,
      threads: dockStatesByThread,
    });
  }, [chosenDockOpen, dockStatesByThread, scope, windowId]);
  useEffect(() => {
    writeBottomPanelToolPresentation(scope, windowId, bottomPanelStatesByThread);
  }, [bottomPanelStatesByThread, scope, windowId]);

  const persistBottomPanelPresentation = useCallback(
    (next: BottomPanelPresentation) => {
      setBottomPanelPresentation(next);
      writeBottomPanelPresentation(scope, windowId, next);
    },
    [scope, windowId],
  );

  return {
    dockVisible,
    setDockVisible,
    dockStatesByThread,
    setDockStatesByThread,
    fallbackDockState,
    setFallbackDockState,
    bottomPanelPresentation,
    persistBottomPanelPresentation,
    bottomPanelStatesByThread,
    setBottomPanelStatesByThread,
    fallbackBottomPanelState,
    setFallbackBottomPanelState,
  };
}
