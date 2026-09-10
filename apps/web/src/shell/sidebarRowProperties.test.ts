import { describe, expect, it } from "vitest";
import {
  defaultSidebarRowProperties,
  normalizeSidebarRowProperties,
  readSidebarRowProperties,
  sidebarRowPropertiesAll,
  writeSidebarRowProperties,
} from "./sidebarRowProperties";

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  readonly entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe("sidebar row property visibility", () => {
  it("starts each view showing exactly what it showed before it could be told otherwise", () => {
    expect(defaultSidebarRowProperties("projects")).toMatchObject({
      branch: true,
      pullRequest: true,
      lastUpdated: true,
      status: true,
    });
    expect(defaultSidebarRowProperties("activity")).toMatchObject({
      project: true,
      branch: false,
      pullRequest: false,
      lastUpdated: false,
      status: true,
    });
  });

  it("keeps a property hidden in one view visible in the other", () => {
    const storage = memoryStorage();

    writeSidebarRowProperties(
      "projects",
      { ...defaultSidebarRowProperties("projects"), pullRequest: false },
      storage,
    );

    expect(readSidebarRowProperties("projects", storage).pullRequest).toBe(false);
    expect(readSidebarRowProperties("activity", storage)).toEqual(
      defaultSidebarRowProperties("activity"),
    );

    writeSidebarRowProperties(
      "activity",
      { ...defaultSidebarRowProperties("activity"), pullRequest: true },
      storage,
    );

    expect(readSidebarRowProperties("activity", storage).pullRequest).toBe(true);
    expect(readSidebarRowProperties("projects", storage).pullRequest).toBe(false);
  });

  it("reads the same choice back after the renderer is thrown away and rebuilt", () => {
    const storage = memoryStorage();
    const hidden = { ...defaultSidebarRowProperties("projects"), branch: false, status: false };

    writeSidebarRowProperties("projects", hidden, storage);
    const reloaded = readSidebarRowProperties("projects", { getItem: storage.getItem } as Storage);

    expect(reloaded).toEqual(hidden);
  });

  it("keeps a property the saved record never heard of at its view default", () => {
    // A record written before a property existed must not delete that property
    // from the row; it simply says nothing about it.
    expect(normalizeSidebarRowProperties("projects", { pullRequest: false })).toEqual({
      project: false,
      branch: true,
      pullRequest: false,
      lastUpdated: true,
      status: true,
    });
    expect(normalizeSidebarRowProperties("activity", "not an object")).toEqual(
      defaultSidebarRowProperties("activity"),
    );
  });

  it("hides and shows only the properties the view can put on a row", () => {
    // Projects rows sit under their Project heading already, so Project is not
    // theirs to show and Show all must not claim it is.
    expect(sidebarRowPropertiesAll("projects", true).project).toBe(false);
    expect(sidebarRowPropertiesAll("activity", true).project).toBe(true);
    expect(sidebarRowPropertiesAll("activity", false)).toEqual({
      project: false,
      branch: false,
      pullRequest: false,
      lastUpdated: false,
      status: false,
    });
  });

  it("keeps the current session working when storage refuses", () => {
    const refusing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    expect(readSidebarRowProperties("projects", refusing)).toEqual(
      defaultSidebarRowProperties("projects"),
    );
    expect(() =>
      writeSidebarRowProperties("projects", defaultSidebarRowProperties("projects"), refusing),
    ).not.toThrow();
  });
});
