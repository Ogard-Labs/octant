/**
 * Ends a person's snooze when the turn a side task's report started fails. The
 * report's turn runs under the snooze, so without this its failure would stay
 * hidden until the wake time. Each mode says in its own journal how a turn
 * ended: a turn the person stopped is not a failure. Chat records that as
 * `cancelled`; Code's `interrupted` is the person's only after the Stop marker
 * it journals first, and a provider that exits mid-turn is a failure. A turn a
 * restart cut off is left to restart recovery, which may still continue it:
 * recovery journals its `interrupted` after this listens, so an `interrupted`
 * counts only for a turn this host saw start.
 */
import {
  decodeChatAttemptUpdated,
  decodeCodeOperationEventFrame,
  decodeWorkTurnUpdated,
  type ChatThreadId,
  type CodeOperationId,
  type CodeThreadId,
  type EventEnvelope,
  type ThreadDeliveryMark,
  type WorkThreadId,
  type WorkTurnRequestId,
} from "@octant/contracts";

type ReadMark = ThreadDeliveryMark | undefined;

export interface SideTaskReportFailureWakePorts {
  /** The delivery mark of the named turn, as its mode journaled it. */
  readonly chatTurnMark: (threadId: ChatThreadId, turnId: string) => ReadMark;
  readonly workTurnMark: (requestId: WorkTurnRequestId) => ReadMark;
  readonly codeTurnMark: (threadId: CodeThreadId, operationId: CodeOperationId) => ReadMark;
  readonly wakeChat: (threadId: ChatThreadId) => void;
  readonly wakeWork: (threadId: WorkThreadId) => void;
  readonly wakeCode: (threadId: CodeThreadId) => void;
  readonly onError?: (message: string, error: unknown) => void;
}

// The fields that tell a failed turn apart, read before a whole event is
// decoded: most events a turn journals are its progress.
interface ChatAttemptPeek {
  readonly attempt?: {
    readonly id?: string;
    readonly turnId?: string;
    readonly outcome?: string;
    readonly failure?: { readonly code?: string };
  };
}

interface ChatTurnPeek {
  readonly turn?: {
    readonly id?: string;
    readonly delivery?: { readonly kind?: string };
    readonly attempts?: ReadonlyArray<{ readonly id?: string }>;
  };
}

interface WorkTurnPeek {
  readonly status?: string;
}

interface CodeFramePeek {
  readonly operationId?: unknown;
  readonly event?: {
    readonly kind?: string;
    readonly state?: string;
    readonly delivery?: { readonly kind?: string };
    readonly result?: { readonly kind?: string; readonly state?: string };
  };
}

/** How a Code frame ends its turn, if it does: `interrupted` may be a Stop. */
function codeFrameEnd(payload: unknown): "failed" | "interrupted" | "other" | undefined {
  const event = (payload as CodeFramePeek | undefined)?.event;
  const state =
    event?.kind === "operation-state"
      ? event.state
      : event?.kind === "operation-result"
        ? event.result?.kind === "operation-failed"
          ? "failed"
          : event.result?.kind === "provider-turn-state"
            ? event.result.state
            : undefined
        : undefined;
  if (state === undefined || state === "running" || state === "waiting") return undefined;
  return state === "failed" || state === "interrupted" ? state : "other";
}

function isCodeStopRequest(payload: unknown): boolean {
  return (payload as CodeFramePeek | undefined)?.event?.kind === "conversation-turn-stop-requested";
}

export class SideTaskReportFailureWake {
  readonly #ports: SideTaskReportFailureWakePorts;
  /** Code turns a person asked to stop, until their end is journaled. */
  readonly #codeStops = new Set<string>();
  /**
   * Report turns that started in this host: Chat attempts and Code operations
   * until they end, and the Chat turns whose retries start new attempts. Only
   * report turns are kept, so a turn that never ends holds little.
   */
  readonly #startedHere = new Set<string>();

  constructor(ports: SideTaskReportFailureWakePorts) {
    this.#ports = ports;
  }

