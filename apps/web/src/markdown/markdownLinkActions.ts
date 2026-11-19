import { createContext } from "react";

/**
 * provider the anchor still copies its URL and opens in a browser tab.
 */
export interface MarkdownLinkActions {
  readonly openInApp?: (url: string) => void;
  readonly openExternal: (url: string) => void;
}

export const MarkdownLinkActionsContext = createContext<MarkdownLinkActions | undefined>(undefined);
