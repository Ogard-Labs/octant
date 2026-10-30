import { describe, expect, it } from "vitest";
import {
  ACTIVITY_VIEW_STORAGE_KEY,
  buildSidebarActivityView,
  filterSidebarActivityView,
  matchesSidebarSearch,
  buildSidebarStatusView,
  readThreadArrangement,
  writeThreadArrangement,
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
          projectName: "No Project",
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

  it("uses the mode's unfiled label for threads without a Project", () => {
    const view = buildSidebarActivityView({
      now: new Date("2026-08-14T15:00:00.000Z"),
      projects: [],
      unfiledLabel: "Recents",
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
          projectName: "No Project",
          threadId: "undated",
        }),
      ],
    });
  });
});

describe("filterSidebarActivityView", () => {
  const now = new Date("2026-08-14T15:00:00.000Z");
  const view = buildSidebarActivityView({
    now,
    projects: [{ id: projectId, name: "octant" }],
    threads: [
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
        pinned: true,
        projectId,
        threadId: "pinned",
        title: "Always here",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ],
  });

  it("leaves the grouped presentation alone until the query has content", () => {
    expect(filterSidebarActivityView(view, "   ")).toBe(view);
  });

  it("keeps a row whose title matches and drops groups that then have nothing", () => {
    const filtered = filterSidebarActivityView(view, "aurora");
    expect(filtered.groups.map((group) => group.id)).toEqual(["priority"]);
    expect(filtered.groups[0]?.threads.map((item) => item.threadId)).toEqual(["today"]);
    expect(filtered.groups[0]?.threads[0]).toMatchObject({
      projectName: "octant",
      title: "Update AuroraDocs logos",
    });
  });

  it("matches the Project, Recents, or Unfiled folder word on the row", () => {
    expect(
      filterSidebarActivityView(view, "no project").groups.map((group) =>
        group.threads.map((item) => item.threadId),
      ),
    ).toEqual([["yesterday"]]);
    expect(
      filterSidebarActivityView(view, "OCTANT").groups.flatMap((group) =>
        group.threads.map((item) => item.threadId),
      ),
    ).toEqual(["pinned", "today"]);
    expect(
      filterSidebarActivityView(
        buildSidebarActivityView({
          now,
          projects: [],
          unfiledLabel: "Recents",
          threads: [
            thread({
              threadId: "rootless",
              title: "hei",
              updatedAt: "2026-08-13T18:00:00.000Z",
            }),
          ],
        }),
        "recents",
      ).groups[0]?.threads,
    ).toEqual([expect.objectContaining({ projectName: "Recents", threadId: "rootless" })]);
  });

  it("ignores case and collapsed whitespace in the query", () => {
    expect(matchesSidebarSearch("  AURORA  ", "Update AuroraDocs logos")).toBe(true);
    expect(filterSidebarActivityView(view, "  AURORA  ").groups).toHaveLength(1);
  });

  it("returns no groups when nothing matches", () => {
    expect(filterSidebarActivityView(view, "no such thread").groups).toEqual([]);
  });
});

