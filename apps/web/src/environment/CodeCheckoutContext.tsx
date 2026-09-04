import type { CodeEnvironmentObservation } from "@octant/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type CodeCheckoutFacts = Extract<CodeEnvironmentObservation, { readonly status: "ready" }>;

const CodeCheckoutContext = createContext<CodeCheckoutFacts | undefined>(undefined);

/**
 * The checkout a Code thread is bound to, offered to the pane inside it.
 *
 * The Environment component already observes this and wraps the workspace, so
 * the surfaces below it read the same observation rather than starting a second
 * one that could disagree with the panel a few pixels away.
 */
export function CodeCheckoutProvider(props: {
  readonly observation?: CodeCheckoutFacts | undefined;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => props.observation, [props.observation]);
  return (
    <CodeCheckoutContext.Provider value={value}>{props.children}</CodeCheckoutContext.Provider>
  );
}

/** The bound checkout, or `undefined` where none has been observed yet. */
export function useCodeCheckout(): CodeCheckoutFacts | undefined {
  return useContext(CodeCheckoutContext);
}
