import { Ionicons } from "@expo/vector-icons";
import { SymbolView } from "expo-symbols";
import type { IconProps } from "./Icon";
import { systemSymbol } from "./symbols";

/** The system's symbol, which matches the weight and size of the text beside it. */
export function Icon(props: IconProps) {
  const fallback = (
    <Ionicons color={props.color} name={props.name} size={props.size} style={props.style} />
  );
  const symbol = systemSymbol(props.name);
  if (symbol === undefined) return fallback;
  return (
    <SymbolView
      fallback={fallback}
      name={symbol}
      resizeMode="scaleAspectFit"
      size={props.size}
      style={[{ width: props.size * 1.15, height: props.size * 1.15 }, props.style]}
      tintColor={props.color}
      weight="medium"
    />
  );
}
