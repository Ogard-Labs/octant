import type { CodeThread, CodeThreadId } from "@octant/contracts";
import { completedThreadArchiveDue } from "@octant/domain/thread-completion-policy";
import type { CodeCompletedThreadArchiveOutcome } from "./codeService";

/** Once an hour is plenty for a window measured in days. */
export const CODE_COMPLETED_THREAD_ARCHIVE_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

export interface CodeCompletedThreadArchiveSweepOptions {
  readonly threads: () => ReadonlyArray<CodeThread>;
  /** The Settings window, or `null` when the person turned the timer off. */
  readonly archiveAfterDays: () => number | null;
  readonly archive: (
    threadId: CodeThreadId,
    input: { readonly afterDays: number | null; readonly now: string },
  ) => CodeCompletedThreadArchiveOutcome;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
  readonly intervalMs?: number;
}

export interface CodeCompletedThreadArchiveSweepSummary {
  readonly archived: ReadonlyArray<CodeThreadId>;
  readonly skipped: ReadonlyArray<CodeThreadId>;
}

/**
 * The host's own timer for completed threads: every pass archives the ones
 * whose completion is older than the window Settings names.
 *
 * Archiving is the only thing this timer does. It never purges, and 0035's
 * rule that a retention window never deletes on its own still stands: an
 * archived thread keeps its transcript, checkout, and journal. Passes never
 * overlap — the chain schedules the next only after this one returns — and a
 * pass that throws is dropped so the timer outlives one bad read.
 */
export class CodeCompletedThreadArchiveSweep {
  readonly #threads: CodeCompletedThreadArchiveSweepOptions["threads"];
  readonly #archiveAfterDays: CodeCompletedThreadArchiveSweepOptions["archiveAfterDays"];
  readonly #archive: CodeCompletedThreadArchiveSweepOptions["archive"];
  readonly #clock: () => number;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: CodeCompletedThreadArchiveSweepOptions) {
    this.#threads = options.threads;
    this.#archiveAfterDays = options.archiveAfterDays;
    this.#archive = options.archive;
    this.#clock = options.clock ?? (() => Date.now());
    this.#intervalMs = Math.max(
      options.intervalMs ?? CODE_COMPLETED_THREAD_ARCHIVE_SWEEP_INTERVAL_MS,
      1_000,
    );
  }

  /** Runs one pass now, then one per interval. Idempotent. */
  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#runPass();
    this.#scheduleNextPass();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One sweep over every Code thread. Exposed so a test can drive it without the timer. */
  pass(): CodeCompletedThreadArchiveSweepSummary {
    const afterDays = this.#archiveAfterDays();
    const archived: CodeThreadId[] = [];
    const skipped: CodeThreadId[] = [];
    if (afterDays === null) return { archived, skipped };
    const now = new Date(this.#clock()).toISOString();
    for (const thread of this.#threads()) {
      if (this.#stopped) break;
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
      // The archive re-reads and re-decides against the authoritative record,
      // so a thread reopened since this list was read is skipped, not archived.
      const outcome = this.#archive(thread.id, { afterDays, now });
      (outcome.status === "archived" ? archived : skipped).push(thread.id);
    }
    return { archived, skipped };
  }

  #runPass(): void {
    try {
      this.pass();
    } catch {
      // One unreadable pass must not end the timer; the next interval retries.
    }
  }

  #scheduleNextPass(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#runPass();
      this.#scheduleNextPass();
    }, this.#intervalMs);
  }
}
