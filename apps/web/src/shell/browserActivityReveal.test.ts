import { describe, expect, it } from "vitest";
import {
  createBrowserActivityAnnouncementStore,
  decideBrowserActivityReveal,
} from "./browserActivityReveal";

describe("browser activity reveal", () => {
  it("reveals the first Browser session for a thread", () => {
    const store = createBrowserActivityAnnouncementStore();
    expect(store.remember("thread-a", ["session-1"])).toBe("reveal");
  });

  it("ignores the same session on a later poll or remount", () => {
    const store = createBrowserActivityAnnouncementStore();
    store.remember("thread-a", ["session-1"]);
    expect(store.remember("thread-a", ["session-1"])).toBe("ignore");
  });

  it("ignores a growing session that adds another context", () => {
    const store = createBrowserActivityAnnouncementStore();
    store.remember("thread-a", ["session-1"]);
    expect(store.remember("thread-a", ["session-1", "session-2"])).toBe("ignore");
  });

  it("reveals a disjoint session after the previous one ends", () => {
    const store = createBrowserActivityAnnouncementStore();
    store.remember("thread-a", ["session-1"]);
    expect(store.remember("thread-a", ["session-2"])).toBe("reveal");
  });

  it("does not suppress a second thread's first session", () => {
    const store = createBrowserActivityAnnouncementStore();
    store.remember("thread-a", ["session-1"]);
    expect(store.remember("thread-b", ["session-1"])).toBe("reveal");
  });

  it("does not leak announcements from one window store to another", () => {
    const firstWindow = createBrowserActivityAnnouncementStore();
    const secondWindow = createBrowserActivityAnnouncementStore();
    firstWindow.remember("thread-a", ["session-1"]);
    expect(secondWindow.remember("thread-a", ["session-1"])).toBe("reveal");
  });

  it("ignores an empty session list without recording one", () => {
    const store = createBrowserActivityAnnouncementStore();
    expect(store.remember("thread-a", [])).toBe("ignore");
    expect(store.remember("thread-a", ["session-1"])).toBe("reveal");
  });

  it("keeps already-announced ids when a later poll reports none", () => {
    const first = decideBrowserActivityReveal({
      announcedSessionIds: new Set(["session-1"]),
      activeSessionIds: [],
    });
    expect(first.decision).toBe("ignore");
    expect([...first.nextAnnouncedSessionIds]).toEqual(["session-1"]);
  });
});