  /** Feed committed journal appends. */
  onCommittedEvents(events: ReadonlyArray<EventEnvelope>): void {
    for (const event of events) {
      try {
        const wake = this.#wakeFor(event);
        // Written after the append that reported the failure has finished.
        if (wake !== undefined) queueMicrotask(() => this.#run(wake));
      } catch (error) {
        this.#ports.onError?.("A failed report turn could not be read.", error);
      }
    }
  }

  #run(wake: () => void): void {
    try {
      wake();
    } catch (error) {
      this.#ports.onError?.("A failed report turn could not end its thread's snooze.", error);
    }
  }

  #wakeFor(event: EventEnvelope): (() => void) | undefined {
    const ports = this.#ports;
    const isReport = (mark: ReadMark): boolean => mark?.kind === "side-task-report";
    if (event.eventName === "chat.turn-created@1") {
      const turn = (event.payload as ChatTurnPeek | undefined)?.turn;
      if (turn?.delivery?.kind !== "side-task-report" || turn.id === undefined) return undefined;
      this.#startedHere.add(`chat-turn:${turn.id}`);
      for (const attempt of turn.attempts ?? [])
        if (attempt.id !== undefined) this.#startedHere.add(`chat:${attempt.id}`);
      return undefined;
    }
    if (event.eventName === "chat.attempt-updated@1") {
      // A stopped Chat answer is `cancelled`; `interrupted` is the host's or
      // the provider's doing, which is a failure to the person.
      const peek = (event.payload as ChatAttemptPeek | undefined)?.attempt;
      const key = `chat:${peek?.id ?? ""}`;
      if (peek?.outcome === "queued" || peek?.outcome === "streaming") {
        if (this.#startedHere.has(`chat-turn:${peek.turnId ?? ""}`)) this.#startedHere.add(key);
        return undefined;
      }
      // Parked on a question the attempt is still live; only its end counts.
      if (peek?.outcome === "waiting") return undefined;
      const startedHere = this.#startedHere.delete(key);
      if (peek?.outcome !== "failed" && peek?.outcome !== "interrupted") return undefined;
      // A Stop the provider never confirmed is still the person's Stop.
      if (peek.failure?.code === "stop-unconfirmed") return undefined;
      if (peek.outcome === "interrupted" && !startedHere) return undefined;
      const { attempt } = decodeChatAttemptUpdated(event.payload);
      return isReport(ports.chatTurnMark(attempt.threadId, String(attempt.turnId)))
        ? () => ports.wakeChat(attempt.threadId)
        : undefined;
    }
    if (event.eventName === "work.turn-updated@1") {
      if ((event.payload as WorkTurnPeek | undefined)?.status !== "failed") return undefined;
      const turn = decodeWorkTurnUpdated(event.payload);
      // A fork carries its source's turns; nothing ran in it.
      if (turn.carried === true) return undefined;
      return isReport(ports.workTurnMark(turn.requestId))
        ? () => ports.wakeWork(turn.threadId)
        : undefined;
    }
    if (event.eventName === "code.operation-event-recorded@1") {
      // Only the operation is read: the start is the turn's largest frame.
      const peek = event.payload as CodeFramePeek | undefined;
      const operation = typeof peek?.operationId === "string" ? peek.operationId : undefined;
      if (isCodeStopRequest(event.payload)) {
        if (operation !== undefined && this.#startedHere.has(`code:${operation}`))
          this.#codeStops.add(operation);
        return undefined;
      }
      if (peek?.event?.kind === "conversation-turn-started") {
        if (operation !== undefined && peek.event.delivery?.kind === "side-task-report")
          this.#startedHere.add(`code:${operation}`);
        return undefined;
      }
      const end = codeFrameEnd(event.payload);
      if (end === undefined) return undefined;
      const frame = decodeCodeOperationEventFrame(event.payload);
      const stopped = this.#codeStops.delete(String(frame.operationId));
      const startedHere = this.#startedHere.delete(`code:${String(frame.operationId)}`);
      if (end === "other" || (end === "interrupted" && (stopped || !startedHere))) return undefined;
      return isReport(ports.codeTurnMark(frame.threadId, frame.operationId))
        ? () => ports.wakeCode(frame.threadId)
        : undefined;
    }
    return undefined;
  }
}
