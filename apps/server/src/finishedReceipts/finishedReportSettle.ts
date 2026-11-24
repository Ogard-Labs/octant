import type { EventEnvelope } from "@octant/contracts";

/** A turn the journal just recorded as completed, in one mode's own words. */
export interface CompletedTurn {
  readonly threadId: string;
  /** The Work turn id or Code operation id, as a finished report names it. */
  readonly turnId: string;
}

export type FinishedReportSettleOutcome =
  | { readonly status: "settled" }
  | {
      readonly status: "skipped";
      readonly reason:
        | "not-found"
        | "not-active"
        | "already-settled"
        | "busy"
        | "decision-pending"
        | "child-work"
        | "coordinator";
    };

export interface FinishedReportSettlePorts {
  /** The completed turn a committed event records, or nothing for any other event. */
  readonly completedTurn: (event: EventEnvelope) => CompletedTurn | undefined;
  /** The turn the thread's latest finished report was filed in, if it names one. */
  readonly latestReportTurnId: (threadId: string) => string | undefined;
  /**
   * Settles the thread as the host, re-deciding against its authoritative
   * record and keeping it in view while anything still needs the person.
   */
  readonly settle: (threadId: string) => Promise<FinishedReportSettleOutcome>;
  /** The person's Settle threads when they're done switch; off settles nothing. */
  readonly enabled: () => boolean;
  readonly onError?: (message: string, error: unknown) => void;
  /** Waits between tries while the runtime still reports the turn live; tests shorten it. */
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * The completed event can commit a moment before the runtime stops reporting
 * the turn as live, which reads as busy. A few short tries cover that gap;
 * anything still busy after them is real work, and the thread stays in view.
 */
const BUSY_TRIES = 5;
const BUSY_WAIT_MS = 2_000;

/**
 * Settles a Work or Code thread once the turn in which its agent filed a
 * finished report completes. The report is filed while the turn still runs,
 * when a thread cannot settle, so the host acts on the turn's completion.
 *
 * Acting once, on that completion, is what lets a person Un-settle a thread
 * and keep it: nothing re-reads an old report later. A turn that failed, was
 * cancelled or stopped to wait never settles its thread, and neither does a
 * report filed in an earlier turn than the one that completed.
 */
export class FinishedReportSettle {
  readonly #ports: FinishedReportSettlePorts;

  constructor(ports: FinishedReportSettlePorts) {
    this.#ports = ports;
  }

  /** Feed committed journal appends; a completed turn that filed its report settles its thread. */
  onCommittedEvents(events: ReadonlyArray<EventEnvelope>): void {
    if (!this.#ports.enabled()) return;
    for (const event of events) {
      let completed: CompletedTurn | undefined;
      try {
        completed = this.#ports.completedTurn(event);
      } catch (error) {
        this.#ports.onError?.("A completed turn event did not decode.", error);
        continue;
      }
      if (completed === undefined) continue;
      if (this.#ports.latestReportTurnId(completed.threadId) !== completed.turnId) continue;
      void this.#settle(completed.threadId).catch((error: unknown) =>
        this.#ports.onError?.("A finished thread could not be settled.", error),
      );
    }
  }

  /** Settles the thread, trying again while only the turn's own wind-down keeps it busy. */
  async #settle(threadId: string): Promise<FinishedReportSettleOutcome> {
    const wait =
      this.#ports.wait ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let outcome = await this.#ports.settle(threadId);
    for (let tries = 1; tries < BUSY_TRIES && outcome.status === "skipped"; tries += 1) {
      if (outcome.reason !== "busy") break;
      await wait(BUSY_WAIT_MS);
      outcome = await this.#ports.settle(threadId);
    }
    return outcome;
  }
}
