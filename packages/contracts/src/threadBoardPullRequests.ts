import { Schema } from "effect";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * Maximum pull-request summaries rendered on one Work or Code board card. The
 * server may join more matches; overflow is reported through `hiddenCount`.
 */
export const MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY = 3;

export const ThreadBoardPullRequestIdentity = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type ThreadBoardPullRequestIdentity = typeof ThreadBoardPullRequestIdentity.Type;

export const ThreadBoardPullRequestState = Schema.Literal(
  "unknown",
  "draft",
  "open",
  "merged",
  "closed",
);
export type ThreadBoardPullRequestState = typeof ThreadBoardPullRequestState.Type;

/**
 * `unavailable` means the snapshot cannot reach GitHub at all — `gh` missing,
 * unauthenticated, or offline — which is a different promise than `stale`
 * (reachable, but the facts are older than the last successful refresh).
 */
export const ThreadBoardPullRequestFreshness = Schema.Literal("fresh", "stale", "unavailable");
export type ThreadBoardPullRequestFreshness = typeof ThreadBoardPullRequestFreshness.Type;

export const ThreadBoardPullRequestMergeability = Schema.Literal(
  "mergeable",
  "conflicting",
  "unknown",
);
export type ThreadBoardPullRequestMergeability = typeof ThreadBoardPullRequestMergeability.Type;

export const ThreadBoardPullRequestChecksSummary = Schema.Literal(
  "unknown",
  "pending",
  "passing",
  "failing",
);
export type ThreadBoardPullRequestChecksSummary = typeof ThreadBoardPullRequestChecksSummary.Type;

export const ThreadBoardPullRequestReviewSummary = Schema.Literal(
  "unknown",
  "none",
  "pending",
  "approved",
  "changes-requested",
);
export type ThreadBoardPullRequestReviewSummary = typeof ThreadBoardPullRequestReviewSummary.Type;

/**
 * Largest line count the host reports for one side of a pull request, and the
 * most checks it counts. The host clamps to these so a very large pull request
 * is reported as large instead of failing a whole snapshot to decode.
 */
export const MAX_PULL_REQUEST_LINE_COUNT = 100_000_000;
export const MAX_PULL_REQUEST_CHECK_COUNT = 10_000;

/** Added or removed lines of the whole pull request, as the forge counts them. */
export const PullRequestLineCount = Schema.Int.pipe(Schema.between(0, MAX_PULL_REQUEST_LINE_COUNT));

/**
 * How many checks passed out of how many were counted. A check is counted when
 * the forge has decided it as passed or failed, or it is still running or
 * waiting; a skipped, neutral, cancelled or stale check is left out, because it
 * neither passes nor holds the pull request back. So a pull request whose
 * checks read "passing" always has `passed === total`.
 */
export const PullRequestCheckCounts = Schema.Struct({
  passed: Schema.Int.pipe(Schema.between(0, MAX_PULL_REQUEST_CHECK_COUNT)),
  total: Schema.Int.pipe(Schema.between(1, MAX_PULL_REQUEST_CHECK_COUNT)),
})
  .pipe(Schema.filter((counts) => counts.passed <= counts.total))
  .annotations(strict);
export type PullRequestCheckCounts = typeof PullRequestCheckCounts.Type;

/**
 * Why an open pull request is on its way in: `auto-merge` means auto-merge is
 * switched on, so it merges by itself once its requirements pass; `queued`
 * means it is in the repository's merge queue.
 */
export const PullRequestMerging = Schema.Literal("auto-merge", "queued");
export type PullRequestMerging = typeof PullRequestMerging.Type;

/**
 * How a Work board card reaches pull-request evidence through a Code thread.
 * Code board cards omit this field.
 */
export const ThreadBoardPullRequestRelationship = Schema.Literal("linked", "promoted");
export type ThreadBoardPullRequestRelationship = typeof ThreadBoardPullRequestRelationship.Type;

/**
 * One read-only pull-request summary joined from the in-memory Project pull-
 * request snapshot. `readyToMerge` is conservative: it is true only when every
 * required signal is present, fresh, and non-ambiguous; it never implies the
 * host can merge on GitHub.
 */
export const ThreadBoardPullRequestSummary = Schema.Struct({
  identity: ThreadBoardPullRequestIdentity,
  title: boundedNonEmptyText(256),
  state: ThreadBoardPullRequestState,
  checks: ThreadBoardPullRequestChecksSummary,
  review: ThreadBoardPullRequestReviewSummary,
  mergeability: ThreadBoardPullRequestMergeability,
  freshness: ThreadBoardPullRequestFreshness,
  readyToMerge: Schema.Boolean,
  relationship: Schema.optional(ThreadBoardPullRequestRelationship),
  /**
   * Added lines, removed lines, checks passed out of counted, and why an open
   * pull request is merging. Each is absent when the host has not read it (a
   * snapshot from before the fact was recorded, or a pull request known only
   * from a thread); absent never means zero, no checks, or not merging.
   */
  additions: Schema.optional(PullRequestLineCount),
  deletions: Schema.optional(PullRequestLineCount),
  checkCounts: Schema.optional(PullRequestCheckCounts),
  merging: Schema.optional(PullRequestMerging),
}).annotations(strict);
export type ThreadBoardPullRequestSummary = typeof ThreadBoardPullRequestSummary.Type;

export const ThreadBoardPullRequestSummaries = Schema.Struct({
  items: Schema.Array(ThreadBoardPullRequestSummary).pipe(
    Schema.maxItems(MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY),
  ),
  hiddenCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ThreadBoardPullRequestSummaries = typeof ThreadBoardPullRequestSummaries.Type;

export const decodeThreadBoardPullRequestIdentity = Schema.decodeUnknownSync(
  ThreadBoardPullRequestIdentity,
);
export const decodeThreadBoardPullRequestSummary = Schema.decodeUnknownSync(
  ThreadBoardPullRequestSummary,
);
export const decodeThreadBoardPullRequestSummaries = Schema.decodeUnknownSync(
  ThreadBoardPullRequestSummaries,
);
