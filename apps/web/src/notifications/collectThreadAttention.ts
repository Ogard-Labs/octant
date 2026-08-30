import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import type { CodeProviderRequest, CodeThreadNavigationItem } from "../code/useCodeController";
import type { ThreadAttentionSignal } from "./threadAttention";

export interface ThreadAttentionSources {
  readonly chatThreads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly codeThreads: ReadonlyArray<CodeThreadNavigationItem>;
  /** Live provider requests keyed by Code thread id for every open thread. */
  readonly codeProviderRequestsByThreadId?: Readonly<
    Record<string, ReadonlyArray<CodeProviderRequest>>
  >;
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
  for (const [threadId, requests] of Object.entries(sources.codeProviderRequestsByThreadId ?? {})) {
    if (requests.length === 0) continue;
    const thread = sources.codeThreads.find((entry) => String(entry.threadId) === threadId);
    const title = thread?.title ?? "Code thread";
    const shared = {
      threadId,
      title,
      source: "code" as const,
      ...(thread?.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
    };
    for (const request of requests) {
      signals.push(
        request.kind === "approval"
          ? { ...shared, reason: "approval-required", detail: request.summary }
          : { ...shared, reason: "question-asked", detail: request.prompt },
      );
    }
  }
  return signals;
}
