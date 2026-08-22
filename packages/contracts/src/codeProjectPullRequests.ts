import { Schema } from "effect";
import { CodeThreadId } from "./code";
import {
  CodePullRequestReviewChangedFile,
  CodePullRequestReviewCheck,
  CodePullRequestReviewComment,
  CodePullRequestReviewCommit,
  CodePullRequestReviewOpinion,
  CodePullRequestReviewSection,
  MAX_CODE_PULL_REQUEST_REVIEW_ITEMS,
} from "./codeOperations";
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
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );
const uniqueArray = <A, I, R>(schema: Schema.Schema<A, I, R>, maximum: number) =>
  Schema.Array(schema).pipe(
    Schema.filter(
      (values) =>
        values.length <= maximum &&
        new Set(values.map((value) => String(value))).size === values.length,
    ),
  );
const PullRequestUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
);
const boundedReviewArray = <A, I, R>(schema: Schema.Schema<A, I, R>) =>
  Schema.Array(schema).pipe(
    Schema.filter((values) => values.length <= MAX_CODE_PULL_REQUEST_REVIEW_ITEMS),
  );

export const MAX_CODE_PROJECT_PULL_REQUEST_ROWS = 100;
export const MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DESCRIPTION_BYTES = 256 * 1024;
export const MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES = 1024 * 1024;
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

/**
 * Cached read of one in-memory Project-scoped pull-request detail snapshot.
 * There is no refresh flag: GitHub is reached only by an explicit refresh
 * command.
 */
export const CodeProjectPullRequestDetailQuery = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CodeProjectPullRequestDetailQuery = typeof CodeProjectPullRequestDetailQuery.Type;

export const CodeProjectPullRequestDetailRefreshCommand = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CodeProjectPullRequestDetailRefreshCommand =
  typeof CodeProjectPullRequestDetailRefreshCommand.Type;

export const CodeProjectPullRequestDetailSection = CodePullRequestReviewSection;
export type CodeProjectPullRequestDetailSection = typeof CodeProjectPullRequestDetailSection.Type;

export const CodeProjectPullRequestDetailObserved = Schema.Struct({
  state: Schema.Literal("observed"),
  freshness: Schema.Literal("fresh", "stale"),
  ambiguous: Schema.Boolean,
  staleSections: uniqueArray(CodeProjectPullRequestDetailSection, 7),
  number: Schema.Int.pipe(Schema.positive()),
  url: PullRequestUrl,
  title: boundedText(1_024),
  pullRequestState: Schema.Literal("open", "merged", "closed", "draft"),
  baseRepository: boundedNonEmptyText(512),
  baseBranch: branchName,
  headRepository: boundedText(512),
  headBranch: branchName,
  author: boundedText(255),
  matchesDeliveryBranch: Schema.Literal(false),
  description: boundedText(MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DESCRIPTION_BYTES),
  diff: boundedText(MAX_CODE_PROJECT_PULL_REQUEST_DETAIL_DIFF_BYTES),
  diffTruncated: Schema.Boolean,
  commits: boundedReviewArray(CodePullRequestReviewCommit),
  files: boundedReviewArray(CodePullRequestReviewChangedFile),
  checks: boundedReviewArray(CodePullRequestReviewCheck),
  reviews: boundedReviewArray(CodePullRequestReviewOpinion),
  comments: boundedReviewArray(CodePullRequestReviewComment),
}).annotations(strict);
export type CodeProjectPullRequestDetailObserved = typeof CodeProjectPullRequestDetailObserved.Type;

export const CodeProjectPullRequestDetail = Schema.Union(
  CodeProjectPullRequestDetailObserved,
  Schema.Struct({
    state: Schema.Literal("unavailable"),
  }).annotations(strict),
  Schema.Struct({
    state: Schema.Literal("empty"),
  }).annotations(strict),
);
export type CodeProjectPullRequestDetail = typeof CodeProjectPullRequestDetail.Type;

/**
 * Current authorized detail snapshot. Process-local only: never journaled.
 */
export const CodeProjectPullRequestDetailView = Schema.Struct({
  version: Schema.Literal(1),
  query: CodeProjectPullRequestDetailQuery,
  detail: CodeProjectPullRequestDetail,
  freshness: CodeProjectPullRequestFreshness,
  linkedThreads: Schema.Array(CodeProjectPullRequestLinkedThread).pipe(
    Schema.maxItems(MAX_CODE_PROJECT_PULL_REQUEST_LINKED_THREADS),
  ),
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeProjectPullRequestDetailView = typeof CodeProjectPullRequestDetailView.Type;

export const decodeCodeProjectPullRequestDetailQuery = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailQuery,
);
export const decodeCodeProjectPullRequestDetailRefreshCommand = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailRefreshCommand,
);
export const decodeCodeProjectPullRequestDetailView = Schema.decodeUnknownSync(
  CodeProjectPullRequestDetailView,
);
