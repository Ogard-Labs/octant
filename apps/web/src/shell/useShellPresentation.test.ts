import { describe, expect, it } from "vitest";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./useShellPresentation";

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
    } as Storage;

    expect(readSidebarCollapsed({})).toBe(false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
    writeSidebarCollapsed({ localStorage }, true);
    expect(readSidebarCollapsed({ localStorage })).toBe(true);
    writeSidebarCollapsed({ localStorage }, false);
    expect(readSidebarCollapsed({ localStorage })).toBe(false);
  });
});
