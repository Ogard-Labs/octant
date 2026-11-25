/**
 * Ends a person's snooze when the turn a side task's report started fails. The
 * report's turn runs under the snooze, so without this its failure would stay
 * hidden until the wake time. Each mode says in its own journal how a turn
 * ended: a turn the person stopped is not a failure. Chat records that as
 * `cancelled`; Code's `interrupted` is the person's only after the Stop marker
 * it journals first, and a provider that exits mid-turn is a failure. A turn a
 * restart cut off is left to restart recovery, which may still continue it.
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
  readonly attempt?: { readonly outcome?: string; readonly failure?: { readonly code?: string } };
}

interface WorkTurnPeek {
  readonly status?: string;
}

interface CodeFramePeek {
  readonly event?: {
    readonly kind?: string;
    readonly state?: string;
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
    if (event.eventName === "chat.attempt-updated@1") {
      // A stopped Chat answer is `cancelled`; `interrupted` is the host's or
      // the provider's doing, which is a failure to the person.
      // A Stop the provider never confirmed is still the person's Stop.
      const peek = (event.payload as ChatAttemptPeek | undefined)?.attempt;
      if (peek?.outcome !== "failed" && peek?.outcome !== "interrupted") return undefined;
      if (peek.failure?.code === "stop-unconfirmed") return undefined;
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
      if (isCodeStopRequest(event.payload)) {
        this.#codeStops.add(String(decodeCodeOperationEventFrame(event.payload).operationId));
        return undefined;
      }
      const end = codeFrameEnd(event.payload);
      if (end === undefined) return undefined;
      const frame = decodeCodeOperationEventFrame(event.payload);
      const stopped = this.#codeStops.delete(String(frame.operationId));
      if (end === "other" || (end === "interrupted" && stopped)) return undefined;
      return isReport(ports.codeTurnMark(frame.threadId, frame.operationId))
        ? () => ports.wakeCode(frame.threadId)
        : undefined;
    }
    return undefined;
  }
}
