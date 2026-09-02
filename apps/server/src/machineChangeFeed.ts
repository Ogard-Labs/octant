import {
  decodeMachineChangeFrame,
  type MachineChangeFrame,
  type MachineChangeTopic,
} from "@octant/contracts/machine-changes";

interface Subscriber {
  readonly queue: MachineChangeFrame[];
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
  resolve: (() => void) | undefined;
  closed: boolean;
}

const DEFAULT_MAX_FRAMES = 256;
const MAX_SUBSCRIBERS = 32;
const MAX_PENDING_FRAMES = 32;

/** One bounded process-local invalidation feed shared by every product mode. */
export class MachineChangeFeed {
  readonly #frames: MachineChangeFrame[] = [];
  readonly #subscribers = new Set<Subscriber>();
  readonly #maxFrames: number;
  #nextSequence = 1;
  #closed = false;

  constructor(options: { readonly maxFrames?: number } = {}) {
    this.#maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  }

  head(): number {
    return this.#nextSequence - 1;
  }

  async waitFor(topic: MachineChangeTopic, signal: AbortSignal): Promise<void> {
    const afterSequence = this.head();
    for await (const frame of this.subscribe({ afterSequence, signal })) {
      if (frame.kind === "snapshot-required" || frame.topics.includes(topic)) return;
    }
  }

  publishCommitted(input: {
    readonly events: ReadonlyArray<{
      readonly aggregateType: string;
      readonly payload?: unknown;
    }>;
  }): void {
    const topics = new Set<MachineChangeTopic>();
    for (const event of input.events) {
      for (const topic of topicsForEvent(event)) topics.add(topic);
    }
    this.publish([...topics]);
  }

  publish(topics: ReadonlyArray<MachineChangeTopic>): void {
    if (this.#closed || topics.length === 0) return;
    const frame = decodeMachineChangeFrame({
      kind: "changed",
      sequence: this.#nextSequence,
      topics: [...new Set(topics)],
    });
    this.#nextSequence += 1;
    this.#frames.push(frame);
    while (this.#frames.length > this.#maxFrames) this.#frames.shift();
    for (const subscriber of this.#subscribers) {
      if (subscriber.closed) continue;
      if (subscriber.queue.length >= MAX_PENDING_FRAMES) {
        subscriber.queue.length = 0;
        subscriber.queue.push(this.#snapshotRequired());
        subscriber.closed = true;
      } else {
        subscriber.queue.push(frame);
      }
      subscriber.resolve?.();
    }
  }

  async *subscribe(input: {
    readonly afterSequence: number;
    readonly signal: AbortSignal;
  }): AsyncGenerator<MachineChangeFrame> {
    if (this.#closed || input.signal.aborted) return;
    const earliest = this.#frames[0]?.sequence ?? this.#nextSequence;
    if (input.afterSequence < earliest - 1 || input.afterSequence > this.head()) {
      yield this.#snapshotRequired();
      return;
    }
    if (this.#subscribers.size >= MAX_SUBSCRIBERS) {
      yield this.#snapshotRequired();
      return;
    }
    const subscriber: Subscriber = {
      queue: this.#frames.filter((frame) => frame.sequence > input.afterSequence),
      signal: input.signal,
      onAbort: () => {
        subscriber.closed = true;
        subscriber.resolve?.();
      },
      resolve: undefined,
      closed: false,
    };
    this.#subscribers.add(subscriber);
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
      this.#subscribers.delete(subscriber);
    }
  }

  close(): void {
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.queue.length = 0;
      subscriber.queue.push(this.#snapshotRequired());
      subscriber.closed = true;
      subscriber.resolve?.();
    }
  }

  #snapshotRequired(): MachineChangeFrame {
    return decodeMachineChangeFrame({
      kind: "snapshot-required",
      sequence: this.#nextSequence - 1,
    });
  }
}

function topicsForEvent(event: {
  readonly aggregateType: string;
  readonly payload?: unknown;
}): ReadonlyArray<MachineChangeTopic> {
  const { aggregateType } = event;
  if (aggregateType === "project") {
    return ["projects", "chat-navigation", "work-navigation", "code-navigation"];
  }
  if (aggregateType.startsWith("chat-")) return ["chat-navigation"];
  if (aggregateType.startsWith("work-")) return ["work-navigation"];
  if (aggregateType === "code-operation") {
    const kind = codeOperationEventKind(event.payload);
    return kind === undefined || CODE_NAVIGATION_EVENT_KINDS.has(kind) ? ["code-navigation"] : [];
  }
  if (aggregateType.startsWith("code-")) return ["code-navigation"];
  if (aggregateType.startsWith("extension-")) return ["extensions"];
  return [];
}

const CODE_NAVIGATION_EVENT_KINDS = new Set([
  "conversation-turn-started",
  "operation-state",
  "terminal-state-changed",
  "approval-requested",
  "input-requested",
  "operation-result",
]);

function codeOperationEventKind(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = Reflect.get(payload, "event");
  if (typeof event !== "object" || event === null) return undefined;
  const kind = Reflect.get(event, "kind");
  return typeof kind === "string" ? kind : undefined;
}
