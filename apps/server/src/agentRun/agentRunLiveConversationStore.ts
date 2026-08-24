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

interface ConversationSubscriber {
  readonly runId: AgentRunId;
  afterSequence: number;
  readonly queue: AgentRunLiveConversationSnapshot[];
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve: (() => void) | undefined;
  closed: boolean;
}

const MAX_SUBSCRIBERS_PER_RUN = 8;
const MAX_PENDING_SUBSCRIBER_UPDATES = 32;

/**
 * Process-local live child transcript. It is deliberately not a projection or
 * journal: provider output is transient, purgeable, and never authoritative.
 * The persisted AgentRun result remains the only durable completion record.
 */
export class AgentRunLiveConversationStore {
  readonly #runs = new Map<AgentRunId, ConversationState>();
  readonly #subscribers = new Map<AgentRunId, Set<ConversationSubscriber>>();

  begin(runId: AgentRunId): void {
    this.clear(runId);
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
    this.#publish(runId);
  }

  complete(runId: AgentRunId): void {
    const state = this.#runs.get(runId);
    if (state?.status === "live") {
      state.status = "complete";
      this.#publish(runId);
    }
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
    this.#publish(runId);
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
    const subscribers = this.#subscribers.get(runId);
    if (subscribers === undefined) return;
    for (const subscriber of subscribers) {
      subscriber.closed = true;
      subscriber.resolve?.();
    }
    this.#subscribers.delete(runId);
  }

  /**
   * Subscribe to one process-local child transcript. The first yielded value
   * is a bounded snapshot after the requested cursor; later values are
   * incremental snapshots published by append/terminal transitions. The
   * subscriber is removed on abort, completion, or generator cancellation.
   */
  async *subscribe(input: {
    readonly runId: AgentRunId;
    readonly afterSequence?: number;
    readonly signal: AbortSignal;
  }): AsyncGenerator<AgentRunLiveConversationSnapshot> {
    const state = this.#runs.get(input.runId);
    if (state === undefined || input.signal.aborted) return;
    const subscribers = this.#subscribers.get(input.runId) ?? new Set();
    if (subscribers.size >= MAX_SUBSCRIBERS_PER_RUN) {
      yield {
        status: "stale",
        entries: [],
        truncated: false,
        staleReason: "Live child transcript has reached its subscriber limit; reconnect later.",
      };
      return;
    }
    const initial = this.read(input);
    if (initial === undefined) return;
    const subscriber: ConversationSubscriber = {
      runId: input.runId,
      afterSequence: input.afterSequence ?? 0,
      queue: [initial],
      signal: input.signal,
      onAbort: () => {
        subscriber.closed = true;
        subscriber.resolve?.();
      },
      resolve: undefined,
      closed: false,
    };
    const lastInitialSequence = initial.entries.at(-1)?.sequence;
    if (lastInitialSequence !== undefined) subscriber.afterSequence = lastInitialSequence;
    subscribers.add(subscriber);
    this.#subscribers.set(input.runId, subscribers);
    input.signal.addEventListener("abort", subscriber.onAbort, { once: true });
    try {
      for (;;) {
        if ((subscriber.closed && subscriber.queue.length === 0) || input.signal.aborted) return;
        const next = subscriber.queue.shift();
        if (next !== undefined) {
          yield next;
          if (next.status !== "live") return;
          continue;
        }
        await new Promise<void>((resolve) => {
          subscriber.resolve = resolve;
        });
        subscriber.resolve = undefined;
      }
    } finally {
      input.signal.removeEventListener("abort", subscriber.onAbort);
      subscriber.closed = true;
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.#subscribers.delete(input.runId);
    }
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

  #publish(runId: AgentRunId): void {
    const subscribers = this.#subscribers.get(runId);
    if (subscribers === undefined || subscribers.size === 0) return;
    for (const subscriber of subscribers) {
      if (subscriber.closed) continue;
      const snapshot = this.read({ runId, afterSequence: subscriber.afterSequence });
      if (snapshot === undefined) {
        subscriber.closed = true;
      } else {
        const lastSequence = snapshot.entries.at(-1)?.sequence;
        if (lastSequence !== undefined) subscriber.afterSequence = lastSequence;
        // Do not queue empty live deltas. Terminal snapshots are meaningful
        // even without entries and are therefore always delivered.
        if (snapshot.entries.length > 0 || snapshot.status !== "live") {
          if (subscriber.queue.length >= MAX_PENDING_SUBSCRIBER_UPDATES) {
            subscriber.queue.length = 0;
            subscriber.queue.push({
              ...snapshot,
              status: "stale",
              staleReason: "Live child transcript consumer fell behind; reconnect to continue.",
            });
            subscriber.closed = true;
            subscriber.resolve?.();
            continue;
          }
          subscriber.queue.push(snapshot);
        }
      }
      subscriber.resolve?.();
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
