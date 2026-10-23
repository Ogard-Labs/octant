import { createContext } from "react";

/**
 * How a sidebar thread row opens into the pane's tabs: a single click opens
 * the thread in place of the pane's open tab unless that tab was kept, and a
 * double click keeps the thread as a tab of its own (workspace.md, Opening
 * into tabs). `null` where no workspace owns tabs (rows rendered alone).
 */
export interface SidebarThreadTabs {
  readonly openAsPreview: (threadId: string) => void;
  readonly keep: (threadId: string) => void;
}

export const SidebarThreadTabsContext = createContext<SidebarThreadTabs | null>(null);
