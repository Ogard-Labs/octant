import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";

const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * Maximum pull-request summaries rendered on one Work or Code board card. The
 * server may join more matches; overflow is reported through `hiddenCount`.
 */
export const MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY = 3;

/**
 * Maximum pull-request summaries a Code thread's navigation entry carries. The
 * sidebar's hover card and the thread's Environment tool list every pull
 * request the thread worked on, so this bound is far above a board card's;
 * overflow is still reported through `hiddenCount`.
 */
export const MAX_THREAD_NAVIGATION_PULL_REQUEST_DISPLAY = 50;

export const ThreadBoardPullRequestIdentity = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
});
export type ThreadBoardPullRequestIdentity = typeof ThreadBoardPullRequestIdentity.Type;

export const ThreadBoardPullRequestState = Schema.Literals([
  "unknown",
  "draft",
  "open",
  "merged",
  "closed",
]);
export type ThreadBoardPullRequestState = typeof ThreadBoardPullRequestState.Type;

/**
 * `unavailable` means the snapshot cannot reach GitHub at all — `gh` missing,
 * unauthenticated, or offline — which is a different promise than `stale`
 * (reachable, but the facts are older than the last successful refresh).
 */
export const ThreadBoardPullRequestFreshness = Schema.Literals(["fresh", "stale", "unavailable"]);
export type ThreadBoardPullRequestFreshness = typeof ThreadBoardPullRequestFreshness.Type;

export const ThreadBoardPullRequestMergeability = Schema.Literals([
  "mergeable",
  "conflicting",
  "unknown",
]);
export type ThreadBoardPullRequestMergeability = typeof ThreadBoardPullRequestMergeability.Type;

export const ThreadBoardPullRequestChecksSummary = Schema.Literals([
  "unknown",
  "pending",
  "passing",
  "failing",
]);
export type ThreadBoardPullRequestChecksSummary = typeof ThreadBoardPullRequestChecksSummary.Type;

export const ThreadBoardPullRequestReviewSummary = Schema.Literals([
  "unknown",
  "none",
  "pending",
  "approved",
  "changes-requested",
]);
export type ThreadBoardPullRequestReviewSummary = typeof ThreadBoardPullRequestReviewSummary.Type;

/**
 * Largest line count the host reports for one side of a pull request, and the
 * most checks it counts. The host clamps to these so a very large pull request
 * is reported as large instead of failing a whole snapshot to decode.
 */
export const MAX_PULL_REQUEST_LINE_COUNT = 100_000_000;
export const MAX_PULL_REQUEST_CHECK_COUNT = 10_000;

/** Added or removed lines of the whole pull request, as the forge counts them. */
export const PullRequestLineCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: MAX_PULL_REQUEST_LINE_COUNT }),
);

/**
 * How many checks passed out of how many were counted. A check is counted when
 * the forge has decided it as passed or failed, or it is still running or
 * waiting; a skipped, neutral, cancelled or stale check is left out, because it
 * neither passes nor holds the pull request back. So a pull request whose
 * checks read "passing" always has `passed === total`.
 */
export const PullRequestCheckCounts = Schema.Struct({
  passed: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_PULL_REQUEST_CHECK_COUNT })),
  total: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PULL_REQUEST_CHECK_COUNT })),
}).check(Schema.makeFilter((counts) => counts.passed <= counts.total));
export type PullRequestCheckCounts = typeof PullRequestCheckCounts.Type;

/**
 * Why an open pull request is on its way in: `auto-merge` means auto-merge is
 * switched on, so it merges by itself once its requirements pass; `queued`
 * means it is in the repository's merge queue.
 */
export const PullRequestMerging = Schema.Literals(["auto-merge", "queued"]);
export type PullRequestMerging = typeof PullRequestMerging.Type;

/**
 * How a Work board card reaches pull-request evidence through a Code thread.
 * Code board cards omit this field.
 */
export const ThreadBoardPullRequestRelationship = Schema.Literals(["linked", "promoted"]);
export type ThreadBoardPullRequestRelationship = typeof ThreadBoardPullRequestRelationship.Type;

/**
 * Where an open pull request stands in its stack: `position` 1 is the bottom,
 * which lands first, and `parent` is the number of the pull request it is based
 * on, absent on the bottom. The host derives it from the branches of every open
 * pull request the window may read in that repository, so a thread that worked
 * on two layers of four still reads "2 of 4".
 */
export const PullRequestStackPlace = Schema.Struct({
  position: PositiveInt,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
  parent: Schema.optional(PositiveInt),
}).check(
  Schema.makeFilter(
    (place) =>
      place.position <= place.size && (place.parent === undefined) === (place.position === 1),
  ),
);
export type PullRequestStackPlace = typeof PullRequestStackPlace.Type;

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
  /** Absent on a pull request of no stack, and on a board card, which has no room for it. */
  stack: Schema.optional(PullRequestStackPlace),
});
export type ThreadBoardPullRequestSummary = typeof ThreadBoardPullRequestSummary.Type;

export const ThreadBoardPullRequestSummaries = Schema.Struct({
  items: Schema.Array(ThreadBoardPullRequestSummary).check(
    Schema.isMaxLength(MAX_THREAD_BOARD_PULL_REQUEST_DISPLAY),
  ),
  hiddenCount: NonNegativeInt,
});
export type ThreadBoardPullRequestSummaries = typeof ThreadBoardPullRequestSummaries.Type;

/**
 * The same summaries as a board card's, bounded for a thread's navigation
 * entry instead. The decoded shape is identical, so one renderer reads both.
 */
export const ThreadNavigationPullRequestSummaries = Schema.Struct({
  items: Schema.Array(ThreadBoardPullRequestSummary).check(
    Schema.isMaxLength(MAX_THREAD_NAVIGATION_PULL_REQUEST_DISPLAY),
  ),
  hiddenCount: NonNegativeInt,
});

export const decodeThreadBoardPullRequestIdentity = Schema.decodeUnknownSync(
  ThreadBoardPullRequestIdentity,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadBoardPullRequestSummary = Schema.decodeUnknownSync(
  ThreadBoardPullRequestSummary,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadBoardPullRequestSummaries = Schema.decodeUnknownSync(
  ThreadBoardPullRequestSummaries,
  STRICT_DECODE_OPTIONS,
);
export const decodeThreadNavigationPullRequestSummaries = Schema.decodeUnknownSync(
  ThreadNavigationPullRequestSummaries,
  STRICT_DECODE_OPTIONS,
);
