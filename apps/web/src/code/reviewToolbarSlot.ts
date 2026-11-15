import { createContext } from "react";

/**
 * Where Review's diff controls go when the Review tool draws its own toolbar
 * row: the view switch stands at that row's left, and the diff's layout,
 * whitespace, refresh and more controls are placed at its right. Without a slot
 * (the switch lives in a tile bar, or the diff stands alone) the diff draws its
 * own controls row; `null` is a slot that is about to exist.
 */
export const ReviewToolbarSlotContext = createContext<HTMLElement | null | undefined>(undefined);
