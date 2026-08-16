import type { MobileRouteId } from "../copy";

export interface MobileNavigationState {
  readonly activeRoute: MobileRouteId;
}

export function createInitialNavigationState(): MobileNavigationState {
  return { activeRoute: "home" };
}

export function selectMobileRoute(
  state: MobileNavigationState,
  route: MobileRouteId,
): MobileNavigationState {
  if (state.activeRoute === route) return state;
  return { activeRoute: route };
}

export function mobileThreadReturnRouteForDeepLink(activeRoute: MobileRouteId): "home" | "agents" {
  return activeRoute === "agents" ? "agents" : "home";
}

export function backMobileRoute(
  route: MobileRouteId,
  threadReturnRoute?: "home" | "agents",
): MobileRouteId | undefined {
  switch (route) {
    case "thread":
      return threadReturnRoute ?? "agents";
    case "agents":
    case "hosts":
      return "home";
    case "home":
      return undefined;
  }
}
