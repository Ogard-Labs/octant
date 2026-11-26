import type { CodeThread, ThreadLinkedIssue } from "@octant/contracts";
import { linkedIssueLabel } from "@octant/domain/tracker-issue-write-policy";
import { MERGE_WHEN_READY_OFFER } from "@octant/domain/code-pull-request-switch-policy";
import type { TrackerAdvanceOptions, TrackerIssueWrites } from "./trackerIssueWrites";

/** As often as the merged-thread pass: the pull-request evidence it reads is cached. */
export const LINKED_ISSUE_WRITE_BACK_INTERVAL_MS = 2 * 60 * 1_000;

/** The thread's own pull request as the host's cached evidence shows it; GitHub is never called. */
export interface LinkedThreadPullRequest {
  readonly state: "open" | "merged" | "closed";
  readonly url: string;
  readonly number: number;
  /** `owner/name`. */
  readonly baseRepository: string;
}

export interface LinkedIssueWriteBackOptions {
  readonly writes: Pick<TrackerIssueWrites, "advance">;
  readonly linked: (threadId: string) => ReadonlyArray<ThreadLinkedIssue>;
  readonly threads: () => ReadonlyArray<CodeThread>;
  readonly readThread: (threadId: string) => CodeThread | undefined;
  /** The Project's "Keep linked issues up to date"; off writes nothing. */
  readonly keepCurrent: (projectId: CodeThread["projectId"]) => boolean;
  /** The thread's pull request as the journal records it. */
  readonly pullRequest: (thread: CodeThread) => Promise<LinkedThreadPullRequest | undefined>;
  /**
   * The thread's pull request the refresh cache saw merged. A merge made
   * outside Octant reaches the cache before the journal, which still says
   * open, so this one wins.
   */
  readonly mergedPullRequest: (thread: CodeThread) => Promise<LinkedThreadPullRequest | undefined>;
  /**
   * Adds one keyed line to the thread's "Pull request updates" follow-up.
   * Answers false when it held the line back (a follow-up the person set is
   * open); the line is told at a later pass instead.
   */
  readonly tell: (threadId: string, key: string, line: string) => Promise<boolean>;
  /**
   * Adds the Merge when ready offer unless the follow-up already has a line
   * for that pull request: an Auto-fix notice (its own Merge action among
   * them) is never replaced by the offer. Answers false when it held the
   * offer back for now, as for a follow-up the person set by hand.
   */
  readonly offer: (threadId: string, ref: string, line: string) => Promise<boolean>;
  readonly intervalMs?: number;
}

/**
 * Keeps the issues linked to a Code thread current, when its Project asks:
 * In Progress when a turn starts, In Review once the thread's pull request is
 * open, Done with a comment once it merged. It also offers Merge when ready
 * on a linked thread's open pull request, which the person turns on; the
 * offer writes nothing outside Octant, so it does not wait for the switch.
 * Passes never overlap, and one failing thread does not end a pass.
 */
export class LinkedIssueWriteBack {
  readonly #options: LinkedIssueWriteBackOptions;
  readonly #intervalMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #stopped = false;
  /** Pull requests offered Merge when ready since start, so a dismissed offer stays dismissed. */
  readonly #offered = new Set<string>();
  /**
   * Refusal lines a thread's follow-up could not take yet. The writes record
   * a refusal once and never repeat its notice, so a line held back here is
   * the only copy left.
   */
  readonly #heldNotices = new Map<string, Array<{ readonly key: string; readonly line: string }>>();
  /** Threads with a new trigger since the last pass: their refused or failed moments are retried. */
  readonly #retryRequested = new Set<string>();

  constructor(options: LinkedIssueWriteBackOptions) {
    this.#options = options;
    this.#intervalMs = Math.max(options.intervalMs ?? LINKED_ISSUE_WRITE_BACK_INTERVAL_MS, 1_000);
  }

  start(): void {
    if (this.#stopped || this.#timer !== undefined || this.#running) return;
    void this.#runPassThenSchedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** A person asked the thread for a turn: its linked issues are In Progress. */
  async onTurnStarted(threadId: string): Promise<void> {
    if (!this.#keepsCurrent(threadId)) return;
    this.#retryRequested.add(threadId);
    await this.#advance(threadId, "in-progress", { retry: true });
  }

  /** The thread's agent opened its pull request: its linked issues are In Review now, not at the next pass. */
  async onPullRequestCreated(threadId: string): Promise<void> {
    if (!this.#keepsCurrent(threadId)) return;
    await this.#advance(threadId, "in-review", { retry: true });
  }

  #keepsCurrent(threadId: string): boolean {
    const thread = this.#options.readThread(threadId);
    if (thread === undefined || !this.#options.keepCurrent(thread.projectId)) return false;
    return this.#options.linked(threadId).length > 0;
  }

  /** One pass over every thread with linked issues. Exposed so a test can drive it. */
  async pass(): Promise<void> {
    for (const thread of this.#options.threads()) {
      if (this.#stopped) return;
      const threadId = String(thread.id);
      try {
        await this.#tellHeld(threadId);
        const linked = this.#options.linked(threadId);
        if (linked.length === 0) continue;
        const recorded = await this.#options.pullRequest(thread);
        const pullRequest =
          recorded?.state === "merged"
            ? recorded
            : ((await this.#options.mergedPullRequest(thread)) ?? recorded);
        if (pullRequest === undefined || pullRequest.state === "closed") continue;
        const ref = `${pullRequest.baseRepository}#${String(pullRequest.number)}`;
        const offerKey = `${threadId} ${ref}`;
        if (pullRequest.state === "open" && !this.#offered.has(offerKey)) {
          if (await this.#options.offer(threadId, ref, `${ref} ${MERGE_WHEN_READY_OFFER}`)) {
            this.#offered.add(offerKey);
          }
        }
        if (!this.#options.keepCurrent(thread.projectId)) continue;
        const retry = this.#retryRequested.delete(threadId);
        if (pullRequest.state === "open") await this.#advance(threadId, "in-review", { retry });
        else
          await this.#advance(
            threadId,
            "done",
            { retry, requireEarlierWrite: true },
            pullRequest.url,
          );
      } catch {
        // This thread's alone; the next pass decides it again.
      }
    }
  }

  async #advance(
    threadId: string,
    moment: "in-progress" | "in-review" | "done",
    options: TrackerAdvanceOptions,
    url?: string,
  ): Promise<void> {
    const notices = await this.#options.writes.advance(threadId, moment, url, options);
    const held = this.#heldNotices.get(threadId) ?? [];
    for (const notice of notices) {
      const key = linkedIssueLabel(notice.issue);
      if (!(await this.#options.tell(threadId, key, notice.message))) {
        held.push({ key, line: notice.message });
      }
    }
    if (held.length > 0) this.#heldNotices.set(threadId, held);
  }

  async #tellHeld(threadId: string): Promise<void> {
    const held = this.#heldNotices.get(threadId);
    if (held === undefined) return;
    const still = [];
    for (const notice of held) {
      if (!(await this.#options.tell(threadId, notice.key, notice.line))) still.push(notice);
    }
    if (still.length === 0) this.#heldNotices.delete(threadId);
    else this.#heldNotices.set(threadId, still);
  }

  async #runPassThenSchedule(): Promise<void> {
    this.#running = true;
    try {
      await this.pass();
    } catch {
      // One unreadable pass must not end the timer.
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
