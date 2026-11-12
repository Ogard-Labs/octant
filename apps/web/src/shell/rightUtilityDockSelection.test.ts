import { describe, expect, it } from "vitest";
import {
  addThreadUtilityTab,
  addUtilityTabState,
  closeThreadUtilityTab,
  changeDisplayedUtilityState,
  closeUtilityTabState,
  hideUtilityCard,
  hideUtilityTile,
  isUtilityToolMinimised,
  minimiseUtilityTool,
  offeredBrowserStaysMinimised,
  minimisedUtilityTabIds,
  MINIMISABLE_DOCK_SURFACES,
  moveUtilityTile,
  openThreadUtilityTab,
  openUtilityTabBesideState,
  openUtilityTabState,
  shownTileColumns,
  readBottomPanelToolPresentation,
  readUtilityDockOpen,
  readUtilityDockPresentation,
  removeUtilityTabs,
  restoreUtilityTool,
  resizeUtilityTileColumn,
  resizeUtilityTileColumns,
  retainAvailableUtilityTabs,
  selectThreadUtilityTab,
  selectUtilityTabState,
  shownUtilityTabIds,
  showUtilityTabAlone,
  showUtilityTabBelow,
  showUtilityTabBeside,
  withoutTileLayout,
  type ThreadUtilityDockState,
  threadUtilityDockState,
  threadUtilityDockKey,
  writeBottomPanelToolPresentation,
  writeUtilityDockPresentation,
  updateThreadUtilityTabBrowserContext,
  type ThreadUtilityDockStates,
} from "./rightUtilityDockSelection";

/** The remembered Browser page is checked by its own tests; these compare tabs and selection. */
function bare(state: ThreadUtilityDockState): ThreadUtilityDockState {
  const { lastBrowser: _remembered, ...rest } = state;
  return rest;
}

describe("thread-owned right utility dock tabs", () => {
  it("adds independent Browser and Terminal instances while singleton tools stay singular", () => {
    const browserOne = "10000000-0000-4000-8000-000000000001";
    const browserTwo = "10000000-0000-4000-8000-000000000002";
    const terminalOne = "10000000-0000-4000-8000-000000000003";
    let state: Parameters<typeof addUtilityTabState>[0] = { tabs: [] };

    state = addUtilityTabState(state, "browser", browserOne);
    state = addUtilityTabState(state, "browser", browserTwo);
    state = addUtilityTabState(state, "terminal", terminalOne);
    state = addUtilityTabState(state, "files", "10000000-0000-4000-8000-000000000004");
    state = addUtilityTabState(state, "files", "10000000-0000-4000-8000-000000000005");

    expect(bare(state)).toEqual({
      tabs: [
        { id: browserOne, surface: "browser" },
        { id: browserTwo, surface: "browser" },
        { id: terminalOne, surface: "terminal" },
        { id: "files", surface: "files" },
      ],
      active: "files",
    });
  });

  it("binds a dedicated Browser context to the tab that adopted it", () => {
    const key = threadUtilityDockKey("code", "thread-a");
    const tabId = "10000000-0000-4000-8000-000000000001";
    const contextId = "60000000-0000-4000-8000-000000000001";
    let states: ThreadUtilityDockStates = new Map();

    states = addThreadUtilityTab(states, key, "browser", tabId, contextId);

    expect(bare(threadUtilityDockState(states, key))).toEqual({
      tabs: [{ id: tabId, surface: "browser", browserContextId: contextId }],
      active: tabId,
    });
  });

  it("opens the shared Browser tab rather than a dedicated instance", () => {
    const key = threadUtilityDockKey("code", "thread-a");
    const dedicatedId = "10000000-0000-4000-8000-000000000001";
    let states: ThreadUtilityDockStates = new Map();

    states = addThreadUtilityTab(states, key, "browser", dedicatedId);
    states = openThreadUtilityTab(states, key, "browser");

    // An announced agent session belongs to the thread's shared context, so
    // the reveal selects the singleton tab instead of whichever dedicated
    // instance a link open added first.
    expect(bare(threadUtilityDockState(states, key))).toEqual({
      tabs: [
        { id: dedicatedId, surface: "browser" },
        { id: "browser", surface: "browser" },
      ],
      active: "browser",
    });

    states = openThreadUtilityTab(states, key, "browser");
    expect(threadUtilityDockState(states, key).active).toBe("browser");
  });

  it("restores each thread's open tabs and selected tab without sharing state", () => {
    const first = threadUtilityDockKey("code", "thread-a");
    const second = threadUtilityDockKey("code", "thread-b");
    let states: ThreadUtilityDockStates = new Map();

    states = openThreadUtilityTab(states, first, "browser");
    states = openThreadUtilityTab(states, first, "terminal");
    states = openThreadUtilityTab(states, second, "ios-simulator");

    expect(bare(threadUtilityDockState(states, first))).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "terminal", surface: "terminal" },
      ],
      active: "terminal",
    });
    expect(bare(threadUtilityDockState(states, second))).toEqual({
      tabs: [{ id: "ios-simulator", surface: "ios-simulator" }],
      active: "ios-simulator",
    });

    states = selectThreadUtilityTab(states, first, "browser");
    states = closeThreadUtilityTab(states, first, "browser");
    expect(bare(threadUtilityDockState(states, first))).toEqual({
      tabs: [{ id: "terminal", surface: "terminal" }],
      active: "terminal",
    });
    expect(threadUtilityDockState(states, second).active).toBe("ios-simulator");
  });

  it("drops tools the host no longer offers without rebinding the remaining selection", () => {
    expect(
      retainAvailableUtilityTabs(
        {
          tabs: [
            { id: "browser", surface: "browser" },
            { id: "plan", surface: "plan" },
            { id: "terminal", surface: "terminal" },
          ],
          active: "plan",
        },
        new Set(["browser", "terminal"]),
      ),
    ).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "terminal", surface: "terminal" },
      ],
      active: "terminal",
    });
  });

  it("removes bottom-panel tools from the dock without losing other tabs", () => {
    expect(
      removeUtilityTabs(
        {
          tabs: [
            { id: "browser", surface: "browser" },
            { id: "terminal", surface: "terminal" },
            { id: "files", surface: "files" },
          ],
          active: "terminal",
        },
        new Set(["browser", "terminal"]),
      ),
    ).toEqual({ tabs: [{ id: "files", surface: "files" }], active: "files" });
  });
});

