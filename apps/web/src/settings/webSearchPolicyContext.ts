import type { WebSearchDataPolicy } from "@octant/contracts/web-search";
import { createContext } from "react";

/**
 * The host's web search data policy as Settings last read it, for the pages
 * that show what it locks. Undefined until read, or off a host that has none.
 */
export const WebSearchPolicyContext = createContext<WebSearchDataPolicy | undefined>(undefined);
