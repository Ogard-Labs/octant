import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  readBottomPanelToolPresentation,
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
  readonly setDockVisible: Dispatch<SetStateAction<boolean>>;
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
  /** A narrow window shows the dock as a modal drawer, so it never opens itself. */
  defaultOpen = true,
): ThreadUtilityPresentation {
  const [dockVisible, setDockVisible] = useState(
    () => readUtilityDockPresentation(scope, windowId, defaultOpen).open,
  );
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

  useEffect(() => {
    writeUtilityDockPresentation(scope, windowId, {
      open: dockVisible,
      threads: dockStatesByThread,
    });
  }, [dockStatesByThread, dockVisible, scope, windowId]);
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
