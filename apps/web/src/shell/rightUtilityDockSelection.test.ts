import { describe, expect, it } from "vitest";
import {
  closeThreadUtilityTab,
  openThreadUtilityTab,
  retainAvailableUtilityTabs,
  selectThreadUtilityTab,
  threadUtilityDockState,
  threadUtilityDockKey,
  type ThreadUtilityDockStates,
} from "./rightUtilityDockSelection";

describe("thread-owned right utility dock tabs", () => {
  it("restores each thread's open tabs and selected tab without sharing state", () => {
    const first = threadUtilityDockKey("code", "thread-a");
    const second = threadUtilityDockKey("code", "thread-b");
    let states: ThreadUtilityDockStates = new Map();

    states = openThreadUtilityTab(states, first, "browser");
    states = openThreadUtilityTab(states, first, "terminal");
    states = openThreadUtilityTab(states, second, "ios-simulator");

    expect(threadUtilityDockState(states, first)).toEqual({
      tabs: ["browser", "terminal"],
      active: "terminal",
    });
    expect(threadUtilityDockState(states, second)).toEqual({
      tabs: ["ios-simulator"],
      active: "ios-simulator",
    });

    states = selectThreadUtilityTab(states, first, "browser");
    states = closeThreadUtilityTab(states, first, "browser");
    expect(threadUtilityDockState(states, first)).toEqual({
      tabs: ["terminal"],
      active: "terminal",
    });
    expect(threadUtilityDockState(states, second).active).toBe("ios-simulator");
  });

  it("drops tools the host no longer offers without rebinding the remaining selection", () => {
    expect(
      retainAvailableUtilityTabs(
        { tabs: ["browser", "plan", "terminal"], active: "plan" },
        new Set(["browser", "terminal"]),
      ),
    ).toEqual({ tabs: ["browser", "terminal"], active: "terminal" });
  });
});
