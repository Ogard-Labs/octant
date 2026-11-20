/**
 * Pull request reviewer plugin contribution contracts.
 *
 * A pull request reviewer inspects one pushed head of a Code thread's pull
 * request through narrow, host-mediated ports and produces findings for the
 * host's existing `CodeReviewFinding` contract. Reviewers receive no raw
 * filesystem path, shell handle, or forge token, and the seam never exposes
 * formal forge reviews (approve or request changes).
 */

import { Schema } from "effect";
import { AgentRunId } from "./agentRun";
import {
  CodeCheckoutId,
  CodeDigest,
  CodeFileId,
  CodeRelativePath,
  CodeReviewFindingId,
  CodeThreadId,
} from "./code";
import { CodeOperationId, CodeReviewLocation } from "./codeOperations";
import { GithubRepositoryName, GithubRepositoryOwner } from "./githubCatalogue";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();

const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\u0000"),
    ),
  );

const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\u0000"),
    ),
  );

const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));

/** Maximum findings one pull request review run may submit. */
export const MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN = 64;
/** Maximum UTF-8 bytes a review prompt handed to a host-mediated review turn may carry. */
export const MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES = 128 * 1024;
/** Maximum UTF-8 bytes a single summary comment posted to a pull request may carry. */
export const MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES = 32 * 1024;
/** Maximum changed files included in one host-verified diff snapshot. */
export const MAX_PULL_REQUEST_REVIEW_DIFF_FILES = 512;
/** Maximum UTF-8 bytes of patch text per changed file in a diff snapshot. */
export const MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES = 256 * 1024;

/** A reviewer as the plugin host names it: the plugin and its component. */
export const PullRequestReviewerId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.pattern(/^[a-z0-9][a-z0-9._/-]*$/),
  Schema.brand("PullRequestReviewerId"),
);
export type PullRequestReviewerId = typeof PullRequestReviewerId.Type;

/** One host-admitted invocation of a pull request reviewer on a specific head. */
export const PullRequestReviewId = Schema.UUID.pipe(Schema.brand("PullRequestReviewId"));
export type PullRequestReviewId = typeof PullRequestReviewId.Type;

/** The pull request under review. */
export const PullRequestReviewTarget = Schema.Struct({
  projectId: ProjectId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type PullRequestReviewTarget = typeof PullRequestReviewTarget.Type;

/** The worker thread's route, given as a read-only fact so a reviewer knows what authored the diff. */
export const PullRequestReviewWorkerRoute = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type PullRequestReviewWorkerRoute = typeof PullRequestReviewWorkerRoute.Type;

/**
 * The model route the person picked for a model-backed reviewer, when one is
 * configured. There is no implicit fallback route: when absent or unusable, a
 * host-mediated review turn refuses honestly.
 */
export const PullRequestReviewRoute = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  effort: Schema.optional(boundedNonEmptyText(64)),
}).annotations(strict);
export type PullRequestReviewRoute = typeof PullRequestReviewRoute.Type;

/**
 * Host-owned opt-in switches as currently observed for this review. Advisory to
 * the reviewer; the host re-enforces both switches independently on every call.
 */
export const PullRequestReviewOptIns = Schema.Struct({
  postSummaryComment: Schema.Boolean,
  sendBlockingFindingsToWorker: Schema.Boolean,
}).annotations(strict);
export type PullRequestReviewOptIns = typeof PullRequestReviewOptIns.Type;

/** Immutable host-assembled request describing the exact PR head to review. */
export const PullRequestReviewRequest = Schema.Struct({
  reviewId: PullRequestReviewId,
  target: PullRequestReviewTarget,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  headSha: GitObjectId,
  baseRef: boundedNonEmptyText(512),
  baseSha: Schema.optional(GitObjectId),
  workerRoute: PullRequestReviewWorkerRoute,
  configuredRoute: Schema.optional(PullRequestReviewRoute),
  optIns: PullRequestReviewOptIns,
}).annotations(strict);
export type PullRequestReviewRequest = typeof PullRequestReviewRequest.Type;

