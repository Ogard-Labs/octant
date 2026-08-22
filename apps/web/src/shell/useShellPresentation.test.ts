import { describe, expect, it } from "vitest";
import {
  readBottomPanelPresentation,
  readSidebarCollapsed,
  writeBottomPanelPresentation,
  writeSidebarCollapsed,
} from "./useShellPresentation";

describe("sidebar collapsed persistence", () => {
  it("reads and writes the presentation preference without throwing when storage is missing", () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    } as unknown as Storage;

    expect(readSidebarCollapsed({})).toBe(false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
    writeSidebarCollapsed({ localStorage }, true);
    expect(readSidebarCollapsed({ localStorage })).toBe(true);
    writeSidebarCollapsed({ localStorage }, false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
  });
});

describe("bottom panel persistence", () => {
  it("keeps presentation state per window and clamps restored height", () => {
    const storage = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    } as unknown as Storage;

    expect(readBottomPanelPresentation({ localStorage }, "window-a")).toEqual({
      open: false,
      height: 260,
    });
    writeBottomPanelPresentation({ localStorage }, "window-a", { open: true, height: 340 });
    expect(readBottomPanelPresentation({ localStorage }, "window-a")).toEqual({
      open: true,
      height: 340,
    });
    expect(readBottomPanelPresentation({ localStorage }, "window-b")).toEqual({
      open: false,
      height: 260,
    });

    writeBottomPanelPresentation({ localStorage }, "window-a", { open: true, height: 9_000 });
    expect(readBottomPanelPresentation({ localStorage }, "window-a").height).toBe(640);
  });
});