describe("thread utility presentation persistence", () => {
  it("restores repeatable Browser identities and their isolated contexts", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    const browserOne = "10000000-0000-4000-8000-000000000001";
    const browserTwo = "10000000-0000-4000-8000-000000000002";
    let states: ThreadUtilityDockStates = new Map();
    states = addThreadUtilityTab(states, key, "browser", browserOne);
    states = addThreadUtilityTab(states, key, "browser", browserTwo);
    states = updateThreadUtilityTabBrowserContext(
      states,
      key,
      browserTwo,
      "60000000-0000-4000-8000-000000000002",
    );

    writeUtilityDockPresentation({ localStorage }, "window-a", { open: true, threads: states });

    expect(
      bare(
        threadUtilityDockState(
          readUtilityDockPresentation({ localStorage }, "window-a").threads,
          key,
        ),
      ),
    ).toEqual({
      tabs: [
        { id: browserOne, surface: "browser" },
        {
          id: browserTwo,
          surface: "browser",
          browserContextId: "60000000-0000-4000-8000-000000000002",
        },
      ],
      active: browserTwo,
    });
  });

  it("restores a window's thread dock tabs and selected tool after a reload", () => {
    const localStorage = memoryStorage();
    const first = threadUtilityDockKey("code", "thread-a");
    const second = threadUtilityDockKey("code", "thread-b");
    let states: ThreadUtilityDockStates = new Map();
    states = openThreadUtilityTab(states, first, "browser");
    states = openThreadUtilityTab(states, first, "terminal");
    states = selectThreadUtilityTab(states, first, "browser");
    states = openThreadUtilityTab(states, second, "files");

    writeUtilityDockPresentation({ localStorage }, "window-a", { open: true, threads: states });
    const restored = readUtilityDockPresentation({ localStorage }, "window-a");

    expect(restored.open).toBe(true);
    expect(bare(threadUtilityDockState(restored.threads, first))).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "terminal", surface: "terminal" },
      ],
      active: "browser",
    });
    expect(bare(threadUtilityDockState(restored.threads, second))).toEqual({
      tabs: [{ id: "files", surface: "files" }],
      active: "files",
    });
  });

  it("keeps each window's dock tools from another window", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: true,
      threads: openThreadUtilityTab(new Map(), key, "terminal"),
    });
    expect(readUtilityDockPresentation({ localStorage }, "window-b")).toEqual({
      open: false,
      threads: new Map(),
    });
  });

  it("reports no choice for a window that has never shown or hidden the dock", () => {
    expect(readUtilityDockOpen({ localStorage: memoryStorage() }, "fresh")).toBeUndefined();
  });

  it("reports the choice a window actually made", () => {
    const localStorage = memoryStorage();
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: false,
      threads: new Map(),
    });

    expect(readUtilityDockOpen({ localStorage }, "window-a")).toBe(false);
  });

  it("keeps the dock closed until a window chooses to show it", () => {
    expect(readUtilityDockPresentation({ localStorage: memoryStorage() }, "fresh")).toEqual({
      open: false,
      threads: new Map(),
    });
  });

  it("uses the caller's default when the dock record is malformed", () => {
    const localStorage = memoryStorage();
    localStorage.setItem("octant.shell.utility-dock.window-a.v1", "not json");

    expect(readUtilityDockPresentation({ localStorage }, "window-a", true).open).toBe(true);
  });

  it("uses the caller's default when the persisted open value is invalid", () => {
    const localStorage = memoryStorage();
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({ open: "yes", threads: {} }),
    );

    expect(readUtilityDockPresentation({ localStorage }, "window-a", true).open).toBe(true);
  });

  it("keeps the dock closed once a window has closed it", () => {
    const localStorage = memoryStorage();
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: false,
      threads: new Map(),
    });

    expect(readUtilityDockPresentation({ localStorage }, "window-a").open).toBe(false);
  });

  it("drops unknown dock surfaces and keeps the remaining selected tool", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("work", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: {
          [key]: { tabs: ["browser", "not-a-tool", "changes"], active: "not-a-tool" },
        },
      }),
    );

    expect(
      bare(
        threadUtilityDockState(
          readUtilityDockPresentation({ localStorage }, "window-a").threads,
          key,
        ),
      ),
    ).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "review", surface: "review" },
      ],
      active: "review",
    });
  });

  it("restores a window's bottom-panel tools for the same thread", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    const states = openThreadUtilityTab(new Map(), key, "terminal");
    writeBottomPanelToolPresentation({ localStorage }, "window-a", states);
    expect(
      bare(
        threadUtilityDockState(readBottomPanelToolPresentation({ localStorage }, "window-a"), key),
      ),
    ).toEqual({
      tabs: [{ id: "terminal", surface: "terminal" }],
      active: "terminal",
    });
    expect(readBottomPanelToolPresentation({ localStorage }, "window-b")).toEqual(new Map());
  });
});

