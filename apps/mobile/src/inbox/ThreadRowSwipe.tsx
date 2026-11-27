import type { ReactNode } from "react";
import type { MobileIconName } from "../ui/symbols";

export interface SwipeAction {
  readonly id: string;
  readonly label: string;
  readonly icon: MobileIconName;
  /** The palette's fill behind the action. */
  readonly fill: string;
  readonly onPress: () => void;
}

export interface ThreadRowSwipeProps {
  readonly children: ReactNode;
  /** From the leading edge, and from the trailing one; the outermost first. */
  readonly leading: ReadonlyArray<SwipeAction>;
  readonly trailing: ReadonlyArray<SwipeAction>;
}

/** Where rows do not swipe, the row menu offers the same actions. */
export function ThreadRowSwipe(props: ThreadRowSwipeProps) {
  return props.children;
}
