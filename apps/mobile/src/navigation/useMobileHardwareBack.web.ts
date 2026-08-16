import type { MobileRouteId } from "../copy";

export function useMobileHardwareBack(
  _activeRoute: MobileRouteId,
  _onSelectRoute: (route: MobileRouteId) => void,
  _onHomeBack?: () => boolean,
  _threadReturnRoute?: "home" | "agents",
): void {}
