import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  type CodeConversationPage,
  type CodeEvidenceReference,
  type CodeThreadId,
} from "@octant/contracts";
import type { SessionConversationMessage } from "../context/contextHarnessService";
import type { ReadCodeConversationInput } from "./codeOperationEventStore";

/**
 * Enough pages for a very long thread. A thread longer still gets no
 * conversation at all rather than its oldest part, since a handover is worth
 * most for the newest turns.
 */
const MAX_CODE_SESSION_CONVERSATION_PAGES = 40;

/**
 * A Code thread's public conversation, oldest first, as the host summarizes
 * it: each turn's prompt and, once the turn completed, its final reply.
 * Rewound turns are not in it (the event store leaves them out), reasoning
 * and tool steps never are, and a message whose text cannot be read is left
 * out rather than guessed at. Each message's source names its turn and its
 * evidence (identical text shares evidence, so the turn tells two "continue"
 * prompts apart), and a retried reply or a rewind past it reads as a different
 * conversation. Undefined when the thread is too long, or cannot be read.
 */
export function readCodeSessionConversation(
  threadId: CodeThreadId,
  sources: {
    readonly conversation: (input: ReadCodeConversationInput) => CodeConversationPage;
    readonly readEvidence: (reference: CodeEvidenceReference) => string | undefined;
  },
): ReadonlyArray<SessionConversationMessage> | undefined {
  const messages: Array<SessionConversationMessage> = [];
  let cursor = 0;
  for (let pages = 0; ; pages += 1) {
    if (pages === MAX_CODE_SESSION_CONVERSATION_PAGES) return undefined;
    let page: CodeConversationPage;
    try {
      page = sources.conversation({
        threadId,
        afterCursor: cursor,
        limit: MAX_CODE_CONVERSATION_PAGE_SIZE,
      });
    } catch {
      // The store refuses a scan past its bound; a thread that long gets none.
      return undefined;
    }
    for (const turn of page.turns) {
      const exchangeKey = String(turn.operationId);
      const prompt = sources.readEvidence(turn.prompt);
      if (prompt !== undefined && prompt.trim().length > 0) {
        messages.push({
          source: {
            kind: "message",
            referenceId: `${exchangeKey}:user:${String(turn.prompt.contentId)}`,
          },
          role: "user",
          exchangeKey,
          content: prompt,
        });
      }
      if (turn.status !== "completed") continue;
      const parts = turn.assistant.flatMap((reference) => {
        const text = sources.readEvidence(reference);
        return text === undefined ? [] : [text];
      });
      const reply = parts.join("");
      const last = turn.assistant.at(-1);
      if (last === undefined || reply.trim().length === 0) continue;
      messages.push({
        source: {
          kind: "message",
          referenceId: `${exchangeKey}:assistant:${String(last.contentId)}`,
        },
        role: "assistant",
        exchangeKey,
        content: reply,
      });
    }
    if (!page.hasMore || page.nextCursor <= cursor) return messages;
    cursor = page.nextCursor;
  }
}
