import {
  decodeMentionableThreadId,
  type CodeThread,
  type CodeThreadId,
  type SiblingThreadState,
  type WindowId,
} from "@octant/contracts";
import type { ThreadMentionDirectory } from "../chat/threadMentionService";
import { boardRuntimeActivityFromWorks } from "../code/codeThreadBoardService";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import type { SiblingThreadSnapshot, SiblingThreadSource } from "./siblingThreadTools";

/**
 * The host facts a Code turn's sibling-threads tool reads. Every one is the
 * host's own record, never a renderer value: the persisted Code threads, the
 * runtime work the board folds, the running turn's open approvals and
 * questions, the decision a finished turn closed with, and the `#thread`
 * mention read.
 */
export interface CodeSiblingThreadEvidence {
  /**
   * Every persisted Code thread. A deleted thread's row is erased with it, and
   * a child run never has one, so neither can be listed or resolved.
   */
  readonly threads: () => ReadonlyArray<CodeThread>;
  readonly thread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly runtimeWorks: (threadId: CodeThreadId) => ReadonlyArray<ProjectedCodeRuntimeWork>;
  /** Whether the thread's running turn holds an approval or a question the person has not answered. */
  readonly turnAwaitsPerson: (threadId: CodeThreadId) => boolean;
  /** Whether the thread's latest finished turn closed by asking the person to decide. */
  readonly decisionPending: (thread: CodeThread) => boolean;
  /** The Code `#thread` mention read, which re-authorizes the window on every page. */
  readonly mentions: Pick<ThreadMentionDirectory, "readTranscript">;
}

/**
 * The sibling-threads source for one Code turn, bound to the window the turn
 * runs for. A `read` shows exactly what a `#thread` mention of the same thread
 * from that window would, and nothing a mention from it would refuse.
 */
export function codeSiblingThreadSource(
  evidence: CodeSiblingThreadEvidence,
  windowId: WindowId,
): SiblingThreadSource {
  const snapshot = (thread: CodeThread): SiblingThreadSnapshot => ({
    threadId: thread.id,
    projectId: thread.projectId,
    mode: "code",
    closed: thread.lifecycle === "archived" || thread.completedAt !== undefined,
    title: thread.title,
    ...codeSiblingThreadState(thread, evidence),
  });
  return {
    thread: (threadId) => {
      const thread = evidence.thread(threadId);
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
 * What a Code thread is doing, from the same evidence that files it on the
 * Code board. A running turn or other running work is `working`; work owed by
 * the person (an unanswered approval or question, a step whose outcome is
 * unconfirmed or that waits on a decision, an interrupted last turn, or a
 * finished turn that asked the person to decide) is `waiting-for-person`;
 * anything else is `idle`.
 *
 * `stateChangedAt` is when the host last moved the work that decides the
 * state: the newest update among the latest provider turn and every other
 * runtime work record, or the thread's creation when it has never run. A turn
 * parked on an approval keeps its running record, so its time is when that
 * turn last moved, not when the question was asked.
 */
export function codeSiblingThreadState(
  thread: CodeThread,
  evidence: Pick<
    CodeSiblingThreadEvidence,
    "runtimeWorks" | "turnAwaitsPerson" | "decisionPending"
  >,
): { readonly state: SiblingThreadState; readonly stateChangedAt: string } {
  const works = evidence.runtimeWorks(thread.id);
  const activity = boardRuntimeActivityFromWorks(works, {
    turnParkedOnPerson: evidence.turnAwaitsPerson(thread.id),
  });
  const state: SiblingThreadState = activity.executing
    ? "working"
    : activity.awaitingInput || activity.interrupted || evidence.decisionPending(thread)
      ? "waiting-for-person"
      : "idle";
  return { state, stateChangedAt: latestDecidingUpdate(works) ?? thread.createdAt };
}

/** The newest update among the records the board's fold lets speak. */
function latestDecidingUpdate(works: ReadonlyArray<ProjectedCodeRuntimeWork>): string | undefined {
  let latestTurn: ProjectedCodeRuntimeWork | undefined;
  for (const entry of works) {
    if (entry.work.kind !== "provider-turn") continue;
    if (latestTurn === undefined || entry.firstSequence > latestTurn.firstSequence) {
      latestTurn = entry;
    }
  }
  let latest: string | undefined;
  for (const entry of works) {
    if (entry.work.kind === "provider-turn" && entry !== latestTurn) continue;
    const at = entry.work.updatedAt;
    if (latest === undefined || Date.parse(at) > Date.parse(latest)) latest = at;
  }
  return latest;
}
