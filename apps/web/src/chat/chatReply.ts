import type {
  ChatAttempt,
  ChatContentBody,
  ChatContentReference,
  ChatThreadView,
} from "@octant/contracts";
import { chatTurnAnsweredAttempt } from "@octant/domain/chat-policy";
import { withoutProviderCitationMarkers } from "@octant/domain/chat-message-parts";

/** The content a reference names, when its role and digest still match. */
export function resolvedContent(
  contentById: ReadonlyMap<string, ChatContentBody>,
  reference: ChatContentReference,
  expectedRole: ChatContentBody["role"],
): ChatContentBody | undefined {
  const content = contentById.get(String(reference.contentId));
  return content?.role === expectedRole && content.digest === reference.digest
    ? content
    : undefined;
}

/**
 * One attempt's reply text. The runner persists every streamed delta as its
 * own reference, so the bodies are joined before the provider's citation
 * markers are stripped: a marker split across deltas would otherwise leak its
 * tail ("9view0") into the text.
 */
export function attemptReplyText(
  attempt: Pick<ChatAttempt, "responseRefs">,
  contentById: ReadonlyMap<string, ChatContentBody>,
): string | undefined {
  const joined = attempt.responseRefs
    .flatMap((reference) => {
      const content = resolvedContent(contentById, reference, "assistant");
      return content === undefined ? [] : [content.body];
    })
    .join("");
  return joined.length === 0 ? undefined : withoutProviderCitationMarkers(joined);
}

/** The text a turn answered with: its answering attempt's reply, or none. */
export function turnReplyText(view: ChatThreadView, turnId: string): string | undefined {
  const turn = view.turns.find((candidate) => String(candidate.id) === turnId);
  if (turn === undefined) return undefined;
  const answering = chatTurnAnsweredAttempt(turn);
  if (answering === undefined) return undefined;
  const text = attemptReplyText(
    answering,
    new Map(view.contents.map((content) => [String(content.contentId), content])),
  )?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}
