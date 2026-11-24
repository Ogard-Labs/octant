import type { CodeThread, CodeThreadId } from "@octant/contracts";
import type { MergedPullRequest, MergedThreadPutAwayOutcome } from "./codeService";
import type {
  CodeThreadOwnPullRequest,
  CodeThreadMetadataService,
} from "./codeThreadMetadataService";
import { splitRepositoryName } from "./pullRequestLinkService";

/**
 * How often the host looks for Code threads whose pull request merged. The
 * evidence is already cached (the Pull requests refresh, the pull-request
 * watch and the thread's own operations), so a shorter wait finds nothing new.
 */
export const MERGED_THREAD_PUT_AWAY_INTERVAL_MS = 2 * 60 * 1_000;

/** As many merged pull requests as a thread records; matches its contract bound. */
export const MAX_RECORDED_MERGES = 32;

/** Threads looked at between yields to the event loop, as in the archive sweep. */
const MERGED_THREAD_PUT_AWAY_BATCH = 25;

export type { MergedPullRequest };

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
   * The merged pull requests the Pull requests refresh cache shows as this
   * thread's own delivery (`threadDeliversPullRequest`). A merge made outside
   * Octant reaches this cache, not the thread's history.
   */
  readonly cachedMerges: (thread: CodeThread) => ReadonlyArray<MergedPullRequest>;
  /** A finished turn's decision still waiting on the person keeps the thread in view. */
  readonly decisionPending: (thread: CodeThread) => boolean;
  readonly samePullRequest: SameMergedPullRequest;
  readonly putAway: (
    threadId: CodeThreadId,
    merges: ReadonlyArray<MergedPullRequest>,
    samePullRequest: (left: MergedPullRequest, right: MergedPullRequest) => boolean,
  ) => MergedThreadPutAwayOutcome;
  /** The person's Settings choice; off means the pass reads and writes nothing. */
  readonly enabled: () => boolean;
  readonly intervalMs?: number;
}

/**
 * Whether a cached pull request is what the thread delivers: one Octant's own
 * pull-request operations recorded for it, or one on its delivery branch in its
 * delivery repository. That is the repository its target names, and the one
 * those operations ran in: a server thread's target is a `local/…` placeholder,
 * which only the operation resolves. A thread is also linked to pull requests
 * its tool calls reviewed or commented on, in any of the Project's
 * repositories, and merging one of those delivers nothing here, even when it
 * shares a number or a branch name with the thread's own.
 */
export function threadDeliversPullRequest(input: {
  readonly thread: Pick<CodeThread, "deliveryTarget" | "projectId">;
  readonly own: ReadonlyArray<CodeThreadOwnPullRequest>;
  readonly pullRequest: {
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly number: number;
    readonly headBranch: string;
  };
  readonly sameRepository: (
    projectId: CodeThread["projectId"],
    left: { readonly owner: string; readonly name: string },
    right: { readonly owner: string; readonly name: string },
  ) => boolean;
}): boolean {
  const { thread, own, pullRequest } = input;
  const here = { owner: pullRequest.repositoryOwner, name: pullRequest.repositoryName };
  const same = (repository: { readonly owner: string; readonly name: string }) =>
    input.sameRepository(thread.projectId, repository, here);
  if (own.some((entry) => entry.number === pullRequest.number && same(entry.repository))) {
    return true;
  }
  if (pullRequest.headBranch !== thread.deliveryTarget.branchIntent) return false;
  const target = splitRepositoryName(thread.deliveryTarget.proposedBaseRepository);
  return (target !== undefined && same(target)) || own.some((entry) => same(entry.repository));
}

/**
 * Puts a Code thread away once a pull request it delivers merged. Only a
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
        const merges = await this.#merges(thread);
        const same = (left: MergedPullRequest, right: MergedPullRequest) =>
          this.#options.samePullRequest(thread.projectId, left, right);
        const recorded = thread.putAwayForPullRequests ?? [];
        // Only a merge the thread was never put away for counts, whatever its
        // number: pull request numbers order creation, not merging.
        if (!merges.some((merge) => !recorded.some((known) => same(known, merge)))) continue;
        if (this.#options.decisionPending(thread)) continue;
        const outcome = this.#options.putAway(thread.id, merges, same);
        if (outcome.status === "put-away") putAway.push(thread.id);
      } catch {
        // A version race means the thread changed under the pass, and the
        // next pass re-decides it; any other failure is this thread's alone.
      }
    }
    return putAway;
  }

  /**
   * Every merged pull request linked to the thread, from the thread's own
   * delivery evidence and the refresh cache; none while child work the thread
   * started is still running or its result is unread. All of them are
   * recorded when the thread is put away, so one that a cache drops and
   * another still shows (a GitHub sign-out clears the refresh cache) never
   * reads as new.
   */
  async #merges(thread: CodeThread): Promise<ReadonlyArray<MergedPullRequest>> {
    const view = await this.#options.metadata.project([
      { thread, projectProjectionPresent: this.#options.projectExists(thread.projectId) },
    ]);
    const metadata = view.threads[0];
    if (metadata === undefined) return [];
    if (metadata.childAgents.active > 0 || metadata.childAgents.unacknowledgedResults > 0) {
      return [];
    }
    const linked = metadata.linkedPullRequest;
    const seen = [
      ...(linked.kind === "linked" && linked.state === "merged" && linked.matchesDeliveryBranch
        ? [{ baseRepository: linked.baseRepository, number: linked.number }]
        : []),
      ...this.#options.cachedMerges(thread),
    ];
    // Both sources often name the same merge; it is one merge. Past the
    // record's bound the same fixed slice is kept every pass, so a thread with
    // more merged pull requests than it can record does not trade one for
    // another on each pass and read the dropped one as new.
    const distinct: MergedPullRequest[] = [];
    for (const merge of seen) {
      if (
        !distinct.some((known) => this.#options.samePullRequest(thread.projectId, known, merge))
      ) {
        distinct.push(merge);
      }
    }
    return distinct
      .sort(
        (left, right) =>
          left.baseRepository.localeCompare(right.baseRepository) || left.number - right.number,
      )
      .slice(0, MAX_RECORDED_MERGES);
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
