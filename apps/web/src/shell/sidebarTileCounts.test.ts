import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "./navigationModel";
import { countSidebarTiles } from "./sidebarTileCounts";

const row = (overrides: Partial<ChatThreadNavigationItem>): ChatThreadNavigationItem => ({
  threadId: overrides.threadId ?? "thread",
  title: "Thread",
  ...overrides,
});

describe("sidebar tile counts", () => {
  const now = new Date(2026, 9, 1, 15, 0, 0);

  it("counts running threads, unread finished turns, and threads completed today", () => {
    const counts = countSidebarTiles(
      [
        row({ threadId: "a", activity: "working" }),
        row({ threadId: "b", activity: "working", unread: true }),
        row({ threadId: "c", unread: true }),
        row({ threadId: "d" }),
        row({
          threadId: "e",
          shelf: "completed",
          completedAt: new Date(2026, 9, 1, 9, 30).toISOString(),
        }),
        row({
          threadId: "f",
          shelf: "completed",
          completedAt: new Date(2026, 8, 30, 23, 59).toISOString(),
        }),
      ],
      now,
    );
    expect(counts).toEqual({ running: 2, toReview: 1, doneToday: 1 });
  });

  it("leaves snoozed threads out of running and review even when they are unread", () => {
    expect(
      countSidebarTiles(
        [row({ threadId: "a", shelf: "snoozed", unread: true, activity: "working" })],
        now,
      ),
    ).toEqual({ running: 0, toReview: 0, doneToday: 0 });
  });
});
