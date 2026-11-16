import {
  decodeCodeThreadId,
  THREAD_RETENTION_EVENT_NAMES,
  type CodeThread,
  type CodeThreadId,
  type Project,
  type ProjectId,
} from "@octant/contracts";
import type { OutlivingSessions } from "../providers/outlivingSessions";
import { codeSessionKey, codeSessionTerms } from "./codeOperationRuntime";

interface CommittedEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: unknown;
}

export interface CodeKeptSessionReads {
  readonly keeper: Pick<OutlivingSessions, "stopThreadIfChanged" | "keptKeys">;
  /** The Code thread as committed: the Code projection is applied inside the append. */
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  /** The Project as committed: the Project projection is applied inside the append. */
  readonly readProject: (projectId: ProjectId) => Project | undefined;
}

/**
 * Stops each kept Code session whose thread or Project a committed append
 * changed so that it would now start a session on other terms, reach a folder
 * the Project no longer grants, or run no turn at all.
 *
 * Both reads are current when the journal tells its listeners: the Code and
 * Project projections are registered with the journal and applied inside the
 * append's transaction. A Project change (an extra folder removed, a relink,
 * an archive) touches no thread, so every kept session of that Project is
 * judged again; any change to the folders a session was granted stops it,
 * since the next turn would replace a session acquired for other folders
 * anyway.
 */
export async function stopKeptSessionsOfChangedCodeThreads(
  append: { readonly events: ReadonlyArray<CommittedEvent> },
  reads: CodeKeptSessionReads,
): Promise<void> {
  const threadIds = new Set<string>();
  const purged = new Set<string>();
  const changedProjects = new Set<string>();
  for (const event of append.events) {
    if (event.aggregateType === "code-thread") threadIds.add(event.aggregateId);
    else if (event.aggregateType === "project") changedProjects.add(event.aggregateId);
    else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      const payload = event.payload as { readonly mode?: unknown; readonly threadId?: unknown };
      if (payload.mode === "code" && typeof payload.threadId === "string")
        purged.add(payload.threadId);
    }
  }
  if (changedProjects.size > 0) {
    for (const key of reads.keeper.keptKeys()) {
      if (key.startsWith("code:")) threadIds.add(key.slice("code:".length));
    }
  }
  for (const threadId of new Set([...threadIds, ...purged])) {
    let id: CodeThreadId;
    try {
      id = decodeCodeThreadId(threadId);
    } catch {
      continue;
    }
    const thread = purged.has(threadId) ? undefined : reads.readThread(id);
    // A session kept for a thread of another Project is not judged again for
    // a change to this one.
    if (
      thread !== undefined &&
      changedProjects.size > 0 &&
      !changedProjects.has(String(thread.projectId)) &&
      !append.events.some(
        (event) => event.aggregateType === "code-thread" && event.aggregateId === threadId,
      )
    )
      continue;
    await reads.keeper.stopThreadIfChanged(codeSessionKey(id), {
      terms:
        thread === undefined
          ? undefined
          : codeSessionTerms(thread, reads.readProject(thread.projectId)),
    });
  }
}
