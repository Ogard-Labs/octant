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

function codeThreadTitle(
  sources: ThreadAttentionSources,
  threadId: string,
): string | undefined {
  return sources.codeThreads.find((thread) => String(thread.threadId) === threadId)?.title;
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
    if (thread.followUp === true) {
      signals.push({ threadId: thread.threadId, reason: "question-asked", title: thread.title });
    } else if (thread.unread === true) {
      signals.push({ threadId: thread.threadId, reason: "turn-finished", title: thread.title });
    }
  }
  for (const thread of sources.codeThreads) {
    if (thread.followUp !== true) continue;
    signals.push({
      threadId: String(thread.threadId),
      reason: "question-asked",
      title: thread.title,
    });
  }
  const activeCodeThreadId = sources.activeCodeThreadId;
  if (activeCodeThreadId !== undefined) {
    const title = codeThreadTitle(sources, activeCodeThreadId) ?? "Code thread";
    for (const request of sources.codeProviderRequests ?? []) {
      signals.push(
        request.kind === "approval"
          ? {
              threadId: activeCodeThreadId,
              reason: "approval-required",
              title,
              detail: request.summary,
            }
          : {
              threadId: activeCodeThreadId,
              reason: "question-asked",
              title,
              detail: request.prompt,
            },
      );
    }
  }
  return signals;
}
