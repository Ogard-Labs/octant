import type { CodeEnvironmentObservation } from "@octant/contracts";
import { createContext, useContext, useMemo, type ReactNode } from "react";

export type CodeCheckoutFacts = Extract<CodeEnvironmentObservation, { readonly status: "ready" }>;

/**
 * The checkout reading a pane may need beyond the ready facts: the whole
 * observation, and the read's own failure sentence when the host declined to
 * answer with an observation at all.
 */
export interface CodeCheckoutState {
  readonly observation?: CodeEnvironmentObservation | undefined;
  readonly errorMessage?: string | undefined;
}

const CodeCheckoutContext = createContext<CodeCheckoutState | undefined>(undefined);

/**
 * The checkout a Code thread is bound to, offered to the pane inside it.
 *
 * The Environment component already observes this and wraps the workspace, so
 * the surfaces below it read the same observation rather than starting a second
 * one that could disagree with the panel a few pixels away. The context keeps
 * the whole observation — a surface that reports why the checkout cannot be
 * read needs the unavailable or failed `reason`, which a ready-only projection
 * would drop.
 */
export function CodeCheckoutProvider(props: {
  readonly observation?: CodeEnvironmentObservation | undefined;
  readonly errorMessage?: string | undefined;
  readonly children: ReactNode;
}) {
  const value = useMemo(
    () =>
      props.observation === undefined && props.errorMessage === undefined
        ? undefined
        : { observation: props.observation, errorMessage: props.errorMessage },
    [props.observation, props.errorMessage],
  );
  return (
    <CodeCheckoutContext.Provider value={value}>{props.children}</CodeCheckoutContext.Provider>
  );
}

/** The bound checkout, or `undefined` where none has been observed ready yet. */
export function useCodeCheckout(): CodeCheckoutFacts | undefined {
  const observation = useContext(CodeCheckoutContext)?.observation;
  return observation?.status === "ready" ? observation : undefined;
}

/**
 * The checkout reading as it came, including the `reason` an unavailable or
 * failed observation carries and the failure sentence of a read the host
 * refused outright. `undefined` where no observation has reached this
 * surface — never invented.
 */
export function useCodeCheckoutObservation(): CodeCheckoutState | undefined {
  return useContext(CodeCheckoutContext);
}
