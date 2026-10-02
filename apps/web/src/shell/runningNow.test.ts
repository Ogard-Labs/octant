import type { CodeBoardCard } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "./navigationModel";
import {
  reviewWaitingCount,
  runningCardsFromBoard,
  runningCardsFromNavigation,
  runningThreadCount,
} from "./runningNow";

function row(overrides: Partial<ChatThreadNavigationItem>): ChatThreadNavigationItem {
  return { threadId: "thread", title: "Thread", ...overrides };
}

function boardCard(overrides: Record<string, unknown>): CodeBoardCard {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    providerInstanceId: "provider-1",
    title: "Wire the board",
    executing: true,
    worktree: { kind: "available", head: { kind: "branch", name: "feature/board" } },
    childAgents: { active: 1, completed: 0, failed: 0, unacknowledgedResults: 0 },
    lastMeaningfulActivityAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  } as unknown as CodeBoardCard;
}

describe("the threads a start screen counts as waiting for review", () => {
  it("counts finished unread threads and leaves out running, snoozed, and read ones", () => {
    expect(
      reviewWaitingCount([
        row({ threadId: "finished", unread: true }),
        row({ threadId: "running", unread: true, activity: "working" }),
        row({ threadId: "snoozed", unread: true, shelf: "snoozed" }),
        row({ threadId: "read", unread: false }),
      ]),
    ).toBe(1);
  });
});

describe("the threads Running now lists", () => {
  it("lists only executing board cards, with the branch and the host's activity line", () => {
    const cards = runningCardsFromBoard(
      [
        boardCard({
          childAgents: {
            active: 1,
            completed: 0,
            failed: 0,
            unacknowledgedResults: 0,
            latestSummary: "Reading App.tsx",
          },
        }),
        boardCard({ threadId: "thread-2", title: "Idle", executing: false }),
      ],
      {
        projectNames: new Map([["project-1", "octant"]]),
        providers: new Map([["provider-1", { displayName: "Claude", driverKind: "claude" }]]),
      },
    );

    expect(cards).toEqual([
      {
        threadId: "thread-1",
        projectId: "project-1",
        title: "Wire the board",
        projectName: "octant",
        branch: "feature/board",
        provider: { displayName: "Claude", driverKind: "claude" },
        latestActivity: "Reading App.tsx",
        activeAt: "2026-10-01T09:00:00.000Z",
      },
    ]);
  });

  it("lists only the navigation rows the host projects as executing, newest first", () => {
    const cards = runningCardsFromNavigation(
      [
        row({
          threadId: "older",
          title: "Older",
          activity: "working",
          updatedAt: "2026-10-01T08:00:00Z",
        }),
        row({
          threadId: "newer",
          title: "Newer",
          activity: "working",
          updatedAt: "2026-10-01T09:00:00Z",
        }),
        row({ threadId: "waiting", title: "Waiting", activity: "attention" }),
        row({ threadId: "rested", title: "Rested", activity: "working", shelf: "snoozed" }),
      ],
      new Map(),
    );

    expect(cards.map((card) => card.threadId)).toEqual(["newer", "older"]);
  });
});

describe("the running count in a start screen's heading", () => {
  it("counts every running thread even when the cards stop at four", () => {
    const working = Array.from({ length: 6 }, (_, index) =>
      row({ threadId: `running-${String(index)}`, activity: "working" }),
    );
    expect(runningCardsFromNavigation(working, new Map())).toHaveLength(4);
    expect(
      runningThreadCount([
        ...working,
        row({ threadId: "rested", activity: "working", shelf: "snoozed" }),
      ]),
    ).toBe(6);
  });
});
