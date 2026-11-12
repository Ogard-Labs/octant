import type { OctantMode } from "@octant/contracts";
import {
  completedThreadArchiveDue,
  type RestingThreadLifecycle,
} from "@octant/domain/thread-completion-policy";
import { ConcurrencyConflict } from "./persistence/journalErrors";

/** Once an hour is plenty for a window measured in days. */
export const COMPLETED_THREAD_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * How many threads one batch of a pass looks at before it hands the event
 * loop back. Every archive is a synchronous journal write on the host's one
 * thread, so a pass over thousands of completed threads in one go held Stop
 * and approval answers until it finished.
 */
export const COMPLETED_THREAD_ARCHIVE_SWEEP_BATCH = 50;

export type CompletedThreadArchiveOutcome =
  | { readonly status: "archived" }
  | { readonly status: "skipped"; readonly reason: "not-found" | "not-due" };

export interface CompletedThreadArchiveInput {
  readonly afterDays: number | null;
  readonly now: string;
}

/** What one mode's thread service lends the sweep: its threads and its archive door. */
export interface CompletedThreadArchiveSource {
  readonly mode: OctantMode;
  readonly threads: () => ReadonlyArray<{
    readonly id: string;
    readonly lifecycle: RestingThreadLifecycle;
    readonly completedAt?: string | undefined;
  }>;
  readonly archive: (
    threadId: string,
    input: CompletedThreadArchiveInput,
  ) => CompletedThreadArchiveOutcome;
}

export interface CompletedThreadArchiveSweepOptions {
  readonly sources: ReadonlyArray<CompletedThreadArchiveSource>;
  /** The Settings window, or `null` when the person turned the timer off. */
  readonly archiveAfterDays: () => number | null;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
  readonly intervalMs?: number;
  /** Threads examined between yields; defaults to {@link COMPLETED_THREAD_ARCHIVE_SWEEP_BATCH}. */
  readonly batchSize?: number;
}

/**
 * Why a due thread was not archived this pass: the service's own answer, a
 * version race ("changed": the next pass re-decides), or a failure of the
 * mode's service on this thread alone while the rest of the pass still ran.
 */
export type CompletedThreadArchiveSkipReason = "not-found" | "not-due" | "changed" | "failed";

export interface CompletedThreadArchiveSweepSummary {
  readonly archived: ReadonlyArray<{ readonly mode: OctantMode; readonly threadId: string }>;
  readonly skipped: ReadonlyArray<{
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly reason: CompletedThreadArchiveSkipReason;
  }>;
}

/**
 * The host's own timer for completed threads: every pass archives the ones
 * whose completion is older than the window Settings names, in every mode.
 *
 * Archiving is the only thing this timer does. It never purges, and the
 * rule that a retention window never deletes on its own still stands: an
 * archived thread keeps its transcript, checkout, and journal. Passes never
 * overlap — the chain schedules the next only after this one settles — and a
 * pass that throws is dropped so the timer outlives one bad read. A pass
 * works in bounded batches and yields to the event loop between them, so a
 * large sweep cannot starve Stop or approval handling.
 */
export class CompletedThreadArchiveSweep {
  readonly #sources: ReadonlyArray<CompletedThreadArchiveSource>;
  readonly #archiveAfterDays: CompletedThreadArchiveSweepOptions["archiveAfterDays"];
  readonly #clock: () => number;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;

  constructor(options: CompletedThreadArchiveSweepOptions) {
    this.#sources = options.sources;
    this.#archiveAfterDays = options.archiveAfterDays;
    this.#clock = options.clock ?? (() => Date.now());
    this.#intervalMs = Math.max(
      options.intervalMs ?? COMPLETED_THREAD_ARCHIVE_SWEEP_INTERVAL_MS,
      1_000,
    );
    this.#batchSize = Math.max(options.batchSize ?? COMPLETED_THREAD_ARCHIVE_SWEEP_BATCH, 1);
  }

  /** Runs one pass now, then one per interval. Idempotent. */
  start(): void {
    if (this.#stopped || this.#timer !== undefined || this.#running) return;
    void this.#runPassThenSchedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One sweep over every mode's threads. Exposed so a test can drive it without the timer. */
  async pass(): Promise<CompletedThreadArchiveSweepSummary> {
    const afterDays = this.#archiveAfterDays();
    const archived: Array<{ mode: OctantMode; threadId: string }> = [];
    const skipped: Array<{
      mode: OctantMode;
      threadId: string;
      reason: CompletedThreadArchiveSkipReason;
    }> = [];
    if (afterDays === null) return { archived, skipped };
    const now = new Date(this.#clock()).toISOString();
    let examined = 0;
    for (const source of this.#sources) {
      for (const thread of source.threads()) {
        if (examined > 0 && examined % this.#batchSize === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        examined += 1;
        if (this.#stopped) return { archived, skipped };
        if (
          !completedThreadArchiveDue({
            lifecycle: thread.lifecycle,
            completedAt: thread.completedAt,
            afterDays,
            now,
          })
        ) {
          continue;
        }
        // Each mode's archive re-reads and re-decides against its authoritative
        // record, so a thread reopened since this list was read is skipped.
        // One thread's failure is its own: a version race or a refusing
        // service must not end the pass before the threads after it.
        let outcome: CompletedThreadArchiveOutcome;
        try {
          outcome = source.archive(thread.id, { afterDays, now });
        } catch (error) {
          skipped.push({
            mode: source.mode,
            threadId: thread.id,
            reason: error instanceof ConcurrencyConflict ? "changed" : "failed",
          });
          continue;
        }
        if (outcome.status === "archived") {
          archived.push({ mode: source.mode, threadId: thread.id });
        } else {
          skipped.push({ mode: source.mode, threadId: thread.id, reason: outcome.reason });
        }
      }
    }
    return { archived, skipped };
  }

  async #runPassThenSchedule(): Promise<void> {
    this.#running = true;
    try {
      await this.pass();
    } catch {
      // One unreadable pass must not end the timer; the next interval retries.
    } finally {
      this.#running = false;
    }
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#runPassThenSchedule();
    }, this.#intervalMs);
  }
}
