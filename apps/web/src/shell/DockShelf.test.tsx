import { describe, expect, it } from "vitest";
import { dockShelfEntries } from "./DockShelf";
import {
  addUtilityTabState,
  minimiseUtilityTool,
  openUtilityTabState,
  type ThreadUtilityDockState,
} from "./rightUtilityDockSelection";

function opened(...ids: ReadonlyArray<"browser" | "terminal" | "files">): ThreadUtilityDockState {
  let state: ThreadUtilityDockState = { tabs: [] };
  for (const id of ids) state = openUtilityTabState(state, id);
  return state;
}

const nobody = { agentBrowserLive: false, terminalPossible: true };
const live = { agentBrowserLive: true, terminalPossible: true };

describe("the cards a dock state asks for", () => {
  it("has none when nothing is minimised and the agent has no live Browser", () => {
    expect(dockShelfEntries(opened("files", "browser", "terminal"), nobody)).toEqual([]);
  });

  it("has one card for each minimised tool, the Browser first", () => {
    const state = minimiseUtilityTool(
      minimiseUtilityTool(opened("terminal", "browser", "files"), "terminal"),
      "browser",
    );
    expect(dockShelfEntries(state, nobody)).toEqual([
      { tabId: "browser", surface: "browser" },
      { tabId: "terminal", surface: "terminal" },
    ]);
  });

  it("shows the Browser without it being minimised while the agent's session is live, as long as it has a tab", () => {
    expect(dockShelfEntries(opened("files", "browser"), live)).toEqual([
      { tabId: "browser", surface: "browser" },
    ]);
    expect(dockShelfEntries(opened("files"), live)).toEqual([]);
  });

  it("never draws a card for a Terminal the person did not minimise, live session or not", () => {
    expect(dockShelfEntries(opened("terminal"), live)).toEqual([]);
  });

  it("draws one Browser card however it got there", () => {
    const state = minimiseUtilityTool(opened("files", "browser"), "browser");
    expect(dockShelfEntries(state, live)).toHaveLength(1);
  });

  it("draws no Terminal card for a thread that cannot have a Terminal", () => {
    const state = minimiseUtilityTool(opened("files", "terminal"), "terminal");
    expect(dockShelfEntries(state, { agentBrowserLive: false, terminalPossible: false })).toEqual(
      [],
    );
  });

  it("stands the Browser card for the page the Browser last showed", () => {
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    const parked = minimiseUtilityTool(state, pageOne);
    expect(dockShelfEntries(parked, nobody)).toEqual([{ tabId: pageTwo, surface: "browser" }]);
  });
});
