import type { CoordinatorBounds, CoordinatorWorkerLevel, UtcTimestamp } from "@octant/contracts";
import type { CodeCommand, CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";

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

export function moveCodeThread(thread: CodeThread, projectId: ProjectId): CodeCommand {
  return {
    kind: "move-code-thread",
    threadId: thread.id,
    expectedVersion: thread.version,
    projectId,
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

/** The person's override: Done whatever the delivery target says. */
export function markCodeThreadDone(thread: CodeThread): CodeCommand {
  return {
    kind: "mark-code-thread-done",
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

/**
 * Make coordinator and Stop coordinating; the host refuses it for a worker.
 * A worker level fixes every worker's level and is accepted only while making.
 */
export function setCodeThreadCoordinator(
  thread: CodeThread,
  coordinator: boolean,
  workerLevel?: CoordinatorWorkerLevel,
): CodeCommand {
  return {
    kind: "set-code-thread-coordinator",
    threadId: thread.id,
    expectedVersion: thread.version,
    coordinator,
    ...(workerLevel === undefined ? {} : { workerLevel }),
  };
}

/** A coordinator's wake, round and start bounds; a bound left out returns to its default. */
export function setCodeThreadCoordinatorBounds(
  thread: CodeThread,
  bounds: CoordinatorBounds,
): CodeCommand {
  return {
    kind: "set-code-thread-coordinator-bounds",
    threadId: thread.id,
    expectedVersion: thread.version,
    bounds,
  };
}

/** The thread's Wake when a message arrives switch. */
export function setCodeThreadMessageWake(thread: CodeThread, wake: boolean): CodeCommand {
  return {
    kind: "set-code-thread-message-wake",
    threadId: thread.id,
    expectedVersion: thread.version,
    wake,
  };
}

/** The thread's Continue after restart switch. */
export function setCodeThreadRestartContinuation(
  thread: CodeThread,
  continueAfterRestart: boolean,
): CodeCommand {
  return {
    kind: "set-code-thread-restart-continuation",
    threadId: thread.id,
    expectedVersion: thread.version,
    continueAfterRestart,
  };
}

/** A worker's Wake for coordinator switch. */
export function setCodeThreadCoordinatorWake(thread: CodeThread, wake: boolean): CodeCommand {
  return {
    kind: "set-code-thread-coordinator-wake",
    threadId: thread.id,
    expectedVersion: thread.version,
    wake,
  };
}
