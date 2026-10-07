import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { countSidebarTiles } from "../shell/sidebarTileCounts";
import { buildReviewEntries, orderReviewEntries, reviewEntryKey } from "./reviewModel";

const thread = (overrides: Partial<ChatThreadNavigationItem>): ChatThreadNavigationItem => ({
  threadId: overrides.threadId ?? "thread",
  title: overrides.title ?? "Thread",
  ...overrides,
});

describe("review entries", () => {
  const rows = [
    thread({ threadId: "finished", unread: true, projectId: "p1" }),
    thread({ threadId: "running", unread: true, activity: "working" }),
    thread({ threadId: "read" }),
    thread({ threadId: "snoozed", unread: true, shelf: "snoozed" }),
    thread({ threadId: "done", unread: true, shelf: "completed" }),
    thread({ threadId: "asks", unread: true, activity: "attention" }),
  ];

  it("lists exactly the threads the To review tile counts", () => {
    const entries = buildReviewEntries({
      threads: rows.map((row) => ({ mode: "code" as const, thread: row })),
      projectNames: new Map([["p1", "Octant"]]),
      unfiledLabel: "No project",
    });

    expect(entries.map((entry) => entry.threadId)).toEqual(["finished", "asks"]);
    expect(entries.length).toBe(countSidebarTiles(rows, new Date()).toReview);
    expect(entries[0]).toMatchObject({ mode: "code", projectName: "Octant" });
    expect(entries[1]).toMatchObject({ projectName: "No project" });
  });

  it("keeps each thread's own kind so Chat threads stay Chat", () => {
    const entries = buildReviewEntries({
      threads: [
        { mode: "chat", thread: thread({ threadId: "c", unread: true }) },
        { mode: "work", thread: thread({ threadId: "w", unread: true }) },
      ],
      projectNames: new Map(),
      unfiledLabel: "No project",
    });

    expect(entries.map(reviewEntryKey)).toEqual(["chat:c", "work:w"]);
  });
});

describe("review order", () => {
  const entry = (threadId: string, updatedAt?: string) => ({
    mode: "code" as const,
    threadId,
    title: threadId,
    projectName: "Octant",
    ...(updatedAt === undefined ? {} : { updatedAt }),
  });

  it("puts the thread that finished longest ago first and prefers the host's finish time", () => {
    const ordered = orderReviewEntries(
      [
        entry("recent", "2026-10-06T10:00:00Z"),
        // Its record last changed long ago, but its turn only just ended.
        entry("old-record-new-turn", "2026-10-01T10:00:00Z"),
        entry("oldest", "2026-10-05T10:00:00Z"),
        entry("undated"),
      ],
      new Map([["code:old-record-new-turn", "2026-10-06T11:00:00Z"]]),
    );

    expect(ordered.map((item) => item.threadId)).toEqual([
      "oldest",
      "recent",
      "old-record-new-turn",
      "undated",
    ]);
  });
});
