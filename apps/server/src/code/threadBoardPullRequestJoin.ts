import type {
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestRow,
  CodeThreadId,
  ThreadBoardPullRequestSummaries,
} from "@octant/contracts";
import {
  composeThreadBoardPullRequestSummaries,
  matchPullRequestRowsToCodeThread,
} from "@octant/domain/thread-board-pull-request-policy";

export interface ThreadBoardPullRequestSnapshot {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly githubRevoked: boolean;
}

export function joinCodeThreadBoardPullRequests(input: {
  readonly threadId: CodeThreadId;
  readonly snapshot: ThreadBoardPullRequestSnapshot;
}): ThreadBoardPullRequestSummaries {
  const matches = matchPullRequestRowsToCodeThread({
    threadId: String(input.threadId),
    rows: input.snapshot.rows,
  });
  return composeThreadBoardPullRequestSummaries({
    rows: input.snapshot.rows,
    snapshotFreshness: input.snapshot.freshness,
    githubRevoked: input.snapshot.githubRevoked,
    matches,
  });
}

export function joinWorkThreadBoardPullRequests(): ThreadBoardPullRequestSummaries {
  // Promotions are Project-scoped today, so they cannot prove which Work
  // thread produced a Code thread. Fail closed until the contract carries an
  // authoritative Work-thread relationship.
  return { items: [], hiddenCount: 0 };
}
