import type { CodeThread, CodeThreadId } from "@octant/contracts";
import type { MergedThreadPutAwayOutcome } from "./codeService";
import type { CodeThreadMetadataService } from "./codeThreadMetadataService";

/**
 * How often the host looks for Code threads whose pull request merged. The
 * evidence is already cached (the Pull requests refresh, the pull-request
 * watch and the thread's own operations), so a shorter wait finds nothing new.
 */
export const MERGED_THREAD_PUT_AWAY_INTERVAL_MS = 2 * 60 * 1_000;

/** Threads looked at between yields to the event loop, as in the archive sweep. */
const MERGED_THREAD_PUT_AWAY_BATCH = 25;

export interface MergedPullRequest {
  readonly baseRepository: string;
  readonly number: number;
}

/**
 * Whether two merged pull requests are the same one in this Project, across a
 * repository rename: a recorded name is the one the host saw at the time.
 */
export type SameMergedPullRequest = (
  projectId: CodeThread["projectId"],
  left: MergedPullRequest,
  right: MergedPullRequest,
) => boolean;

export interface MergedThreadPutAwayOptions {
  readonly threads: () => ReadonlyArray<CodeThread>;
  readonly projectExists: (projectId: CodeThread["projectId"]) => boolean;
  /** The board's cached-only projection: it never calls GitHub or Git. */
  readonly metadata: Pick<CodeThreadMetadataService, "project">;
  /**
   * Merged pull requests the Pull requests refresh cache links to the thread.
   * A merge made outside Octant reaches this cache, not the thread's history.
   */
  readonly cachedMerges: (threadId: CodeThreadId) => ReadonlyArray<MergedPullRequest>;
  /** A finished turn's decision still waiting on the person keeps the thread in view. */
  readonly decisionPending: (thread: CodeThread) => boolean;
  readonly samePullRequest: SameMergedPullRequest;
  readonly putAway: (
    threadId: CodeThreadId,
    pullRequest: MergedPullRequest,
    alreadyPutAwayFor: (recorded: MergedPullRequest) => boolean,
  ) => MergedThreadPutAwayOutcome;
  /** The person's Settings choice; off means the pass reads and writes nothing. */
  readonly enabled: () => boolean;
  readonly intervalMs?: number;
}

/**
 * Puts a Code thread away once a pull request linked to it merged. Only a
 * merge settles a thread on its own: an opened pull request, a finished
 * investigation or a local commit is Done on the board yet still work the
 * person is likely to come back to the same day. Child work still running or
 * unread, and a decision still waiting on the person, keep it in view.
 *
 * Each candidate is re-decided by the Code service against the thread's
 * journaled record, which also remembers the pull request it was put away
 * for, so a thread taken back out of the shelf is not put away again for the
 * same merge. Passes never overlap and one failing thread does not end a pass.
 */
export class MergedThreadPutAway {
  readonly #options: MergedThreadPutAwayOptions;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;

  constructor(options: MergedThreadPutAwayOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(options.intervalMs ?? MERGED_THREAD_PUT_AWAY_INTERVAL_MS, 1_000);
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

  /** One pass over every Code thread. Exposed so a test can drive it without the timer. */
  async pass(): Promise<ReadonlyArray<CodeThreadId>> {
    const putAway: CodeThreadId[] = [];
    if (!this.#options.enabled()) return putAway;
    const candidates = this.#options
      .threads()
      .filter((thread) => thread.lifecycle === "active" && !isCoordinator(thread));
    let examined = 0;
    for (const thread of candidates) {
      if (examined > 0 && examined % MERGED_THREAD_PUT_AWAY_BATCH === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      examined += 1;
      if (this.#stopped) return putAway;
      try {
        const merge = await this.#latestMerge(thread);
        if (merge === undefined || this.#options.decisionPending(thread)) continue;
        const alreadyPutAwayFor = (recorded: MergedPullRequest) =>
          this.#options.samePullRequest(thread.projectId, recorded, merge);
        const recorded = thread.putAwayForPullRequest;
        if (recorded !== undefined && alreadyPutAwayFor(recorded)) continue;
        const outcome = this.#options.putAway(thread.id, merge, alreadyPutAwayFor);
        if (outcome.status === "put-away") putAway.push(thread.id);
      } catch {
        // A version race means the thread changed under the pass, and the
        // next pass re-decides it; any other failure is this thread's alone.
      }
    }
    return putAway;
  }

  /**
   * The newest merged pull request linked to the thread, from the thread's
   * own delivery evidence or the refresh cache; none while child work the
   * thread started is still running or its result is unread.
   */
  async #latestMerge(thread: CodeThread): Promise<MergedPullRequest | undefined> {
    const view = await this.#options.metadata.project([
      { thread, projectProjectionPresent: this.#options.projectExists(thread.projectId) },
    ]);
    const metadata = view.threads[0];
    if (metadata === undefined) return undefined;
    if (metadata.childAgents.active > 0 || metadata.childAgents.unacknowledgedResults > 0) {
      return undefined;
    }
    const linked = metadata.linkedPullRequest;
    const merges = [
      ...(linked.kind === "linked" && linked.state === "merged" && linked.matchesDeliveryBranch
        ? [{ baseRepository: linked.baseRepository, number: linked.number }]
        : []),
      ...this.#options.cachedMerges(thread.id),
    ];
    // The highest number is the latest merge, so a thread linked to several
    // merged pull requests settles on one and is not put away for each in turn.
    return merges.reduce<MergedPullRequest | undefined>(
      (latest, merge) => (latest === undefined || merge.number > latest.number ? merge : latest),
      undefined,
    );
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

/** A coordinator ends by its own done-when condition, never by a merge it did not make. */
function isCoordinator(thread: CodeThread): boolean {
  return thread.coordinator === true;
}
