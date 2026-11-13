import type { CommittedAppend } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { threadsArchivedBy } from "./threadArchiveWatch";

const threadId = "5a000000-0000-4000-8000-000000000001";
const otherThreadId = "5a000000-0000-4000-8000-000000000002";

function append(
  ...events: ReadonlyArray<{ readonly eventName: string; readonly payload: unknown }>
): CommittedAppend {
  return { events } as unknown as CommittedAppend;
}

describe("the threads a committed append archived", () => {
  it.each(["chat", "work", "code"])("names a %s thread whose update archived it", (mode) => {
    expect(
      threadsArchivedBy(
        append({
          eventName: `${mode}.thread-updated@1`,
          payload: { kind: "thread-updated", thread: { id: threadId, lifecycle: "archived" } },
        }),
      ),
    ).toEqual([threadId]);
  });

  it("names a thread being deleted and a Chat thread that was deleted", () => {
    expect(
      threadsArchivedBy(
        append(
          {
            eventName: "work.thread-updated@1",
            payload: { kind: "thread-updated", thread: { id: threadId, lifecycle: "deleting" } },
          },
          {
            eventName: "chat.deleted@1",
            payload: { kind: "deleted", threadId: otherThreadId },
          },
        ),
      ),
    ).toEqual([threadId, otherThreadId]);
  });

  it("names nothing for a thread that stays on the lists, a Code thread waiting after a restart included", () => {
    expect(
      threadsArchivedBy(
        append(
          {
            eventName: "code.thread-updated@1",
            payload: { kind: "thread-updated", thread: { id: threadId, lifecycle: "active" } },
          },
          {
            eventName: "code.thread-updated@1",
            payload: { kind: "thread-updated", thread: { id: threadId, lifecycle: "waiting" } },
          },
          {
            eventName: "code.thread-updated@1",
            payload: { kind: "thread-updated", thread: { id: threadId, lifecycle: "interrupted" } },
          },
          {
            eventName: "project.updated@1",
            payload: { thread: { id: otherThreadId, lifecycle: "archived" } },
          },
        ),
      ),
    ).toEqual([]);
  });
});
