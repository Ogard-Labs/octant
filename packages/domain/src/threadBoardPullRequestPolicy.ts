import type {
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestRow,
  ThreadBoardPullRequestFreshness,
  ThreadBoardPullRequestRelationship,
  ThreadBoardPullRequestState,
  ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
import { MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY } from "@octant/contracts";

export interface ThreadBoardPullRequestJoinRow {
  readonly row: CodeProjectPullRequestRow;
  readonly relationship?: ThreadBoardPullRequestRelationship;
}

export interface ThreadBoardPullRequestJoinInput {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly snapshotFreshness: CodeProjectPullRequestFreshness;
  readonly githubRevoked: boolean;
}

function summaryFreshness(
  snapshotFreshness: CodeProjectPullRequestFreshness,
): ThreadBoardPullRequestFreshness {
  return snapshotFreshness.status === "fresh" ? "fresh" : "stale";
}

export function deriveThreadBoardPullRequestState(input: {
  readonly draft: boolean;
}): ThreadBoardPullRequestState {
  return input.draft ? "draft" : "open";
}

/**
 * Conservative read-only merge readiness. Requires an open, non-draft pull
 * request with passing checks, approved review, and a fresh snapshot. Unknown
 * or stale evidence never qualifies.
 */
export function deriveConservativeReadyToMerge(input: {
  readonly state: ThreadBoardPullRequestState;
  readonly checks: CodeProjectPullRequestRow["checks"];
  readonly review: CodeProjectPullRequestRow["review"];
  readonly freshness: ThreadBoardPullRequestFreshness;
}): boolean {
  if (input.freshness !== "fresh") return false;
  if (input.state !== "open") return false;
  if (input.checks !== "passing") return false;
  if (input.review !== "approved") return false;
  return true;
}

export function matchPullRequestRowsToCodeThread(input: {
  readonly threadId: string;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
}): ReadonlyArray<ThreadBoardPullRequestJoinRow> {
  const matches: ThreadBoardPullRequestJoinRow[] = [];
  for (const row of input.rows) {
    if (!row.linkedThreads.some((thread) => String(thread.threadId) === input.threadId)) continue;
    matches.push({ row });
  }
  return matches;
}

export function matchPullRequestRowsToWorkThread(input: {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly promotedCodeThreadIds: ReadonlySet<string>;
  readonly linkedCodeThreadIds: ReadonlySet<string>;
}): ReadonlyArray<ThreadBoardPullRequestJoinRow> {
  const matches: ThreadBoardPullRequestJoinRow[] = [];
  const seen = new Set<string>();
  for (const row of input.rows) {
    for (const linked of row.linkedThreads) {
      const threadKey = `${String(row.projectId)}:${String(linked.threadId)}:${row.number}`;
      if (seen.has(threadKey)) continue;
      const threadId = String(linked.threadId);
      const relationship = input.promotedCodeThreadIds.has(threadId)
        ? "promoted"
        : input.linkedCodeThreadIds.has(threadId)
          ? "linked"
          : undefined;
      if (relationship === undefined) continue;
      seen.add(threadKey);
      matches.push({ row, relationship });
    }
  }
  return matches;
}

export function composeThreadBoardPullRequestSummaries(
  input: ThreadBoardPullRequestJoinInput & {
    readonly matches: ReadonlyArray<ThreadBoardPullRequestJoinRow>;
  },
): ThreadBoardPullRequestSummaries {
  if (input.githubRevoked || input.rows.length === 0) {
    return { items: [], hiddenCount: 0 };
  }
  const freshness = summaryFreshness(input.snapshotFreshness);
  const sorted = [...input.matches].sort((left, right) =>
    right.row.updatedAt.localeCompare(left.row.updatedAt),
  );
  const hiddenCount = Math.max(0, sorted.length - MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY);
  const items = sorted.slice(0, MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY).map(({ row, relationship }) => {
    const state = deriveThreadBoardPullRequestState({ draft: row.draft });
    return {
      identity: {
        projectId: row.projectId,
        repositoryOwner: row.repositoryOwner,
        repositoryName: row.repositoryName,
        number: row.number,
      },
      title: row.title,
      state,
      checks: row.checks,
      review: row.review,
      freshness,
      readyToMerge: deriveConservativeReadyToMerge({
        state,
        checks: row.checks,
        review: row.review,
        freshness,
      }),
      ...(relationship === undefined ? {} : { relationship }),
    };
  });
  return { items, hiddenCount };
}
