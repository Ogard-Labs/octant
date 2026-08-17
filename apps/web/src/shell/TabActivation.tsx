import type { WorkspaceTabId } from "@octant/contracts";
import { createContext, useContext, type ReactNode } from "react";

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
}

export function createTabActivationRegistry(): TabActivationRegistry {
  const activated = new Set<WorkspaceTabId>();
  return {
    noteActivated: (tabId) => {
      activated.add(tabId);
    },
    wasActivatedThisSession: (tabId) => activated.has(tabId),
  };
}

/** Without a registry there is no evidence of activation, so nothing may act on it. */
const NEVER_ACTIVATED: TabActivationRegistry = {
  noteActivated: () => undefined,
  wasActivatedThisSession: () => false,
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
