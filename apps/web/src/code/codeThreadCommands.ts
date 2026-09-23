import type { UtcTimestamp } from "@octant/contracts";
import type { CodeCommand, CodeThread, CodeThreadId } from "@octant/contracts/code";

export function findCodeThread(
  threads: ReadonlyArray<CodeThread> | undefined,
  threadId: CodeThreadId,
): CodeThread | undefined {
  return threads?.find((thread) => String(thread.id) === String(threadId));
}

export function renameCodeThread(thread: CodeThread, title: string): CodeCommand {
  return {
    kind: "rename-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
    title: title as never,
  };
}

export function pinCodeThread(thread: CodeThread, pinned: boolean): CodeCommand {
  return {
    kind: "pin-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
    pinned,
  };
}

export function archiveCodeThread(thread: CodeThread): CodeCommand {
  return {
    kind: "change-code-thread-lifecycle",
    threadId: thread.id,
    expectedVersion: thread.version,
    lifecycle: "archived",
  };
}

export function completeCodeThread(thread: CodeThread): CodeCommand {
  return {
    kind: "complete-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
  };
}

export function reopenCodeThread(thread: CodeThread): CodeCommand {
  return {
    kind: "reopen-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
  };
}

export function snoozeCodeThread(thread: CodeThread, until: UtcTimestamp): CodeCommand {
  return {
    kind: "snooze-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
    until,
  };
}

export function wakeCodeThread(thread: CodeThread): CodeCommand {
  return {
    kind: "wake-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
  };
}
