import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import {
  GithubRepositoryName,
  GithubRepositoryNodeId,
  GithubRepositoryOwner,
} from "./githubCatalogue";
import { ProjectId } from "./projects";

const encoder = new TextEncoder();

const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter(
      (value) => encoder.encode(value).byteLength <= maximumBytes && !value.includes("\0"),
    ),
  );

const branchName = boundedNonEmptyText(255).check(
  Schema.makeFilter((value) => !/\s/.test(value) && !value.includes("..")),
);

const PullRequestUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
);

/** Fork or base head owner login as observed on github.com; display-only. */
const PullRequestHeadOwner = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/));

const uniqueArray = <S extends Schema.Top>(schema: S, maximum: number) =>
  Schema.Array(schema).check(
    Schema.makeFilter(
      (values) =>
        values.length <= maximum &&
        new Set(values.map((value) => String(value))).size === values.length,
    ),
  );

export const MAX_CODE_PULL_REQUEST_LINK_THREADS = 32;

/** Stable host-local identifier of one linked pull request record in the journal. */
export const PullRequestLinkId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("PullRequestLinkId"),
);
export type PullRequestLinkId = typeof PullRequestLinkId.Type;

/** Strict GitHub GraphQL / REST node identity for a pull request on github.com. */
export const GithubPullRequestNodeId = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z0-9+/=_-]{1,128}$/.test(value)),
);
export type GithubPullRequestNodeId = typeof GithubPullRequestNodeId.Type;

/** Which automated pull-request switch was reconciled during duplicate link merging. */
export const PullRequestSwitchKind = Schema.Literals(["merge-when-ready", "auto-fix", "watch"]);
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
  number: PositiveInt,
  url: Schema.optional(PullRequestUrl),
  baseBranch: Schema.optional(branchName),
  headOwner: Schema.optional(PullRequestHeadOwner),
  headBranch: Schema.optional(branchName),
  pullRequestNodeId: Schema.optional(GithubPullRequestNodeId),
  baseRepositoryNodeId: Schema.optional(GithubRepositoryNodeId),
  linkedAt: UtcTimestamp,
});
export type CodePullRequestLinkCreated = typeof CodePullRequestLinkCreated.Type;

/** Records an additional Code thread linked to an existing pull-request link. */
export const CodePullRequestLinkThreadAttached = Schema.Struct({
  linkId: PullRequestLinkId,
  threadId: CodeThreadId,
});
export type CodePullRequestLinkThreadAttached = typeof CodePullRequestLinkThreadAttached.Type;

/**
 * Backfills missing github.com forge node IDs onto an existing pull-request
 * link without rewriting prior journal entries.
 */
export const CodePullRequestLinkForgeIdsBackfilled = Schema.Struct({
  linkId: PullRequestLinkId,
  pullRequestNodeId: Schema.optional(GithubPullRequestNodeId),
  baseRepositoryNodeId: Schema.optional(GithubRepositoryNodeId),
}).check(
  Schema.makeFilter(
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
  number: PositiveInt,
  url: Schema.optional(PullRequestUrl),
  baseBranch: Schema.optional(branchName),
  headOwner: Schema.optional(PullRequestHeadOwner),
  headBranch: Schema.optional(branchName),
});
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
}).check(Schema.makeFilter((value) => String(value.linkId) !== String(value.survivingLinkId)));
export type CodePullRequestLinkMergedInto = typeof CodePullRequestLinkMergedInto.Type;

export const decodePullRequestLinkId = Schema.decodeUnknownSync(
  PullRequestLinkId,
  STRICT_DECODE_OPTIONS,
);
export const decodeGithubPullRequestNodeId = Schema.decodeUnknownSync(
  GithubPullRequestNodeId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePullRequestLinkCreated = Schema.decodeUnknownSync(
  CodePullRequestLinkCreated,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePullRequestLinkThreadAttached = Schema.decodeUnknownSync(
  CodePullRequestLinkThreadAttached,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePullRequestLinkForgeIdsBackfilled = Schema.decodeUnknownSync(
  CodePullRequestLinkForgeIdsBackfilled,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePullRequestLinkDisplayUpdated = Schema.decodeUnknownSync(
  CodePullRequestLinkDisplayUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeCodePullRequestLinkMergedInto = Schema.decodeUnknownSync(
  CodePullRequestLinkMergedInto,
  STRICT_DECODE_OPTIONS,
);
