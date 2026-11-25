import type {
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeThread,
  CodeThreadId,
} from "@octant/contracts";
import {
  worktreeReclaimTrigger,
  type WorktreeCleanupChoices,
  type WorktreeReclaimTrigger,
} from "@octant/domain/code-worktree-cleanup-policy";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { ManagedWorktreeReclaimResult } from "./managedWorktreeReclaim";

/** Once an hour is plenty for a window measured in days. */
export const WORKTREE_RECLAIM_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/** Threads one batch looks at before it hands the event loop back. */
const BATCH = 10;

export interface WorktreeReclaimSweepOptions {
  /** The person's cleanup choices; absent or empty means the sweep removes nothing. */
  readonly cleanup: () => WorktreeCleanupChoices | undefined;
  readonly threads: () => ReadonlyArray<CodeThread>;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  /** Epoch milliseconds of the thread's latest journaled activity, when it has any. */
  readonly lastActivityAt: (threadId: CodeThreadId) => number | undefined;
  /**
   * Anything the host tracks may still be working in the thread's folder: a
   * turn, a child run, a debug session, a Project shell, a queued message or a
   * wake-up. Read again after the cleanup begins.
   */
  readonly threadHasWork: (threadId: CodeThreadId) => boolean;
  readonly reclaim: (
    input: Readonly<{
      receiptId: string;
      trigger: WorktreeReclaimTrigger;
      isIdle: () => boolean;
    }>,
    signal: AbortSignal,
  ) => Promise<ManagedWorktreeReclaimResult>;
  readonly abandon: (
    receiptId: string,
    signal: AbortSignal,
  ) => Promise<ManagedWorktreeReclaimResult>;
  readonly clock?: () => number;
  readonly intervalMs?: number;
}

export type WorktreeReclaimSkipReason = "working" | "refused" | "failed" | "waiting";

export interface WorktreeReclaimSweepSummary {
  readonly reclaimed: ReadonlyArray<CodeThreadId>;
  /** Interrupted cleanups the person's choices no longer ask for, returned to working checkouts. */
  readonly abandoned: ReadonlyArray<CodeThreadId>;
  readonly skipped: ReadonlyArray<{
    readonly threadId: CodeThreadId;
    readonly reason: WorktreeReclaimSkipReason;
  }>;
}

/**
 * The host's timer for restorable worktree cleanup. A pass looks at every
 * managed worktree, removes the ones the person's choices qualify, and settles
 * a cleanup a restart interrupted. The cleanup service decides everything
 * about each folder; this only picks candidates, so a default install, where
 * no choice is on, removes nothing. Passes never overlap, and one thread's
 * failure leaves the rest of the pass running.
 */
export class WorktreeReclaimSweep {
  readonly #options: WorktreeReclaimSweepOptions;
  readonly #clock: () => number;
  readonly #intervalMs: number;
  readonly #abort = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;
  /**
   * Whether a cleanup may be pending. True until one pass has looked, since a
   * restart can leave one, and again whenever a cleanup this pass touched was
   * not settled. Only this timer begins a cleanup, so with no choice on and
   * nothing pending a pass has nothing to find.
   */
  #mayHavePending = true;

  constructor(options: WorktreeReclaimSweepOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => Date.now());
    this.#intervalMs = Math.max(options.intervalMs ?? WORKTREE_RECLAIM_SWEEP_INTERVAL_MS, 1_000);
  }

  /** Runs one pass now, then one per interval. Idempotent. */
  start(): void {
    if (this.#stopped || this.#timer !== undefined || this.#running) return;
    void this.#runThenSchedule();
  }

  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One pass. Exposed so a test can drive it without the timer. */
  async pass(): Promise<WorktreeReclaimSweepSummary> {
    const reclaimed: CodeThreadId[] = [];
    const abandoned: CodeThreadId[] = [];
    const skipped: Array<{ threadId: CodeThreadId; reason: WorktreeReclaimSkipReason }> = [];
    if (this.#stopped) return { reclaimed, abandoned, skipped };
    if (!this.#chosen() && !this.#mayHavePending) return { reclaimed, abandoned, skipped };
    let unsettled = false;
    let looked = 0;
    for (const thread of this.#options.threads()) {
      if (this.#stopped) break;
      if (looked > 0 && looked % BATCH === 0) await new Promise((resolve) => setImmediate(resolve));
      looked += 1;
      let readable = false;
      try {
        const checkout = this.#options.readCheckout(thread.checkoutId);
        if (checkout?.kind !== "managed-worktree") continue;
        const receipt = await this.#options.loadReceipt(String(checkout.ownershipReceiptId));
        readable = true;
        const resuming = receipt?.state === "cleanup-pending" && receipt.reclaim !== undefined;
        if (receipt === undefined || (receipt.state !== "ready" && !resuming)) continue;
        // The choices are read for each thread, not once for the pass: one turned
        // off while an earlier folder was being removed stops the rest.
        const trigger = this.#triggerNow(thread, receipt);
        if (trigger === undefined) {
          if (!resuming) continue;
          // A cleanup was under way, and the person has since turned it off or
          // the thread has been used: the folder goes back to being the thread's.
          const settled = await this.#options.abandon(receipt.receiptId, this.#abort.signal);
          if (settled.status === "restored") abandoned.push(thread.id);
          else if (settled.status === "reclaimed") reclaimed.push(thread.id);
          else {
            unsettled = true;
            skipped.push({ threadId: thread.id, reason: "waiting" });
          }
          continue;
        }
        if (this.#options.threadHasWork(thread.id)) {
          unsettled ||= resuming;
          skipped.push({ threadId: thread.id, reason: "working" });
          continue;
        }
        const result = await this.#options.reclaim(
          {
            receiptId: receipt.receiptId,
            trigger,
            // Asked again right before the removal begins: quiet, and the
            // choice that qualified the folder still on.
            isIdle: () =>
              !this.#options.threadHasWork(thread.id) &&
              this.#triggerNow(thread, receipt) === trigger,
          },
          this.#abort.signal,
        );
        if (result.status === "reclaimed") reclaimed.push(thread.id);
        else {
          // A cleanup still pending, refused or not, is handed back by a later
          // pass when its choice no longer stands.
          if (resuming || result.status === "waiting" || result.status === "interrupted") {
            unsettled = true;
          }
          skipped.push({
            threadId: thread.id,
            reason:
              result.status === "refused"
                ? result.reason === "working"
                  ? "working"
                  : "refused"
                : "waiting",
          });
        }
      } catch {
        // A receipt that cannot be read says nothing about a pending cleanup.
        if (readable) unsettled = true;
        skipped.push({ threadId: thread.id, reason: "failed" });
      }
    }
    // A pass cut short by a stop has not looked at everything.
    this.#mayHavePending = unsettled || this.#stopped;
    return { reclaimed, abandoned, skipped };
  }

  /** Whether any cleanup choice is on, read now. */
  #chosen(): boolean {
    const choices = this.#options.cleanup();
    return choices?.whenMerged === true || (choices?.inactivityDays ?? 0) >= 1;
  }

  /** What qualifies the thread's folder under the choices as they stand now, if anything. */
  #triggerNow(
    thread: CodeThread,
    receipt: ManagedWorktreeReceipt,
  ): WorktreeReclaimTrigger | undefined {
    // With no choice on, no thread's activity is worth reading.
    if (!this.#chosen()) return undefined;
    return worktreeReclaimTrigger({
      choices: this.#options.cleanup(),
      lastActivityAt: this.#lastActivityAt(thread, receipt),
      now: this.#clock(),
    });
  }

  /**
   * A restore and an abandoned cleanup write neither the thread's record nor
   * its journal, so the receipt's own "ready again" time counts too; without
   * it a worktree a person just restored would be removed on the next pass.
   */
  #lastActivityAt(thread: CodeThread, receipt: ManagedWorktreeReceipt): number {
    const changed = Date.parse(thread.updatedAt);
    const journaled = this.#options.lastActivityAt(thread.id);
    const handedBack = receipt.readyAgainAt === undefined ? 0 : Date.parse(receipt.readyAgainAt);
    return Math.max(
      Number.isFinite(changed) ? changed : 0,
      journaled ?? 0,
      Number.isFinite(handedBack) ? handedBack : 0,
    );
  }

  async #runThenSchedule(): Promise<void> {
    this.#running = true;
    try {
      await this.pass();
    } catch {
      // A pass that throws is dropped so the timer outlives one bad read.
    } finally {
      this.#running = false;
    }
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runThenSchedule();
    }, this.#intervalMs);
    this.#timer.unref?.();
  }
}
