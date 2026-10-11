import type { CodeConversationTurnHandoff, CodeOperationEvent } from "@octant/contracts";

/** The part of a journaled handoff the transcript shows; the text itself stays on the host. */
export function handoffSummary(
  event: Extract<CodeOperationEvent, { readonly kind: "context-handoff-attached" }>,
): CodeConversationTurnHandoff {
  return {
    reason: event.reason,
    previousProviderInstanceId: event.previousProviderInstanceId,
    previousModelId: event.previousModelId,
    messages: event.messages,
    omissions: event.omissions,
    externalContentIngested: event.externalContentIngested,
  };
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * What a handoff carried and what it did not, in one sentence. Every omission
 * the host counted is named, so a short handoff never reads as a short
 * conversation, and the sentence always says the previous session and its
 * hidden reasoning stayed behind.
 */
export function providerSwitchHandoffDisclosure(
  handoff: CodeConversationTurnHandoff,
  previousLabel: string,
): string {
  const { omissions } = handoff;
  const left = [
    omissions.earlierMessages > 0
      ? count(omissions.earlierMessages, "earlier message", "earlier messages")
      : undefined,
    omissions.missingBodies > 0
      ? `${count(omissions.missingBodies, "message", "messages")} no longer stored`
      : undefined,
    omissions.oversizedBodies > 0
      ? `${count(omissions.oversizedBodies, "message", "messages")} too large to read`
      : undefined,
    omissions.emptyBodies > 0
      ? count(omissions.emptyBodies, "empty message", "empty messages")
      : undefined,
    omissions.unfinishedReplies > 0
      ? count(omissions.unfinishedReplies, "unfinished reply", "unfinished replies")
      : undefined,
    omissions.attachments > 0
      ? count(omissions.attachments, "attachment", "attachments")
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const shortened =
    omissions.truncatedMessages > 0
      ? ` ${count(omissions.truncatedMessages, "message was", "messages were")} shortened.`
      : "";
  return [
    `Handed over ${count(handoff.messages, "recent message", "recent messages")} from ${previousLabel} as text.`,
    left.length === 0 ? "" : ` Left out: ${left.join(", ")}.`,
    shortened,
    handoff.externalContentIngested ? " Some of it came from outside content." : "",
    " Hidden reasoning, tool activity and the previous session did not transfer.",
  ].join("");
}

/** What the next message will do after the person picked a different provider. */
export function pendingProviderSwitchNotice(nextLabel: string, previousLabel: string): string {
  return `Your next message starts a new session on ${nextLabel}, with recent messages handed over as text. Hidden reasoning and the ${previousLabel} session do not carry over.`;
}
