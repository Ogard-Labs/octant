import {
  MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS,
  type AgentRunConversationEntry,
  type AgentRunConversationReadStatus,
  type AgentRunExecutionKind,
  type AgentRunLifecycleStatus,
  type ProviderCapabilitySupport,
  type UtcTimestamp,
} from "@octant/contracts";

const ACTIVE_WITHOUT_TRANSCRIPT: ReadonlySet<AgentRunLifecycleStatus> = new Set([
  "queued",
  "starting",
  "running",
  "waiting",
]);

export interface AgentRunConversationLiveSnapshot {
  readonly status: AgentRunConversationReadStatus;
  readonly entries: ReadonlyArray<AgentRunConversationEntry>;
  readonly truncated: boolean;
  readonly staleReason?: string;
}

export interface AgentRunConversationRetainedResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly occurredAt: UtcTimestamp;
}

export interface AgentRunConversationDisclosure {
  readonly status: AgentRunConversationReadStatus;
  readonly entries: ReadonlyArray<AgentRunConversationEntry>;
  readonly truncated: boolean;
  readonly staleReason?: string;
}

/**
 * Classify one server-authoritative child-conversation read.
 *
 * Live text is never journal authority: callers pass a process-local snapshot
 * and/or a host-retained result. Provider-native live text is refused unless
 * the host observed an equivalent transcript capability; a retained final
 * reply is host-owned and remains readable after the child has completed.
 * Missing live state for an active managed child is stale, never invented.
 */
export function resolveAgentRunConversationDisclosure(input: {
  readonly executionKind: AgentRunExecutionKind;
  readonly lifecycleStatus: AgentRunLifecycleStatus;
  readonly recoveryReason?: string;
  readonly nativeLiveTranscriptSupport?: ProviderCapabilitySupport;
  readonly live?: AgentRunConversationLiveSnapshot;
  readonly retained?: AgentRunConversationRetainedResult;
  readonly afterSequence?: number;
  readonly surface?: "snapshot" | "stream";
}): AgentRunConversationDisclosure {
  const afterSequence = input.afterSequence ?? 0;
  const nativeLivePermitted =
    input.executionKind !== "provider-native" || input.nativeLiveTranscriptSupport === "supported";

  if (input.live !== undefined && nativeLivePermitted) {
    return {
      status: input.live.status,
      entries: input.live.entries.filter((entry) => entry.sequence > afterSequence),
      truncated: input.live.truncated,
      ...(input.live.staleReason === undefined ? {} : { staleReason: input.live.staleReason }),
    };
  }

  if (input.retained !== undefined) {
    const bounded = boundRetainedEntry(input.retained);
    return {
      status: "complete",
      entries: afterSequence >= bounded.sequence ? [] : [bounded],
      truncated: input.retained.truncated || bounded.text.length < input.retained.text.length,
    };
  }

  if (!nativeLivePermitted) {
    return {
      status: "unavailable",
      entries: [],
      truncated: false,
      staleReason: "Provider-native child transcript is not available through this host.",
    };
  }

  const disconnected =
    ACTIVE_WITHOUT_TRANSCRIPT.has(input.lifecycleStatus) ||
    (input.lifecycleStatus === "interrupted" &&
      input.recoveryReason === "restart-without-resumable-execution");
  if (disconnected) {
    return {
      status: "stale",
      entries: [],
      truncated: false,
      staleReason:
        input.surface === "stream"
          ? "The child session is no longer connected to this host; reconnect to resume viewing."
          : "The child session is no longer connected to this host.",
    };
  }

  return {
    status: "unavailable",
    entries: [],
    truncated: false,
    staleReason: "No retained child conversation is available.",
  };
}

function boundRetainedEntry(
  retained: AgentRunConversationRetainedResult,
): AgentRunConversationEntry {
  const text =
    retained.text.length <= MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS
      ? retained.text
      : retained.text.slice(0, MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS);
  return {
    sequence: 1,
    kind: "assistant",
    text,
    occurredAt: retained.occurredAt,
  };
}
