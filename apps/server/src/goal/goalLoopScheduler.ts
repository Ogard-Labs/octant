/**
 * Circulation for continuous goal loops.
 *
 * The loop service refuses to drive itself (see scheduleNextRound): a loop
 * that re-entered its own round would decide its own pacing, and a host that
 * wants work to stop would have nowhere to say so. This scheduler is that
 * host-side voice. It queues exactly one follow-up per thread and runs it on
 * the macrotask queue, so a round that schedules its successor cannot recurse
 * into it and a pause recorded between rounds is always observed.
 */
export class GoalLoopScheduler {
  readonly #advance: (threadId: string) => Promise<unknown>;
  readonly #queued = new Set<string>();

  constructor(options: { readonly advance: (threadId: string) => Promise<unknown> }) {
    this.#advance = options.advance;
  }

  schedule(threadId: string): void {
    if (this.#queued.has(threadId)) return;
    this.#queued.add(threadId);
    queueMicrotask(() => {
      this.#queued.delete(threadId);
      try {
        void this.#advance(threadId).catch(() => undefined);
      } catch {
        // An advance that throws synchronously still consumed its slot; a
        // later schedule() call is what resumes circulation, exactly as a
        // rejected round does.
      }
    });
  }
}
