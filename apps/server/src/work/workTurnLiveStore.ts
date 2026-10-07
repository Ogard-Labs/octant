import {
  decodeWorkTurnStreamFrame,
  type ThreadTaskProgressList,
  type WorkThreadId,
  type WorkTurnRequestId,
  type WorkTurnState,
  type WorkTurnStreamFrame,
} from "@octant/contracts";

interface ThreadFrames {
  nextSequence: number;
  frames: WorkTurnStreamFrame[];
  /** Requests whose announced retry no frame has cleared yet. */
  readonly retrying: Set<string>;
}

interface Subscriber {
  readonly queue: WorkTurnStreamFrame[];
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve: (() => void) | undefined;
  closed: boolean;
}

const DEFAULT_MAX_FRAMES_PER_THREAD = 256;
const MAX_SUBSCRIBERS_PER_THREAD = 8;
const MAX_PENDING_SUBSCRIBER_FRAMES = 32;

/**
 * Bounded process-local Work response feed.
 *
 * Durable transcript state remains in the journal projection. This feed only
 * removes the polling delay while a host process is alive; a gap or restart
 * explicitly sends the client back through the transcript snapshot.
 */
export class WorkTurnLiveStore {
  readonly #threads = new Map<WorkThreadId, ThreadFrames>();
  readonly #subscribers = new Map<WorkThreadId, Set<Subscriber>>();
  readonly #maxFramesPerThread: number;
  #closed = false;

  constructor(options: { readonly maxFramesPerThread?: number } = {}) {
    const maxFramesPerThread = options.maxFramesPerThread ?? DEFAULT_MAX_FRAMES_PER_THREAD;
    if (!Number.isSafeInteger(maxFramesPerThread) || maxFramesPerThread < 1) {
      throw new Error("Work turn replay frame bound must be a positive safe integer.");
    }
    this.#maxFramesPerThread = maxFramesPerThread;
  }

