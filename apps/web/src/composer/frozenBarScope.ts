import { createContext, useContext, type ReactNode } from "react";

/**
 * The bar a thread's composer gives way to while a move holds the thread:
 * moving away, moving after its turn, handed over, or arriving here. The
 * thread pane provides it; absent, the composer shows as usual.
 */
export const FrozenBarScope = createContext<ReactNode>(undefined);

export function useFrozenBar(): ReactNode {
  return useContext(FrozenBarScope);
}
