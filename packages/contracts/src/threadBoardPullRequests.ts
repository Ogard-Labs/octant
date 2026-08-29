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