describe("dock tool tiles", () => {
  const surfaces = ["ios-simulator", "browser", "canvas", "files", "plan"] as const;
  function opened(...ids: ReadonlyArray<(typeof surfaces)[number] | "terminal">) {
    let state: ThreadUtilityDockState = { tabs: [] };
    for (const id of ids) state = openUtilityTabState(state, id);
    return state;
  }
  function columnsOf(state: ThreadUtilityDockState): ReadonlyArray<ReadonlyArray<string>> {
    return (state.layout?.columns ?? []).map((column) => column.tiles.map((tile) => tile.tabId));
  }
  /** Plan on the left; Files above Canvas on the right; Canvas focused. */
  function twoColumns() {
    let state = opened("ios-simulator", "canvas", "files", "plan");
    state = showUtilityTabBeside(state, "files");
    state = selectUtilityTabState(state, "plan");
    return showUtilityTabBeside(state, "canvas");
  }
  /** Files and Plan stacked on the right, Canvas on the left; Plan focused. */
  function twoColumnsForMoves() {
    let state = opened("canvas", "files", "plan");
    state = showUtilityTabBeside(selectUtilityTabState(state, "canvas"), "files");
    state = selectUtilityTabState(state, "files");
    return showUtilityTabBelow(state, "plan");
  }
  function sharesAddUp(state: ThreadUtilityDockState) {
    const columns = state.layout?.columns ?? [];
    expect(columns.reduce((sum, column) => sum + column.share, 0)).toBeCloseTo(1);
    for (const column of columns) {
      expect(column.tiles.reduce((sum, tile) => sum + tile.share, 0)).toBeCloseTo(1);
    }
  }

  it("keeps the single-tool view when no tool is shown beside another", () => {
    const state = opened("ios-simulator", "canvas");
    expect(state.layout).toBeUndefined();
    expect(shownUtilityTabIds(state)).toEqual(["canvas"]);
    expect(shownUtilityTabIds({ tabs: [] })).toEqual([]);
  });

  it("shows a tab beside the focused tile and focuses it", () => {
    const state = showUtilityTabBeside(opened("ios-simulator", "canvas"), "ios-simulator");
    expect(columnsOf(state)).toEqual([["canvas"], ["ios-simulator"]]);
    expect(state.active).toBe("ios-simulator");
    expect(shownUtilityTabIds(state)).toEqual(["canvas", "ios-simulator"]);
    sharesAddUp(state);
  });

  it("shows a tab below the focused tile in its column", () => {
    const state = showUtilityTabBelow(opened("ios-simulator", "canvas"), "ios-simulator");
    expect(columnsOf(state)).toEqual([["canvas", "ios-simulator"]]);
    sharesAddUp(state);
  });

  it("puts a tab shown beside with two columns below in the last column", () => {
    const state = twoColumns();
    expect(columnsOf(state)).toEqual([["plan"], ["files", "canvas"]]);
    expect(state.active).toBe("canvas");
    sharesAddUp(state);
  });

  it("refuses a tile past the caps and returns the same state", () => {
    let state = opened("ios-simulator", "canvas", "files", "plan", "terminal");
    state = showUtilityTabBelow(state, "files");
    state = showUtilityTabBelow(state, "plan");
    expect(columnsOf(state)).toEqual([["terminal", "files", "plan"]]);
    const before = state;
    expect(showUtilityTabBelow(state, "canvas")).toBe(before);
    expect(showUtilityTabBelow(state, "ios-simulator")).toBe(before);
  });

  it("moves a tab that is already shown rather than showing it twice", () => {
    let state = showUtilityTabBeside(opened("ios-simulator", "canvas", "files"), "ios-simulator");
    state = selectUtilityTabState(state, "files");
    state = showUtilityTabBelow(state, "ios-simulator");
    expect(columnsOf(state)).toEqual([["files", "ios-simulator"]]);
    expect(state.active).toBe("ios-simulator");
    sharesAddUp(state);
  });

  it("shows one Browser tile whose page is whichever Browser tab was chosen", () => {
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state = openUtilityTabState({ tabs: [] }, "ios-simulator");
    state = openUtilityTabState(state, "browser");
    state = showUtilityTabBeside(state, "ios-simulator");
    state = addUtilityTabState(state, "browser", pageTwo);
    expect(columnsOf(state).flat()).toEqual([pageTwo, "ios-simulator"]);
    expect(state.active).toBe(pageTwo);
    state = selectUtilityTabState(state, "ios-simulator");
    state = selectUtilityTabState(state, "browser");
    expect(columnsOf(state).flat()).toEqual(["browser", "ios-simulator"]);
    expect(columnsOf(showUtilityTabBeside(state, pageTwo)).flat()).toEqual([
      pageTwo,
      "ios-simulator",
    ]);
  });

  it("replaces only the focused tile when a hidden tab is chosen", () => {
    let state = showUtilityTabBeside(
      opened("ios-simulator", "canvas", "files", "plan"),
      "ios-simulator",
    );
    expect(columnsOf(state)).toEqual([["plan"], ["ios-simulator"]]);
    state = selectUtilityTabState(state, "canvas");
    expect(columnsOf(state)).toEqual([["plan"], ["canvas"]]);
    expect(state.active).toBe("canvas");
    state = selectUtilityTabState(state, "plan");
    expect(columnsOf(state)).toEqual([["plan"], ["canvas"]]);
    expect(state.active).toBe("plan");
  });

  it("hides a tile without closing its tool and drops a layout left with one tile", () => {
    const tiled = showUtilityTabBeside(opened("ios-simulator", "canvas"), "ios-simulator");
    const hidden = hideUtilityTile(tiled, "ios-simulator");
    expect(hidden.layout).toBeUndefined();
    expect(hidden.tabs.map((tab) => tab.id)).toEqual(["ios-simulator", "canvas"]);
    expect(hidden.active).toBe("canvas");
  });

  it("moves focus to a neighbouring tile when the focused tile is hidden", () => {
    const hidden = hideUtilityTile(twoColumns(), "canvas");
    expect(columnsOf(hidden)).toEqual([["plan"], ["files"]]);
    expect(hidden.active).toBe("files");
    expect(hidden.tabs).toHaveLength(4);
    sharesAddUp(hidden);
  });

  it("shows one tool alone and keeps every other tab open", () => {
    const tiled = showUtilityTabBeside(opened("ios-simulator", "canvas"), "ios-simulator");
    const alone = showUtilityTabAlone(tiled, "canvas");
    expect(alone.layout).toBeUndefined();
    expect(alone.active).toBe("canvas");
    expect(alone.tabs).toHaveLength(2);
  });

  it("removes a closed tool's tile and focuses its neighbour", () => {
    const tiled = showUtilityTabBeside(opened("ios-simulator", "canvas"), "ios-simulator");
    const closed = closeUtilityTabState(tiled, "ios-simulator");
    expect(closed).toEqual({ tabs: [{ id: "canvas", surface: "canvas" }], active: "canvas" });
  });

  it("prunes tiles of tools another region took or that are no longer available", () => {
    const tiled = showUtilityTabBeside(opened("ios-simulator", "canvas", "files"), "ios-simulator");
    expect(removeUtilityTabs(tiled, new Set(["canvas"])).layout).toEqual(tiled.layout);
    const moved = removeUtilityTabs(tiled, new Set(["files"]));
    expect(moved.layout).toBeUndefined();
    expect(moved.active).toBe("ios-simulator");
    const retained = retainAvailableUtilityTabs(tiled, new Set(["canvas", "files"]));
    expect(retained.layout).toBeUndefined();
    expect(retained.active).toBe("files");
  });

  it("resizes columns and tiles with every share above the floor and adding up", () => {
    const state = twoColumns();
    const wide = resizeUtilityTileColumns(state, [9, 1]);
    expect(wide.layout?.columns.map((column) => column.share)).toEqual([0.85, 0.15]);
    const tall = resizeUtilityTileColumn(state, 1, [3, 1]);
    expect(tall.layout?.columns[1]?.tiles.map((tile) => tile.share)).toEqual([0.75, 0.25]);
    expect(resizeUtilityTileColumns(state, [1, Number.NaN])).toBe(state);
    expect(resizeUtilityTileColumns(state, [1])).toBe(state);
    sharesAddUp(wide);
    sharesAddUp(tall);
  });

  it("never lets a layout reach the bottom panel", () => {
    const tiled = showUtilityTabBeside(opened("ios-simulator", "canvas"), "ios-simulator");
    expect(withoutTileLayout(tiled)).toEqual({ tabs: tiled.tabs, active: "ios-simulator" });
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    writeBottomPanelToolPresentation({ localStorage }, "window-a", new Map([[key, tiled]]));
    const read = threadUtilityDockState(
      readBottomPanelToolPresentation({ localStorage }, "window-a"),
      key,
    );
    expect(read.layout).toBeUndefined();
    expect(read.tabs).toHaveLength(2);
  });

  it("keeps the tile layout through a stored round trip", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    let state = showUtilityTabBeside(opened("ios-simulator", "canvas", "files"), "ios-simulator");
    state = showUtilityTabBelow(state, "files");
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: true,
      threads: new Map([[key, state]]),
    });
    const read = readUtilityDockPresentation({ localStorage }, "window-a").threads;
    expect(threadUtilityDockState(read, key)).toEqual(state);
  });

  it("reads an old record without a layout exactly as before", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: { [key]: { tabs: ["canvas", "files"], active: "canvas" } },
      }),
    );
    expect(
      threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
      ),
    ).toEqual({
      tabs: [
        { id: "canvas", surface: "canvas" },
        { id: "files", surface: "files" },
      ],
      active: "canvas",
    });
  });

  function readStored(layout: unknown, active = "canvas") {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: {
          [key]: {
            tabs: ["canvas", "files", "plan", "ios-simulator"].map((id) => ({ id, surface: id })),
            active,
            layout,
          },
        },
      }),
    );
    return threadUtilityDockState(
      readUtilityDockPresentation({ localStorage }, "window-a").threads,
      key,
    );
  }

  it("drops stored layout entries that are unknown, repeated or past the caps", () => {
    const state = readStored({
      columns: [
        {
          share: 1,
          tiles: [
            { tabId: "canvas", share: 1 },
            { tabId: "canvas", share: 1 },
            { tabId: "ghost", share: 1 },
            { tabId: "files", share: 1 },
            { tabId: "plan", share: 1 },
            { tabId: "ios-simulator", share: 1 },
          ],
        },
        { share: 1, tiles: [] },
        { share: 1, tiles: [{ tabId: "plan", share: 1 }] },
      ],
    });
    expect(columnsOf(state)).toEqual([["canvas", "files", "plan"]]);
  });

  it("normalises stored shares that are not positive numbers", () => {
    const state = readStored({
      columns: [
        { share: -1, tiles: [{ tabId: "canvas", share: "wide" }] },
        { share: Number.NaN, tiles: [{ tabId: "files", share: 0 }] },
      ],
    });
    expect(state.layout?.columns.map((column) => column.share)).toEqual([0.5, 0.5]);
    expect(state.layout?.columns.map((column) => column.tiles[0]?.share)).toEqual([1, 1]);
  });

  it("drops a stored layout that is left with fewer than two tiles", () => {
    const state = readStored({ columns: [{ share: 1, tiles: [{ tabId: "canvas", share: 1 }] }] });
    expect(state.layout).toBeUndefined();
    expect(state.active).toBe("canvas");
    expect(readStored("nonsense").layout).toBeUndefined();
  });

  it("focuses a shown tile when the stored active tab is not shown", () => {
    const state = readStored(
      {
        columns: [
          { share: 1, tiles: [{ tabId: "canvas", share: 1 }] },
          { share: 1, tiles: [{ tabId: "files", share: 1 }] },
        ],
      },
      "plan",
    );
    expect(state.active).toBe("canvas");
  });

  it("keeps one Browser tile when a Browser page is shown beside another with no layout yet", () => {
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = selectUtilityTabState(state, pageOne);
    const beside = showUtilityTabBeside(state, pageTwo);
    expect(beside.layout).toBeUndefined();
    expect(beside.active).toBe(pageTwo);
  });

  it("opens a tool and shows it beside the focused tile in one state", () => {
    const state = openUtilityTabBesideState(opened("files"), "canvas", "unused");
    expect(columnsOf(state)).toEqual([["files"], ["canvas"]]);
    expect(state.active).toBe("canvas");
    expect(state.tabs.map((tab) => tab.id)).toEqual(["files", "canvas"]);
    const terminal = openUtilityTabBesideState(
      state,
      "terminal",
      "10000000-0000-4000-8000-000000000003",
    );
    expect(terminal.tabs.at(-1)).toEqual({
      id: "10000000-0000-4000-8000-000000000003",
      surface: "terminal",
    });
    expect(columnsOf(terminal)).toEqual([
      ["files"],
      ["canvas", "10000000-0000-4000-8000-000000000003"],
    ]);
  });

  it("selects and closes tabs on the tools on screen when the bottom panel holds the focused tile's tool", () => {
    // Terminal | Files with Terminal focused, Review open but hidden; the panel takes Terminal.
    const stored = showUtilityTabBeside(
      selectUtilityTabState(opened("files", "terminal", "plan"), "files"),
      "terminal",
    );
    expect(columnsOf(stored).flat().sort()).toEqual(["files", "terminal"]);
    const panel = new Set<"terminal">(["terminal"]);
    const displayed = removeUtilityTabs(stored, panel);
    expect(shownUtilityTabIds(displayed)).toEqual(["files"]);

    const selected = changeDisplayedUtilityState(stored, displayed, (state) =>
      selectUtilityTabState(state, "plan"),
    );
    expect(shownUtilityTabIds(removeUtilityTabs(selected, panel))).toEqual(["plan"]);

    const closed = changeDisplayedUtilityState(stored, displayed, (state) =>
      closeUtilityTabState(state, "files"),
    );
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["terminal", "plan"]);
  });

  it("remembers the Browser page last shown and forgets it when that page closes", () => {
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = openUtilityTabState(state, "files");
    expect(state.lastBrowser).toBe(pageTwo);
    state = selectUtilityTabState(state, pageOne);
    expect(state.lastBrowser).toBe(pageOne);
    state = selectUtilityTabState(state, pageTwo);
    state = showUtilityTabAlone(selectUtilityTabState(state, "files"), "files");
    expect(state.lastBrowser).toBe(pageTwo);
    expect(closeUtilityTabState(state, pageTwo).lastBrowser).toBeUndefined();
    expect(closeUtilityTabState(state, pageOne).lastBrowser).toBe(pageTwo);
  });

  it("keeps the remembered Browser page through a stored round trip and drops one that is gone", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    const pageOne = "10000000-0000-4000-8000-000000000001";
    const pageTwo = "10000000-0000-4000-8000-000000000002";
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = openUtilityTabState(state, "files");
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: true,
      threads: new Map([[key, state]]),
    });
    const read = (value: unknown) => {
      localStorage.setItem(
        "octant.shell.utility-dock.window-a.v1",
        JSON.stringify({ open: true, threads: { [key]: value } }),
      );
      return threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
      );
    };
    writeUtilityDockPresentation({ localStorage }, "window-b", {
      open: true,
      threads: new Map([[key, state]]),
    });
    expect(
      threadUtilityDockState(readUtilityDockPresentation({ localStorage }, "window-b").threads, key)
        .lastBrowser,
    ).toBe(pageTwo);
    expect(
      read({ tabs: ["files"], active: "files", lastBrowser: "files" }).lastBrowser,
    ).toBeUndefined();
    expect(read({ tabs: ["files"], active: "files", lastBrowser: 7 }).lastBrowser).toBeUndefined();
  });

  it("moves a tile up and down within its column, keeping each tile's share", () => {
    let state = showUtilityTabBelow(opened("files", "canvas", "plan"), "files");
    state = showUtilityTabBelow(selectUtilityTabState(state, "plan"), "canvas");
    expect(columnsOf(state)).toEqual([["plan", "canvas", "files"]]);
    expect(columnsOf(moveUtilityTile(state, "canvas", "up"))).toEqual([
      ["canvas", "plan", "files"],
    ]);
    expect(columnsOf(moveUtilityTile(state, "canvas", "down"))).toEqual([
      ["plan", "files", "canvas"],
    ]);
    expect(moveUtilityTile(state, "plan", "up")).toBe(state);
    expect(moveUtilityTile(state, "files", "down")).toBe(state);
  });

  it("moves a tile to the other column, or makes the second column from a one-column layout", () => {
    const two = showUtilityTabBelow(opened("files", "canvas"), "files");
    expect(columnsOf(moveUtilityTile(two, "files", "right"))).toEqual([["canvas"], ["files"]]);
    // The second column is an even split, as showing a tool beside makes it.
    expect(
      moveUtilityTile(two, "files", "right").layout?.columns.map((column) => column.share),
    ).toEqual([0.5, 0.5]);
    expect(
      moveUtilityTile(two, "files", "left").layout?.columns.map((column) => column.share),
    ).toEqual([0.5, 0.5]);
    expect(columnsOf(moveUtilityTile(two, "files", "left"))).toEqual([["files"], ["canvas"]]);
    sharesAddUp(moveUtilityTile(two, "files", "right"));
    const sided = twoColumnsForMoves();
    expect(columnsOf(moveUtilityTile(sided, "files", "left"))).toEqual([
      ["files", "canvas"],
      ["plan"],
    ]);
    expect(moveUtilityTile(sided, "plan", "right")).toBe(sided);
    expect(moveUtilityTile(sided, "files", "up")).toBe(sided);
  });

  it("collapses to one column when the only tile of a column moves across", () => {
    const sided = showUtilityTabBeside(opened("files", "canvas"), "files");
    expect(columnsOf(sided)).toEqual([["canvas"], ["files"]]);
    const moved = moveUtilityTile(sided, "files", "left");
    expect(columnsOf(moved)).toEqual([["files", "canvas"]]);
    expect(moved.layout?.columns).toHaveLength(1);
    // A single tile in a one-column layout has nowhere to go sideways.
    expect(
      moveUtilityTile(hideUtilityTile(sided, "files"), "canvas", "right").layout,
    ).toBeUndefined();
  });

  it("refuses a move into a full column, and moves the Browser tile like any other", () => {
    let full = opened("ios-simulator", "canvas", "files", "plan");
    full = showUtilityTabBelow(full, "files");
    full = showUtilityTabBelow(full, "canvas");
    full = showUtilityTabBeside(full, "ios-simulator");
    expect(columnsOf(full)[0]).toHaveLength(3);
    expect(columnsOf(full)[1]).toEqual(["ios-simulator"]);
    // The right column holds one, the left three: a move left is refused.
    expect(moveUtilityTile(full, "ios-simulator", "left")).toBe(full);
    const pageId = "10000000-0000-4000-8000-000000000001";
    const withBrowser = showUtilityTabBeside(
      addUtilityTabState(opened("files"), "browser", pageId),
      "files",
    );
    const moved = moveUtilityTile(withBrowser, pageId, "right");
    // Its column had nothing else, so moving across joins the other and one column remains.
    expect(columnsOf(moved)).toEqual([[pageId, "files"]]);
    expect(moved.lastBrowser).toBe(pageId);
    expect(columnsOf(moveUtilityTile(moved, pageId, "down"))).toEqual([["files", pageId]]);
  });

  it("counts the columns a state shows", () => {
    expect(shownTileColumns(opened("files"))).toBe(1);
    expect(shownTileColumns(showUtilityTabBeside(opened("files", "canvas"), "files"))).toBe(2);
  });

  it("applies tile changes to the tiles on screen when the bottom panel holds one of them", () => {
    // Plan, Terminal and Files in one column; the panel holds Terminal.
    let stored = showUtilityTabBelow(opened("plan", "terminal", "files"), "plan");
    stored = showUtilityTabBelow(selectUtilityTabState(stored, "files"), "terminal");
    expect(columnsOf(stored)).toEqual([["files", "terminal", "plan"]]);
    const displayed = removeUtilityTabs(stored, new Set(["terminal"]));
    expect(columnsOf(displayed)).toEqual([["files", "plan"]]);

    const resized = changeDisplayedUtilityState(stored, displayed, (state) =>
      resizeUtilityTileColumn(state, 0, [3, 1]),
    );
    expect(resized.layout?.columns[0]?.tiles.map((tile) => tile.share)).toEqual([0.75, 0.25]);
    expect(resized.tabs.map((tab) => tab.id)).toEqual(stored.tabs.map((tab) => tab.id));

    // The hidden tile no longer takes a slot: a third displayed tile fits.
    const added = changeDisplayedUtilityState(
      opened("plan", "terminal", "files", "canvas"),
      removeUtilityTabs(opened("plan", "terminal", "files", "canvas"), new Set(["terminal"])),
      (state) => showUtilityTabBelow(state, "plan"),
    );
    expect(columnsOf(added).flat()).toContain("plan");
    expect(changeDisplayedUtilityState(stored, displayed, (state) => state)).toBe(stored);
  });
});