describe("activity view preference", () => {
  it("opens on Status and round-trips each arrangement", () => {
    const storage = memoryStorage();
    expect(readThreadArrangement(storage)).toBe("status");
    writeThreadArrangement("activity", storage);
    expect(storage.getItem(`${ACTIVITY_VIEW_STORAGE_KEY}.chat`)).toBe("on");
    expect(readThreadArrangement(storage)).toBe("activity");
    writeThreadArrangement("projects", storage);
    expect(readThreadArrangement(storage)).toBe("projects");
    writeThreadArrangement("status", storage);
    expect(readThreadArrangement(storage)).toBe("status");
  });

  it("keeps a feed or tree chosen before Status existed", () => {
    expect(
      readThreadArrangement(
        memoryStorage({ [`${ACTIVITY_VIEW_STORAGE_KEY}.code`]: "off" }),
        globalThis,
        "code",
      ),
    ).toBe("projects");
    expect(
      readThreadArrangement(
        memoryStorage({ [`${ACTIVITY_VIEW_STORAGE_KEY}.code`]: "on" }),
        globalThis,
        "code",
      ),
    ).toBe("activity");
  });

  it("keeps Chat, Work, and Code arrangements independent", () => {
    const storage = memoryStorage();
    writeThreadArrangement("activity", storage, globalThis, "chat");
    expect(readThreadArrangement(storage, globalThis, "chat")).toBe("activity");
    expect(readThreadArrangement(storage, globalThis, "code")).toBe("status");
    writeThreadArrangement("projects", storage, globalThis, "code");
    expect(readThreadArrangement(storage, globalThis, "chat")).toBe("activity");
    expect(readThreadArrangement(storage, globalThis, "code")).toBe("projects");
  });

  it("copies a pre-mode preference into each mode once", () => {
    const storage = memoryStorage({ [ACTIVITY_VIEW_STORAGE_KEY]: "on" });
    expect(readThreadArrangement(storage, globalThis, "work")).toBe("activity");
    expect(storage.getItem(ACTIVITY_VIEW_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(`${ACTIVITY_VIEW_STORAGE_KEY}.chat`)).toBe("on");
    writeThreadArrangement("projects", storage, globalThis, "work");
    expect(readThreadArrangement(storage, globalThis, "chat")).toBe("activity");
    expect(readThreadArrangement(storage, globalThis, "work")).toBe("projects");
  });

  it("falls back to Status for a corrupt value", () => {
    const storage = memoryStorage({ [ACTIVITY_VIEW_STORAGE_KEY]: "maybe" });
    expect(readThreadArrangement(storage)).toBe("status");
  });

  it("falls back to Status when resolving storage itself throws", () => {
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
    expect(readThreadArrangement(undefined, storageHolder)).toBe("status");
    expect(() => writeThreadArrangement("activity", undefined, storageHolder)).not.toThrow();
    expect(readThreadArrangement(throwingStorage)).toBe("status");
    expect(() => writeThreadArrangement("activity", throwingStorage)).not.toThrow();
  });

  it("keeps a pinned thread at the top, above attention and recency", () => {
    const view = buildSidebarActivityView({
      now: new Date("2026-08-14T12:00:00.000Z"),
      projects: [{ id: "project-one", name: "Octant" }],
      threads: [
        {
          threadId: "unread",
          title: "Needs a look",
          projectId: "project-one",
          unread: true,
          updatedAt: "2026-08-14T11:59:00.000Z",
        },
        {
          threadId: "pinned",
          title: "Always here",
          projectId: "project-one",
          pinned: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(view.groups[0]?.id).toBe("pinned");
    expect(view.groups[0]?.threads.map((thread) => thread.threadId)).toEqual(["pinned"]);
    expect(view.groups[1]?.id).toBe("priority");
  });
});

describe("buildSidebarStatusView", () => {
  it("groups threads by what they need, pinned first, newest first within a group", () => {
    const view = buildSidebarStatusView({
      projects: [{ id: projectId, name: "Octant" }],
      threads: [
        thread({ threadId: "idle-old", title: "Idle old", updatedAt: "2026-08-10T10:00:00.000Z" }),
        thread({ threadId: "idle-new", title: "Idle new", updatedAt: "2026-08-14T10:00:00.000Z" }),
        thread({ threadId: "working", title: "Running", activity: "working" }),
        thread({ threadId: "review", title: "Finished", unread: true }),
        thread({
          threadId: "asks",
          title: "Asks",
          activity: "attention",
          awaitingKind: "approval",
        }),
        thread({
          threadId: "pinned",
          title: "Pinned and running",
          pinned: true,
          activity: "working",
        }),
      ],
    });
    expect(
      view.groups.map((group) => [group.label, group.threads.map((row) => row.threadId)]),
    ).toEqual([
      ["Pinned", ["pinned"]],
      ["Needs input", ["asks"]],
      ["Ready for review", ["review"]],
      ["Working", ["working"]],
      ["Idle", ["idle-new", "idle-old"]],
    ]);
  });
});
