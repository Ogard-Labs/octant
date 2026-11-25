/**
 * The host's delivery of owed side-task reports into their offering thread.
 * A turn that ends in a side-task child owes its parent a journaled turn
 * carrying the report — this service watches committed appends, dispatches
 * through the parent mode's ordinary turn admission, and journals how the
 * delivery settled. A dispatch the parent cannot take yet — its own turn is
 * running, or its mode is turned off — stays armed and re-fires when the
 * parent's aggregate commits again or the retry cadence arrives. Nothing is
 * polled away: a report still owed at boot is found in the store and
 * delivered like one that was owed live, and a parent that can never take it
 * settles the reports as refused rather than retrying forever.
 */
import {
  CONTEXT_COMPACTION_EVENT_NAMES,
  decodeCodeOperationEventFrame,
  decodeContextCompactionCompleted,
  decodeContextCompactionFailed,
  decodeSideTaskReportOwed,
  decodeThreadRetentionThreadPurged,
  decodeWorkTurnUpdated,
  MAX_SIDE_TASK_REPORT_DELIVERY_BATCH_SIZE,
  THREAD_RETENTION_EVENT_NAMES,
  THREAD_SIDE_TASK_REPORT_EVENT_NAMES,
  type CommittedAppend,
  type EventEnvelope,
  type SideTaskReportOwed,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { SideTaskReportStore } from "./sideTaskReportStore";
import type { SideTaskReportDeliveryModePort } from "./sideTaskReportDeliveryPorts";
import { fitSideTaskReportDeliveryBatch } from "./sideTaskReportDeliveryPrompt";

/** One report still owed its parent, as the store's undelivered reads return it. */
export interface OwedSideTaskReport {
  readonly childThreadId: string;
  readonly report: SideTaskReportOwed;
}

export interface SideTaskReportDeliveryPorts {
  readonly chat: SideTaskReportDeliveryModePort;
  readonly work: SideTaskReportDeliveryModePort;
  readonly code: SideTaskReportDeliveryModePort;
}

export type SideTaskReportDeliveryTimerHandle = unknown;

interface PendingParent {
  readonly parentThreadId: string;
  timer: SideTaskReportDeliveryTimerHandle | undefined;
  evaluating: boolean;
}

interface SideTaskReportDeliveryServiceOptions {
  readonly journal: Pick<Journal, "subscribeCommitted">;
  readonly reports: Pick<
    SideTaskReportStore,
    | "undelivered"
    | "undeliveredForParent"
    | "reportsForParent"
    | "markDelivered"
    | "markRefused"
    | "refuseOwedFrom"
    | "forgetPurgedThread"
  >;
  readonly ports: SideTaskReportDeliveryPorts;
  readonly clock: () => Date;
  /** Injectable so tests drive the retry cadence by hand. */
  readonly schedule?: (atEpochMs: number, fire: () => void) => SideTaskReportDeliveryTimerHandle;
  readonly unschedule?: (handle: SideTaskReportDeliveryTimerHandle) => void;
  /** How long a deferred dispatch waits before retrying. */
  readonly retryAfterMs?: number;
  readonly onError?: (message: string, error: unknown) => void;
}

const DEFER_RETRY_AFTER_MS = 30_000;

const portFor = (
  ports: SideTaskReportDeliveryPorts,
  mode: SideTaskReportOwed["parentMode"],
): SideTaskReportDeliveryModePort => {
  switch (mode) {
    case "chat":
      return ports.chat;
    case "work":
      return ports.work;
    case "code":
      return ports.code;
  }
};

export class SideTaskReportDeliveryService {
  readonly #options: SideTaskReportDeliveryServiceOptions;
  readonly #pending = new Map<string, PendingParent>();

  constructor(options: SideTaskReportDeliveryServiceOptions) {
    this.#options = options;
  }

  /**
   * Arm every report the store still owes a delivery for. A report owed while
   * the host was away is found here and delivered exactly like one owed live.
   */
  start(): void {
    const parents = new Set<string>();
    for (const entry of this.#options.reports.undelivered()) {
      parents.add(String(entry.report.parentThreadId));
    }
    for (const parentThreadId of parents) this.#arm(parentThreadId);
  }

  stop(): void {
    for (const pending of this.#pending.values()) {
      this.#clearTimer(pending);
    }
    this.#pending.clear();
  }

  /** The single entry point `journal.subscribeCommitted` feeds. */
  onCommittedAppend(append: CommittedAppend): void {
    for (const event of append.events) {
      this.#onCommittedEvent(event);
    }
  }

  #onCommittedEvent(event: EventEnvelope): void {
    if (event.eventName === THREAD_SIDE_TASK_REPORT_EVENT_NAMES.owed) {
      try {
        const report = decodeSideTaskReportOwed(event.payload);
        this.#arm(String(report.parentThreadId));
      } catch (error) {
        this.#options.onError?.("Side-task report event did not decode.", error);
      }
      return;
    }
    if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
      try {
        const { threadId } = decodeThreadRetentionThreadPurged(event.payload);
        this.#options.reports.forgetPurgedThread(String(threadId));
      } catch (error) {
        this.#options.onError?.("Side-task report delivery could not decode a purge.", error);
      }
      return;
    }
    if (event.eventName === "chat.deleted@1") {
      try {
        this.#options.reports.refuseOwedFrom(
          event.aggregateId,
          "The side task's thread was deleted.",
        );
      } catch (error) {
        this.#options.onError?.("A deleted side task's reports could not be settled.", error);
      }
    }
    this.#watchParent(event);
  }

  /**
   * A deferred delivery re-fires when its parent thread's aggregate commits —
   * the active turn settling is exactly such a commit. Code turns journal on
   * their own `code-operation` aggregates, so their frames name the thread
   * for the same wake, and a compaction that held the parent's turns ends on
   * the thread's context ledger, which names it as the subject. A Work turn
   * journals on its own `work-turn` aggregate; only its end can free the
   * parent, so what it streams on the way is passed by.
   */
  #watchParent(event: EventEnvelope): void {
    const candidates: ReadonlyArray<string> = (() => {
      if (
        event.aggregateType === "code-operation" &&
        event.eventName === "code.operation-event-recorded@1"
      ) {
        try {
          return [String(decodeCodeOperationEventFrame(event.payload).threadId)];
        } catch (error) {
          this.#options.onError?.(
            "Side-task report delivery could not decode a code frame.",
            error,
          );
          return [];
        }
      }
      if (event.aggregateType === "work-turn" && event.eventName === "work.turn-updated@1") {
        try {
          const turn = decodeWorkTurnUpdated(event.payload);
          return turn.status === "running" ? [] : [String(turn.threadId)];
        } catch (error) {
          this.#options.onError?.("Side-task report delivery could not decode a Work turn.", error);
          return [];
        }
      }
      if (
        event.aggregateType === "context-ledger" &&
        (event.eventName === CONTEXT_COMPACTION_EVENT_NAMES.completed ||
          event.eventName === CONTEXT_COMPACTION_EVENT_NAMES.failed)
      ) {
        try {
          const subject =
            event.eventName === CONTEXT_COMPACTION_EVENT_NAMES.completed
              ? decodeContextCompactionCompleted(event.payload).receipt.subject
              : decodeContextCompactionFailed(event.payload).subject;
          const kind = String(subject.aggregateType);
          return kind === "chat-thread" || kind === "work-thread" || kind === "code-thread"
            ? [String(subject.aggregateId)]
            : [];
        } catch (error) {
          this.#options.onError?.(
            "Side-task report delivery could not decode a compaction.",
            error,
          );
          return [];
        }
      }
      if (
        event.aggregateType === "chat-thread" ||
        event.aggregateType === "work-thread" ||
        event.aggregateType === "code-thread"
      ) {
        return [event.aggregateId];
      }
      return [];
    })();
    for (const parentThreadId of candidates) {
      const pending = this.#pending.get(parentThreadId);
      if (pending === undefined || pending.evaluating) continue;
      // Re-evaluate rather than trusting the commit meant the parent freed
      // up: the port's dispatch is the authority on whether the turn can be
      // admitted now.
      this.#clearTimer(pending);
      queueMicrotask(() => void this.#evaluate(parentThreadId));
    }
  }

  #arm(parentThreadId: string): void {
    const existing = this.#pending.get(parentThreadId);
    if (existing !== undefined) {
      if (existing.evaluating) return;
      this.#clearTimer(existing);
    } else {
      this.#pending.set(parentThreadId, { parentThreadId, timer: undefined, evaluating: false });
    }
    queueMicrotask(() => void this.#evaluate(parentThreadId));
  }

  #retryAfterMs(): number {
    return this.#options.retryAfterMs ?? DEFER_RETRY_AFTER_MS;
  }

  #clearTimer(pending: PendingParent): void {
    if (pending.timer === undefined) return;
    const unschedule =
      this.#options.unschedule ??
      ((handle: SideTaskReportDeliveryTimerHandle) => clearTimeout(handle as never));
    unschedule(pending.timer);
    pending.timer = undefined;
  }

  #armTimer(pending: PendingParent): void {
    const schedule =
      this.#options.schedule ??
      ((at: number, fire: () => void) => setTimeout(fire, Math.max(0, at - Date.now())));
    this.#clearTimer(pending);
    pending.timer = schedule(this.#options.clock().getTime() + this.#retryAfterMs(), () =>
      this.#evaluate(pending.parentThreadId),
    );
  }

  /**
   * Reports already inside a parent turn need no dispatch: the turn's mark is
   * the durable record, so marking them delivered here is what keeps a retry
   * or a replay from minting a second turn. Coverage is asked per report,
   * because one turn may cover any subset of what is owed.
   */
  async #uncovered(
    pending: PendingParent,
    port: SideTaskReportDeliveryModePort,
    owed: ReadonlyArray<OwedSideTaskReport>,
  ): Promise<ReadonlyArray<OwedSideTaskReport> | undefined> {
    const uncovered: OwedSideTaskReport[] = [];
    const coveredByChild = new Map<string, string[]>();
    for (const entry of owed) {
      const covered = await port.alreadyDelivered(
        pending.parentThreadId,
        String(entry.report.reportId),
      );
      if (this.#pending.get(pending.parentThreadId) !== pending) return undefined;
      if (!covered) {
        uncovered.push(entry);
        continue;
      }
      const ids = coveredByChild.get(entry.childThreadId) ?? [];
      ids.push(String(entry.report.reportId));
      coveredByChild.set(entry.childThreadId, ids);
    }
    for (const [childThreadId, reportIds] of coveredByChild) {
      this.#options.reports.markDelivered(childThreadId, reportIds);
    }
    return uncovered;
  }

  async #evaluate(parentThreadId: string): Promise<void> {
    const pending = this.#pending.get(parentThreadId);
    if (pending === undefined || pending.evaluating) return;
    pending.evaluating = true;
    this.#clearTimer(pending);
    try {
      const owedAll = this.#options.reports.undeliveredForParent(parentThreadId);
      const first = owedAll[0];
      if (first === undefined) return;
      const port = portFor(this.#options.ports, first.report.parentMode);
      const uncovered = await this.#uncovered(
        pending,
        port,
        owedAll.slice(0, MAX_SIDE_TASK_REPORT_DELIVERY_BATCH_SIZE),
      );
      if (
        uncovered === undefined ||
        uncovered.length === 0 ||
        this.#pending.get(parentThreadId) !== pending
      )
        return;
      // A batch is never cut inside a report: whatever does not fit the
      // prompt's character bound stays owed for the next evaluation. The fit
      // is a whole prefix, so the entries align with the reports it kept.
      const batch = uncovered.slice(
        0,
        fitSideTaskReportDeliveryBatch(uncovered.map((entry) => entry.report)).length,
      );
      if (batch.length === 0) {
        this.#armTimer(pending);
        return;
      }
      const result = await port.dispatch(
        parentThreadId,
        batch.map((entry) => entry.report),
      );
      if (this.#pending.get(parentThreadId) !== pending) return;
      if (result.kind === "dispatched") {
        const byChild = new Map<string, string[]>();
        for (const entry of batch) {
          const ids = byChild.get(entry.childThreadId) ?? [];
          ids.push(String(entry.report.reportId));
          byChild.set(entry.childThreadId, ids);
        }
        for (const [childThreadId, reportIds] of byChild) {
          this.#options.reports.markDelivered(childThreadId, reportIds);
        }
      } else if (result.kind === "deferred") {
        this.#armTimer(pending);
      } else {
        const byChild = new Map<string, string[]>();
        for (const entry of batch) {
          const ids = byChild.get(entry.childThreadId) ?? [];
          ids.push(String(entry.report.reportId));
          byChild.set(entry.childThreadId, ids);
        }
        for (const [childThreadId, reportIds] of byChild) {
          this.#options.reports.markRefused(childThreadId, reportIds, result.detail);
        }
      }
    } catch (error) {
      // A dispatch may have journaled its turn before throwing. Keep every
      // unsettled report owed so the next admission can read that durable mark.
      this.#options.onError?.("Side-task report delivery will retry.", error);
      if (this.#pending.get(parentThreadId) === pending) this.#armTimer(pending);
    } finally {
      pending.evaluating = false;
      if (this.#pending.get(parentThreadId) === pending) {
        if (this.#options.reports.undeliveredForParent(parentThreadId).length === 0) {
          this.#clearTimer(pending);
          this.#pending.delete(parentThreadId);
        } else if (pending.timer === undefined) {
          queueMicrotask(() => void this.#evaluate(parentThreadId));
        }
      }
    }
  }
}
