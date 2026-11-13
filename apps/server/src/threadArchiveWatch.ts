import type { CommittedAppend } from "@octant/contracts";

const THREAD_UPDATED_EVENTS = new Set([
  "chat.thread-updated@1",
  "work.thread-updated@1",
  "code.thread-updated@1",
]);

/**
 * A Code thread's `waiting` and `interrupted` are a turn's state after a
 * restart, not the thread leaving the lists, so only these count.
 */
const LEFT_THE_LISTS = new Set(["archived", "deleting", "deleted"]);

/**
 * The threads a committed append archived or deleted, in any mode.
 *
 * An ask a thread's agent raised waits for the person with no expiry, and a
 * thread may be archived while its turn is still parked on that ask. The
 * journal is the one place every mode's archive passes through (a person's
 * Archive, a benchmark's own, a deletion), so the services that hold waiting
 * asks give them up from here rather than from each mode's command path.
 */
export function threadsArchivedBy(append: CommittedAppend): ReadonlyArray<string> {
  const threadIds = new Set<string>();
  for (const event of append.events) {
    if (event.eventName === "chat.deleted@1") {
      const deleted = event.payload as { readonly threadId?: unknown };
      if (typeof deleted.threadId === "string") threadIds.add(deleted.threadId);
      continue;
    }
    if (!THREAD_UPDATED_EVENTS.has(event.eventName)) continue;
    const { thread } = event.payload as {
      readonly thread?: { readonly id?: unknown; readonly lifecycle?: unknown };
    };
    if (
      typeof thread?.id === "string" &&
      typeof thread.lifecycle === "string" &&
      LEFT_THE_LISTS.has(thread.lifecycle)
    ) {
      threadIds.add(thread.id);
    }
  }
  return [...threadIds];
}
