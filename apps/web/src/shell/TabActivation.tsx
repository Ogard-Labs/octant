import type { WorkspaceTabId } from "@octant/contracts";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

/**
 * Which workspace tabs the person put in front during this session.
 *
 * A restored layout re-renders whichever tab was active when the window last
 * closed, which is not the same as someone asking for it. A surface that
 * starts a process on view needs that difference: it may act on a tab the
 * person activated, opened, or created here, and must wait for an explicit
 * action on a tab that merely came back with the layout.
 */
export interface TabActivationRegistry {
  readonly noteActivated: (tabId: WorkspaceTabId) => void;
  readonly wasActivatedThisSession: (tabId: WorkspaceTabId) => boolean;
  /** Activation happens while a surface is already mounted, so it must notify. */
  readonly subscribe: (listener: () => void) => () => void;
}

export function createTabActivationRegistry(): TabActivationRegistry {
  const activated = new Set<WorkspaceTabId>();
  const listeners = new Set<() => void>();
  return {
    noteActivated: (tabId) => {
      if (activated.has(tabId)) return;
      activated.add(tabId);
      for (const listener of [...listeners]) listener();
    },
    wasActivatedThisSession: (tabId) => activated.has(tabId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Without a registry there is no evidence of activation, so nothing may act on it. */
const NEVER_ACTIVATED: TabActivationRegistry = {
  noteActivated: () => undefined,
  wasActivatedThisSession: () => false,
  subscribe: () => () => undefined,
};

const TabActivationContext = createContext<TabActivationRegistry>(NEVER_ACTIVATED);

export function TabActivationProvider(props: {
  readonly children: ReactNode;
  readonly registry?: TabActivationRegistry;
}) {
  return (
    <TabActivationContext.Provider value={props.registry ?? NEVER_ACTIVATED}>
      {props.children}
    </TabActivationContext.Provider>
  );
}

export function useTabActivation(): TabActivationRegistry {
  return useContext(TabActivationContext);
}

/**
 * Track one tab's activation reactively. A surface that mounts with a restored
 * layout re-renders when the person finally brings that tab forward, so it can
 * act on the activation instead of waiting for an unrelated render.
 */
export function useTabActivatedThisSession(tabId: WorkspaceTabId): boolean {
  const registry = useTabActivation();
  return useSyncExternalStore(
    registry.subscribe,
    () => registry.wasActivatedThisSession(tabId),
    () => false,
  );
}
