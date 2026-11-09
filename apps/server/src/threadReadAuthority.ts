import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type ChatThreadId,
  type CodeThreadId,
  type ProjectId,
  type WindowId,
  type WorkThreadId,
} from "@octant/contracts";

/** Whether a caller may open one thread, and the Project it is filed in. */
export type ThreadReadDecision =
  | { readonly kind: "readable"; readonly projectId: ProjectId | null }
  | { readonly kind: "refused" };

export type ThreadReadAuthority = (
  scopeId: WindowId,
  thread: { readonly mode: "chat" | "work" | "code"; readonly threadId: string },
) => Promise<ThreadReadDecision>;

/**
 * Each mode's own Open check, the one its thread routes already run before
 * they answer. Each port throws or answers nothing when the caller may not
 * open the thread.
 */
export interface ThreadReadPorts {
  readonly chat: (threadId: ChatThreadId) => { readonly projectId?: ProjectId | undefined };
  readonly work: (
    scopeId: WindowId,
    threadId: WorkThreadId,
  ) => Promise<{ readonly projectId: ProjectId } | undefined>;
  readonly code: (
    scopeId: WindowId,
    threadId: CodeThreadId,
  ) => Promise<{ readonly projectId: ProjectId } | undefined>;
}

/**
 * One answer to "may this caller open this thread?" across Chat, Work, and
 * Code, built from the checks the thread routes themselves run, so a surface
 * that serves what a thread owns (its Canvases, for a paired device) is never
 * wider or narrower than opening the thread. A refusal says nothing about
 * whether the thread exists.
 */
export function createThreadReadAuthority(ports: ThreadReadPorts): ThreadReadAuthority {
  return async (scopeId, thread) => {
    try {
      if (thread.mode === "chat") {
        const read = ports.chat(decodeChatThreadId(thread.threadId));
        return { kind: "readable", projectId: read.projectId ?? null };
      }
      const read =
        thread.mode === "work"
          ? await ports.work(scopeId, decodeWorkThreadId(thread.threadId))
          : await ports.code(scopeId, decodeCodeThreadId(thread.threadId));
      return read === undefined
        ? { kind: "refused" }
        : { kind: "readable", projectId: read.projectId };
    } catch {
      return { kind: "refused" };
    }
  };
}
