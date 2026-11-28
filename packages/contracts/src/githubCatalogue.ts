import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { GithubCapability, GithubCapabilityKind } from "./githubOnboarding";

const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(limit),
    Schema.makeFilter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const ISSUE_BODY_MAX_BYTES = 8 * 1024;
const COMMENT_BODY_MAX_BYTES = 2 * 1024;

/** Empty bodies are valid; bound UTF-8 bytes rather than characters. */
const boundedBody = (maxBytes: number) =>
  Schema.String.check(
    Schema.makeFilter(
      (value) =>
        !SECRETISH.test(value) && !value.includes("\0") && utf8ByteLength(value) <= maxBytes,
    ),
  );

/** GitHub login: 1–39 alphanumerics with single interior hyphens. */
export const GithubRepositoryOwner = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value)),
);
export type GithubRepositoryOwner = typeof GithubRepositoryOwner.Type;

export const GithubRepositoryName = Schema.String.check(
  Schema.makeFilter((value) => /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(value)),
);
export type GithubRepositoryName = typeof GithubRepositoryName.Type;

/** Strict GitHub node identity; names and paths alone are never identity. */
export const GithubRepositoryNodeId = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z0-9+/=_-]{1,128}$/.test(value)),
);
export type GithubRepositoryNodeId = typeof GithubRepositoryNodeId.Type;

/** Server-issued opaque cursor; clients replay it without interpreting it. */
export const GithubCatalogueCursor = Schema.String.check(
  Schema.makeFilter((value) => /^[A-Za-z0-9_-]{1,600}$/.test(value)),
);
export type GithubCatalogueCursor = typeof GithubCatalogueCursor.Type;

export const GithubCataloguePageSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 }),
);
export type GithubCataloguePageSize = typeof GithubCataloguePageSize.Type;

export const GithubRepositoryVisibility = Schema.Literals(["public", "private", "internal"]);
export type GithubRepositoryVisibility = typeof GithubRepositoryVisibility.Type;

export const GithubViewerPermission = Schema.Literals([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);
export type GithubViewerPermission = typeof GithubViewerPermission.Type;

const isoTimestamp = Schema.String.check(
  Schema.makeFilter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)),
);

// Row URLs are display-only conveniences; pin them to github.com and reject
// userinfo so a crafted URL can never smuggle credential material.
const githubUrl = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter(
    (value) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.\-/#?=&%]*$/.test(value) && !SECRETISH.test(value),
  ),
);

const branchName = safeText(255).check(
  Schema.makeFilter((value) => !/\s/.test(value) && !value.includes("..")),
);

export const GithubCatalogueStaleReason = Schema.Literals([
  "rate-limited",
  "refresh-failed",
  "authentication-changed",
  "disconnected",
]);
export type GithubCatalogueStaleReason = typeof GithubCatalogueStaleReason.Type;

export const GithubCatalogueFreshness = Schema.Struct({
  status: Schema.Literals(["fresh", "stale"]),
  staleReason: Schema.optional(GithubCatalogueStaleReason),
});
export type GithubCatalogueFreshness = typeof GithubCatalogueFreshness.Type;

export const GithubRepositoryRow = Schema.Struct({
  nodeId: GithubRepositoryNodeId,
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  visibility: GithubRepositoryVisibility,
  defaultBranch: Schema.optional(branchName),
  viewerPermission: GithubViewerPermission,
  capabilities: Schema.Array(GithubCapability).check(Schema.isMaxLength(4)),
});
export type GithubRepositoryRow = typeof GithubRepositoryRow.Type;

/**
 * Why GitHub says an issue was closed. Absent on an open issue, on a closed one
 * GitHub gives no reason for, on a reason this build does not know, and from an
 * older host, so a reader shows plain Closed.
 */
export const GithubIssueClosedReason = Schema.Literals(["completed", "not-planned", "duplicate"]);
export type GithubIssueClosedReason = typeof GithubIssueClosedReason.Type;

export const GithubIssueRow = Schema.Struct({
  number: PositiveInt,
  title: safeText(256),
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.optional(GithubIssueClosedReason),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
});
export type GithubIssueRow = typeof GithubIssueRow.Type;

export const GithubIssueComment = Schema.Struct({
  author: safeText(128),
  createdAt: isoTimestamp,
  body: boundedBody(COMMENT_BODY_MAX_BYTES),
  truncated: Schema.Boolean,
});
export type GithubIssueComment = typeof GithubIssueComment.Type;

