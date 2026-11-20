import { createContext, useContext } from "react";

/**
 * Bumps each time the host commits a change to saved decision-form answers
 * (including synced answers or clears adopted from another computer), so open
 * decision forms re-read their saved answers without remounting.
 */
export const CanvasChoiceAnswersChangeRevisionContext = createContext(0);
export const useCanvasChoiceAnswersChangeRevision = () =>
  useContext(CanvasChoiceAnswersChangeRevisionContext);
