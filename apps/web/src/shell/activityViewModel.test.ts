import { describe, expect, it } from "vitest";
import {
  ACTIVITY_VIEW_STORAGE_KEY,
  buildSidebarActivityView,
  readActivityViewEnabled,
  writeActivityViewEnabled,
} from "./activityViewModel";
import type { ChatThreadNavigationItem } from "./navigationModel";

const projectId = "11111111-1111-4111-8111-111111111111";

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key) {
      return map.get(key) ?? null;
    },
    key() {
      return null;
    },
    removeItem(key) {
      map.delete(key);
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

function thread(
  overrides: Partial<ChatThreadNavigationItem> &
    Pick<ChatThreadNavigationItem, "threadId" | "title">,
): ChatThreadNavigationItem {
  return overrides;
}

describe("buildSidebarActivityView", () => {
  it("puts unread and follow-up threads in Priority, then groups the rest by recency", () => {
    const now = new Date("2026-08-14T15:00:00.000Z");
    const view = buildSidebarActivityView({
      now,
      projects: [{ id: projectId, name: "octant" }],
      threads: [
        thread({
          followUp: true,
          projectId,
          threadId: "follow-up",
          title: "Review sidebar activity features",
          updatedAt: "2026-08-12T10:00:00.000Z",
        }),
        thread({
          projectId,
          threadId: "today",
          title: "Update AuroraDocs logos",
          unread: true,
          updatedAt: "2026-08-14T12:00:00.000Z",
        }),
        thread({
          threadId: "yesterday",
          title: "Estimate app rebrand effort",
          updatedAt: "2026-08-13T18:00:00.000Z",
        }),
        thread({
          projectId,
          threadId: "wednesday",
          title: "Plan Octant UI redesign",
          updatedAt: "2026-08-12T09:00:00.000Z",
        }),
      ],
    });

    expect(view.groups.map((group) => group.id)).toEqual(["priority", "yesterday", "wednesday"]);
    expect(view.groups[0]).toMatchObject({
      id: "priority",
      label: "Priority",
      threads: [
        expect.objectContaining({
          attention: "unread",
          projectName: "octant",
          threadId: "today",
        }),
        expect.objectContaining({
          attention: "follow-up",
          projectName: "octant",
          threadId: "follow-up",
        }),
      ],
    });
    expect(view.groups[1]).toMatchObject({
      id: "yesterday",
      label: "Yesterday",
      threads: [
        expect.objectContaining({
          projectName: "Unfiled",
          threadId: "yesterday",
        }),
      ],
    });
    expect(view.groups[2]).toMatchObject({
      id: "wednesday",
      label: "Wednesday",
      threads: [
        expect.objectContaining({
          projectName: "octant",
          threadId: "wednesday",
        }),
      ],
    });
  });

  it("uses the mode's rootless label for threads without a Project", () => {
    const view = buildSidebarActivityView({
      now: new Date("2026-08-14T15:00:00.000Z"),
      projects: [],
      rootlessLabel: "Recents",
      threads: [
        thread({ threadId: "rootless", title: "hei", updatedAt: "2026-08-13T18:00:00.000Z" }),
      ],
    });
    expect(view.groups[0]).toMatchObject({
      label: "Yesterday",
      threads: [expect.objectContaining({ projectName: "Recents", threadId: "rootless" })],
    });
  });

  it("keeps weekday buckets on calendar days across a spring-forward gap", () => {
    const now = new Date(2026, 2, 9, 15, 0, 0);
    const saturday = new Date(2026, 2, 7, 18, 0, 0);
    const view = buildSidebarActivityView({
      now,
      projects: [],
      threads: [
        thread({
          threadId: "saturday",
          title: "Saturday notes",
          updatedAt: saturday.toISOString(),
        }),
      ],
    });
    expect(view.groups.map((group) => group.id)).toEqual(["saturday"]);
    expect(view.groups[0]).toMatchObject({
      label: "Saturday",
      threads: [expect.objectContaining({ threadId: "saturday" })],
    });
  });

  it("omits empty recency groups and labels undated threads separately", () => {
    const view = buildSidebarActivityView({
      now: new Date("2026-08-14T15:00:00.000Z"),
      projects: [],
      threads: [thread({ threadId: "undated", title: "Loose chat" })],
    });

    expect(view.groups.map((group) => group.id)).toEqual(["earlier"]);
    expect(view.groups[0]).toMatchObject({
      label: "Earlier",
      threads: [
        expect.objectContaining({
          projectName: "Unfiled",
          threadId: "undated",
        }),
      ],
    });
  });
});

describe("activity view preference", () => {
  it("defaults off and round-trips a local presentation preference", () => {
    const storage = memoryStorage();
    expect(readActivityViewEnabled(storage)).toBe(false);
    writeActivityViewEnabled(true, storage);
    expect(storage.getItem(`${ACTIVITY_VIEW_STORAGE_KEY}.chat`)).toBe("on");
    expect(readActivityViewEnabled(storage)).toBe(true);
    writeActivityViewEnabled(false, storage);
    expect(readActivityViewEnabled(storage)).toBe(false);
  });

  it("keeps Chat, Work, and Code activity preferences independent", () => {
    const storage = memoryStorage();
    writeActivityViewEnabled(true, storage, globalThis, "chat");
    expect(readActivityViewEnabled(storage, globalThis, "chat")).toBe(true);
    expect(readActivityViewEnabled(storage, globalThis, "code")).toBe(false);
    writeActivityViewEnabled(true, storage, globalThis, "code");
    expect(readActivityViewEnabled(storage, globalThis, "chat")).toBe(true);
    expect(readActivityViewEnabled(storage, globalThis, "code")).toBe(true);
    writeActivityViewEnabled(false, storage, globalThis, "chat");
    expect(readActivityViewEnabled(storage, globalThis, "chat")).toBe(false);
    expect(readActivityViewEnabled(storage, globalThis, "code")).toBe(true);
  });

  it("copies a pre-mode preference into each mode once", () => {
    const storage = memoryStorage({ [ACTIVITY_VIEW_STORAGE_KEY]: "on" });
    expect(readActivityViewEnabled(storage, globalThis, "work")).toBe(true);
    expect(storage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(`${ACTIVITY_VIEW_STORAGE_KEY}.chat`)).toBe("on");
    writeActivityViewEnabled(false, storage, globalThis, "work");
    expect(readActivityViewEnabled(storage, globalThis, "chat")).toBe(true);
    expect(readActivityViewEnabled(storage, globalThis, "work")).toBe(false);
  });

  it("ignores corrupt preference values", () => {
    const storage = memoryStorage({ [ACTIVITY_VIEW_STORAGE_KEY]: "maybe" });
    expect(readActivityViewEnabled(storage)).toBe(false);
  });

  it("defaults off when resolving storage itself throws", () => {
    const throwingStorage = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    } as unknown as Storage;
    const storageHolder = {
      get localStorage(): Storage {
        throw new DOMException("denied", "SecurityError");
      },
    };
    expect(readActivityViewEnabled(undefined, storageHolder)).toBe(false);
    expect(() => writeActivityViewEnabled(true, undefined, storageHolder)).not.toThrow();
    expect(readActivityViewEnabled(throwingStorage)).toBe(false);
    expect(() => writeActivityViewEnabled(true, throwingStorage)).not.toThrow();
  });
});
