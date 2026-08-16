import { decodeChatThreadId, type ThreadWorkItem } from "@octant/contracts/chat";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import { describe, expect, it } from "vitest";
import {
  ThreadWorkPolicyRejected,
  applyThreadWorkCommand,
  completeFollowUp,
  evaluateFollowUpTrigger,
  type ThreadWorkList,
} from "./threadWorkPolicy";

const threadId = decodeChatThreadId("11111111-1111-4111-8111-111111111111");
const now = "2026-07-19T10:00:00.000Z" as UtcTimestamp;

function makeItem(
  index: number,
  status: ThreadWorkItem["status"],
  overrides: Partial<ThreadWorkItem> = {},
): ThreadWorkItem {
  const n = index + 1;
  return {
    id: `00000000-0000-4000-8000-00000000000${n}` as ThreadWorkItem["id"],
    threadId,
    title: `Item ${n}`,
    detail: undefined,
    status,
    position: index,
    origin: "user",
    version: 1 as AggregateVersion,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeList(items: ThreadWorkItem[] = [], version = 0): ThreadWorkList {
  return { threadId, version: version as AggregateVersion, items };
}

describe("thread work list policy", () => {
  it("rejects item mutations addressed to another thread", () => {
    const otherThreadId = decodeChatThreadId("22222222-2222-4222-8222-222222222222");
    const item = makeItem(0, "pending");
    const list = makeList([item], 1);

    for (const command of [
      {
        kind: "edit-chat-work-item",
        threadId: otherThreadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: item.id,
        title: "Cross-thread edit",
      },
      {
        kind: "complete-chat-work-item",
        threadId: otherThreadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: item.id,
      },
      {
        kind: "cancel-chat-work-item",
        threadId: otherThreadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: item.id,
      },
      {
        kind: "reopen-chat-work-item",
        threadId: otherThreadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: item.id,
      },
    ] as const) {
      expect(() => applyThreadWorkCommand(list, command, now)).toThrowError(
        expect.objectContaining({ code: "thread-mismatch" }),
      );
    }
  });

  it("adds a work item and increments the list version", () => {
    const list = makeList([], 0);
    const next = applyThreadWorkCommand(
      list,
      {
        kind: "add-chat-work-item",
        threadId,
        expectedVersion: 0 as AggregateVersion,
        itemId: "00000000-0000-4000-8000-000000000001" as ThreadWorkItem["id"],
        title: "First task",
        status: "pending",
        position: 0,
        origin: "user",
      },
      now,
    );
    expect(next.version).toBe(1);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({
      title: "First task",
      status: "pending",
      position: 0,
      version: 1,
    });
    expect(list.version).toBe(0);
    expect(list.items).toHaveLength(0);
  });

  it("rejects stale versions", () => {
    const list = makeList([makeItem(0, "pending")], 1);
    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "add-chat-work-item",
          threadId,
          expectedVersion: 0 as AggregateVersion,
          itemId: "00000000-0000-4000-8000-000000000002" as ThreadWorkItem["id"],
          title: "Second task",
          status: "pending",
          position: 1,
          origin: "user",
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);
  });

  it("rejects duplicate item ids", () => {
    const item = makeItem(0, "pending");
    const list = makeList([item], 1);
    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "add-chat-work-item",
          threadId,
          expectedVersion: 1 as AggregateVersion,
          itemId: item.id,
          title: "Duplicate",
          status: "pending",
          position: 1,
          origin: "user",
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);
  });

  it("edits title, detail, and position", () => {
    const list = makeList([makeItem(0, "pending")], 1);
    const next = applyThreadWorkCommand(
      list,
      {
        kind: "edit-chat-work-item",
        threadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: list.items[0]!.id,
        title: "Updated task",
        detail: "Extra detail",
        position: 3,
      },
      now,
    );
    expect(next.items[0]).toMatchObject({
      title: "Updated task",
      detail: "Extra detail",
      position: 3,
      version: 2,
    });
    expect(list.items[0]!.title).toBe("Item 1");
  });

  it("rejects editing a missing item", () => {
    const list = makeList([], 0);
    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "edit-chat-work-item",
          threadId,
          expectedVersion: 0 as AggregateVersion,
          itemId: "00000000-0000-4000-8000-000000000001" as ThreadWorkItem["id"],
          title: "Missing",
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);
  });

  it("completes, cancels, and reopens items with valid transitions", () => {
    const pending = makeItem(0, "pending");
    const inProgress = makeItem(1, "in-progress");
    const blocked = makeItem(2, "blocked");
    const list = makeList([pending, inProgress, blocked], 1);

    const completed = applyThreadWorkCommand(
      list,
      {
        kind: "complete-chat-work-item",
        threadId,
        expectedVersion: 1 as AggregateVersion,
        itemId: inProgress.id,
      },
      now,
    );
    expect(completed.items.find((i) => i.id === inProgress.id)?.status).toBe("completed");

    const cancelled = applyThreadWorkCommand(
      completed,
      {
        kind: "cancel-chat-work-item",
        threadId,
        expectedVersion: 2 as AggregateVersion,
        itemId: blocked.id,
      },
      now,
    );
    expect(cancelled.items.find((i) => i.id === blocked.id)?.status).toBe("cancelled");

    const reopened = applyThreadWorkCommand(
      cancelled,
      {
        kind: "reopen-chat-work-item",
        threadId,
        expectedVersion: 3 as AggregateVersion,
        itemId: inProgress.id,
      },
      now,
    );
    expect(reopened.items.find((i) => i.id === inProgress.id)?.status).toBe("pending");
  });

  it("rejects invalid status transitions", () => {
    const completed = makeItem(0, "completed");
    const cancelled = makeItem(1, "cancelled");
    const list = makeList([completed, cancelled], 1);

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "complete-chat-work-item",
          threadId,
          expectedVersion: 1 as AggregateVersion,
          itemId: completed.id,
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "cancel-chat-work-item",
          threadId,
          expectedVersion: 1 as AggregateVersion,
          itemId: cancelled.id,
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "reopen-chat-work-item",
          threadId,
          expectedVersion: 1 as AggregateVersion,
          itemId: completed.id,
        },
        now,
      ),
    ).not.toThrow();

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "reopen-chat-work-item",
          threadId,
          expectedVersion: 1 as AggregateVersion,
          itemId: cancelled.id,
        },
        now,
      ),
    ).not.toThrow();
  });

  it("reorders items deterministically and bumps versions", () => {
    const a = makeItem(0, "pending");
    const b = makeItem(1, "pending");
    const c = makeItem(2, "pending");
    const list = makeList([a, b, c], 3);

    const reordered = applyThreadWorkCommand(
      list,
      {
        kind: "reorder-chat-work-items",
        threadId,
        expectedVersion: 3 as AggregateVersion,
        itemIds: [c.id, a.id, b.id],
      },
      now,
    );
    expect(reordered.items.map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(reordered.version).toBe(4);
    expect(reordered.items[0]!.version).toBe(4);
  });

  it("rejects reorder lists with duplicates or missing items", () => {
    const a = makeItem(0, "pending");
    const b = makeItem(1, "pending");
    const list = makeList([a, b], 2);

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "reorder-chat-work-items",
          threadId,
          expectedVersion: 2 as AggregateVersion,
          itemIds: [a.id, a.id],
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);

    expect(() =>
      applyThreadWorkCommand(
        list,
        {
          kind: "reorder-chat-work-items",
          threadId,
          expectedVersion: 2 as AggregateVersion,
          itemIds: [a.id, "00000000-0000-4000-8000-000000000009" as ThreadWorkItem["id"]],
        },
        now,
      ),
    ).toThrow(ThreadWorkPolicyRejected);
  });
});

