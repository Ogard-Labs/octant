import {
  decodeChatThreadId,
  decodeProjectId,
  type ChatThreadId,
  type ProjectId,
} from "@octant/contracts";

export interface UsageSubjectOpeners {
  readonly selectChatThread: (threadId: string) => void;
  readonly selectWorkThread: (threadId: string) => void;
  readonly selectCodeThread: (threadId: string) => void;
  /** Opens a Chat thread by id, as the archive does, whether or not the sidebar lists it. */
  readonly openChatThread: (
    threadId: ChatThreadId,
    title: string,
    projectId?: ProjectId,
  ) => unknown;
  readonly listedChatThreadIds: ReadonlySet<string>;
  readonly chatThreadRow: (
    threadId: string,
  ) => { readonly title: string; readonly projectId?: string | undefined } | undefined;
}

/**
 * Opens the thread a Usage row names and reports whether the subject was one.
 * A Chat thread the sidebar does not list (a Benchmarks cell thread is archived
 * in a hidden Project) opens by id like an archived thread; the sidebar
 * selector would find no row for it and do nothing.
 */
export function openUsageSubject(
  subjectType: string,
  subjectId: string,
  openers: UsageSubjectOpeners,
): boolean {
  if (subjectType === "work-thread") {
    openers.selectWorkThread(subjectId);
    return true;
  }
  if (subjectType === "code-thread") {
    openers.selectCodeThread(subjectId);
    return true;
  }
  if (subjectType !== "chat-thread") return false;
  if (openers.listedChatThreadIds.has(subjectId)) {
    openers.selectChatThread(subjectId);
    return true;
  }
  const row = openers.chatThreadRow(subjectId);
  const projectId = row?.projectId === undefined ? undefined : decodeProjectId(row.projectId);
  const title = row?.title ?? "Benchmark thread";
  void openers.openChatThread(decodeChatThreadId(subjectId), title, projectId);
  return true;
}
