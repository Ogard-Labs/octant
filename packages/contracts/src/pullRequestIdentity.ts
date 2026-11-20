import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import {
  GithubRepositoryName,
  GithubRepositoryNodeId,
  GithubRepositoryOwner,
} from "./githubCatalogue";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();

const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );

const branchName = boundedNonEmptyText(255).pipe(
  Schema.filter((value) => !/\s/.test(value) && !value.includes("..")),
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

/** Fork or base head owner login as observed on github.com; display-only. */
const PullRequestHeadOwner = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_.-]{1,128}$/));

const uniqueArray = <A, I, R>(schema: Schema.Schema<A, I, R>, maximum: number) =>
  Schema.Array(schema).pipe(
    Schema.filter(
      (values) =>
        values.length <= maximum &&
        new Set(values.map((value) => String(value))).size === values.length,
    ),
  );

export const MAX_CODE_PULL_REQUEST_LINK_THREADS = 32;

/** Stable host-local identifier of one linked pull request record in the journal. */
export const PullRequestLinkId = Schema.UUID.pipe(Schema.brand("PullRequestLinkId"));
export type PullRequestLinkId = typeof PullRequestLinkId.Type;

/** Strict GitHub GraphQL / REST node identity for a pull request on github.com. */
export const GithubPullRequestNodeId = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9+/=_-]{1,128}$/.test(value)),
);
export type GithubPullRequestNodeId = typeof GithubPullRequestNodeId.Type;

/** Which automated pull-request switch was reconciled during duplicate link merging. */
export const PullRequestSwitchKind = Schema.Literal("merge-when-ready", "auto-fix", "watch");
export type PullRequestSwitchKind = typeof PullRequestSwitchKind.Type;

/** Aggregate type for every linked pull-request identity journal stream. */
export const CODE_PULL_REQUEST_LINK_AGGREGATE = "code-pull-request-link";

export const CODE_PULL_REQUEST_LINK_CREATED = "code.pull-request-link-created@1";
export const CODE_PULL_REQUEST_LINK_THREAD_ATTACHED = "code.pull-request-link-thread-attached@1";
export const CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED =
  "code.pull-request-link-forge-ids-backfilled@1";
export const CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED = "code.pull-request-link-display-updated@1";
export const CODE_PULL_REQUEST_LINK_MERGED_INTO = "code.pull-request-link-merged-into@1";

/**
 * First journal record of a linked github.com pull request.
 *
 * `pullRequestNodeId` and `baseRepositoryNodeId` (always the base repository,
 * never a fork's head repository) are recorded whenever GitHub supplied them,
 * and omitted when the host was offline or the forge could not supply them so
 * the link still works on `repositoryOwner`/`repositoryName` + `number` until
 * a later observation backfills the forge IDs.
 */
export const CodePullRequestLinkCreated = Schema.Struct({
  linkId: PullRequestLinkId,
  projectId: ProjectId,
  threadIds: uniqueArray(CodeThreadId, MAX_CODE_PULL_REQUEST_LINK_THREADS),
  host: Schema.Literal("github.com"),
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
  url: Schema.optional(PullRequestUrl),
  baseBranch: Schema.optional(branchName),
  headOwner: Schema.optional(PullRequestHeadOwner),
  headBranch: Schema.optional(branchName),
  pullRequestNodeId: Schema.optional(GithubPullRequestNodeId),
  baseRepositoryNodeId: Schema.optional(GithubRepositoryNodeId),
  linkedAt: UtcTimestamp,
}).annotations(strict);
export type CodePullRequestLinkCreated = typeof CodePullRequestLinkCreated.Type;

/** Records an additional Code thread linked to an existing pull-request link. */
export const CodePullRequestLinkThreadAttached = Schema.Struct({
  linkId: PullRequestLinkId,
  threadId: CodeThreadId,
}).annotations(strict);
export type CodePullRequestLinkThreadAttached = typeof CodePullRequestLinkThreadAttached.Type;

/**
 * Backfills missing github.com forge node IDs onto an existing pull-request
 * link without rewriting prior journal entries.
 */
export const CodePullRequestLinkForgeIdsBackfilled = Schema.Struct({
  linkId: PullRequestLinkId,
  pullRequestNodeId: Schema.optional(GithubPullRequestNodeId),
  baseRepositoryNodeId: Schema.optional(GithubRepositoryNodeId),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (value) => value.pullRequestNodeId !== undefined || value.baseRepositoryNodeId !== undefined,
    ),
  );
export type CodePullRequestLinkForgeIdsBackfilled =
  typeof CodePullRequestLinkForgeIdsBackfilled.Type;

/**
 * Updates mutable display and lookup fields (for example after a repository
 * rename or transfer) while preserving the link, its forge IDs, threads,
 * watches, and switches.
 */
export const CodePullRequestLinkDisplayUpdated = Schema.Struct({
  linkId: PullRequestLinkId,
  repositoryOwner: GithubRepositoryOwner,
  repositoryName: GithubRepositoryName,
  number: Schema.Int.pipe(Schema.positive()),
  url: Schema.optional(PullRequestUrl),
  baseBranch: Schema.optional(branchName),
  headOwner: Schema.optional(PullRequestHeadOwner),
  headBranch: Schema.optional(branchName),
}).annotations(strict);
export type CodePullRequestLinkDisplayUpdated = typeof CodePullRequestLinkDisplayUpdated.Type;

/**
 * Marks a later duplicate link as merged into the earlier link that owns the
 * same github.com pull request node ID. Nothing is deleted from the journal;
 * linked threads move to `survivingLinkId`, and any switch that was on in only
 * one of the two links is recorded in `disabledSwitches`.
 */
export const CodePullRequestLinkMergedInto = Schema.Struct({
  linkId: PullRequestLinkId,
  survivingLinkId: PullRequestLinkId,
  pullRequestNodeId: GithubPullRequestNodeId,
  baseRepositoryNodeId: Schema.optional(GithubRepositoryNodeId),
  movedThreadIds: uniqueArray(CodeThreadId, MAX_CODE_PULL_REQUEST_LINK_THREADS),
  disabledSwitches: uniqueArray(PullRequestSwitchKind, 3),
})
  .annotations(strict)
  .pipe(Schema.filter((value) => String(value.linkId) !== String(value.survivingLinkId)));
export type CodePullRequestLinkMergedInto = typeof CodePullRequestLinkMergedInto.Type;

export const decodePullRequestLinkId = Schema.decodeUnknownSync(PullRequestLinkId);
export const decodeGithubPullRequestNodeId = Schema.decodeUnknownSync(GithubPullRequestNodeId);
export const decodeCodePullRequestLinkCreated = Schema.decodeUnknownSync(
  CodePullRequestLinkCreated,
);
export const decodeCodePullRequestLinkThreadAttached = Schema.decodeUnknownSync(
  CodePullRequestLinkThreadAttached,
);
export const decodeCodePullRequestLinkForgeIdsBackfilled = Schema.decodeUnknownSync(
  CodePullRequestLinkForgeIdsBackfilled,
);
export const decodeCodePullRequestLinkDisplayUpdated = Schema.decodeUnknownSync(
  CodePullRequestLinkDisplayUpdated,
);
export const decodeCodePullRequestLinkMergedInto = Schema.decodeUnknownSync(
  CodePullRequestLinkMergedInto,
);