describe("thread follow-up policy", () => {
  it("opens follow-up on a new trigger and updates on a higher trigger", () => {
    const first = evaluateFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "New actionable work",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(first.state).toBe("open");
    expect(first.triggerSequence).toBe(5);
    expect(first.acknowledgedThroughSequence).toBe(0);

    const second = evaluateFollowUpTrigger(threadId, first, {
      sequence: 10,
      reason: "Another reason",
      origin: "manual",
      triggeredAt: now,
    });
    expect(second.state).toBe("open");
    expect(second.triggerSequence).toBe(10);
    expect(second.reason).toBe("Another reason");

    const ignored = evaluateFollowUpTrigger(threadId, second, {
      sequence: 7,
      reason: "Old news",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(ignored.triggerSequence).toBe(10);
  });

  it("ignores duplicate triggers", () => {
    const open = evaluateFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "New actionable work",
      origin: "automatic",
      triggeredAt: now,
    });
    const duplicate = evaluateFollowUpTrigger(threadId, open, {
      sequence: 5,
      reason: "Different reason",
      origin: "manual",
      triggeredAt: now,
    });
    expect(duplicate.reason).toBe("New actionable work");
    expect(duplicate.origin).toBe("automatic");
  });

  it("completes follow-up only with matching acknowledgement and does not clear on view", () => {
    const open = evaluateFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "New actionable work",
      origin: "automatic",
      triggeredAt: now,
    });

    const completed = completeFollowUp(0 as AggregateVersion, open, {
      expectedVersion: 0 as AggregateVersion,
      acknowledgedThroughSequence: 5,
      completedAt: now,
    });
    expect(completed.state).toBe("completed");
    expect(completed.acknowledgedThroughSequence).toBe(5);
    expect(completed.completedAt).toBe(now);

    const viewed = evaluateFollowUpTrigger(threadId, completed, {
      sequence: 3,
      reason: "Viewed",
      origin: "manual",
      triggeredAt: now,
    });
    expect(viewed.state).toBe("completed");
    expect(viewed.triggerSequence).toBe(5);

    const sameTrigger = evaluateFollowUpTrigger(threadId, completed, {
      sequence: 5,
      reason: "Same trigger",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(sameTrigger.state).toBe("completed");

    const reopened = evaluateFollowUpTrigger(threadId, completed, {
      sequence: 10,
      reason: "Newer actionable work",
      origin: "automatic",
      triggeredAt: now,
    });
    expect(reopened.state).toBe("open");
    expect(reopened.triggerSequence).toBe(10);
    expect(reopened.acknowledgedThroughSequence).toBe(5);
  });

  it("rejects completing follow-up with wrong acknowledgement or when already closed", () => {
    const open = evaluateFollowUpTrigger(threadId, undefined, {
      sequence: 5,
      reason: "New actionable work",
      origin: "automatic",
      triggeredAt: now,
    });

    expect(() =>
      completeFollowUp(0 as AggregateVersion, open, {
        expectedVersion: 0 as AggregateVersion,
        acknowledgedThroughSequence: 4,
        completedAt: now,
      }),
    ).toThrow(ThreadWorkPolicyRejected);

    const completed = completeFollowUp(0 as AggregateVersion, open, {
      expectedVersion: 0 as AggregateVersion,
      acknowledgedThroughSequence: 5,
      completedAt: now,
    });

    expect(() =>
      completeFollowUp(1 as AggregateVersion, completed, {
        expectedVersion: 1 as AggregateVersion,
        acknowledgedThroughSequence: 5,
        completedAt: now,
      }),
    ).toThrow(ThreadWorkPolicyRejected);
  });
});
