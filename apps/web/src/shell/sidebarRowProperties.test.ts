import { DEFAULT_SIDEBAR_ROW_PROPERTIES } from "@octant/contracts/shell";
import { describe, expect, it, vi } from "vitest";
import { adoptLegacySidebarRowProperties, sidebarRowPropertiesAll } from "./sidebarRowProperties";

function memoryStorage(): Pick<Storage, "getItem" | "removeItem"> & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

describe("sidebar row property visibility", () => {
  it("hides and shows only the properties the view can put on a row", () => {
    // Projects rows sit under their Project heading already, so Project is not
    // theirs to show and Show all must not claim it is.
    expect(sidebarRowPropertiesAll("projects", true)).toEqual({
      project: false,
      branch: true,
      pullRequest: true,
      lastUpdated: true,
      status: true,
    });
    expect(sidebarRowPropertiesAll("activity", true)).toEqual({
      project: true,
      branch: true,
      pullRequest: true,
      lastUpdated: true,
      status: true,
    });
    expect(sidebarRowPropertiesAll("activity", false)).toEqual({
      project: false,
      branch: false,
      pullRequest: false,
      lastUpdated: false,
      status: false,
    });
  });
});

describe("legacy sidebar row property adoption", () => {
  it("adopts a renderer's stored choices into the host setting and clears the legacy key", async () => {
    const storage = memoryStorage();
    storage.entries.set(
      "octant.sidebar.row-properties.v1.activity",
      JSON.stringify({
        project: false,
        branch: false,
        pullRequest: false,
        lastUpdated: true,
        status: true,
      }),
    );
    const updateSettings = vi.fn(async () => true);

    adoptLegacySidebarRowProperties({
      current: DEFAULT_SIDEBAR_ROW_PROPERTIES,
      updateSettings,
      storage,
    });

    expect(updateSettings).toHaveBeenCalledWith({
      projects: { ...DEFAULT_SIDEBAR_ROW_PROPERTIES.projects },
      activity: {
        project: false,
        branch: false,
        pullRequest: false,
        lastUpdated: true,
        status: true,
      },
    });
    await vi.waitFor(() => expect(storage.entries.size).toBe(0));
  });

  it("leaves a host record someone already changed and clears the legacy keys", () => {
    const storage = memoryStorage();
    storage.entries.set(
      "octant.sidebar.row-properties.v1.projects",
      JSON.stringify({ branch: false, pullRequest: true, lastUpdated: true, status: true }),
    );
    const updateSettings = vi.fn(async () => true);

    adoptLegacySidebarRowProperties({
      current: {
        projects: { ...DEFAULT_SIDEBAR_ROW_PROPERTIES.projects, lastUpdated: false },
        activity: { ...DEFAULT_SIDEBAR_ROW_PROPERTIES.activity },
      },
      updateSettings,
      storage,
    });

    expect(updateSettings).not.toHaveBeenCalled();
    expect(storage.entries.size).toBe(0);
  });

  it("does nothing when the legacy records are absent or already match the defaults", () => {
    const storage = memoryStorage();
    const updateSettings = vi.fn(async () => true);

    adoptLegacySidebarRowProperties({
      current: DEFAULT_SIDEBAR_ROW_PROPERTIES,
      updateSettings,
      storage,
    });
    expect(updateSettings).not.toHaveBeenCalled();

    storage.entries.set(
      "octant.sidebar.row-properties.v1.projects",
      JSON.stringify(DEFAULT_SIDEBAR_ROW_PROPERTIES.projects),
    );
    adoptLegacySidebarRowProperties({
      current: DEFAULT_SIDEBAR_ROW_PROPERTIES,
      updateSettings,
      storage,
    });
    expect(updateSettings).not.toHaveBeenCalled();
    expect(storage.entries.size).toBe(0);
  });
});
