import { createContext } from "react";

/**
 * True while the transcript's Find is open: the quiet Reply detail levels then
 * show every step they hide, so a search reaches all of a turn and nothing
 * hidden is lost.
 */
export const RevealHiddenStepsContext = createContext(false);
