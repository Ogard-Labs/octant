import { describe, expect, it } from "vitest";
import {
  closeThreadUtilityTab,
  openThreadUtilityTab,
  readBottomPanelToolPresentation,
  readUtilityDockOpen,
  readUtilityDockPresentation,
  removeUtilityTabs,
  retainAvailableUtilityTabs,
  selectThreadUtilityTab,
  threadUtilityDockState,
  threadUtilityDockKey,
  writeBottomPanelToolPresentation,
  writeUtilityDockPresentation,
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

  it("removes bottom-panel tools from the dock without losing other tabs", () => {
    expect(
      removeUtilityTabs(
        { tabs: ["browser", "terminal", "files"], active: "terminal" },
        new Set(["browser", "terminal"]),
      ),
    ).toEqual({ tabs: ["files"], active: "files" });
  });
});

describe("thread utility presentation persistence", () => {
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
      tabs: ["browser", "terminal"],
      active: "browser",
    });
    expect(threadUtilityDockState(restored.threads, second)).toEqual({
      tabs: ["files"],
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
      tabs: ["browser", "review"],
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
    ).toEqual({ tabs: ["terminal"], active: "terminal" });
    expect(readBottomPanelToolPresentation({ localStorage }, "window-b")).toEqual(new Map());
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
