import { describe, expect, it } from "vitest";
import {
  addThreadUtilityTab,
  addUtilityTabState,
  closeThreadUtilityTab,
  closeUtilityTabState,
  hideUtilityTile,
  openThreadUtilityTab,
  openUtilityTabState,
  readBottomPanelToolPresentation,
  readUtilityDockOpen,
  readUtilityDockPresentation,
  removeUtilityTabs,
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

    expect(state).toEqual({
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

    expect(threadUtilityDockState(states, key)).toEqual({
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
    expect(threadUtilityDockState(states, key)).toEqual({
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

    expect(threadUtilityDockState(states, first)).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "terminal", surface: "terminal" },
      ],
      active: "terminal",
    });
    expect(threadUtilityDockState(states, second)).toEqual({
      tabs: [{ id: "ios-simulator", surface: "ios-simulator" }],
      active: "ios-simulator",
    });

    states = selectThreadUtilityTab(states, first, "browser");
    states = closeThreadUtilityTab(states, first, "browser");
    expect(threadUtilityDockState(states, first)).toEqual({
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
      threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
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
    expect(threadUtilityDockState(restored.threads, first)).toEqual({
      tabs: [
        { id: "browser", surface: "browser" },
        { id: "terminal", surface: "terminal" },
      ],
      active: "browser",
    });
    expect(threadUtilityDockState(restored.threads, second)).toEqual({
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
      threadUtilityDockState(
        readUtilityDockPresentation({ localStorage }, "window-a").threads,
        key,
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
      threadUtilityDockState(readBottomPanelToolPresentation({ localStorage }, "window-a"), key),
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
