import { Schema } from "effect";

/**
 * The bounds every mode's transcript window carries. A window is one
 * contiguous run of turns, oldest first; these say whether the thread holds
 * turns before and after it. Each mode spreads them into its own window type,
 * whose turns and anchors stay that mode's own.
 */
export const ThreadWindowBoundsFields = {
  hasEarlier: Schema.Boolean,
  hasLater: Schema.Boolean,
} as const;
