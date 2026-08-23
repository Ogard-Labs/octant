import {
  MAX_AGENT_RUN_CONVERSATION_BYTES,
  MAX_AGENT_RUN_CONVERSATION_ENTRIES,
  MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS,
  type AgentRunConversationEntry,
  type AgentRunConversationReadStatus,
  type AgentRunId,
  type UtcTimestamp,
} from "@octant/contracts";

const encoder = new TextEncoder();

export interface AgentRunLiveConversationSnapshot {
  readonly status: AgentRunConversationReadStatus;
  readonly entries: ReadonlyArray<AgentRunConversationEntry>;
  readonly truncated: boolean;
  readonly staleReason?: string;
}

interface ConversationState {
  status: "live" | "complete" | "stale";
  entries: AgentRunConversationEntry[];
  nextSequence: number;
  bytes: number;
  truncated: boolean;
  staleReason?: string;
}

/**
 * Process-local live child transcript. It is deliberately not a projection or
 * journal: provider output is transient, purgeable, and never authoritative.
 * The persisted AgentRun result remains the only durable completion record.
 */
export class AgentRunLiveConversationStore {
  readonly #runs = new Map<AgentRunId, ConversationState>();

  begin(runId: AgentRunId): void {
    this.#runs.set(runId, {
      status: "live",
      entries: [],
      nextSequence: 1,
      bytes: 0,
      truncated: false,
    });
  }

  appendText(runId: AgentRunId, text: string, occurredAt: UtcTimestamp): void {
    const state = this.#runs.get(runId);
    if (state === undefined || state.status !== "live") return;
    const bounded = takeUtf8Prefix(text, MAX_AGENT_RUN_CONVERSATION_ENTRY_CHARACTERS);
    if (bounded.trim().length === 0) return;
    if (bounded.length < text.length) state.truncated = true;
    const entry: AgentRunConversationEntry = {
      sequence: state.nextSequence,
      kind: "assistant",
      text: bounded,
      occurredAt,
    };
    state.nextSequence += 1;
    state.entries.push(entry);
    state.bytes += entryBytes(entry);
    this.#trim(state);
  }

  complete(runId: AgentRunId): void {
    const state = this.#runs.get(runId);
    if (state?.status === "live") state.status = "complete";
  }

  markStale(runId: AgentRunId, reason: string): void {
    const state = this.#runs.get(runId);
    if (state === undefined) {
      this.#runs.set(runId, {
        status: "stale",
        entries: [],
        nextSequence: 1,
        bytes: 0,
        truncated: false,
        staleReason: boundReason(reason),
      });
      return;
    }
    state.status = "stale";
    state.staleReason = boundReason(reason);
  }

  read(input: {
    readonly runId: AgentRunId;
    readonly afterSequence?: number;
  }): AgentRunLiveConversationSnapshot | undefined {
    const state = this.#runs.get(input.runId);
    if (state === undefined) return undefined;
    const entries =
      input.afterSequence === undefined
        ? state.entries
        : state.entries.filter((entry) => {
            const afterSequence = input.afterSequence;
            return afterSequence !== undefined && entry.sequence > afterSequence;
          });
    return {
      status: state.status,
      entries: [...entries],
      truncated: state.truncated,
      ...(state.staleReason === undefined ? {} : { staleReason: state.staleReason }),
    };
  }

  clear(runId: AgentRunId): void {
    this.#runs.delete(runId);
  }

  #trim(state: ConversationState): void {
    while (
      state.entries.length > MAX_AGENT_RUN_CONVERSATION_ENTRIES ||
      state.bytes > MAX_AGENT_RUN_CONVERSATION_BYTES
    ) {
      const removed = state.entries.shift();
      if (removed === undefined) break;
      state.bytes -= entryBytes(removed);
      state.truncated = true;
    }
  }
}

function entryBytes(entry: AgentRunConversationEntry): number {
  return encoder.encode(JSON.stringify(entry)).byteLength;
}

function takeUtf8Prefix(value: string, maxCharacters: number): string {
  let bounded = value.slice(0, maxCharacters);
  while (
    bounded.length > 0 &&
    encoder.encode(JSON.stringify({ text: bounded })).byteLength > MAX_AGENT_RUN_CONVERSATION_BYTES
  ) {
    bounded = bounded.slice(0, Math.max(0, bounded.length - 256));
  }
  return bounded;
}

function boundReason(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? "Live child conversation is stale." : trimmed.slice(0, 512);
}
