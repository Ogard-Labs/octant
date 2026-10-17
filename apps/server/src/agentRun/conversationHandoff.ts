import type {
  ChatBranchConversationHandoff,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSwitchConversationHandoff,
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
    messages: selection.blocks.length - 1,
    omissions: selection.omissions,
    externalContentIngested: selection.source.externalContentIngested,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
  };
}

export function branchHandoffRecord(selection: Available): ChatBranchConversationHandoff {
  return {
    reason: "branch",
    messages: selection.blocks.length - 1,
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
