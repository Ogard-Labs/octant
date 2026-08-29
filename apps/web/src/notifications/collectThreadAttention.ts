import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { CodeProviderRequest, CodeThreadNavigationItem } from "../code/useCodeController";
import type { ThreadAttentionSignal } from "./threadAttention";

export interface ThreadAttentionSources {
  readonly chatThreads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly codeThreads: ReadonlyArray<CodeThreadNavigationItem>;
  /** Questions the active Code turn is blocked on right now. */
  readonly codeProviderRequests?: ReadonlyArray<CodeProviderRequest>;
  readonly activeCodeThreadId?: string;
}

/**
 * Collects every thread state the user is expected to act on. Chat surfaces a
 * finished turn as unread and a durable question as a follow-up; Code surfaces
 * a durable question the same way, and a live blocked turn through the provider
 * requests the workspace is already rendering.
 */
export function collectThreadAttentionSignals(
  sources: ThreadAttentionSources,
): ReadonlyArray<ThreadAttentionSignal> {
  const signals: ThreadAttentionSignal[] = [];
  for (const thread of sources.chatThreads) {
    const shared = {
      threadId: thread.threadId,
      title: thread.title,
      source: "chat" as const,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    };
    if (thread.followUp === true) {
      signals.push({ ...shared, reason: "question-asked" });
    } else if (thread.unread === true) {
      signals.push({ ...shared, reason: "turn-finished" });
    }
  }
  for (const thread of sources.codeThreads) {
    if (thread.followUp !== true) continue;
    signals.push({
      threadId: String(thread.threadId),
      reason: "question-asked",
      title: thread.title,
      source: "code",
      ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
    });
  }
  const activeCodeThreadId = sources.activeCodeThreadId;
  if (activeCodeThreadId !== undefined) {
    const activeThread = sources.codeThreads.find(
      (thread) => String(thread.threadId) === activeCodeThreadId,
    );
    const title = activeThread?.title ?? "Code thread";
    const shared = {
      threadId: activeCodeThreadId,
      title,
      source: "code" as const,
      ...(activeThread?.projectId === undefined
        ? {}
        : { projectId: String(activeThread.projectId) }),
    };
    for (const request of sources.codeProviderRequests ?? []) {
      signals.push(
        request.kind === "approval"
          ? { ...shared, reason: "approval-required", detail: request.summary }
          : { ...shared, reason: "question-asked", detail: request.prompt },
      );
    }
  }
  return signals;
}
