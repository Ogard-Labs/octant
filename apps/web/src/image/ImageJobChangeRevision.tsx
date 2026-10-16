import { createContext, useContext } from "react";

/**
 * Bumps each time the host reports an image job queued or finished, so a
 * generated-image list re-reads at once instead of waiting for its idle
 * cadence. Jobs the agent's image tool starts never pass through the list's
 * own enqueue path.
 */
export const ImageJobChangeRevisionContext = createContext(0);
export const useImageJobChangeRevision = () => useContext(ImageJobChangeRevisionContext);
