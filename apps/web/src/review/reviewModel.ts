import type { OctantMode } from "@octant/contracts/modes";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { isWaitingForReview } from "../shell/runningNow";

/**
 * One finished thread the person has not looked at yet. The thread keeps the
 * kind it was created with, so the mode names which host command answers for
 * it; the page never converts or widens a thread.
 */
export interface ReviewEntry {
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string;
  readonly projectName: string;
  /** When the thread last changed, as the navigation list reports it. */
  readonly updatedAt?: string;
}

export interface ReviewEntrySource {
  readonly mode: OctantMode;
  readonly thread: ChatThreadNavigationItem;
}

/**
 * The threads the sidebar's To review count counts, as rows. The predicate is
 * the tile's own, so the number and the list cannot disagree.
 */
export function buildReviewEntries(input: {
  readonly threads: ReadonlyArray<ReviewEntrySource>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly unfiledLabel: string;
}): ReadonlyArray<ReviewEntry> {
  const entries: ReviewEntry[] = [];
  for (const { mode, thread } of input.threads) {
    if (!isWaitingForReview(thread)) continue;
    entries.push({
      mode,
      threadId: thread.threadId,
      title: thread.title,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      projectName:
        thread.projectId === undefined
          ? input.unfiledLabel
          : (input.projectNames.get(thread.projectId) ?? input.unfiledLabel),
      ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    });
  }
  return entries;
}

/** The key a thread is known by across modes; two modes never share an id, but the key says so. */
export function reviewEntryKey(entry: Pick<ReviewEntry, "mode" | "threadId">): string {
  return `${entry.mode}:${entry.threadId}`;
}

/**
 * Oldest first: the thread that has waited longest is the one the person is
 * most likely to have forgotten. A finish time the host reported for the
 * thread's own activity wins over the thread record's last change, because a
 * provider turn that ends moves the first and not the second.
 */
export function orderReviewEntries(
  entries: ReadonlyArray<ReviewEntry>,
  finishedAt: ReadonlyMap<string, string>,
): ReadonlyArray<ReviewEntry> {
  const when = (entry: ReviewEntry): number => {
    const reported = finishedAt.get(reviewEntryKey(entry)) ?? entry.updatedAt;
    const parsed = reported === undefined ? Number.NaN : Date.parse(reported);
    // A thread with no date at all has no claim to being old; it goes last.
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return entries
    .map((entry, index) => ({ entry, index, at: when(entry) }))
    .sort((left, right) =>
      left.at === right.at ? left.index - right.index : left.at < right.at ? -1 : 1,
    )
    .map((item) => item.entry);
}

/** What a finished thread's checks say, in the words the page shows beside a glyph. */
export type ReviewCheckKind = "passed" | "failing" | "pending" | "none";

export const REVIEW_CHECK_WORDS: Readonly<Record<ReviewCheckKind, string>> = {
  passed: "passed",
  failing: "failing",
  pending: "pending",
  none: "no checks",
};
