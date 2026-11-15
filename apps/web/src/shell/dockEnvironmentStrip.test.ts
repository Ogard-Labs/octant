import { describe, expect, it } from "vitest";
import {
  splitEnvironmentStrip,
  storedColumnShares,
  storedTileShares,
} from "./dockEnvironmentStrip";
import type { ThreadUtilityDockState } from "./rightUtilityDockSelection";

const tabs = [
  { id: "env", surface: "environment" },
  { id: "browser", surface: "browser" },
  { id: "terminal", surface: "terminal" },
] as const;

describe("how the dock divides between the Environment strip and the tools", () => {
  it("shows no tool beside the strip while only Environment is open", () => {
    const split = splitEnvironmentStrip({ tabs: [tabs[0]], active: "env" });
    expect(split.environmentTabId).toBe("env");
    expect(split.toolTabIds).toEqual([]);
    expect(split.toolLayout).toBeUndefined();
  });

  it("puts a Browser in the tool columns, never in the strip", () => {
    const split = splitEnvironmentStrip({ tabs: [tabs[0], tabs[1]], active: "browser" });
    expect(split.toolTabIds).toEqual(["browser"]);
  });

  it("keeps the tool on screen when Environment is brought to the front", () => {
    const split = splitEnvironmentStrip({ tabs: [tabs[0], tabs[1]], active: "env" });
    expect(split.toolTabIds).toEqual(["browser"]);
  });

  it("does not bring a minimised tool back as a column", () => {
    const split = splitEnvironmentStrip({
      tabs: [tabs[0], tabs[1]],
      active: "env",
      minimised: ["browser"],
    });
    expect(split.toolTabIds).toEqual([]);
  });

  it("takes Environment out of a stored layout and keeps the other columns", () => {
    const state: ThreadUtilityDockState = {
      tabs: [...tabs],
      active: "terminal",
      layout: {
        columns: [
          { share: 0.4, tiles: [{ tabId: "env", share: 1 }] },
          {
            share: 0.6,
            tiles: [
              { tabId: "terminal", share: 0.5 },
              { tabId: "browser", share: 0.5 },
            ],
          },
        ],
      },
    };
    const split = splitEnvironmentStrip(state);
    expect(split.toolTabIds).toEqual(["terminal", "browser"]);
    expect(split.toolLayout?.columns).toHaveLength(1);
    expect(split.toolLayout?.columns[0]?.share).toBe(1);
    expect(split.columnOrigins).toEqual([1]);
    expect(storedColumnShares(state, split, [1])).toEqual([0.4, 0.6]);
  });

  it("puts a tile resize back with Environment's share kept in its column", () => {
    const state: ThreadUtilityDockState = {
      tabs: [...tabs],
      active: "browser",
      layout: {
        columns: [
          {
            share: 1,
            tiles: [
              { tabId: "env", share: 0.2 },
              { tabId: "browser", share: 0.4 },
              { tabId: "terminal", share: 0.4 },
            ],
          },
        ],
      },
    };
    const split = splitEnvironmentStrip(state);
    const stored = storedTileShares(state, split, 0, [0.75, 0.25]);
    expect(stored?.column).toBe(0);
    expect(stored?.shares[0]).toBeCloseTo(0.2);
    expect(stored?.shares[1]).toBeCloseTo(0.6);
    expect(stored?.shares[2]).toBeCloseTo(0.2);
  });
});
