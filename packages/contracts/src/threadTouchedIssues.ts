import { Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { LinearIssueIdentifier, LinearIssueUrl } from "./linearIssues";

const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** The most touched issues a Code thread's navigation entry carries. */
export const MAX_THREAD_TOUCHED_ISSUES = 100;

const TouchedIssueFacts = {
  /** The title and state the thread's latest call reported; they only describe it. */
  title: Schema.optional(boundedNonEmptyText(256)),
  state: Schema.optional(boundedNonEmptyText(64)),
  /** When the thread last wrote to it. */
  observedAt: NonEmptyTrimmedString,
};

/**
 * An issue a Code thread's tool calls wrote to (created, commented on,
 * edited, closed or reopened), from its journal alone. The host lists a
 * GitHub issue only in a repository the window may read, and a Linear issue
 * only while Linear is connected; nothing here was fetched for the read.
 */
export const ThreadTouchedIssue = Schema.Union([
  Schema.Struct({
    forge: Schema.Literal("github"),
    owner: GithubRepositoryOwner,
    repository: GithubRepositoryName,
    number: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999 })),
    ...TouchedIssueFacts,
  }),
  Schema.Struct({
    forge: Schema.Literal("linear"),
    identifier: LinearIssueIdentifier,
    url: Schema.optional(LinearIssueUrl),
    ...TouchedIssueFacts,
  }),
]);
export type ThreadTouchedIssue = typeof ThreadTouchedIssue.Type;

export const ThreadTouchedIssues = Schema.Struct({
  items: Schema.Array(ThreadTouchedIssue).check(Schema.isMaxLength(MAX_THREAD_TOUCHED_ISSUES)),
  hiddenCount: NonNegativeInt,
});
export type ThreadTouchedIssues = typeof ThreadTouchedIssues.Type;

export const decodeThreadTouchedIssues = Schema.decodeUnknownSync(
  ThreadTouchedIssues,
  STRICT_DECODE_OPTIONS,
);
