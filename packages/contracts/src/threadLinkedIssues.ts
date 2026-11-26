import { Schema } from "effect";
import { AggregateId, UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { LinearIssueIdentifier, LinearNodeId } from "./linearIssues";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** The most issues one thread is linked to. */
export const MAX_THREAD_LINKED_ISSUES = 10;

/**
 * One issue a thread works on: a GitHub issue by repository and number, or a
 * Linear issue by its public identifier and its node id. Names and titles are
 * never identity.
 */
export const LinkedIssueRef = Schema.Union(
  Schema.Struct({
    forge: Schema.Literal("github"),
    owner: GithubRepositoryOwner,
    repository: GithubRepositoryName,
    number: Schema.Int.pipe(Schema.between(1, 999_999_999)),
  }).annotations(strict),
  Schema.Struct({
    forge: Schema.Literal("linear"),
    identifier: LinearIssueIdentifier,
    issueId: LinearNodeId,
  }).annotations(strict),
);
export type LinkedIssueRef = typeof LinkedIssueRef.Type;

/** Who linked an issue: creating the thread from it, or the person. */
export const LinkedIssueSource = Schema.Literal("created-from", "person");
export type LinkedIssueSource = typeof LinkedIssueSource.Type;

/**
 * A thread's links live on their own aggregate (aggregate id = thread id), so
 * linking never races the thread's own version.
 */
export const THREAD_LINKED_ISSUES_AGGREGATE = "thread-linked-issues";
export const THREAD_LINKED_ISSUE_EVENT_NAMES = {
  linked: "thread.issue-linked@1",
  unlinked: "thread.issue-unlinked@1",
} as const;

export const ThreadIssueLinked = Schema.Struct({
  threadId: AggregateId,
  issue: LinkedIssueRef,
  source: LinkedIssueSource,
  linkedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadIssueLinked = typeof ThreadIssueLinked.Type;

export const ThreadIssueUnlinked = Schema.Struct({
  threadId: AggregateId,
  issue: LinkedIssueRef,
}).annotations(strict);
export type ThreadIssueUnlinked = typeof ThreadIssueUnlinked.Type;

/** A linked issue as a thread's navigation carries it. */
export const ThreadLinkedIssue = Schema.Struct({
  issue: LinkedIssueRef,
  source: LinkedIssueSource,
  linkedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadLinkedIssue = typeof ThreadLinkedIssue.Type;

export const ThreadLinkedIssues = Schema.Array(ThreadLinkedIssue).pipe(
  Schema.maxItems(MAX_THREAD_LINKED_ISSUES),
);
export type ThreadLinkedIssues = typeof ThreadLinkedIssues.Type;

/**
 * Every write Octant attempts on a tracker issue, on its own aggregate per
 * thread. A comment's text is never journaled, only its SHA-256 digest.
 */
export const TRACKER_ISSUE_WRITES_AGGREGATE = "tracker-issue-writes";
export const TRACKER_ISSUE_WRITE_RECORDED = "tracker.issue-write-recorded@1";

/** Where the host moves a linked issue: one moment of the thread's life each. */
export const LinkedIssueMoment = Schema.Literal("in-progress", "in-review", "done");
export type LinkedIssueMoment = typeof LinkedIssueMoment.Type;

export const TrackerIssueWriteAction = Schema.Literal("set-state", "comment", "close");
export type TrackerIssueWriteAction = typeof TrackerIssueWriteAction.Type;

export const TrackerIssueWriteOutcome = Schema.Literal("applied", "skipped", "refused", "failed");
export type TrackerIssueWriteOutcome = typeof TrackerIssueWriteOutcome.Type;

/**
 * Why a write did not apply. `missing-scope` is a Linear token that may only
 * read; `missing-capability` a GitHub login that may not write the
 * repository's issues; `no-matching-state` a Linear team with no state for the
 * moment; `already-there` an issue at or past the target, which the host never
 * moves backwards.
 */
export const TrackerIssueWriteReason = Schema.Literal(
  "missing-scope",
  "missing-capability",
  "no-matching-state",
  "already-there",
  "no-state-on-github",
  "not-linked",
  "not-connected",
  "rate-limited",
  "unavailable",
);
export type TrackerIssueWriteReason = typeof TrackerIssueWriteReason.Type;

export const TrackerIssueWriteRecorded = Schema.Struct({
  threadId: AggregateId,
  issue: LinkedIssueRef,
  action: TrackerIssueWriteAction,
  /** The host's moment; absent on the agent's own writes. */
  target: Schema.optional(LinkedIssueMoment),
  stateId: Schema.optional(LinearNodeId),
  outcome: TrackerIssueWriteOutcome,
  reason: Schema.optional(TrackerIssueWriteReason),
  /** SHA-256 of the comment text, hex; present on a comment only. */
  commentDigest: Schema.optional(Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/))),
  actor: Schema.Literal("host", "agent"),
}).annotations(strict);
export type TrackerIssueWriteRecorded = typeof TrackerIssueWriteRecorded.Type;

export const decodeLinkedIssueRef = Schema.decodeUnknownSync(LinkedIssueRef);
export const decodeThreadIssueLinked = Schema.decodeUnknownSync(ThreadIssueLinked);
export const decodeThreadIssueUnlinked = Schema.decodeUnknownSync(ThreadIssueUnlinked);
export const decodeTrackerIssueWriteRecorded = Schema.decodeUnknownSync(TrackerIssueWriteRecorded);
