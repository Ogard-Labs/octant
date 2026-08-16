import type { ChatThreadView } from "@octant/contracts/chat";
import type { UtcTimestamp } from "@octant/contracts/events";
import { activeChatTurns, chatAttemptAnswered } from "@octant/domain";

/** One message an assistant surface reads, folded from the Chat journal. */
export interface AssistantTranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: UtcTimestamp;
}

/**
 * The conversation an assistant surface is briefed on.
 *
 * Two rules decide what is included, and both ask the same question: did the
 * conversation keep this? Fold edits the way the transcript, export, and
 * context planner do, so an exchange the user superseded is left out. Then
 * admit only a `completed` attempt's text, so a reply that failed, was
 * interrupted or cancelled, or is still arriving is left out too — it is the
 * branch the turn abandoned rather than the one the user replaced, but it is
 * just as much not the answer.
 *
 * Shared rather than restated per surface: Zen and Navigator read the same
 * conversation, and a surface that folded it differently would show the user
 * a different history of the same thread.
 */
export function assistantTranscript(
  view: ChatThreadView,
): ReadonlyArray<AssistantTranscriptMessage> {
  const contentById = new Map(view.contents.map((content) => [String(content.contentId), content]));
  return activeChatTurns(view.turns).flatMap((turn) => {
    const messages: AssistantTranscriptMessage[] = [];
    const user = contentById.get(String(turn.userMessageRef.contentId));
    if (user !== undefined)
      messages.push({ role: "user", text: user.body, createdAt: turn.createdAt });
    for (const attempt of turn.attempts) {
      // The refs below join into a single assistant message, so an unfinished
      // attempt would contribute a whole message the assistant reads as the
      // reply; after a retry it would see the abandoned one and the answer
      // with nothing to tell them apart. A transcript message cannot be marked
      // partial, so such an attempt contributes nothing; the prompt above still
      // rides along, exactly as an unfinished turn's prompt does elsewhere.
      if (!chatAttemptAnswered(attempt)) continue;
      const text = attempt.responseRefs
        .map((reference) => contentById.get(String(reference.contentId))?.body ?? "")
        .join("");
      if (text.length > 0) {
        messages.push({ role: "assistant", text, createdAt: attempt.updatedAt });
      }
    }
    return messages;
  });
}
