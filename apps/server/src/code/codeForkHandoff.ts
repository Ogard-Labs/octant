import type { CodeThread, CodeThreadForkOrigin } from "@octant/contracts";
import type {
  AgentRunParentContextSelection,
  AgentRunParentContextUnavailableReason,
} from "../agentRun/agentRunParentContext";

/**
 * Reads the conversation a fork carries over as text: the source thread's
 * accepted prompts and completed replies through the fork point, through the
 * same bounded selector a child's parent context and a provider switch use.
 * The host wires it; a host without it cannot carry a conversation into a
 * fork, so forks refuse rather than start from nothing.
 */
export type CodeForkConversationReader = (input: {
  readonly source: CodeThread;
  readonly throughOperationId: string;
}) => AgentRunParentContextSelection;

export type CodeForkHandoffRefusal =
  | AgentRunParentContextUnavailableReason
  | "unsupported"
  | "source-unauthorized"
  | "handoff-unreadable"
  | "handoff-unsaved";

/**
 * Why a fork could not carry its source's conversation. Each says what the
 * person can do; none lets a fork start as if it inherited a conversation it
 * was never given.
 */
export const CODE_FORK_HANDOFF_REFUSALS: Readonly<Record<CodeForkHandoffRefusal, string>> = {
  unsupported: "This host cannot carry a conversation into a fork. Start a new task instead.",
  "thread-unavailable":
    "The thread this was forked from is no longer available, so its conversation cannot be carried into the fork.",
  "source-unauthorized":
    "This window cannot read the thread this was forked from, so nothing was carried into the fork.",
  "foreign-thread":
    "The conversation read for the fork does not belong to the thread it was forked from, so nothing was carried over.",
  "foreign-project":
    "The thread this was forked from is not in this task's Project, so nothing was carried over.",
  "source-point-unavailable":
    "The reply this was forked from is no longer in its thread's recorded conversation, so nothing can be carried into the fork.",
  "source-empty":
    "The conversation up to the fork point has no readable messages; earlier messages may have been removed. Start a new task instead.",
  "source-changed":
    "The thread this was forked from changed while it was being read for the fork. Try again.",
  "source-unavailable": "The conversation this was forked from could not be read. Try again.",
  "invalid-page":
    "The conversation this was forked from could not be read consistently. Try again.",
  "history-window-exceeded":
    "The conversation up to the fork point is too long to choose recent messages from. Start a new task instead.",
  "handoff-unreadable":
    "The conversation this fork was prepared with can no longer be read. Send the message again.",
  "handoff-unsaved":
    "The conversation carried into the fork could not be saved, so the message was not sent. Send it again.",
};

/**
 * Select a fork's text handoff and check that what came back is the named
 * source's, in the fork's Project. The reader is handed the source, but a
 * handoff is never another thread's or another Project's conversation that a
 * reader happened to return. Callers authorize the window against the source
 * before calling.
 */
export function selectCodeForkHandoff(
  read: CodeForkConversationReader | undefined,
  input: {
    readonly source: CodeThread;
    readonly origin: CodeThreadForkOrigin;
    readonly projectId: CodeThread["projectId"];
  },
):
  | {
      readonly status: "available";
      readonly selection: Extract<AgentRunParentContextSelection, { readonly status: "available" }>;
    }
  | { readonly status: "refused"; readonly reason: CodeForkHandoffRefusal } {
  if (read === undefined) return { status: "refused", reason: "unsupported" };
  if (String(input.source.id) !== String(input.origin.threadId))
    return { status: "refused", reason: "foreign-thread" };
  if (String(input.source.projectId) !== String(input.projectId))
    return { status: "refused", reason: "foreign-project" };
  let selection: AgentRunParentContextSelection;
  try {
    selection = read({
      source: input.source,
      throughOperationId: String(input.origin.throughOperationId),
    });
  } catch {
    return { status: "refused", reason: "source-unavailable" };
  }
  if (selection.status === "unavailable") return { status: "refused", reason: selection.reason };
  if (
    selection.source.mode !== "code" ||
    selection.source.threadId !== String(input.origin.threadId)
  )
    return { status: "refused", reason: "foreign-thread" };
  if (selection.source.projectId !== String(input.projectId))
    return { status: "refused", reason: "foreign-project" };
  return { status: "available", selection };
}
