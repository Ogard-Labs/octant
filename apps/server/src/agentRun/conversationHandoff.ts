import {
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS,
  type ChatBranchConversationHandoff,
  type RewindConversationHandoff,
  type WorkForkConversationHandoff,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderSwitchConversationHandoff,
} from "@octant/contracts";
import type {
  AgentRunParentContextSelection,
  AgentRunParentContextUnavailableReason,
} from "./agentRunParentContext";

type Available = Extract<AgentRunParentContextSelection, { readonly status: "available" }>;

/**
 * The record a Chat or Work turn journals for a conversation handed to its new
 * provider session. Messages count the conversation carried, not the summary
 * block, and the two fixed `false` values state that Octant never moves a
 * provider's session or hidden reasoning to another provider.
 */
export function providerSwitchHandoffRecord(
  selection: Available,
  previous: { readonly providerInstanceId: ProviderInstanceId; readonly modelId: ProviderModelId },
): ProviderSwitchConversationHandoff {
  return {
    reason: "provider-switch",
    previousProviderInstanceId: previous.providerInstanceId,
    previousModelId: previous.modelId,
    messages: conversationMessages(selection),
    omissions: selection.omissions,
    externalContentIngested: selection.source.externalContentIngested,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
    ...(selection.blocks.filter((block) => block.kind === "conversation-summary").length > 1
      ? { handoverSummary: true }
      : {}),
  };
}

/** The blocks that carry a message of the conversation, not a summary of it. */
function conversationMessages(selection: Available): number {
  return selection.blocks.filter((block) => block.kind !== "conversation-summary").length;
}

/** The most blocks a handover summary may take, so most of a handoff stays verbatim. */
const MAX_HANDOVER_SUMMARY_BLOCKS = 3;

/**
 * Leads a provider switch's handoff with the summary the limit rule wrote with
 * the earlier provider, right after the handoff's own framing block. The
 * summary covers the whole thread, so where its blocks leave no room the
 * oldest verbatim messages give way and are counted as earlier messages; the
 * newest are always kept.
 */
export function withHandoverSummary(
  selection: Available,
  handover: { readonly content: string; readonly completedAt: string } | undefined,
): Available {
  const [framing, ...messages] = selection.blocks;
  if (handover === undefined || framing === undefined || messages.length === 0) return selection;
  const text =
    `Summary of this whole thread, written ${handover.completedAt} by the earlier provider ` +
    "when it neared a usage limit. The messages after it are the newest ones, verbatim.\n\n" +
    handover.content;
  const chunks: Array<string> = [];
  for (
    let start = 0;
    start < text.length && chunks.length < MAX_HANDOVER_SUMMARY_BLOCKS;
    start += MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS
  ) {
    chunks.push(text.slice(start, start + MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS));
  }
  const room = MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS - 1 - chunks.length;
  const dropped = Math.max(0, messages.length - room);
  return {
    ...selection,
    omissions: {
      ...selection.omissions,
      earlierMessages: selection.omissions.earlierMessages + dropped,
    },
    blocks: [
      framing,
      ...chunks.map((chunk) => ({ kind: "conversation-summary" as const, text: chunk })),
      ...messages.slice(dropped),
    ],
  };
}

export function branchHandoffRecord(selection: Available): ChatBranchConversationHandoff {
  return {
    reason: "branch",
    messages: conversationMessages(selection),
    omissions: selection.omissions,
    externalContentIngested: selection.source.externalContentIngested,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
  };
}

/**
 * The record a Work turn journals when it starts a new session for a reason
 * other than a provider change: the thread was rewound and its provider cannot
 * cut its own session back, or a fork runs its first own turn.
 */
export function restartHandoffRecord(
  selection: Available,
  reason: "rewind",
): RewindConversationHandoff;
export function restartHandoffRecord(
  selection: Available,
  reason: "fork",
): WorkForkConversationHandoff;
export function restartHandoffRecord(
  selection: Available,
  reason: "rewind" | "fork",
): RewindConversationHandoff | WorkForkConversationHandoff;
export function restartHandoffRecord(
  selection: Available,
  reason: "rewind" | "fork",
): RewindConversationHandoff | WorkForkConversationHandoff {
  return {
    reason,
    messages: conversationMessages(selection),
    omissions: selection.omissions,
    externalContentIngested: selection.source.externalContentIngested,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
  };
}

/**
 * Whether what the selector returned is the sending thread's own conversation,
 * in its own Project. A handoff is never another thread's or another Project's
 * that a reader happened to return.
 */
export function selectionBelongsToThread(
  selection: Available,
  thread: {
    readonly mode: "chat" | "work";
    readonly id: string;
    readonly projectId: string | undefined;
  },
): "ok" | "foreign-thread" | "foreign-project" {
  if (selection.source.mode !== thread.mode || selection.source.threadId !== thread.id)
    return "foreign-thread";
  if (selection.source.projectId !== thread.projectId) return "foreign-project";
  return "ok";
}

/**
 * Why a turn that needed its conversation handed to a new provider session did
 * not start. Each reason names what the person can do; none starts the new
 * provider without the handoff.
 */
export type ConversationHandoffRefusal =
  | AgentRunParentContextUnavailableReason
  | "unsupported"
  | "nothing-to-hand-over";

export function conversationHandoffRefusalMessage(
  reason: ConversationHandoffRefusal,
  subject: { readonly thread: "Chat" | "Work task"; readonly cause: "switch" | "branch" },
): string {
  const noun = subject.thread === "Chat" ? "This Chat" : "This Work task";
  const recovery =
    subject.cause === "branch"
      ? "Send the message from the original conversation instead."
      : `Switch back to the previous provider or start a new ${subject.thread === "Chat" ? "Chat" : "task"}.`;
  const target = subject.cause === "branch" ? "the branch's provider" : "the new provider";
  switch (reason) {
    case "unsupported":
      return `This host cannot hand a conversation to ${target}. ${recovery}`;
    case "nothing-to-hand-over":
      return `${noun} has no finished reply to hand to ${target}, so its provider could not continue it. ${recovery}`;
    case "thread-unavailable":
      return `${noun} is no longer available, so its conversation cannot be handed to ${target}.`;
    case "foreign-thread":
      return `The conversation read for the handoff does not belong to ${noun.toLowerCase()}, so nothing was handed over. ${recovery}`;
    case "foreign-project":
      return `The conversation read for the handoff does not belong to ${noun.toLowerCase()}'s Project, so nothing was handed over. ${recovery}`;
    case "source-point-unavailable":
      return `${noun} has no recorded conversation to hand to ${target}. ${recovery}`;
    case "source-empty":
      return `${noun} has no readable messages to hand to ${target}; earlier messages may have been removed. ${recovery}`;
    case "source-changed":
      return `${noun}'s conversation changed while it was being read for the handoff. Send the message again.`;
    case "source-unavailable":
    case "invalid-page":
      return `${noun}'s conversation could not be read for the handoff. Send the message again, or ${recovery.charAt(0).toLowerCase()}${recovery.slice(1)}`;
    case "history-window-exceeded":
      return `${noun}'s history is too long to choose recent messages to hand over. ${recovery}`;
  }
}
