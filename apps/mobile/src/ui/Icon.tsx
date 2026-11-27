import type { StyleProp, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { MobileIconName } from "./symbols";

export interface IconProps {
  readonly name: MobileIconName;
  readonly size: number;
  readonly color: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function Icon(props: IconProps) {
  return <Ionicons color={props.color} name={props.name} size={props.size} style={props.style} />;
}
