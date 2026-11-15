import {
  decodeWorkThread,
  decodeWorkThreadId,
  THREAD_RETENTION_EVENT_NAMES,
} from "@octant/contracts";
import type { OutlivingSessions } from "../providers/outlivingSessions";
import { workSessionKey, workSessionTerms } from "./workTurnRuntime";

interface CommittedEvent {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: unknown;
}

/**
 * Stops each kept Work session whose thread a committed append changed so
 * that it would now start a session on other terms, or can run no turn.
 *
 * The terms come from the committed change itself, never from the Work thread
 * projection: the journal tells its listeners of an append synchronously,
 * before the Work thread service applies it to that projection, so a read of
 * the projection here saw the thread as it was before the change and left a
 * session running at a level the person had just lowered. Every Work thread
 * event carries the whole thread; one that cannot be read, and a purge, count
 * as a thread that can run no turn.
 */
export async function stopKeptSessionsOfChangedWorkThreads(
  append: { readonly events: ReadonlyArray<CommittedEvent> },
  keeper: Pick<OutlivingSessions, "stopThreadIfChanged">,
): Promise<void> {
  // The last change in the append is the thread as it now stands.
  const changed = new Map<string, string | undefined>();
  for (const event of append.events) {
    if (event.aggregateType === "work-thread") {
      changed.set(event.aggregateId, committedTerms(event.payload));
    } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      const purged = event.payload as { readonly mode?: unknown; readonly threadId?: unknown };
      if (purged.mode === "work" && typeof purged.threadId === "string")
        changed.set(purged.threadId, undefined);
    }
  }
  for (const [threadId, terms] of changed) {
    let key: string;
    try {
      key = workSessionKey(decodeWorkThreadId(threadId));
    } catch {
      continue;
    }
    await keeper.stopThreadIfChanged(key, { terms });
  }
}

function committedTerms(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("thread" in payload)) return undefined;
  try {
    return workSessionTerms(decodeWorkThread(payload.thread));
  } catch {
    return undefined;
  }
}
