import type { AgentRunLifecycleStatus, EventEnvelope } from "@octant/contracts";
import { isAgentRunActiveStatus } from "@octant/domain";

/** A turn's state change the journal just recorded, in one mode's own words. */
export interface TurnUpdate {
  readonly threadId: string;
  /** The Work turn id or Code operation id, as a finished report names it. */
  readonly turnId: string;
  readonly completed: boolean;
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
  /** The turn state change a committed event records, or nothing for any other event. */
  readonly turnUpdate: (event: EventEnvelope) => TurnUpdate | undefined;
  /**
   * The turn the thread's latest finished report was filed in, while that
   * report is still fresh: a later file change leaves its checks unproven.
   */
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
  /**
   * For each thread with a settle attempt in flight, the turn it last
   * recorded a state change for. A retry stops once a newer turn appears: a
   * person may start one during the wait, and if it ended without a report of
   * its own, settling on the earlier report would hide that turn. Only threads
   * being settled are kept, and each leaves when its attempt ends.
   */
  readonly #latestTurn = new Map<string, string>();
  readonly #attempts = new Map<string, number>();

  constructor(ports: FinishedReportSettlePorts) {
    this.#ports = ports;
  }

  /** Feed committed journal appends; a completed turn that filed its report settles its thread. */
  onCommittedEvents(events: ReadonlyArray<EventEnvelope>): void {
    for (const event of events) {
      let update: TurnUpdate | undefined;
      try {
        update = this.#ports.turnUpdate(event);
      } catch (error) {
        this.#ports.onError?.("A turn event did not decode.", error);
        continue;
      }
      if (update === undefined) continue;
      if (this.#latestTurn.has(update.threadId)) {
        this.#latestTurn.set(update.threadId, update.turnId);
      }
      if (!update.completed || !this.#ports.enabled()) continue;
      if (this.#ports.latestReportTurnId(update.threadId) !== update.turnId) continue;
      const { threadId, turnId } = update;
      this.#latestTurn.set(threadId, turnId);
      this.#attempts.set(threadId, (this.#attempts.get(threadId) ?? 0) + 1);
      void this.#settle(threadId, turnId)
        .catch((error: unknown) =>
          this.#ports.onError?.("A finished thread could not be settled.", error),
        )
        .finally(() => {
          const left = (this.#attempts.get(threadId) ?? 1) - 1;
          if (left > 0) {
            this.#attempts.set(threadId, left);
            return;
          }
          this.#attempts.delete(threadId);
          this.#latestTurn.delete(threadId);
        });
    }
  }

  /** Settles the thread, trying again while only the turn's own wind-down keeps it busy. */
  async #settle(threadId: string, turnId: string): Promise<FinishedReportSettleOutcome> {
    const wait =
      this.#ports.wait ??
      ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    let outcome = await this.#ports.settle(threadId);
    for (let tries = 1; tries < BUSY_TRIES && outcome.status === "skipped"; tries += 1) {
      if (outcome.reason !== "busy") break;
      await wait(BUSY_WAIT_MS);
      // Re-read at the write: a newer turn, a file change that left the report
      // stale, or the switch turned off during the wait each end the attempt.
      if (
        this.#latestTurn.get(threadId) !== turnId ||
        this.#ports.latestReportTurnId(threadId) !== turnId ||
        !this.#ports.enabled()
      ) {
        return { status: "skipped", reason: "busy" };
      }
      outcome = await this.#ports.settle(threadId);
    }
    return outcome;
  }
}

/**
 * Whether a lead's Octant-managed child runs still need the person: a run
 * still going, or a finished one whose result the lead has not read. The
 * Work board counts the same unread results.
 */
export function managedChildWorkPending(
  runs: ReadonlyArray<{
    readonly lifecycleStatus: AgentRunLifecycleStatus;
    readonly resultAcknowledgement: { readonly required: boolean; readonly acknowledged: boolean };
  }>,
): boolean {
  return runs.some(
    (run) =>
      isAgentRunActiveStatus(run.lifecycleStatus) ||
      ((run.lifecycleStatus === "completed" || run.lifecycleStatus === "failed") &&
        run.resultAcknowledgement.required &&
        !run.resultAcknowledgement.acknowledged),
  );
}
