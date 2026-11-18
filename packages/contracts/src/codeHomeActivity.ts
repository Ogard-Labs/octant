import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const ActivityKind = Schema.Literal(
  "prs-merged",
  "issues-closed",
  "releases-published",
  "runs",
);
export type ActivityKind = typeof ActivityKind.Type;

export const ActivityFinish = Schema.Literal("successful", "failed", "canceled");
export type ActivityFinish = typeof ActivityFinish.Type;

/** Which journaled record a `runs` fact came from; delivery kinds name themselves. */
export const ActivityRunSource = Schema.Literal("code", "chat", "work", "agent-run");
export type ActivityRunSource = typeof ActivityRunSource.Type;

export const CODE_HOME_DELIVERY_OBSERVED = "code.home-delivery-observed@1";

const linkedThread = {
  projectId: ProjectId,
  threadId: CodeThreadId,
} as const;

const repositoryIdentity = {
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: PositiveInt,
} as const;

export const ActivityClosingPullRequest = Schema.Struct(repositoryIdentity).annotations(strict);
export type ActivityClosingPullRequest = typeof ActivityClosingPullRequest.Type;

/**
 * A forge merge a linked thread is confirmed to have witnessed. `mergedBy` is
 * the audited login the forge recorded as the merger, never the pull request's
 * author.
 */
export const ActivityPullRequestMergedObserved = Schema.Struct({
  kind: Schema.Literal("prs-merged"),
  ...linkedThread,
  ...repositoryIdentity,
  title: Schema.optional(boundedNonEmptyText(256)),
  occurredAt: UtcTimestamp,
  mergedBy: GithubRepositoryOwner,
}).annotations(strict);
export type ActivityPullRequestMergedObserved = typeof ActivityPullRequestMergedObserved.Type;

/** A forge issue closure a linked thread is confirmed to have witnessed. */
export const ActivityIssueClosedObserved = Schema.Struct({
  kind: Schema.Literal("issues-closed"),
  ...linkedThread,
  ...repositoryIdentity,
  title: Schema.optional(boundedNonEmptyText(256)),
  occurredAt: UtcTimestamp,
  closingPullRequest: ActivityClosingPullRequest,
}).annotations(strict);
export type ActivityIssueClosedObserved = typeof ActivityIssueClosedObserved.Type;

export const ActivityDeliveryObserved = Schema.Union(
  ActivityPullRequestMergedObserved,
  ActivityIssueClosedObserved,
);
export type ActivityDeliveryObserved = typeof ActivityDeliveryObserved.Type;

/** Fact metadata for a `runs` row: the run's settled finish and its mode. */
export const ActivityRunFactMetadata = Schema.Struct({
  source: ActivityRunSource,
  runId: Schema.NonEmptyTrimmedString,
  finish: ActivityFinish,
  mode: OctantMode,
}).annotations(strict);
export type ActivityRunFactMetadata = typeof ActivityRunFactMetadata.Type;

export const decodeActivityDeliveryObserved = Schema.decodeUnknownSync(ActivityDeliveryObserved);
export const decodeActivityRunFactMetadata = Schema.decodeUnknownSync(ActivityRunFactMetadata);

/* ------------------------------------------------------------------ *
 * Authorized Code Home reads                                          *
 * ------------------------------------------------------------------ */

/** Half-open activity window `[from, until)`; a null `from` is unbounded below. */
export const ActivityWindow = Schema.Struct({
  from: Schema.NullOr(UtcTimestamp),
  until: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((window) => window.from === null || window.from < window.until, {
      description: "an activity window whose start precedes its end",
    }),
  );
export type ActivityWindow = typeof ActivityWindow.Type;

/** Which history a card reads; `github` resolves through the forge seam. */
export const ActivityCardSource = Schema.Literal("octant", "github");
export type ActivityCardSource = typeof ActivityCardSource.Type;

export const ActivitySnapshotId = Schema.UUID.pipe(Schema.brand("ActivitySnapshotId"));
export type ActivitySnapshotId = typeof ActivitySnapshotId.Type;

const boundedOffset = Schema.Int.pipe(Schema.nonNegative(), Schema.lessThanOrEqualTo(1_000_000));

/**
 * One read builds the totals and the first page; every later page names the
 * frozen snapshot it came from, so a new journal append cannot move a
 * drilldown that is already open.
 */
export const ActivityQuery = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("read"),
    card: ActivityKind,
    source: ActivityCardSource,
    current: ActivityWindow,
    comparison: Schema.optional(ActivityWindow),
    refresh: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("page"),
    snapshotId: ActivitySnapshotId,
    offset: boundedOffset,
    allFinished: Schema.optional(Schema.Boolean),
  }),
).annotations(strict);
export type ActivityQuery = typeof ActivityQuery.Type;

