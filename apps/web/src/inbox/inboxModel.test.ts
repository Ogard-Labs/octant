import { describe, expect, it } from "vitest";
import type { ThreadAttentionSignal } from "../notifications/threadAttention";
import { assignedWorkSeenKey, buildInboxAttentionItems } from "./inboxModel";

const signal = (overrides: Partial<ThreadAttentionSignal>): ThreadAttentionSignal => ({
  threadId: "thread-a",
  reason: "turn-finished",
  title: "Thread",
  source: "code",
  ...overrides,
});

describe("buildInboxAttentionItems", () => {
  it("lists blocked threads before finished ones and names their Project", () => {
    const items = buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "turn-finished", title: "Done turn" }),
        signal({ threadId: "t2", reason: "approval-required", title: "Blocked", projectId: "p1" }),
        signal({ threadId: "t3", reason: "question-asked", title: "Asking" }),
      ],
      new Map([["p1", "Octant"]]),
    );
    expect(items.map((item) => item.signal.reason)).toEqual([
      "approval-required",
      "question-asked",
      "turn-finished",
    ]);
    expect(items[0]?.projectName).toBe("Octant");
    expect(items[1]?.projectName).toBeUndefined();
  });

  it("keeps one row per thread-and-reason so a re-render never doubles the list", () => {
    const items = buildInboxAttentionItems(
      [
        signal({ threadId: "t1", reason: "question-asked" }),
        signal({ threadId: "t1", reason: "question-asked" }),
      ],
      new Map(),
    );
    expect(items).toHaveLength(1);
  });
});

describe("assignedWorkSeenKey", () => {
  it("changes when the item is updated upstream, so it lights up again", () => {
    const item = {
      category: "issue" as const,
      owner: "octant",
      name: "octant",
      number: 7,
      title: "Issue",
      author: "octocat",
      updatedAt: "2026-08-28T10:00:00Z",
      url: "https://github.com/octant/octant/issues/7",
    };
    expect(assignedWorkSeenKey(item)).not.toBe(
      assignedWorkSeenKey({ ...item, updatedAt: "2026-08-29T10:00:00Z" }),
    );
  });
});
