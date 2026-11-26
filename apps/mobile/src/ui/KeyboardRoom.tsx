import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

export interface KeyboardRoomProps {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  /** What the view already leaves at the foot of the screen, which the keyboard covers. */
  readonly leaves?: number;
  readonly testID?: string;
}

/** A browser makes room for its keyboard itself. */
export function KeyboardRoom(props: KeyboardRoomProps) {
  return (
    <View style={props.style} testID={props.testID}>
      {props.children}
    </View>
  );
}