export const GithubIssueDetail = Schema.Struct({
  number: PositiveInt,
  title: safeText(256),
  state: Schema.Literals(["open", "closed"]),
  stateReason: Schema.optional(GithubIssueClosedReason),
  author: safeText(128),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  url: githubUrl,
  labels: Schema.Array(safeText(50)).check(Schema.isMaxLength(20)),
  body: boundedBody(ISSUE_BODY_MAX_BYTES),
  bodyTruncated: Schema.Boolean,
  comments: Schema.Array(GithubIssueComment).check(Schema.isMaxLength(10)),
  /** How many older comments `comments`, the newest ten, leaves out. */
  commentsOmitted: Schema.optional(NonNegativeInt),
  /** Present when the number is a pull request, read only when the request allowed one. */
  pullRequest: Schema.optional(Schema.Literal(true)),
});
export type GithubIssueDetail = typeof GithubIssueDetail.Type;

export const GithubPullRequestRow = Schema.Struct({
  number: PositiveInt,
  title: safeText(256),
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
  baseBranch: Schema.optional(branchName),
  headBranch: Schema.optional(branchName),
});
export type GithubPullRequestRow = typeof GithubPullRequestRow.Type;

/** One issue or pull request a repository search found. */
export const GithubSearchRow = Schema.Struct({
  kind: Schema.Literals(["issue", "pull-request"]),
  number: PositiveInt,
  title: safeText(256),
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
  /** Only on a closed issue; a pull request has none. */
  stateReason: Schema.optional(GithubIssueClosedReason),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
});
export type GithubSearchRow = typeof GithubSearchRow.Type;

export const GithubProjectRow = Schema.Struct({
  number: PositiveInt,
  title: safeText(256),
  closed: Schema.Boolean,
  updatedAt: isoTimestamp,
  url: githubUrl,
});
export type GithubProjectRow = typeof GithubProjectRow.Type;

const pageFields = {
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optional(GithubCatalogueCursor),
  freshness: GithubCatalogueFreshness,
};

export const GithubRepositoryPage = Schema.Struct({
  rows: Schema.Array(GithubRepositoryRow).check(Schema.isMaxLength(100)),
  sort: Schema.Literal("pushed-desc"),
  ...pageFields,
});
export type GithubRepositoryPage = typeof GithubRepositoryPage.Type;

