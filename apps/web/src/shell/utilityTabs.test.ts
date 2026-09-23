import { describe, expect, it } from "vitest";
import { describeUtilityTabs } from "./utilityTabs";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import type { ThreadUtilityDockTab } from "./rightUtilityDockSelection";

describe("describeUtilityTabs", () => {
  it("numbers tabs that share a utility surface", () => {
    const tabs: ReadonlyArray<ThreadUtilityDockTab> = [
      { id: "browser-1", surface: "browser" },
      { id: "browser-2", surface: "browser" },
    ];

    expect(describeUtilityTabs(tabs).map((tab) => tab.label)).toEqual(["Browser 1", "Browser 2"]);
  });

  it("keeps a lone utility tab's bare label", () => {
    expect(describeUtilityTabs([{ id: "canvas", surface: "canvas" }])[0]?.label).toBe("Canvas");
  });

  it("drops tabs for unknown utility surfaces", () => {
    const tabs: ReadonlyArray<ThreadUtilityDockTab> = [
      { id: "unknown", surface: "unknown" as RightUtilityDockSurfaceId },
    ];

    expect(describeUtilityTabs(tabs)).toEqual([]);
  });
});