/** One activity row: what it is, when it happened, and where it navigates. */
export const ActivityRecord = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prs-merged"),
    occurredAt: UtcTimestamp,
    id: Schema.NonEmptyTrimmedString,
    label: Schema.NonEmptyTrimmedString,
    repositoryOwner: GithubRepositoryOwner,
    repositoryName: GithubRepositoryName,
    number: PositiveInt,
    mergedBy: GithubRepositoryOwner,
    threadId: CodeThreadId,
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("issues-closed"),
    occurredAt: UtcTimestamp,
    id: Schema.NonEmptyTrimmedString,
    label: Schema.NonEmptyTrimmedString,
    repositoryOwner: GithubRepositoryOwner,
    repositoryName: GithubRepositoryName,
    number: PositiveInt,
    closingPullRequest: ActivityClosingPullRequest,
    threadId: CodeThreadId,
    projectId: Schema.optional(ProjectId),
  }),
  Schema.Struct({
    kind: Schema.Literal("releases-published"),
    occurredAt: UtcTimestamp,
    id: Schema.NonEmptyTrimmedString,
    label: Schema.NonEmptyTrimmedString,
    tag: Schema.NonEmptyTrimmedString,
    url: Schema.NonEmptyTrimmedString,
  }),
  Schema.Struct({
    kind: Schema.Literal("runs"),
    occurredAt: UtcTimestamp,
    id: Schema.NonEmptyTrimmedString,
    label: Schema.NonEmptyTrimmedString,
    source: ActivityRunSource,
    finish: ActivityFinish,
    mode: OctantMode,
    threadId: Schema.NonEmptyTrimmedString,
    runId: Schema.NonEmptyTrimmedString,
    projectId: Schema.optional(ProjectId),
  }),
).annotations(strict);
export type ActivityRecord = typeof ActivityRecord.Type;

/** How each `runs` view settled, counted across the whole selected window. */
export const ActivityFinishedCounts = Schema.Struct({
  successful: boundedOffset,
  failed: boundedOffset,
  canceled: boundedOffset,
}).annotations(strict);
export type ActivityFinishedCounts = typeof ActivityFinishedCounts.Type;

export const ActivityViewReason = Schema.Literal(
  "not-recorded",
  "not-connected",
  "not-checked",
  "incomplete",
  "rate-limited",
  "read-failed",
  "expired",
  "authorization-changed",
);
export type ActivityViewReason = typeof ActivityViewReason.Type;

export const ActivityViewFallback = Schema.Literal(
  "no-github-connection",
  "insecure-github-storage",
);
export type ActivityViewFallback = typeof ActivityViewFallback.Type;

/** The card view a caller may render; `records` never exceeds one page (25). */
export const ActivityView = Schema.Struct({
  status: Schema.Literal("ready", "partial", "unavailable"),
  source: ActivityCardSource,
  reason: Schema.optional(ActivityViewReason),
  fallback: Schema.optional(ActivityViewFallback),
  checkedAt: Schema.optional(UtcTimestamp),
  coverageFrom: Schema.optional(UtcTimestamp),
  count: Schema.optional(boundedOffset),
  comparisonCount: Schema.optional(boundedOffset),
  finished: Schema.optional(ActivityFinishedCounts),
  snapshotId: Schema.optional(ActivitySnapshotId),
  records: Schema.Array(ActivityRecord).pipe(Schema.maxItems(25)),
  nextOffset: Schema.optional(boundedOffset),
}).annotations(strict);
export type ActivityView = typeof ActivityView.Type;

export const decodeActivityQuery = Schema.decodeUnknownSync(ActivityQuery);
export const encodeActivityQuery = Schema.encodeSync(ActivityQuery);
export const decodeActivityView = Schema.decodeUnknownSync(ActivityView);
export const encodeActivityView = Schema.encodeSync(ActivityView);
export const decodeActivityRecord = Schema.decodeUnknownSync(ActivityRecord);