/** One changed file in a host-verified PR diff snapshot; carries no host filesystem path. */
export const PullRequestReviewDiffFile = Schema.Struct({
  fileId: CodeFileId,
  path: CodeRelativePath,
  fileDigest: CodeDigest,
  status: Schema.Literal("added", "modified", "deleted", "renamed"),
  previousPath: Schema.optional(CodeRelativePath),
  patch: Schema.optional(boundedText(MAX_PULL_REQUEST_REVIEW_FILE_PATCH_BYTES)),
  truncated: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type PullRequestReviewDiffFile = typeof PullRequestReviewDiffFile.Type;

/** Host-verified read-only diff snapshot bound to one exact pull request head. */
export const PullRequestReviewDiffSnapshot = Schema.Struct({
  headSha: GitObjectId,
  baseRef: boundedNonEmptyText(512),
  baseSha: Schema.optional(GitObjectId),
  reviewOperationId: CodeOperationId,
  files: Schema.Array(PullRequestReviewDiffFile).pipe(
    Schema.maxItems(MAX_PULL_REQUEST_REVIEW_DIFF_FILES),
  ),
  truncated: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type PullRequestReviewDiffSnapshot = typeof PullRequestReviewDiffSnapshot.Type;

/**
 * One finding proposed by a reviewer plugin. The host verifies the path,
 * location, file digest, and diff anchor against the captured PR head before
 * writing a `CodeReviewFinding`, and stamps authorship and provenance itself.
 */
export const PullRequestReviewFindingProposal = Schema.Struct({
  path: CodeRelativePath,
  location: CodeReviewLocation,
  side: Schema.optional(Schema.Literal("original", "modified")),
  severity: Schema.Literal("note", "warning", "error"),
  summary: boundedNonEmptyText(4_096),
}).annotations(strict);
export type PullRequestReviewFindingProposal = typeof PullRequestReviewFindingProposal.Type;

/**
 * Why a host-mediated review turn or reviewer invocation was refused. Every
 * reason is explicit so the review pane can tell the person why nothing ran
 * without falling back silently to another model.
 */
export const PullRequestReviewTurnRefusalReason = Schema.Literal(
  "no-route-configured",
  "no-account",
  "route-refused",
  "capacity",
  "spend-ceiling",
  "head-stale",
  "not-effective",
  "unsupported",
);
export type PullRequestReviewTurnRefusalReason = typeof PullRequestReviewTurnRefusalReason.Type;

/** The settled outcome of one pull request reviewer invocation. */
export const PullRequestReviewOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("completed"),
    findingIds: Schema.Array(CodeReviewFindingId).pipe(
      Schema.maxItems(MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN),
    ),
    runId: Schema.optional(AgentRunId),
    summaryCommentPosted: Schema.optional(Schema.Boolean),
    handedBackToWorker: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("stale"),
    currentHeadSha: Schema.optional(GitObjectId),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: PullRequestReviewTurnRefusalReason,
    detail: boundedNonEmptyText(2_048),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("cancelled"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("failed"),
    detail: boundedNonEmptyText(2_048),
  }).annotations(strict),
);
export type PullRequestReviewOutcome = typeof PullRequestReviewOutcome.Type;

export const decodePullRequestReviewerId = Schema.decodeUnknownSync(PullRequestReviewerId);
export const decodePullRequestReviewId = Schema.decodeUnknownSync(PullRequestReviewId);
export const decodePullRequestReviewRequest = Schema.decodeUnknownSync(PullRequestReviewRequest);
export const decodePullRequestReviewDiffSnapshot = Schema.decodeUnknownSync(
  PullRequestReviewDiffSnapshot,
);
export const decodePullRequestReviewFindingProposal = Schema.decodeUnknownSync(
  PullRequestReviewFindingProposal,
);
export const decodePullRequestReviewOutcome = Schema.decodeUnknownSync(PullRequestReviewOutcome);
