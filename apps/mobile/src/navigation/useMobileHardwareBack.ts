import { useEffect } from "react";
import { BackHandler } from "react-native";
import type { MobileRouteId } from "../copy";
import { backMobileRoute } from "./navigationState";

export function useMobileHardwareBack(
  activeRoute: MobileRouteId,
  onSelectRoute: (route: MobileRouteId) => void,
  onHomeBack?: () => boolean,
  threadReturnRoute?: "home" | "agents",
): void {
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (activeRoute === "home" && onHomeBack?.()) return true;
      const previous = backMobileRoute(activeRoute, threadReturnRoute);
      if (previous === undefined) return false;
      onSelectRoute(previous);
      return true;
    });
    return () => subscription.remove();
  }, [activeRoute, onHomeBack, onSelectRoute, threadReturnRoute]);
}
