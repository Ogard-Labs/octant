import { Platform } from "react-native";

/** Whether the system draws its controls on Liquid Glass (iOS 26 and later). */
export function hasLiquidGlass(): boolean {
  return Platform.OS === "ios" && Number.parseInt(String(Platform.Version), 10) >= 26;
}