describe("minimised dock tools", () => {
  const pageOne = "10000000-0000-4000-8000-000000000001";
  const pageTwo = "10000000-0000-4000-8000-000000000002";
  const shellTab = "10000000-0000-4000-8000-000000000003";
  function opened(...ids: ReadonlyArray<"browser" | "terminal" | "files" | "canvas" | "plan">) {
    let state: ThreadUtilityDockState = { tabs: [] };
    for (const id of ids) state = openUtilityTabState(state, id);
    return state;
  }
  function columnsOf(state: ThreadUtilityDockState): ReadonlyArray<ReadonlyArray<string>> {
    return (state.layout?.columns ?? []).map((column) => column.tiles.map((tile) => tile.tabId));
  }
  /** The invariants every state must keep, whatever function produced it. */
  function holdsInvariants(state: ThreadUtilityDockState) {
    const cards = minimisedUtilityTabIds(state);
    const open = state.tabs.map((tab) => tab.id);
    expect(new Set(cards).size).toBe(cards.length);
    for (const id of cards) {
      expect(open).toContain(id);
      expect(shownUtilityTabIds(state)).not.toContain(id);
      expect(state.active).not.toBe(id);
      const surface = state.tabs.find((tab) => tab.id === id)?.surface;
      expect(surface !== undefined && MINIMISABLE_DOCK_SURFACES.has(surface)).toBe(true);
      // A tool is a card whole.
      for (const tab of state.tabs.filter((candidate) => candidate.surface === surface)) {
        expect(cards).toContain(tab.id);
      }
    }
  }

  it("minimises only the Browser and the Terminal", () => {
    const state = opened("files", "browser");
    expect(minimiseUtilityTool(state, "files")).toBe(state);
    expect(minimiseUtilityTool(state, "missing")).toBe(state);
    expect([...MINIMISABLE_DOCK_SURFACES].sort()).toEqual(["browser", "terminal"]);
  });

  it("brings the overview back when the only shown tool is minimised and keeps the other tabs open", () => {
    const state = minimiseUtilityTool(opened("files", "browser"), "browser");
    expect(state.active).toBeUndefined();
    expect(shownUtilityTabIds(state)).toEqual([]);
    expect(state.tabs.map((tab) => tab.id)).toEqual(["files", "browser"]);
    expect(minimisedUtilityTabIds(state)).toEqual(["browser"]);
    holdsInvariants(state);
  });

  it("leaves the other tile when one of two shown tools is minimised, and focus follows", () => {
    let state = showUtilityTabBeside(opened("canvas", "browser", "terminal"), "browser");
    state = selectUtilityTabState(state, "browser");
    expect(columnsOf(state)).toHaveLength(2);
    const minimised = minimiseUtilityTool(state, "browser");
    expect(minimised.layout).toBeUndefined();
    expect(shownUtilityTabIds(minimised)).toEqual(["terminal"]);
    expect(minimised.active).toBe("terminal");
    expect(minimisedUtilityTabIds(minimised)).toEqual(["browser"]);
    holdsInvariants(minimised);
  });

  it("keeps a layout of the remaining tiles when one of three is minimised", () => {
    let state = opened("canvas", "browser", "terminal", "files");
    state = showUtilityTabBeside(state, "browser");
    state = showUtilityTabBelow(state, "canvas");
    expect(shownUtilityTabIds(state)).toHaveLength(3);
    const minimised = minimiseUtilityTool(state, "browser");
    expect(shownUtilityTabIds(minimised)).toHaveLength(2);
    expect(minimised.layout).toBeDefined();
    holdsInvariants(minimised);
  });

  it("minimises every page of the Browser and every Terminal of the thread together", () => {
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = addUtilityTabState(state, "terminal", shellTab);
    state = addUtilityTabState(state, "files", "files-id");
    const minimised = minimiseUtilityTool(state, pageTwo);
    expect(minimisedUtilityTabIds(minimised)).toEqual([pageOne, pageTwo]);
    expect(minimiseUtilityTool(minimised, pageOne)).toBe(minimised);
    holdsInvariants(minimised);
    const both = minimiseUtilityTool(minimised, shellTab);
    expect(minimisedUtilityTabIds(both)).toEqual([pageOne, pageTwo, shellTab]);
    holdsInvariants(both);
  });

  it("takes a card away without showing or closing its tool", () => {
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    state = openUtilityTabState(state, "files");
    const parked = minimiseUtilityTool(state, pageOne);
    const hidden = hideUtilityCard(parked, pageTwo);
    expect(hidden.minimised).toBeUndefined();
    expect(hidden.tabs).toEqual(state.tabs);
    expect(hidden.active).toBe(state.active);
    expect(shownUtilityTabIds(hidden)).toEqual(["files"]);
    holdsInvariants(hidden);
    expect(hideUtilityCard(hidden, pageOne)).toBe(hidden);
    expect(hideUtilityCard(state, "files")).toBe(state);

    // With nothing shown the overview stays, and the tool waits in the strip.
    const overview = minimiseUtilityTool(opened("files", "terminal"), "terminal");
    const away = hideUtilityCard(overview, "terminal");
    expect(away.active).toBeUndefined();
    expect(away.tabs.map((tab) => tab.id)).toEqual(["files", "terminal"]);
    expect(away.minimised).toBeUndefined();
  });

  it("says whether the person has a tool minimised, which a newly announced session must leave alone", () => {
    const state = minimiseUtilityTool(opened("files", "browser"), "browser");
    expect(isUtilityToolMinimised(state, "browser")).toBe(true);
    expect(isUtilityToolMinimised(state, "terminal")).toBe(false);
    expect(isUtilityToolMinimised(restoreUtilityTool(state, "browser"), "browser")).toBe(false);
  });

  it("remembers the Browser page last shown through a minimise", () => {
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    const parked = minimiseUtilityTool(state, pageTwo);
    expect(parked.lastBrowser).toBe(pageTwo);
    expect(restoreUtilityTool(parked, parked.lastBrowser ?? pageOne).active).toBe(pageTwo);
  });

  it("restores a tool as the one tool shown when nothing else is shown", () => {
    const alone = minimiseUtilityTool(opened("files", "browser"), "browser");
    const restoredAlone = restoreUtilityTool(alone, "browser");
    expect(restoredAlone.active).toBe("browser");
    expect(minimisedUtilityTabIds(restoredAlone)).toEqual([]);
    expect(restoredAlone.minimised).toBeUndefined();
    expect(restoreUtilityTool(restoredAlone, "browser")).toBe(restoredAlone);
  });

  it("restores a tool to the place it was minimised from without taking a shown tool's tile", () => {
    // Browser left, Files right and focused; Canvas open but hidden.
    let state = showUtilityTabBeside(opened("canvas", "files", "browser"), "files");
    state = showUtilityTabBeside(selectUtilityTabState(state, "browser"), "files");
    expect(columnsOf(state)).toEqual([["browser"], ["files"]]);
    const parked = minimiseUtilityTool(state, "browser");
    expect(parked.minimisedPlaces).toEqual([
      { surface: "browser", column: 0, row: 0, alone: true },
    ]);
    const back = restoreUtilityTool(parked, "browser");
    expect(columnsOf(back)).toEqual([["browser"], ["files"]]);
    expect(back.active).toBe("browser");
    expect(back.minimised).toBeUndefined();
    expect(back.minimisedPlaces).toBeUndefined();
    holdsInvariants(back);
  });

  it("restores a tool to its row in a column it shared while that column has room", () => {
    const stacked = showUtilityTabBelow(
      showUtilityTabBelow(opened("canvas", "browser", "files", "plan"), "files"),
      "browser",
    );
    const before = columnsOf(stacked);
    expect(before).toHaveLength(1);
    expect(before[0]).toHaveLength(3);
    const state = selectUtilityTabState(stacked, before[0]?.[0] ?? "");
    const parked = minimiseUtilityTool(state, "files");
    expect(columnsOf(restoreUtilityTool(parked, "files"))).toEqual(before);
  });

  it("restores a tool as the last tile when the place it stood in is gone", () => {
    const parked = minimiseUtilityTool(
      showUtilityTabBeside(opened("terminal", "files"), "terminal"),
      "terminal",
    );
    const gone: ThreadUtilityDockState = {
      ...parked,
      minimisedPlaces: [{ surface: "terminal", column: 1, row: 2, alone: false }],
    };
    const back = restoreUtilityTool(gone, "terminal");
    expect(columnsOf(back)).toEqual([["files"], ["terminal"]]);
    expect(back.active).toBe("terminal");
    holdsInvariants(back);
  });

  it("restores a tool as a new column when the single tool shown leaves room beside it", () => {
    const state = showUtilityTabBeside(opened("browser", "files"), "browser");
    const parked = minimiseUtilityTool(state, "browser");
    expect(shownUtilityTabIds(parked)).toEqual(["files"]);
    const back = restoreUtilityTool(parked, "browser");
    expect(columnsOf(back)).toEqual([["files"], ["browser"]]);
  });

  it("remembers no place for a tool that was the one shown, and puts it beside whatever is shown later", () => {
    const parked = minimiseUtilityTool(opened("files", "terminal"), "terminal");
    expect(parked.minimisedPlaces).toBeUndefined();
    const other = selectUtilityTabState(parked, "files");
    expect(columnsOf(restoreUtilityTool(other, "terminal"))).toEqual([["files"], ["terminal"]]);
  });

  it("forgets where a tool stood when its card is hidden or the tool is shown again another way", () => {
    const state = showUtilityTabBeside(opened("browser", "files"), "browser");
    const parked = minimiseUtilityTool(state, "browser");
    expect(hideUtilityCard(parked, "browser").minimisedPlaces).toBeUndefined();
    expect(showUtilityTabAlone(parked, "browser").minimisedPlaces).toBeUndefined();
  });

  it("keeps a remembered place through a stored round trip and drops one that is invalid or has no card", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    const parked = minimiseUtilityTool(
      showUtilityTabBeside(opened("browser", "files"), "browser"),
      "browser",
    );
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: true,
      threads: new Map([[key, parked]]),
    });
    const read = (state: unknown) => {
      localStorage.setItem(
        "octant.shell.utility-dock.window-a.v1",
        JSON.stringify({ open: true, threads: { [key]: state } }),
      );
      return threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
      );
    };
    const stored = JSON.parse(localStorage.getItem("octant.shell.utility-dock.window-a.v1") ?? "{}")
      .threads[key];
    expect(read(stored)).toEqual(parked);
    const place = (column: unknown, row: unknown, surface = "browser") => ({
      ...stored,
      minimisedPlaces: [{ surface, column, row, alone: true }],
    });
    expect(read(place(5, 0)).minimisedPlaces).toBeUndefined();
    expect(read(place(0, 1.5)).minimisedPlaces).toBeUndefined();
    expect(read(place(0, 0, "files")).minimisedPlaces).toBeUndefined();
    expect(read({ ...stored, minimised: undefined }).minimisedPlaces).toBeUndefined();
  });

  it("leaves a minimised Browser minimised for an agent's session only where the shelf is drawn", () => {
    const parked = minimiseUtilityTool(opened("files", "browser"), "browser");
    expect(offeredBrowserStaysMinimised(parked, { offered: true, shelfDrawn: true })).toBe(true);
    // The narrow window's modal dock has no shelf and no dot: the session opens the Browser.
    expect(offeredBrowserStaysMinimised(parked, { offered: true, shelfDrawn: false })).toBe(false);
    // What the person asked for restores it anywhere.
    expect(offeredBrowserStaysMinimised(parked, { offered: false, shelfDrawn: true })).toBe(false);
    expect(
      offeredBrowserStaysMinimised(opened("files", "browser"), { offered: true, shelfDrawn: true }),
    ).toBe(false);
    const opening = openUtilityTabState(parked, "browser");
    expect(opening.active).toBe("browser");
    expect(opening.minimised).toBeUndefined();
  });

  it("restores every page of a minimised Browser when any of its tabs is selected or opened", () => {
    let state: ThreadUtilityDockState = { tabs: [] };
    state = addUtilityTabState(state, "browser", pageOne);
    state = addUtilityTabState(state, "browser", pageTwo);
    const minimised = minimiseUtilityTool(state, pageOne);
    expect(selectUtilityTabState(minimised, pageTwo).minimised).toBeUndefined();
    expect(selectUtilityTabState(minimised, pageTwo).active).toBe(pageTwo);
    const another = addUtilityTabState(
      minimised,
      "browser",
      "10000000-0000-4000-8000-000000000009",
    );
    expect(another.minimised).toBeUndefined();
    expect(openUtilityTabState(minimised, "browser").minimised).toBeUndefined();
  });

  it("restores a minimised tool when it is shown beside, below or alone", () => {
    let state = minimiseUtilityTool(opened("files", "canvas", "browser"), "browser");
    state = selectUtilityTabState(state, "files");
    for (const show of [showUtilityTabBeside, showUtilityTabBelow, showUtilityTabAlone]) {
      const shown = show(state, "browser");
      expect(shown.minimised).toBeUndefined();
      expect(shownUtilityTabIds(shown)).toContain("browser");
      holdsInvariants(shown);
    }
  });

  it("restores a tool opened beside while a card stands for its tool", () => {
    const state = minimiseUtilityTool(opened("files", "terminal"), "terminal");
    const next = openUtilityTabBesideState(
      selectUtilityTabState(state, "files"),
      "terminal",
      shellTab,
    );
    expect(next.minimised).toBeUndefined();
    expect(shownUtilityTabIds(next)).toContain(shellTab);
    holdsInvariants(next);
  });

  it("closing a card's tab removes it, and the remaining tabs keep the overview", () => {
    const parked = minimiseUtilityTool(opened("files", "terminal", "browser"), "browser");
    expect(parked.active).toBeUndefined();
    const closed = closeUtilityTabState(parked, "browser");
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["files", "terminal"]);
    expect(closed.minimised).toBeUndefined();
    expect(closed.active).toBeUndefined();
    holdsInvariants(closed);
  });

  it("closing the shown tool moves to a tab that is not a card", () => {
    // Browser (card), Files shown, Canvas: closing Files must not pick the card.
    let state = opened("browser", "files", "canvas");
    state = minimiseUtilityTool(selectUtilityTabState(state, "browser"), "browser");
    state = selectUtilityTabState(state, "files");
    const closed = closeUtilityTabState(state, "files");
    expect(closed.active).toBe("canvas");
    holdsInvariants(closed);
    const onlyCard = closeUtilityTabState(closeUtilityTabState(state, "files"), "canvas");
    expect(onlyCard.active).toBeUndefined();
    expect(minimisedUtilityTabIds(onlyCard)).toEqual(["browser"]);
  });

  it("keeps the invariants when tools are removed, retained or hidden", () => {
    let state = showUtilityTabBeside(opened("canvas", "browser", "terminal", "files"), "terminal");
    state = minimiseUtilityTool(state, "browser");
    holdsInvariants(removeUtilityTabs(state, new Set(["files"])));
    const withoutShell = removeUtilityTabs(state, new Set(["terminal"]));
    expect(withoutShell.tabs.map((tab) => tab.surface)).not.toContain("terminal");
    expect(minimisedUtilityTabIds(withoutShell)).toEqual(["browser"]);
    holdsInvariants(retainAvailableUtilityTabs(state, new Set(["canvas", "files", "terminal"])));
    expect(
      retainAvailableUtilityTabs(state, new Set(["canvas", "files", "terminal"])).minimised,
    ).toBeUndefined();
    holdsInvariants(hideUtilityTile(state, "terminal"));
  });

  it("keeps a card when the bottom panel holds its tool and a tile change is made on what is shown", () => {
    const stored = minimiseUtilityTool(opened("files", "canvas", "terminal"), "terminal");
    const displayed = removeUtilityTabs(stored, new Set(["terminal"]));
    expect(minimisedUtilityTabIds(displayed)).toEqual([]);
    const changed = changeDisplayedUtilityState(stored, displayed, (state) =>
      showUtilityTabBeside(state, "files"),
    );
    expect(minimisedUtilityTabIds(changed)).toEqual(["terminal"]);
    expect(changed.tabs.map((tab) => tab.id)).toContain("terminal");
    holdsInvariants(changed);
  });

  it("keeps the cards through a stored round trip, the overview included", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    let state = minimiseUtilityTool(opened("files", "browser", "terminal"), "browser");
    state = minimiseUtilityTool(state, "terminal");
    writeUtilityDockPresentation({ localStorage }, "window-a", {
      open: true,
      threads: new Map([[key, state]]),
    });
    const read = threadUtilityDockState(
      readUtilityDockPresentation({ localStorage }, "window-a").threads,
      key,
    );
    expect(read).toEqual(state);
    expect(read.active).toBeUndefined();
  });

  it("reads an old record, with no cards, as before", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: { [key]: { tabs: ["browser", "files"], active: "files" } },
      }),
    );
    expect(
      threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
      ),
    ).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "files", surface: "files" },
      ],
      active: "files",
    });
  });

  it("drops stored cards that are unknown, repeated, not minimisable, or shown", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: {
          [key]: {
            tabs: ["files", "browser", "terminal", "canvas"],
            active: "browser",
            minimised: ["files", "ghost", "terminal", "terminal", 7, { id: "browser" }],
          },
        },
      }),
    );
    const read = threadUtilityDockState(
      readUtilityDockPresentation({ localStorage }, "window-a").threads,
      key,
    );
    expect(minimisedUtilityTabIds(read)).toEqual(["terminal"]);
    expect(read.active).toBe("browser");
    holdsInvariants(read);
  });

  it("never lets a stored card be the active tab or sit in a tile", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    localStorage.setItem(
      "octant.shell.utility-dock.window-a.v1",
      JSON.stringify({
        open: true,
        threads: {
          [key]: {
            tabs: ["files", "browser", "canvas"],
            active: "browser",
            minimised: ["browser"],
            layout: {
              columns: [
                { share: 0.5, tiles: [{ tabId: "files", share: 1 }] },
                {
                  share: 0.5,
                  tiles: [
                    { tabId: "browser", share: 0.5 },
                    { tabId: "canvas", share: 0.5 },
                  ],
                },
              ],
            },
          },
        },
      }),
    );
    const read = threadUtilityDockState(
      readUtilityDockPresentation({ localStorage }, "window-a").threads,
      key,
    );
    holdsInvariants(read);
    expect(shownUtilityTabIds(read)).toEqual(["files", "canvas"]);
  });

  it("never stores or reads a card for the bottom panel", () => {
    const localStorage = memoryStorage();
    const key = threadUtilityDockKey("code", "thread-a");
    const state = minimiseUtilityTool(opened("files", "browser"), "browser");
    writeBottomPanelToolPresentation({ localStorage }, "window-a", new Map([[key, state]]));
    expect(
      JSON.parse(localStorage.getItem("octant.shell.bottom-panel-tools.window-a.v1") ?? "{}"),
    ).not.toHaveProperty("threads.code:thread-a.minimised");
    const read = threadUtilityDockState(
      readBottomPanelToolPresentation({ localStorage }, "window-a"),
      key,
    );
    expect(read.minimised).toBeUndefined();
    expect(withoutTileLayout(state).minimised).toBeUndefined();
  });
});

function memoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  } as unknown as Storage;
}
