import type {
  CodeConversationTurnHandoff,
  CodeForkMergeBack,
  CodeForkMergeBackOutcome,
  CodeOperationEvent,
} from "@octant/contracts";

/** The part of a journaled handoff the transcript shows; the text itself stays on the host. */
export function handoffSummary(
  event: Extract<CodeOperationEvent, { readonly kind: "context-handoff-attached" }>,
): CodeConversationTurnHandoff {
  switch (event.reason) {
    case "provider-switch":
      return {
        reason: event.reason,
        previousProviderInstanceId: event.previousProviderInstanceId,
        previousModelId: event.previousModelId,
        messages: event.messages,
        omissions: event.omissions,
        externalContentIngested: event.externalContentIngested,
        ...(event.inherited === undefined ? {} : { inherited: event.inherited }),
      };
    case "fork":
      return {
        reason: event.reason,
        forkedFrom: event.forkedFrom,
        messages: event.messages,
        omissions: event.omissions,
        externalContentIngested: event.externalContentIngested,
      };
    case "fork-native-session":
      return { reason: event.reason, forkedFrom: event.forkedFrom };
  }
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}

type TextHandoff = Exclude<CodeConversationTurnHandoff, { readonly reason: "fork-native-session" }>;

/** Every omission the host counted, named, so a short handoff never reads as a short conversation. */
function omissionsDisclosure(handoff: Pick<TextHandoff | CodeForkMergeBack, "omissions">): string {
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
  return [
    left.length === 0 ? "" : ` Left out: ${left.join(", ")}.`,
    omissions.truncatedMessages > 0
      ? ` ${count(omissions.truncatedMessages, "message was", "messages were")} shortened by ${count(omissions.truncatedCharacters, "character", "characters")}.`
      : "",
    omissions.sourceTruncatedMessages > 0
      ? ` ${count(omissions.sourceTruncatedMessages, "message was", "messages were")} already cut short when recorded.`
      : "",
  ].join("");
}

/**
 * What a handoff carried and what it did not, in one sentence. A text
 * handoff names every omission and says the previous session and its hidden
 * reasoning stayed behind; a fork also says the source's later replies did
 * not come with it.
 */
export function conversationHandoffDisclosure(
  handoff: CodeConversationTurnHandoff,
  label: (selection: { readonly providerInstanceId: string; readonly modelId: string }) => string,
): string {
  switch (handoff.reason) {
    case "provider-switch":
      return [
        `Handed over ${count(handoff.messages, "recent message", "recent messages")} from ${label({ providerInstanceId: handoff.previousProviderInstanceId, modelId: handoff.previousModelId })} as text.`,
        handoff.inherited === undefined
          ? ""
          : ` ${count(handoff.inherited.messages, "of them comes", "of them come")} from the conversation this was forked from, up to the reply it was forked from.`,
        omissionsDisclosure(handoff),
        // The taint is the thread's, not the excerpts': the outside content that
        // set it may be tool output or an attachment the handoff never carried.
        handoff.externalContentIngested ? " This thread has taken in outside content." : "",
        handoff.inherited?.externalContentIngested === true
          ? " The thread it was forked from has taken in outside content."
          : "",
        " Hidden reasoning, tool activity and the previous session did not transfer.",
      ].join("");
    case "fork":
      return [
        `Forked with ${count(handoff.messages, "recent message", "recent messages")} of the source conversation as text, up to the reply it was forked from.`,
        omissionsDisclosure(handoff),
        handoff.externalContentIngested ? " The source thread has taken in outside content." : "",
        " Hidden reasoning, tool activity, the source's session and its later replies did not transfer.",
      ].join("");
    case "fork-native-session":
      return "Forked by continuing the source's own session up to the reply it was forked from, with its messages and tool activity. The source's later replies did not transfer.";
  }
}

/** The part of a journaled merge delivery the transcript shows. */
export function forkMergeBackSummary(
  event: Extract<CodeOperationEvent, { readonly kind: "fork-context-delivered" }>,
): CodeForkMergeBack {
  const { kind: _kind, mergeOperationId: _merge, ...mergeBack } = event;
  return mergeBack;
}

/**
 * What a merge back carried into this turn and what it did not. It says the
 * fork's file changes did not come with it, so nobody mistakes merged
 * conversation for merged code.
 */
export function forkMergeBackDisclosure(mergeBack: CodeForkMergeBack): string {
  return [
    `Merged back ${count(mergeBack.messages, "message", "messages")} as text from a fork of this thread${mergeBack.afterOperationId === undefined ? "" : ", since its previous merge back"}.`,
    omissionsDisclosure(mergeBack),
    mergeBack.externalContentIngested ? " The fork has taken in outside content." : "",
    " Hidden reasoning, tool activity and the fork's file changes did not transfer; code reaches this thread only through Git review.",
  ].join("");
}

const MERGE_BACK_REFUSALS: Record<
  Extract<CodeForkMergeBackOutcome, { readonly status: "refused" }>["reason"],
  string
> = {
  unsupported: "This host cannot merge a fork's conversation back.",
  "not-a-fork": "This thread is not a fork, so there is nothing to merge back.",
  "source-unavailable": "The thread this was forked from is no longer available.",
  "source-unauthorized": "This window cannot reach the thread this was forked from.",
  "foreign-project": "The thread this was forked from is no longer in this Project.",
  "point-unavailable": "Only a finished reply of this fork can be merged back.",
  "already-merged": "This fork is already merged back through this reply.",
  "nothing-new": "Nothing readable is new in this fork since the fork point or its last merge back.",
  "fork-unreadable": "This fork's conversation could not be read. Try again.",
  unsaved: "The merge back could not be saved. Try again.",
};

/** What the person sees on the fork after asking to merge it back. */
export function forkMergeBackOutcomeMessage(outcome: CodeForkMergeBackOutcome): string {
  if (outcome.status === "refused") return MERGE_BACK_REFUSALS[outcome.reason];
  return `Merged ${count(outcome.messages, "message", "messages")} back into the thread this was forked from. Its next message carries them; nothing runs until then.`;
}

/** What the next message will do after the person picked a different provider. */
export function pendingProviderSwitchNotice(nextLabel: string, previousLabel: string): string {
  return `Your next message starts a new session on ${nextLabel}. Recent messages go as text; hidden reasoning and the ${previousLabel} session do not carry over.`;
}