export const GithubIssuePage = Schema.Struct({
  rows: Schema.Array(GithubIssueRow).check(Schema.isMaxLength(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
});
export type GithubIssuePage = typeof GithubIssuePage.Type;

export const GithubPullRequestPage = Schema.Struct({
  rows: Schema.Array(GithubPullRequestRow).check(Schema.isMaxLength(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
});
export type GithubPullRequestPage = typeof GithubPullRequestPage.Type;

export const GithubSearchPage = Schema.Struct({
  rows: Schema.Array(GithubSearchRow).check(Schema.isMaxLength(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
});
export type GithubSearchPage = typeof GithubSearchPage.Type;

export const GithubProjectPage = Schema.Struct({
  rows: Schema.Array(GithubProjectRow).check(Schema.isMaxLength(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
});
export type GithubProjectPage = typeof GithubProjectPage.Type;

export const GithubIssueStateFilter = Schema.Literals(["open", "closed", "all"]);
export type GithubIssueStateFilter = typeof GithubIssueStateFilter.Type;

/** The closed reasons a read can be narrowed to; GitHub's search names both. */
export const GithubIssueClosedReasonFilter = Schema.Literals(["completed", "not-planned"]);
export type GithubIssueClosedReasonFilter = typeof GithubIssueClosedReasonFilter.Type;

export const GithubAssignedWorkCategory = Schema.Literals([
  "issue",
  "pull-request",
  "review-request",
]);
export type GithubAssignedWorkCategory = typeof GithubAssignedWorkCategory.Type;

/**
 * One open item waiting on the signed-in account, with its repository spelled
 * out: unlike the per-repository catalogue pages, assigned work spans every
 * repository the account can see, so a row without owner/name would be
 * unattributable in a cross-repository list.
 */
export const GithubAssignedWorkItem = Schema.Struct({
  category: GithubAssignedWorkCategory,
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  number: PositiveInt,
  title: safeText(256),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
  /** Set only on a draft pull request; absent from an older host's items. */
  draft: Schema.optional(Schema.Boolean),
});
export type GithubAssignedWorkItem = typeof GithubAssignedWorkItem.Type;

/**
 * A bounded snapshot, not a pageable catalogue: the inbox answers "what is
 * waiting on me right now", and anything beyond this cap belongs in the
 * repository catalogues, which do page.
 */
export const GithubAssignedWorkPage = Schema.Struct({
  items: Schema.Array(GithubAssignedWorkItem).check(Schema.isMaxLength(90)),
  freshness: GithubCatalogueFreshness,
});
export type GithubAssignedWorkPage = typeof GithubAssignedWorkPage.Type;

/**
 * The only reads a client may request. There is no field, header, endpoint,
 * GraphQL, CLI-flag, host, or mutation selection surface.
 */
export const GithubCatalogueReadRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    search: Schema.optional(safeText(160)),
    refresh: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("recent-repositories"),
  }),
  Schema.Struct({
    kind: Schema.Literal("repository"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
  }),
  Schema.Struct({
    kind: Schema.Literal("issues"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    state: Schema.optional(GithubIssueStateFilter),
    search: Schema.optional(safeText(160)),
    /** Narrows the read to issues nobody has been assigned. */
    assignee: Schema.optional(Schema.Literal("none")),
    /** Narrows a read of closed issues to one reason; refused with any other state. */
    closedReason: Schema.optional(GithubIssueClosedReasonFilter),
  }).check(
    Schema.makeFilter(
      (request) => request.closedReason === undefined || request.state === "closed",
    ),
  ),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    number: PositiveInt,
    /**
     * Reads the number even when it is a pull request. Absent, a pull request
     * is unavailable, as an issue reference always was.
     */
    includePullRequest: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("search"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    query: safeText(160),
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    state: Schema.optional(GithubIssueStateFilter),
    /** Matches the terms against titles only; absent searches titles and bodies. */
    match: Schema.optional(Schema.Literal("title")),
  }),
  Schema.Struct({
    kind: Schema.Literal("item"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    number: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    state: Schema.optional(GithubIssueStateFilter),
  }),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("assigned-work"),
  }),
]);
export type GithubCatalogueReadRequest = typeof GithubCatalogueReadRequest.Type;

export const GithubCatalogueUnavailableReason = Schema.Literals([
  "unauthorized",
  "scope-limited",
  "rate-limited",
  "insecure-storage",
  "external-token",
  "invalid-cursor",
  "unavailable",
]);
export type GithubCatalogueUnavailableReason = typeof GithubCatalogueUnavailableReason.Type;

export const GithubCatalogueUnavailable = Schema.Struct({
  kind: Schema.Literal("unavailable"),
  capability: GithubCapabilityKind,
  reason: GithubCatalogueUnavailableReason,
  remediation: Schema.optional(safeText(256)),
  retryAfterSeconds: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  ),
});
export type GithubCatalogueUnavailable = typeof GithubCatalogueUnavailable.Type;

export const GithubCatalogueReadResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    page: GithubRepositoryPage,
  }),
  Schema.Struct({
    kind: Schema.Literal("recent-repositories"),
    rows: Schema.Array(GithubRepositoryRow).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    kind: Schema.Literal("repository"),
    row: GithubRepositoryRow,
    freshness: GithubCatalogueFreshness,
  }),
  Schema.Struct({
    kind: Schema.Literal("issues"),
    page: GithubIssuePage,
  }),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    issue: GithubIssueDetail,
    freshness: GithubCatalogueFreshness,
  }),
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    page: GithubPullRequestPage,
  }),
  Schema.Struct({
    kind: Schema.Literal("search"),
    page: GithubSearchPage,
  }),
  Schema.Struct({
    kind: Schema.Literal("item"),
    row: GithubSearchRow,
    freshness: GithubCatalogueFreshness,
  }),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    page: GithubProjectPage,
  }),
  Schema.Struct({
    kind: Schema.Literal("assigned-work"),
    page: GithubAssignedWorkPage,
  }),
  GithubCatalogueUnavailable,
]);
export type GithubCatalogueReadResponse = typeof GithubCatalogueReadResponse.Type;

/**
 * Records one explicit repository selection into the host-local recents list.
 * The server resolves the row from its own observations; a client cannot
 * inject invented repository facts.
 */
export const GithubRecentRepositoryCommand = Schema.Struct({
  kind: Schema.Literal("record-recent-repository"),
  nodeId: GithubRepositoryNodeId,
});
export type GithubRecentRepositoryCommand = typeof GithubRecentRepositoryCommand.Type;

export const decodeGithubCatalogueReadRequest = Schema.decodeUnknownSync(
  GithubCatalogueReadRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeGithubCatalogueReadResponse = Schema.decodeUnknownSync(
  GithubCatalogueReadResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeGithubRecentRepositoryCommand = Schema.decodeUnknownSync(
  GithubRecentRepositoryCommand,
  STRICT_DECODE_OPTIONS,
);
