import { describe, expect, it } from "vitest";
import {
  backMobileRoute,
  createInitialNavigationState,
  mobileThreadReturnRouteForDeepLink,
  selectMobileRoute,
} from "./navigationState";

describe("mobile navigation state", () => {
  it("starts on home inbox", () => {
    expect(createInitialNavigationState()).toEqual({ activeRoute: "home" });
  });

  it("switches between home, agents, thread, and hosts", () => {
    const home = createInitialNavigationState();
    const agents = selectMobileRoute(home, "agents");
    const thread = selectMobileRoute(agents, "thread");
    const hosts = selectMobileRoute(thread, "hosts");
    expect(agents.activeRoute).toBe("agents");
    expect(thread.activeRoute).toBe("thread");
    expect(hosts.activeRoute).toBe("hosts");
  });

  it("maps native back to the previous mobile surface without exiting child screens", () => {
    expect(backMobileRoute("thread")).toBe("agents");
    expect(backMobileRoute("thread", "home")).toBe("home");
    expect(backMobileRoute("thread", "agents")).toBe("agents");
    expect(backMobileRoute("agents")).toBe("home");
    expect(backMobileRoute("hosts")).toBe("home");
    expect(backMobileRoute("home")).toBeUndefined();
  });

  it("records the current overview before opening a warm deep-linked thread", () => {
    expect(mobileThreadReturnRouteForDeepLink("home")).toBe("home");
    expect(mobileThreadReturnRouteForDeepLink("agents")).toBe("agents");
  });
});
