import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { MessageActionItem } from "./MessageActions";

export interface MessageMenuProps {
  readonly actions: ReadonlyArray<MessageActionItem>;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

/** Where the system has no menu for a message, its actions stay under it alone. */
export function MessageMenu(props: MessageMenuProps) {
  return <View style={props.style}>{props.children}</View>;
}
