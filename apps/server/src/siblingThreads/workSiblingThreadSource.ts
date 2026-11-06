import {
  decodeMentionableThreadId,
  decodeSiblingThreadId,
  decodeWorkThreadId,
  type SiblingThreadState,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
} from "@octant/contracts";
import type { ThreadMentionDirectory } from "../chat/threadMentionService";
import type { WorkBoardRuntimeActivity } from "../work/workThreadBoardService";
import type { SiblingThreadSnapshot, SiblingThreadSource } from "./siblingThreadTools";

/**
 * The host facts a Work turn's threads tool reads, each the host's own record:
 * the projected Work threads, the runtime activity that files a thread on the
 * Work board, the thread's turns, and the Work `#thread` mention read.
 */
export interface WorkSiblingThreadEvidence {
  /** Every projected Work thread; a deleted one is closed and never listed. */
  readonly threads: () => ReadonlyArray<WorkThread>;
  readonly thread: (threadId: WorkThreadId) => WorkThread | undefined;
  /** The activity the Work board files the thread by. */
  readonly activity: (threadId: WorkThreadId) => WorkBoardRuntimeActivity;
  /** When each of the thread's turns last changed. */
  readonly turnUpdates: (threadId: WorkThreadId) => ReadonlyArray<{ readonly updatedAt: string }>;
  /** The Work `#thread` mention read, which re-authorizes the window on every call. */
  readonly mentions: Pick<ThreadMentionDirectory, "readTranscript">;
}

/**
 * The threads source for one Work turn, bound to the window the turn runs for.
 * A `read` shows exactly what a `#thread` mention of the same thread from that
 * window would, and nothing a mention from it would refuse.
 */
export function workSiblingThreadSource(
  evidence: WorkSiblingThreadEvidence,
  windowId: WindowId,
): SiblingThreadSource {
  const snapshot = (thread: WorkThread): SiblingThreadSnapshot => ({
    threadId: decodeSiblingThreadId(String(thread.id)),
    projectId: thread.projectId,
    mode: "work",
    // Done by a person, archived, or on its way to deletion: none is a
    // thread another one should be reading or waiting on.
    closed:
      thread.lifecycle !== "active" ||
      thread.completedAt !== undefined ||
      thread.completionConfirmed === true,
    title: thread.title,
    ...workSiblingThreadState(thread, evidence),
  });
  return {
    thread: (threadId) => {
      const thread = evidence.thread(decodeWorkThreadId(String(threadId)));
      return thread === undefined ? undefined : snapshot(thread);
    },
    projectThreads: (projectId) =>
      evidence
        .threads()
        .filter((thread) => String(thread.projectId) === String(projectId))
        .map(snapshot),
    readTranscript: async (threadId) =>
      await evidence.mentions.readTranscript(windowId, decodeMentionableThreadId(String(threadId))),
  };
}

/**
 * What a Work thread is doing, from the same activity that files it on the
 * Work board: a running turn is `working`; an unanswered approval or
 * question, an interrupted turn, or a finished turn that asked the person to
 * decide is `waiting-for-person`; anything else is `idle`. `stateChangedAt` is
 * the newest change among its turns, or its creation when it has never run.
 */
export function workSiblingThreadState(
  thread: WorkThread,
  evidence: Pick<WorkSiblingThreadEvidence, "activity" | "turnUpdates">,
): { readonly state: SiblingThreadState; readonly stateChangedAt: string } {
  const activity = evidence.activity(thread.id);
  const state: SiblingThreadState = activity.executing
    ? "working"
    : activity.awaitingInput || activity.interrupted || activity.decisionPending === true
      ? "waiting-for-person"
      : "idle";
  let latest: string | undefined;
  for (const turn of evidence.turnUpdates(thread.id)) {
    if (latest === undefined || Date.parse(turn.updatedAt) > Date.parse(latest)) {
      latest = turn.updatedAt;
    }
  }
  return { state, stateChangedAt: latest ?? thread.createdAt };
}
