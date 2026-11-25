import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { LinearIssueIdentifier } from "./linearIssues";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ThreadBoardDerivation } from "./threadBoard";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** Rows one host answers, most pressing first; the rest are said with `truncated`. */
export const MAX_ACTIVE_WORK_ROWS = 200;
export const MAX_ACTIVE_WORK_TITLE_LENGTH = 200;
/** Linked pull requests and issues one row names. */
export const MAX_ACTIVE_WORK_LINKS = 8;

const ActiveWorkText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_ACTIVE_WORK_TITLE_LENGTH),
);

/**
 * What a row is. A client drops a row of a kind it does not know, so a later
 * host may add one (a bot) without an earlier client losing the whole answer.
 */
export const ActiveWorkKind = Schema.Literal("thread", "coordinator", "subagent", "routine-run");
export type ActiveWorkKind = typeof ActiveWorkKind.Type;

/** A linked pull request by identity. Never its title, which an outsider may have written. */
export const ActiveWorkPullRequest = Schema.Struct({
  owner: GithubRepositoryOwner,
  repository: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type ActiveWorkPullRequest = typeof ActiveWorkPullRequest.Type;

/** A linked issue by identity, never by title. */
export const ActiveWorkIssue = Schema.Union(
  Schema.Struct({
    forge: Schema.Literal("github"),
    owner: GithubRepositoryOwner,
    repository: GithubRepositoryName,
    number: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
  Schema.Struct({
    forge: Schema.Literal("linear"),
    identifier: LinearIssueIdentifier,
  }).annotations(strict),
);
export type ActiveWorkIssue = typeof ActiveWorkIssue.Type;

/**
 * One piece of work that is not Done, on the host that answered. `board` is
 * the thread board's own derivation, so a row can never say a state the board
 * would not. A fact the host does not already hold is absent, never guessed.
 */
export const ActiveWorkRow = Schema.Struct({
  kind: ActiveWorkKind,
  mode: OctantMode,
  /** The thread to open; a subagent's is the thread it works for. */
  threadId: Schema.UUID,
  /** The run a subagent row is, so one thread's subagents stay apart. */
  runId: Schema.optional(Schema.UUID),
  /** Absent on a subagent whose task the reader may not see. */
  title: Schema.optional(ActiveWorkText),
  /** The title of the thread a subagent works for. */
  parentTitle: Schema.optional(ActiveWorkText),
  projectId: Schema.optional(ProjectId),
  projectName: Schema.optional(ActiveWorkText),
  board: ThreadBoardDerivation,
  /** `owner/name`, when the Project's checkout names one GitHub repository. */
  repository: Schema.optional(ActiveWorkText),
  branch: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  /** Present when the thread works in a worktree of its own. */
  ownWorktree: Schema.optional(Schema.Literal(true)),
  pullRequests: Schema.Array(ActiveWorkPullRequest).pipe(Schema.maxItems(MAX_ACTIVE_WORK_LINKS)),
  issues: Schema.Array(ActiveWorkIssue).pipe(Schema.maxItems(MAX_ACTIVE_WORK_LINKS)),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ActiveWorkRow = typeof ActiveWorkRow.Type;

/** One host's answer about its own work, within what the reader may open there. */
export const ActiveWork = Schema.Struct({
  rows: Schema.Array(ActiveWorkRow).pipe(Schema.maxItems(MAX_ACTIVE_WORK_ROWS)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type ActiveWork = typeof ActiveWork.Type;

export const ActiveWorkFailure = Schema.Struct({
  code: Schema.Literal("invalid", "unauthorized", "unavailable"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type ActiveWorkFailure = typeof ActiveWorkFailure.Type;

export const decodeActiveWork = Schema.decodeUnknownSync(ActiveWork);
export const decodeActiveWorkRow = Schema.decodeUnknownSync(ActiveWorkRow);
export const decodeActiveWorkFailure = Schema.decodeUnknownSync(ActiveWorkFailure);
