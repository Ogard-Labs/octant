import { describe, expect, it } from "vitest";
import { dockShelfEntries } from "./DockShelf";
import {
  minimiseUtilityTool,
  openUtilityTabState,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";

function opened(...ids: ReadonlyArray<"browser" | "terminal" | "files">): ThreadUtilityDockState {
  let state: ThreadUtilityDockState = { tabs: [] };
  for (const id of ids) state = openUtilityTabState(state, id);
  return state;
}

describe("the cards a dock state asks for", () => {
  it("has none when nothing is minimised and the agent has no live Browser", () => {
    expect(dockShelfEntries(opened("files", "browser", "terminal"), false)).toEqual([]);
  });

  it("has one card for each minimised tool, the Browser first", () => {
    const state = minimiseUtilityTool(
      minimiseUtilityTool(opened("terminal", "browser", "files"), "terminal"),
      "browser",
    );
    expect(dockShelfEntries(state, false)).toEqual([
      { tabId: "browser", surface: "browser" },
      { tabId: "terminal", surface: "terminal" },
    ]);
  });

  it("shows the Browser without it being minimised while the agent's session is live, as long as it has a tab", () => {
    expect(dockShelfEntries(opened("files", "browser"), true)).toEqual([
      { tabId: "browser", surface: "browser" },
    ]);
    expect(dockShelfEntries(opened("files"), true)).toEqual([]);
  });

  it("never draws a card for a Terminal the person did not minimise, live session or not", () => {
    expect(dockShelfEntries(opened("terminal"), true)).toEqual([]);
  });

  it("draws one Browser card however it got there", () => {
    const state = minimiseUtilityTool(opened("files", "browser"), "browser");
    expect(dockShelfEntries(state, true)).toHaveLength(1);
  });
});
