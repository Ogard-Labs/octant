import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );
const githubUpdatedAt = Schema.String.pipe(
  Schema.filter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)),
);
const branchName = boundedNonEmptyText(255).pipe(
  Schema.filter((value) => !/\s/.test(value) && !value.includes("..")),
);

export const MAX_CODE_PROJECT_PULL_REQUEST_ROWS = 100;
export const MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS = 1_000;
export const MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS = 32;

/**
 * Cached read of the in-memory Project-scoped active pull-request snapshot.
 * There is no refresh flag: GitHub is reached only by an explicit refresh
 * command.
 */
export const CodeProjectPullRequestQuery = Schema.Struct({
  version: Schema.Literal(1),
}).annotations(strict);
export type CodeProjectPullRequestQuery = typeof CodeProjectPullRequestQuery.Type;

export const CodeProjectPullRequestRefreshCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("refresh-all"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refresh-project"),
    projectId: ProjectId,
  }).annotations(strict),
);
export type CodeProjectPullRequestRefreshCommand = typeof CodeProjectPullRequestRefreshCommand.Type;

export const CodeProjectPullRequestStaleReason = Schema.Literal(
  "rate-limited",
  "timeout",
  "malformed",
  "disconnected",
  "refresh-failed",
);
export type CodeProjectPullRequestStaleReason = typeof CodeProjectPullRequestStaleReason.Type;

export const CodeProjectPullRequestFreshness = Schema.Struct({
  status: Schema.Literal("fresh", "stale", "empty"),
  staleReason: Schema.optional(CodeProjectPullRequestStaleReason),
  lastSuccessfulRefreshAt: Schema.optional(UtcTimestamp),
  retryAfter: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CodeProjectPullRequestFreshness = typeof CodeProjectPullRequestFreshness.Type;

export const CodeProjectPullRequestConnection = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("connected"),
    projectId: ProjectId,
    projectName: boundedNonEmptyText(512),
    repositoryOwner: GithubRepositoryOwner,
    repositoryName: GithubRepositoryName,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unconnected"),
    projectId: ProjectId,
    projectName: boundedNonEmptyText(512),
  }).annotations(strict),
);
export type CodeProjectPullRequestConnection = typeof CodeProjectPullRequestConnection.Type;

export const CodeProjectPullRequestChecksSummary = Schema.Literal(
  "unknown",
  "pending",
  "passing",
  "failing",
);
export type CodeProjectPullRequestChecksSummary = typeof CodeProjectPullRequestChecksSummary.Type;

export const CodeProjectPullRequestReviewSummary = Schema.Literal(
  "unknown",
  "none",
  "pending",
  "approved",
  "changes-requested",
);
export type CodeProjectPullRequestReviewSummary = typeof CodeProjectPullRequestReviewSummary.Type;

export const CodeProjectPullRequestLinkedThread = Schema.Struct({
  threadId: CodeThreadId,
  title: boundedNonEmptyText(512),
}).annotations(strict);
export type CodeProjectPullRequestLinkedThread = typeof CodeProjectPullRequestLinkedThread.Type;

export const CodeProjectPullRequestRow = Schema.Struct({
  projectId: ProjectId,
  projectName: boundedNonEmptyText(512),
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
  title: boundedNonEmptyText(256),
  draft: Schema.Boolean,
  author: boundedNonEmptyText(128),
  baseBranch: branchName,
  headBranch: branchName,
  updatedAt: githubUpdatedAt,
  checks: CodeProjectPullRequestChecksSummary,
  review: CodeProjectPullRequestReviewSummary,
  linkedThreads: Schema.Array(CodeProjectPullRequestLinkedThread).pipe(
    Schema.maxItems(MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
  ),
}).annotations(strict);
export type CodeProjectPullRequestRow = typeof CodeProjectPullRequestRow.Type;

/**
 * Current authorized snapshot. Process-local only: never journaled.
 */
export const CodeProjectPullRequestView = Schema.Struct({
  version: Schema.Literal(1),
  query: CodeProjectPullRequestQuery,
  projects: Schema.Array(CodeProjectPullRequestConnection).pipe(
    Schema.filter(
      (projects) =>
        projects.length <= MAX_CODE_PROJECT_PULL_REQUEST_PROJECTS &&
        new Set(projects.map((project) => String(project.projectId))).size === projects.length,
    ),
  ),
  rows: Schema.Array(CodeProjectPullRequestRow).pipe(
    Schema.maxItems(MAX_CODE_PROJECT_PULL_REQUEST_ROWS),
  ),
  repositoriesTruncated: Schema.Boolean,
  pullRequestsTruncated: Schema.Boolean,
  freshness: CodeProjectPullRequestFreshness,
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeProjectPullRequestView = typeof CodeProjectPullRequestView.Type;

export const decodeCodeProjectPullRequestQuery = Schema.decodeUnknownSync(
  CodeProjectPullRequestQuery,
);
export const decodeCodeProjectPullRequestRefreshCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestRefreshCommand,
);
export const decodeCodeProjectPullRequestView = Schema.decodeUnknownSync(
  CodeProjectPullRequestView,
);
export const decodeCodeProjectPullRequestRow = Schema.decodeUnknownSync(CodeProjectPullRequestRow);
