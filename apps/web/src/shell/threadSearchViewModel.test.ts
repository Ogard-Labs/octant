import { describe, expect, it } from "vitest";
import {
  buildThreadSearchResults,
  flattenThreadSearchHits,
  type ThreadSearchThread,
} from "./threadSearchViewModel";

const projects = [
  { id: "p1", name: "Octant" },
  { id: "p2", name: "Harness" },
];

function thread(overrides: Partial<ThreadSearchThread> & { threadId: string }): ThreadSearchThread {
  return {
    mode: "chat",
    title: "Untitled",
    lifecycle: "active",
    ...overrides,
  };
}

describe("buildThreadSearchResults", () => {
  it("shows the most recent authorized threads before the query has content", () => {
    const results = buildThreadSearchResults({
      mode: "chat",
      query: "   ",
      threads: [
        thread({
          threadId: "t1",
          title: "Release checklist",
          updatedAt: "2026-08-03T00:00:00.000Z",
        }),
        thread({
          threadId: "t2",
          title: "Older notes",
          updatedAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      projects,
    });

    expect(flattenThreadSearchHits(results).map((hit) => hit.threadId)).toEqual(["t1", "t2"]);
    expect(results.truncated).toBe(false);
  });

  it("matches titles in the current mode and labels Project, Recents, and Unfiled threads", () => {
    const results = buildThreadSearchResults({
      mode: "work",
      query: "release",
      unfiledLabel: "Recents",
      threads: [
        thread({ threadId: "t1", mode: "work", title: "Release checklist", projectId: "p1" }),
        thread({ threadId: "t2", mode: "work", title: "Release notes" }),
        thread({ threadId: "t3", mode: "work", title: "Unrelated" }),
      ],
      projects,
    });

    expect(results.hitCount).toBe(2);
    expect(flattenThreadSearchHits(results).map((hit) => hit.folderLabel)).toEqual([
      "Octant",
      "Recents",
    ]);
  });

  it("keeps the source thread's Project identity on the hit", () => {
    // Opening a hit must carry the thread's own Project, or a cross-Project
    // open dispatches a plain open-tab the workspace policy rightly rejects.
    const results = buildThreadSearchResults({
      mode: "work",
      query: "release",
      threads: [
        thread({ threadId: "t1", mode: "work", title: "Release checklist", projectId: "p2" }),
        thread({ threadId: "t2", mode: "work", title: "Release notes" }),
      ],
      projects,
    });

    expect(flattenThreadSearchHits(results).map((hit) => hit.projectId)).toEqual(["p2", undefined]);
  });

  it("labels a Chat thread with no Project Unfiled by default", () => {
    const results = buildThreadSearchResults({
      mode: "chat",
      query: "notes",
      threads: [thread({ threadId: "t1", title: "Release notes" })],
      projects,
    });

    expect(flattenThreadSearchHits(results)[0]?.folderLabel).toBe("Unfiled");
  });

  it("groups archived matches after live ones instead of dropping them", () => {
    const results = buildThreadSearchResults({
      mode: "chat",
      query: "release",
      threads: [
        thread({ threadId: "t1", title: "Release archive", lifecycle: "archived" }),
        thread({ threadId: "t2", title: "Release checklist" }),
      ],
      projects,
    });

    expect(results.groups.map((group) => group.id)).toEqual(["threads", "archived"]);
    expect(flattenThreadSearchHits(results).map((hit) => hit.threadId)).toEqual(["t2", "t1"]);
    expect(flattenThreadSearchHits(results)[1]?.archived).toBe(true);
  });

  it("never surfaces another mode's threads", () => {
    const results = buildThreadSearchResults({
      mode: "code",
      query: "release",
      threads: [
        thread({ threadId: "t1", mode: "chat", title: "Release checklist" }),
        thread({ threadId: "t2", mode: "work", title: "Release notes" }),
        thread({ threadId: "t3", mode: "code", title: "Release branch" }),
      ],
      projects,
    });

    expect(flattenThreadSearchHits(results).map((hit) => hit.threadId)).toEqual(["t3"]);
  });

  it("keeps hits from Projects a named Code view does not show", () => {
    // The caller passes every current-mode thread the host listed; a named view
    // is presentation, so a thread in a Project outside it still matches.
    const results = buildThreadSearchResults({
      mode: "code",
      query: "release",
      unfiledLabel: "Recents",
      threads: [
        thread({ threadId: "t1", mode: "code", title: "Release branch", projectId: "p1" }),
        thread({ threadId: "t2", mode: "code", title: "Release hotfix", projectId: "p9" }),
      ],
      projects: [{ id: "p1", name: "Octant" }],
    });

    expect(flattenThreadSearchHits(results).map((hit) => hit.threadId)).toEqual(["t1", "t2"]);
    expect(flattenThreadSearchHits(results)[1]?.folderLabel).toBe("Recents");
  });

  it("omits threads the host has retired", () => {
    const results = buildThreadSearchResults({
      mode: "chat",
      query: "release",
      threads: [
        thread({ threadId: "t1", title: "Release checklist", lifecycle: "deleting" }),
        thread({ threadId: "t2", title: "Release notes", lifecycle: "deleted" }),
      ],
      projects,
    });

    expect(results.hitCount).toBe(0);
  });

  it("orders hits by recency and reports truncation", () => {
    const results = buildThreadSearchResults({
      limit: 2,
      mode: "chat",
      query: "release",
      threads: [
        thread({ threadId: "t1", title: "Release one", updatedAt: "2026-08-01T00:00:00.000Z" }),
        thread({ threadId: "t2", title: "Release two", updatedAt: "2026-08-03T00:00:00.000Z" }),
        thread({ threadId: "t3", title: "Release three", updatedAt: "2026-08-02T00:00:00.000Z" }),
      ],
      projects,
    });

    expect(flattenThreadSearchHits(results).map((hit) => hit.threadId)).toEqual(["t2", "t3"]);
    expect(results.truncated).toBe(true);
  });

  it("ignores case and collapsed whitespace in the query", () => {
    const results = buildThreadSearchResults({
      mode: "chat",
      query: "  RELEASE   Check ",
      threads: [thread({ threadId: "t1", title: "Release check for August" })],
      projects,
    });

    expect(results.hitCount).toBe(1);
  });
});
