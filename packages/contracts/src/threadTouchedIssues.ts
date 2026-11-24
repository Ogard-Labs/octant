import { Schema } from "effect";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { LinearIssueIdentifier, LinearIssueUrl } from "./linearIssues";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** The most touched issues a Code thread's navigation entry carries. */
export const MAX_THREAD_TOUCHED_ISSUES = 100;

const TouchedIssueFacts = {
  /** The title and state the thread's latest call reported; they only describe it. */
  title: Schema.optional(boundedNonEmptyText(256)),
  state: Schema.optional(boundedNonEmptyText(64)),
  /** When the thread last wrote to it. */
  observedAt: Schema.NonEmptyTrimmedString,
};

/**
 * An issue a Code thread's tool calls wrote to (created, commented on,
 * edited, closed or reopened), from its journal alone. The host lists a
 * GitHub issue only in a repository the window may read, and a Linear issue
 * only while Linear is connected; nothing here was fetched for the read.
 */
export const ThreadTouchedIssue = Schema.Union(
  Schema.Struct({
    forge: Schema.Literal("github"),
    owner: GithubRepositoryOwner,
    repository: GithubRepositoryName,
    number: Schema.Int.pipe(Schema.between(1, 999_999_999)),
    ...TouchedIssueFacts,
  }).annotations(strict),
  Schema.Struct({
    forge: Schema.Literal("linear"),
    identifier: LinearIssueIdentifier,
    url: Schema.optional(LinearIssueUrl),
    ...TouchedIssueFacts,
  }).annotations(strict),
);
export type ThreadTouchedIssue = typeof ThreadTouchedIssue.Type;

export const ThreadTouchedIssues = Schema.Struct({
  items: Schema.Array(ThreadTouchedIssue).pipe(Schema.maxItems(MAX_THREAD_TOUCHED_ISSUES)),
  hiddenCount: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type ThreadTouchedIssues = typeof ThreadTouchedIssues.Type;

export const decodeThreadTouchedIssues = Schema.decodeUnknownSync(ThreadTouchedIssues);
