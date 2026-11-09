import type { ContextCompactionRecord, ContextSubjectRef, WindowId } from "@octant/contracts";
import { decideIdleCompaction } from "@octant/domain/context-compaction";
import { automaticCompactionId } from "./automaticCompaction";
import type { SessionCompactionService } from "./sessionCompaction";

/** Once a minute is fine-grained enough for a rule measured in minutes. */
export const IDLE_COMPACTION_SWEEP_INTERVAL_MS = 60_000;

export interface IdleCompactionOptions {
  readonly compactions: Pick<SessionCompactionService, "start" | "windowFill">;
  readonly latestCompaction: (subject: ContextSubjectRef) => ContextCompactionRecord | undefined;
  /** Read on every pass, so a change in Settings applies to the next one. */
  readonly idleMinutes: () => number | null;
  /** Epoch milliseconds. */
  readonly clock?: () => number;
  readonly intervalMs?: number;
}

interface QuietThread {
  readonly subject: ContextSubjectRef;
  readonly endedAt: string;
  readonly windowId: WindowId | undefined;
}

/**
 * Compacts a thread once no turn has run on it for the minutes the person
 * set, so the turn they come back to starts from a summary.
 *
 * It knows the threads whose turns ended while this host ran, with the window
 * each turn ran under: a Code thread is compacted only under that window, and
 * only while it is still open (D-4). A thread whose last turn ended before
 * the host started is left alone. Each quiet spell gets one attempt, under an
 * id derived from the turn that began it, so a pass that runs twice, or a
 * restart, never pays for the same spell twice. A pass reads stored facts and
 * asks no provider anything until a thread qualifies.
 */
export class IdleCompactions {
  readonly #options: IdleCompactionOptions;
  readonly #clock: () => number;
  readonly #intervalMs: number;
  readonly #quiet = new Map<string, QuietThread>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: IdleCompactionOptions) {
    this.#options = options;
    this.#clock = options.clock ?? (() => Date.now());
    this.#intervalMs = Math.max(options.intervalMs ?? IDLE_COMPACTION_SWEEP_INTERVAL_MS, 1_000);
  }

  /** A turn ended; the thread's quiet spell starts now, under that turn's window. */
  turnEnded(input: {
    readonly subject: ContextSubjectRef;
    readonly endedAt: string;
    readonly windowId?: WindowId | undefined;
  }): void {
    this.#quiet.set(key(input.subject), {
      subject: input.subject,
      endedAt: input.endedAt,
      windowId: input.windowId,
    });
  }

  /** Runs a pass every interval until stopped. Idempotent. */
  start(): void {
    if (this.#stopped || this.#timer !== undefined) return;
    this.#scheduleNextPass();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One pass over the quiet threads. Exposed so a test can drive it without the timer. */
  pass(): void {
    const thresholdMinutes = this.#options.idleMinutes();
    if (thresholdMinutes === null) {
      // Forgotten while the rule is off, so turning it on later counts only
      // turns from then on, rather than compacting every thread the host has
      // seen go quiet in one pass.
      this.#quiet.clear();
      return;
    }
    const now = this.#clock();
    for (const [threadKey, quiet] of this.#quiet) {
      if (this.#stopped) return;
      const endedAt = Date.parse(quiet.endedAt);
      // The cheap check first: most threads are not yet quiet long enough,
      // and those cost no read at all.
      if (!Number.isFinite(endedAt) || now - endedAt < thresholdMinutes * 60_000) continue;
      try {
        if (this.#attempt(quiet, endedAt, thresholdMinutes, now) === "turn-running") continue;
      } catch {
        // A thread the rule could not judge is left as it was.
      }
      // One attempt per quiet spell, whatever it met: a refused or skipped
      // spell waits for the thread's next turn.
      this.#quiet.delete(threadKey);
    }
  }

  #attempt(
    quiet: QuietThread,
    endedAt: number,
    thresholdMinutes: number,
    now: number,
  ): "started" | "skipped" | "turn-running" {
    // Compacted since the spell began, by a rule or by the person: the window
    // already starts from a summary.
    if (compactedSince(this.#options.latestCompaction(quiet.subject), endedAt)) return "skipped";
    const fill = this.#options.compactions.windowFill(quiet.subject);
    if (fill === undefined) return "skipped";
    const cause = decideIdleCompaction({
      thresholdMinutes,
      lastTurnEndedAt: endedAt,
      now,
      tokens: fill.tokens,
    });
    if (cause === undefined) return "skipped";
    const result = this.#options.compactions.start(
      {
        kind: "compact-session",
        subject: quiet.subject,
        compactionId: automaticCompactionId(quiet.subject, `rule:idle:${quiet.endedAt}`, 1),
      },
      "host-policy",
      quiet.windowId,
      cause,
    );
    if (result.kind !== "compaction-refused") return "started";
    return result.reason === "turn-running" ? "turn-running" : "skipped";
  }

  #scheduleNextPass(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      try {
        this.pass();
      } catch {
        // One unreadable pass must not end the timer; the next interval retries.
      }
      this.#scheduleNextPass();
    }, this.#intervalMs);
  }
}

function key(subject: ContextSubjectRef): string {
  return `${String(subject.aggregateType)}:${String(subject.aggregateId)}`;
}

function compactedSince(latest: ContextCompactionRecord | undefined, endedAt: number): boolean {
  if (latest === undefined) return false;
  if (latest.status === "running") return true;
  const at = latest.status === "completed" ? latest.receipt.completedAt : latest.failedAt;
  return Date.parse(String(at)) >= endedAt;
}
