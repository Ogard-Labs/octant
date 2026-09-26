import { createContext, useContext, type ReactNode } from "react";

/**
 * What the thread around this composer has delegated and still needs the
 * person's eye: its active subagents and finished ones awaiting review.
 *
 * The composer is where the person works on the thread, so live delegated
 * work reads there rather than in a strip above the transcript, which sat
 * detached from anything the person was doing. The pane supplies the content;
 * the composer only gives it a place, so it knows nothing about how subagents
 * are read or controlled.
 */
export const ComposerSubagentsContext = createContext<ReactNode>(null);

export function ComposerSubagents() {
  return <>{useContext(ComposerSubagentsContext)}</>;
}
