import {
  decodeWorkThread,
  decodeWorkThreadId,
  THREAD_RETENTION_EVENT_NAMES,
  type Project,
  type ProjectId,
  type WorkThread,
  type WorkThreadId,
} from "@octant/contracts";
import type { OutlivingSessions } from "../providers/outlivingSessions";
import { workSessionKey, workSessionTerms } from "./workTurnRuntime";

interface CommittedEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: unknown;
}

export interface WorkKeptSessionReads {
  readonly keeper: Pick<OutlivingSessions, "stopThreadIfChanged" | "keptKeys">;
  /** The Work thread projection, which a committed thread change has not reached yet. */
  readonly readThread: (threadId: WorkThreadId) => WorkThread | undefined;
  /**
   * The Project as committed: the Project projection is applied inside the
   * journal's append, before any listener is told of it.
   */
  readonly readProject: (projectId: ProjectId) => Project | undefined;
}

/**
 * Stops each kept Work session whose thread or Project a committed append
 * changed so that it would now start a session on other terms, reach a folder
 * the Project no longer grants, or run no turn at all.
 *
 * A thread's terms come from the committed change itself, never from the Work
 * thread projection: the journal tells its listeners of an append
 * synchronously, before the Work thread service applies it to that
 * projection, so a read of the projection here saw the thread as it was before
 * the change and left a session running at a level the person had just
 * lowered. Every Work thread event carries the whole thread; one that cannot
 * be read, and a purge, count as a thread that can run no turn.
 *
 * A Project change (an extra folder removed, a relink, an archive) touches no
 * thread, so every kept session of that Project is judged again against the
 * Project as committed; the Project projection already holds it when the
 * listener runs. Any change to the folders a session was granted stops it: a
 * session acquired before a folder was added would be replaced by the next
 * turn anyway, since the keeper holds one session per folder set.
 */
export async function stopKeptSessionsOfChangedWorkThreads(
  append: { readonly events: ReadonlyArray<CommittedEvent> },
  reads: WorkKeptSessionReads,
): Promise<void> {
  // The last change in the append is the thread as it now stands.
  const changed = new Map<string, string | undefined>();
  const changedProjects = new Set<string>();
  for (const event of append.events) {
    if (event.aggregateType === "work-thread") {
      const thread = committedThread(event.payload);
      changed.set(
        event.aggregateId,
        thread === undefined
          ? undefined
          : workSessionTerms(thread, reads.readProject(thread.projectId)),
      );
    } else if (event.aggregateType === "project") {
      changedProjects.add(event.aggregateId);
    } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      const purged = event.payload as { readonly mode?: unknown; readonly threadId?: unknown };
      if (purged.mode === "work" && typeof purged.threadId === "string")
        changed.set(purged.threadId, undefined);
    }
  }
  if (changedProjects.size > 0) {
    for (const key of reads.keeper.keptKeys()) {
      if (!key.startsWith("work:")) continue;
      const threadId = key.slice("work:".length);
      if (changed.has(threadId)) continue;
      let thread: WorkThread | undefined;
      try {
        thread = reads.readThread(decodeWorkThreadId(threadId));
      } catch {
        thread = undefined;
      }
      if (thread !== undefined && !changedProjects.has(String(thread.projectId))) continue;
      changed.set(
        threadId,
        thread === undefined
          ? undefined
          : workSessionTerms(thread, reads.readProject(thread.projectId)),
      );
    }
  }
  for (const [threadId, terms] of changed) {
    let key: string;
    try {
      key = workSessionKey(decodeWorkThreadId(threadId));
    } catch {
      continue;
    }
    await reads.keeper.stopThreadIfChanged(key, { terms });
  }
}

function committedThread(payload: unknown): WorkThread | undefined {
  if (typeof payload !== "object" || payload === null || !("thread" in payload)) return undefined;
  try {
    return decodeWorkThread(payload.thread);
  } catch {
    return undefined;
  }
}
