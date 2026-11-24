import type {
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestRow,
  ThreadBoardPullRequestFreshness,
  ThreadBoardPullRequestRelationship,
  ThreadBoardPullRequestState,
  ThreadBoardPullRequestSummaries,
  ThreadBoardPullRequestSummary,
  ThreadTouchedIssue,
  ThreadTouchedIssues,
} from "@octant/contracts";
import {
  MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY,
  MAX_THREAD_NAVIGATION_PULL_REQUEST_DISPLAY,
  MAX_THREAD_TOUCHED_ISSUES,
} from "@octant/contracts";

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

function summarizePullRequest(
  match: ThreadBoardPullRequestJoinRow,
  freshness: ThreadBoardPullRequestFreshness,
): ThreadBoardPullRequestSummary {
  const { row, relationship } = match;
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
    ...(row.additions === undefined ? {} : { additions: row.additions }),
    ...(row.deletions === undefined ? {} : { deletions: row.deletions }),
    ...(row.checkCounts === undefined ? {} : { checkCounts: row.checkCounts }),
    ...(row.merging === undefined ? {} : { merging: row.merging }),
  };
}

function byMostRecentlyUpdated(
  left: ThreadBoardPullRequestJoinRow,
  right: ThreadBoardPullRequestJoinRow,
): number {
  return right.row.updatedAt.localeCompare(left.row.updatedAt);
}

function boundSummaries(
  input: ThreadBoardPullRequestJoinInput & {
    readonly matches: ReadonlyArray<ThreadBoardPullRequestJoinRow>;
  },
  order: (left: ThreadBoardPullRequestJoinRow, right: ThreadBoardPullRequestJoinRow) => number,
  limit: number,
): ThreadBoardPullRequestSummaries {
  if (input.githubRevoked || input.rows.length === 0) {
    return { items: [], hiddenCount: 0 };
  }
  const freshness = summaryFreshness(input.snapshotFreshness);
  const sorted = [...input.matches].sort(order);
  return {
    items: sorted.slice(0, limit).map((match) => summarizePullRequest(match, freshness)),
    hiddenCount: Math.max(0, sorted.length - limit),
  };
}

/** A board card's few pull requests: the most recently updated first. */
export function composeThreadBoardPullRequestSummaries(
  input: ThreadBoardPullRequestJoinInput & {
    readonly matches: ReadonlyArray<ThreadBoardPullRequestJoinRow>;
  },
): ThreadBoardPullRequestSummaries {
  return boundSummaries(input, byMostRecentlyUpdated, MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY);
}

/**
 * Where a pull request sorts in a thread's own list: work still in flight
 * (open, draft, or a restart-recovered identity whose state is not yet known)
 * before work that landed, and landed work before work that was abandoned.
 */
function lifecycleRank(match: ThreadBoardPullRequestJoinRow): number {
  const state = deriveThreadBoardPullRequestState({
    state: match.row.state,
    draft: match.row.draft,
  });
  if (state === "merged") return 1;
  if (state === "closed") return 2;
  return 0;
}

/**
 * Every pull request a Code thread worked on, as its navigation entry carries
 * them for the sidebar's hover card and the Environment tool: in-flight first,
 * then merged, then closed, each group most recently updated first.
 */
export function composeThreadNavigationPullRequestSummaries(
  input: ThreadBoardPullRequestJoinInput & {
    readonly matches: ReadonlyArray<ThreadBoardPullRequestJoinRow>;
  },
): ThreadBoardPullRequestSummaries {
  return boundSummaries(
    input,
    (left, right) =>
      lifecycleRank(left) - lifecycleRank(right) || byMostRecentlyUpdated(left, right),
    MAX_THREAD_NAVIGATION_PULL_REQUEST_DISPLAY,
  );
}

/** States, as GitHub or a Linear workflow names them, that mean an issue is finished. */
const FINISHED_ISSUE_STATES: ReadonlySet<string> = new Set([
  "closed",
  "done",
  "completed",
  "canceled",
  "cancelled",
  "duplicate",
]);

/** Whether the state an issue was last seen in means it is finished. */
export function threadTouchedIssueIsFinished(issue: ThreadTouchedIssue): boolean {
  return issue.state !== undefined && FINISHED_ISSUE_STATES.has(issue.state.toLowerCase());
}

/**
 * The issues a Code thread's tool calls wrote to, as its navigation entry
 * carries them: a GitHub issue only in a repository the window may read and
 * while GitHub is not revoked, a Linear issue only while Linear is connected.
 * Open issues come first, then finished ones, each newest first.
 */
export function composeThreadTouchedIssues(input: {
  readonly issues: ReadonlyArray<ThreadTouchedIssue>;
  readonly readableRepositories: ReadonlyArray<{ readonly owner: string; readonly name: string }>;
  readonly githubRevoked: boolean;
  readonly linearConnected: boolean;
}): ThreadTouchedIssues | undefined {
  const readable = new Set(
    input.readableRepositories.map(
      (repository) => `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
    ),
  );
  const visible = input.issues.filter((issue) =>
    issue.forge === "github"
      ? !input.githubRevoked &&
        readable.has(`${issue.owner.toLowerCase()}/${issue.repository.toLowerCase()}`)
      : input.linearConnected,
  );
  if (visible.length === 0) return undefined;
  const ordered = [...visible].sort(
    (left, right) =>
      Number(threadTouchedIssueIsFinished(left)) - Number(threadTouchedIssueIsFinished(right)) ||
      right.observedAt.localeCompare(left.observedAt),
  );
  return {
    items: ordered.slice(0, MAX_THREAD_TOUCHED_ISSUES),
    hiddenCount: Math.max(0, ordered.length - MAX_THREAD_TOUCHED_ISSUES),
  };
}
