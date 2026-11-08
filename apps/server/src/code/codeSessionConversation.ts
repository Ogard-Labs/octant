import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  type CodeConversationPage,
  type CodeEvidenceReference,
  type CodeThreadId,
} from "@octant/contracts";
import type { SessionConversationMessage } from "../context/contextHarnessService";
import type { ReadCodeConversationInput } from "./codeOperationEventStore";

/** Enough pages for a very long thread; a handover reads its newest part anyway. */
const MAX_CODE_SESSION_CONVERSATION_PAGES = 40;

/**
 * A Code thread's public conversation, oldest first, as the host summarizes
 * it: each turn's prompt and, once the turn completed, its final reply.
 * Rewound turns are not in it (the event store leaves them out), reasoning
 * and tool steps never are, and a message whose text cannot be read is left
 * out rather than guessed at. Each message's source is its evidence, so a
 * retried reply or a rewind past it reads as a different conversation.
 */
export function readCodeSessionConversation(
  threadId: CodeThreadId,
  sources: {
    readonly conversation: (input: ReadCodeConversationInput) => CodeConversationPage;
    readonly readEvidence: (reference: CodeEvidenceReference) => string | undefined;
  },
): ReadonlyArray<SessionConversationMessage> {
  const messages: Array<SessionConversationMessage> = [];
  let cursor = 0;
  for (let pages = 0; pages < MAX_CODE_SESSION_CONVERSATION_PAGES; pages += 1) {
    const page = sources.conversation({
      threadId,
      afterCursor: cursor,
      limit: MAX_CODE_CONVERSATION_PAGE_SIZE,
    });
    for (const turn of page.turns) {
      const exchangeKey = String(turn.operationId);
      const prompt = sources.readEvidence(turn.prompt);
      if (prompt !== undefined && prompt.trim().length > 0) {
        messages.push({
          source: { kind: "message", referenceId: String(turn.prompt.contentId) },
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
        source: { kind: "message", referenceId: String(last.contentId) },
        role: "assistant",
        exchangeKey,
        content: reply,
      });
    }
    if (!page.hasMore || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  return messages;
}
