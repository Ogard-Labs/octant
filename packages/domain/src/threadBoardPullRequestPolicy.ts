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
  if (snapshotFreshness.status === "fresh") return "fresh";
  // A snapshot that cannot reach GitHub at all is a different promise than a
  // reachable-but-old one: the rows below are journal-known identities that no
  // refresh — explicit or background — can currently confirm.
  if (snapshotFreshness.staleReason === "disconnected") return "unavailable";
  return "stale";
}

export function deriveThreadBoardPullRequestState(input: {
  readonly state: CodeProjectPullRequestRow["state"];
  readonly draft: boolean;
}): ThreadBoardPullRequestState {
  if (input.state !== "open") return input.state;
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
  readonly mergeability: CodeProjectPullRequestRow["mergeability"];
  readonly freshness: ThreadBoardPullRequestFreshness;
}): boolean {
  if (input.freshness !== "fresh") return false;
  if (input.state !== "open") return false;
  if (input.checks !== "passing") return false;
  if (input.review !== "approved") return false;
  if (input.mergeability !== "mergeable") return false;
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
  const items = sorted
    .slice(0, MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY)
    .map(({ row, relationship }) => {
      const state = deriveThreadBoardPullRequestState({ state: row.state, draft: row.draft });
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
        mergeability: row.mergeability,
        freshness,
        readyToMerge: deriveConservativeReadyToMerge({
          state,
          checks: row.checks,
          review: row.review,
          mergeability: row.mergeability,
          freshness,
        }),
        ...(relationship === undefined ? {} : { relationship }),
      };
    });
  return { items, hiddenCount };
}
