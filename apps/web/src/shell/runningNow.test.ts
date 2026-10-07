import { describe, expect, it } from "vitest";
import type { ChatThreadNavigationItem } from "./navigationModel";
import { reviewWaitingCount, runningThreadCount } from "./runningNow";

function row(overrides: Partial<ChatThreadNavigationItem>): ChatThreadNavigationItem {
  return { threadId: "thread", title: "Thread", ...overrides };
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

describe("the threads a start screen counts as running", () => {
  it("counts only rows the host projects as executing and never a rested one", () => {
    expect(
      runningThreadCount([
        row({ threadId: "a", activity: "working" }),
        row({ threadId: "b", activity: "working" }),
        row({ threadId: "c", activity: "working", shelf: "snoozed" }),
        row({ threadId: "d", unread: true }),
      ]),
    ).toBe(2);
  });
});
