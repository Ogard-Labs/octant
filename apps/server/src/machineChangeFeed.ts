import {
  BROWSER_CAPTURE_AGGREGATE_TYPE,
  CONTEXT_COMPACTION_EVENT_NAMES,
  IMAGE_JOB_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_AGGREGATE_TYPE,
  NATIVE_HARNESS_SESSION_EVENT_NAMES,
  THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE,
  THREAD_RETENTION_EVENT_NAMES,
  THREAD_SIDE_TASKS_AGGREGATE_TYPE,
} from "@octant/contracts";
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
  readonly #childQuestionIds = new Set<string>();
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
      readonly eventName?: string;
      readonly payload?: unknown;
    }>;
  }): void {
    const topics = new Set<MachineChangeTopic>();
    for (const event of input.events) {
      for (const topic of topicsForEvent(event)) topics.add(topic);
      if (this.#auxiliaryDurableListsChanged(event)) {
        topics.add("browser-captures");
        topics.add("thread-follow-ups");
        topics.add("thread-message-queue");
      }
      if (this.#approvalChanged(event)) {
        topics.add("chat-navigation");
        topics.add("work-navigation");
        topics.add("code-navigation");
      } else if (this.#childQuestionChanged(event)) {
        topics.add("work-navigation");
        topics.add("code-navigation");
      }
    }
    this.publish([...topics]);
  }

  /**
   * Whether this event removes a thread's durable captures, follow-up offers,
   * or message queue. A delete or purge must not leave those lists serving a
   * thread that is gone; ordinary text deltas never land here, so they stay
   * off the auxiliary topics.
   */
  #auxiliaryDurableListsChanged(event: {
    readonly aggregateType: string;
    readonly eventName?: string;
  }): boolean {
    return (
      event.eventName === "chat.deleted@1" ||
      event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged
    );
  }

  /**
   * Whether this event asks or settles a harness approval, the agent's own or a
   * subagent's. Either one moves the thread's sidebar mark, board status, and
   * Needs you row, and a settle can come from a surface or a resume that never
   * saw the ask (an approval a restart left behind), so none is filtered.
   */
  #approvalChanged(event: {
    readonly aggregateType: string;
    readonly eventName?: string;
  }): boolean {
    if (event.aggregateType !== NATIVE_HARNESS_SESSION_AGGREGATE_TYPE) return false;
    const names = NATIVE_HARNESS_SESSION_EVENT_NAMES;
    return event.eventName === names.approvalAsked || event.eventName === names.approvalSettled;
  }

  /**
   * Whether this event asks or settles a question a subagent made. Only those
   * reach the navigation reads: the lead's own question is answered where it is
   * asked. An ask names its subagent in `source`; a settle names only the
   * question, so the ask's id is remembered until its settle, which every ask
   * reaches (answered, expired, or cancelled).
   */
  #childQuestionChanged(event: {
    readonly aggregateType: string;
    readonly eventName?: string;
    readonly payload?: unknown;
  }): boolean {
    if (event.aggregateType !== NATIVE_HARNESS_SESSION_AGGREGATE_TYPE) return false;
    const payload = event.payload as
      | { readonly id?: unknown; readonly source?: unknown; readonly questionId?: unknown }
      | null
      | undefined;
    if (payload === undefined || payload === null) return false;
    const names = NATIVE_HARNESS_SESSION_EVENT_NAMES;
    if (event.eventName === names.questionAsked) {
      if (payload.source === undefined) return false;
      this.#childQuestionIds.add(String(payload.id));
      return true;
    }
    if (event.eventName === names.questionSettled) {
      return this.#childQuestionIds.delete(String(payload.questionId));
    }
    return false;
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
    const replay = this.#frames.filter((frame) => frame.sequence > input.afterSequence);
    if (replay.length > MAX_PENDING_FRAMES) {
      yield this.#snapshotRequired();
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
  readonly eventName?: string;
  readonly payload?: unknown;
}): ReadonlyArray<MachineChangeTopic> {
  const { aggregateType } = event;
  if (aggregateType === BROWSER_CAPTURE_AGGREGATE_TYPE) return ["browser-captures"];
  if (
    aggregateType === THREAD_SIDE_TASKS_AGGREGATE_TYPE ||
    aggregateType === THREAD_FOLLOW_UP_SUGGESTIONS_AGGREGATE_TYPE
  )
    return ["thread-follow-ups"];
  if (
    aggregateType === NATIVE_HARNESS_SESSION_AGGREGATE_TYPE &&
    (event.eventName === NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpsSuggested ||
      event.eventName === NATIVE_HARNESS_SESSION_EVENT_NAMES.followUpActivated)
  )
    return ["thread-follow-ups"];
  if (aggregateType === "thread-message-queue") return ["thread-message-queue"];
  if (aggregateType === "project") {
    return ["projects", "chat-navigation", "work-navigation", "code-navigation"];
  }
  if (aggregateType.startsWith("chat-")) return ["chat-navigation"];
  // A compaction of a Chat session ends on the thread's context ledger, and
  // its outcome rides the thread's held stream, which wakes on Chat changes.
  if (aggregateType === "context-ledger") {
    return compactionOutcomeSubjectType(event) === "chat-thread" ? ["chat-navigation"] : [];
  }
  if (aggregateType.startsWith("work-")) return ["work-navigation"];
  if (aggregateType === "code-operation") {
    const kind = codeOperationEventKind(event.payload);
    return kind === undefined || CODE_NAVIGATION_EVENT_KINDS.has(kind) ? ["code-navigation"] : [];
  }
  if (aggregateType.startsWith("code-")) return ["code-navigation"];
  if (aggregateType.startsWith("extension-")) return ["extensions"];
  // The agent's image tool queues and finishes jobs outside any request the
  // renderer made, so the thread learns of them here rather than on a timer.
  if (aggregateType === IMAGE_JOB_AGGREGATE_TYPE) return ["image-jobs"];
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

function compactionOutcomeSubjectType(event: {
  readonly eventName?: string;
  readonly payload?: unknown;
}): string | undefined {
  const { eventName, payload } = event;
  if (typeof payload !== "object" || payload === null) return undefined;
  const ended =
    eventName === CONTEXT_COMPACTION_EVENT_NAMES.completed
      ? Reflect.get(payload, "receipt")
      : eventName === CONTEXT_COMPACTION_EVENT_NAMES.failed
        ? payload
        : undefined;
  if (typeof ended !== "object" || ended === null) return undefined;
  const subject = Reflect.get(ended, "subject");
  if (typeof subject !== "object" || subject === null) return undefined;
  const aggregateType = Reflect.get(subject, "aggregateType");
  return typeof aggregateType === "string" ? aggregateType : undefined;
}

function codeOperationEventKind(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const event = Reflect.get(payload, "event");
  if (typeof event !== "object" || event === null) return undefined;
  const kind = Reflect.get(event, "kind");
  return typeof kind === "string" ? kind : undefined;
}