  head(threadId: WorkThreadId): number {
    return (this.#threads.get(threadId)?.nextSequence ?? 1) - 1;
  }

  appendResponse(threadId: WorkThreadId, requestId: WorkTurnRequestId, text: string): void {
    if (this.#closed || text.length === 0) return;
    const state = this.#state(threadId);
    this.#publish(
      threadId,
      decodeWorkTurnStreamFrame({
        kind: "response-delta",
        sequence: state.nextSequence,
        threadId,
        requestId,
        text,
      }),
    );
  }

  appendRetry(
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    notice: {
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly reason: "rate-limited" | "unavailable" | "stream-interrupted" | "empty-completion";
      readonly announcedAt: string;
    },
  ): void {
    if (this.#closed) return;
    const state = this.#state(threadId);
    state.retrying.add(String(requestId));
    this.#publish(
      threadId,
      decodeWorkTurnStreamFrame({
        kind: "provider-retry",
        sequence: state.nextSequence,
        threadId,
        requestId,
        attempt: notice.attempt,
        maxAttempts: notice.maxAttempts,
        delayMs: notice.delayMs,
        reason: notice.reason,
        announcedAt: notice.announcedAt,
      }),
    );
  }

  /** Says once that a retried request was answered; every later call is a no-op. */
  clearRetry(threadId: WorkThreadId, requestId: WorkTurnRequestId): void {
    if (this.#closed) return;
    const state = this.#state(threadId);
    if (!state.retrying.delete(String(requestId))) return;
    this.#publish(
      threadId,
      decodeWorkTurnStreamFrame({
        kind: "provider-retry-cleared",
        sequence: state.nextSequence,
        threadId,
        requestId,
      }),
    );
  }

  /** Publishes the provider's restated task list whole, so a late subscriber reads current state. */
  appendTasks(
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    tasks: ThreadTaskProgressList,
  ): void {
    if (this.#closed || tasks.length === 0) return;
    const state = this.#state(threadId);
    this.#publish(
      threadId,
      decodeWorkTurnStreamFrame({
        kind: "turn-tasks",
        sequence: state.nextSequence,
        threadId,
        requestId,
        tasks,
      }),
    );
  }

  settle(threadId: WorkThreadId, turn: WorkTurnState): void {
    if (this.#closed) return;
    const state = this.#state(threadId);
    state.retrying.delete(String(turn.requestId));
    this.#publish(
      threadId,
      decodeWorkTurnStreamFrame({
        kind: "turn-settled",
        sequence: state.nextSequence,
        threadId,
        turn,
      }),
    );
  }

  async *subscribe(input: {
    readonly threadId: WorkThreadId;
    readonly afterSequence: number;
    readonly signal: AbortSignal;
  }): AsyncGenerator<WorkTurnStreamFrame> {
    if (this.#closed || input.signal.aborted) return;
    const state = this.#state(input.threadId);
    const earliest = state.frames[0]?.sequence ?? state.nextSequence;
    if (input.afterSequence < earliest - 1 || input.afterSequence > this.head(input.threadId)) {
      yield this.#snapshotRequired(input.threadId);
      return;
    }
    const subscribers = this.#subscribers.get(input.threadId) ?? new Set();
    if (subscribers.size >= MAX_SUBSCRIBERS_PER_THREAD) {
      yield this.#snapshotRequired(input.threadId);
      return;
    }
    const replay = state.frames.filter((frame) => frame.sequence > input.afterSequence);
    if (replay.length > MAX_PENDING_SUBSCRIBER_FRAMES) {
      yield this.#snapshotRequired(input.threadId);
      return;
    }
    const subscriber: Subscriber = {
      queue: replay,
      signal: input.signal,
      onAbort: () => {
        subscriber.closed = true;
        subscriber.resolve?.();
      },
      resolve: undefined,
      closed: false,
    };
    subscribers.add(subscriber);
    this.#subscribers.set(input.threadId, subscribers);
    input.signal.addEventListener("abort", subscriber.onAbort, { once: true });
    try {
      for (;;) {
        if ((subscriber.closed && subscriber.queue.length === 0) || input.signal.aborted) return;
        const next = subscriber.queue.shift();
        if (next !== undefined) {
          yield next;
          if (next.kind === "snapshot-required") return;
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
      if (subscribers.size === 0) this.#subscribers.delete(input.threadId);
    }
  }

  close(): void {
    this.#closed = true;
    for (const [threadId, subscribers] of this.#subscribers) {
      for (const subscriber of subscribers) {
        subscriber.queue.length = 0;
        subscriber.queue.push(this.#snapshotRequired(threadId));
        subscriber.closed = true;
        subscriber.resolve?.();
      }
    }
  }

  #state(threadId: WorkThreadId): ThreadFrames {
    const existing = this.#threads.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadFrames = { nextSequence: 1, frames: [], retrying: new Set() };
    this.#threads.set(threadId, created);
    return created;
  }

  #publish(threadId: WorkThreadId, frame: WorkTurnStreamFrame): void {
    const state = this.#state(threadId);
    state.nextSequence = frame.sequence + 1;
    state.frames.push(frame);
    while (state.frames.length > this.#maxFramesPerThread) state.frames.shift();
    const subscribers = this.#subscribers.get(threadId);
    if (subscribers === undefined) return;
    for (const subscriber of subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= MAX_PENDING_SUBSCRIBER_FRAMES) {
        subscriber.queue.length = 0;
        subscriber.queue.push(this.#snapshotRequired(threadId));
        subscriber.closed = true;
      } else {
        subscriber.queue.push(frame);
      }
      subscriber.resolve?.();
    }
  }

  #snapshotRequired(threadId: WorkThreadId): WorkTurnStreamFrame {
    return decodeWorkTurnStreamFrame({
      kind: "snapshot-required",
      sequence: this.head(threadId),
      threadId,
    });
  }
}
