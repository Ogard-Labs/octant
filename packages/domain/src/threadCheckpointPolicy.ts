/**
 * Pure policy for thread checkpoints: the points a user marks in a thread so
 * they can take the work up again from there.
 *
 * Two rules shape everything here. A checkpoint is a marker on an append-only
 * journal, so marking one records where a turn already is and never copies
 * state; and taking one up again produces a *second* thread, so restoring can
 * never rewind, rewrite, or discard the thread it came from.
 *
 * This module decides only what is decidable from recorded facts. Whether a
 * revision is still reachable in the repository, whether a managed worktree may
 * be created, and whether the caller holds the authority to create a thread at
 * all are observations and authority checks the server owns; it maps their
 * typed failures onto the same refusal reasons.
 */

import type {
  ThreadCheckpointAnchor,
  ThreadCheckpointAnchorRequest,
  ThreadCheckpointRefusalReason,
} from "@octant/contracts/thread-checkpoints";

export interface CheckpointChatThreadFacts {
  readonly mode: "chat";
  readonly threadId: string;
  readonly lifecycle: "active" | "archived" | "deleting" | "deleted";
  /** Whether the marked turn is still part of the thread's active conversation. */
  readonly carriesAnchor: boolean;
  readonly projectId?: string;
  readonly projectAvailable?: boolean;
}

export interface CheckpointCodeThreadFacts {
  readonly mode: "code";
  readonly threadId: string;
  readonly lifecycle: "active" | "archived" | "waiting" | "interrupted";
  readonly carriesAnchor: boolean;
  /** The revision the checkout was on before the marked turn ran, when the host caught it. */
  readonly revision?: string;
  readonly projectId: string;
  readonly projectAvailable: boolean;
}

export type CheckpointThreadFacts = CheckpointChatThreadFacts | CheckpointCodeThreadFacts;

export type ThreadCheckpointMarkPlan =
  | Readonly<{
      status: "marks";
      anchor: ThreadCheckpointAnchor;
      projectId?: string;
    }>
  | Readonly<{ status: "refuses"; reason: ThreadCheckpointRefusalReason }>;

export type ThreadCheckpointRestorePlan =
  | Readonly<{ status: "branches-chat"; threadId: string; turnId: string }>
  | Readonly<{
      status: "creates-code-thread";
      sourceThreadId: string;
      operationId: string;
      revision: string;
      projectId: string;
    }>
  | Readonly<{ status: "refuses"; reason: ThreadCheckpointRefusalReason }>;

/** The checkpoint facts a restore decision needs; the rest of the record is presentation. */
export interface CheckpointRestoreSubject {
  readonly anchor: ThreadCheckpointAnchor;
  readonly lifecycle: "marked" | "forgotten";
}

const refuses = (reason: ThreadCheckpointRefusalReason) => ({ status: "refuses", reason }) as const;

/**
 * A checkpoint belongs to a thread the user is still working in. An archived
 * thread is deliberately out of the way, and a deleting one is on its way out,
 * so neither takes a new marker or hands one back — unarchiving is the explicit
 * step that makes it possible again.
 */
function usable(thread: CheckpointThreadFacts): boolean {
  return thread.mode === "chat" ? thread.lifecycle === "active" : thread.lifecycle !== "archived";
}

function projectUnavailable(thread: CheckpointThreadFacts): boolean {
  return thread.projectId !== undefined && thread.projectAvailable === false;
}

export function planThreadCheckpointMark(input: {
  readonly anchor: ThreadCheckpointAnchorRequest;
  readonly thread: CheckpointThreadFacts | undefined;
}): ThreadCheckpointMarkPlan {
  const { anchor, thread } = input;
  if (
    thread === undefined ||
    thread.mode !== anchor.mode ||
    String(thread.threadId) !== String(anchor.threadId) ||
    !usable(thread)
  ) {
    return refuses("thread-unavailable");
  }
  if (!thread.carriesAnchor) return refuses("anchor-unavailable");

  if (anchor.mode === "chat") {
    return {
      status: "marks",
      anchor: { mode: "chat", threadId: anchor.threadId, turnId: anchor.turnId },
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    };
  }
  // A Code checkpoint that names no revision would be a point the user could
  // never return to, so it is refused at marking rather than at restore.
  const revision = thread.mode === "code" ? thread.revision : undefined;
  if (revision === undefined) return refuses("revision-unavailable");
  return {
    status: "marks",
    anchor: {
      mode: "code",
      threadId: anchor.threadId,
      operationId: anchor.operationId,
      revision,
    },
    ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
  };
}

export function planThreadCheckpointRestore(input: {
  readonly checkpoint: CheckpointRestoreSubject;
  readonly thread: CheckpointThreadFacts | undefined;
}): ThreadCheckpointRestorePlan {
  const { checkpoint, thread } = input;
  if (checkpoint.lifecycle === "forgotten") return refuses("checkpoint-forgotten");
  const anchor = checkpoint.anchor;
  if (
    thread === undefined ||
    thread.mode !== anchor.mode ||
    String(thread.threadId) !== String(anchor.threadId) ||
    !usable(thread)
  ) {
    return refuses("thread-unavailable");
  }
  if (!thread.carriesAnchor) return refuses("anchor-unavailable");
  if (projectUnavailable(thread)) return refuses("project-unavailable");

  if (anchor.mode === "chat") {
    return {
      status: "branches-chat",
      threadId: String(anchor.threadId),
      turnId: String(anchor.turnId),
    };
  }
  // Code binds a Project before it may hold a checkout, so a Code checkpoint
  // whose thread reports none is a thread the host can no longer place.
  if (thread.mode !== "code") return refuses("thread-unavailable");
  return {
    status: "creates-code-thread",
    sourceThreadId: String(anchor.threadId),
    operationId: String(anchor.operationId),
    revision: anchor.revision,
    projectId: thread.projectId,
  };
}
