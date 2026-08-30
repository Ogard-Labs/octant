import { Schema } from "effect";
import { GithubCapability, GithubCapabilityKind } from "./githubOnboarding";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const SECRETISH =
  /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+|token=|authorization)/i;
const safeText = (limit: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(limit),
    Schema.filter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const ISSUE_BODY_MAX_BYTES = 8 * 1024;
const COMMENT_BODY_MAX_BYTES = 2 * 1024;

/** Empty bodies are valid; bound UTF-8 bytes rather than characters. */
const boundedBody = (maxBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) =>
        !SECRETISH.test(value) && !value.includes("\0") && utf8ByteLength(value) <= maxBytes,
    ),
  );

/** GitHub login: 1–39 alphanumerics with single interior hyphens. */
export const GithubRepositoryOwner = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(value)),
);
export type GithubRepositoryOwner = typeof GithubRepositoryOwner.Type;

export const GithubRepositoryName = Schema.String.pipe(
  Schema.filter((value) => /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(value)),
);
export type GithubRepositoryName = typeof GithubRepositoryName.Type;

/** Strict GitHub node identity; names and paths alone are never identity. */
export const GithubRepositoryNodeId = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9+/=_-]{1,128}$/.test(value)),
);
export type GithubRepositoryNodeId = typeof GithubRepositoryNodeId.Type;

/** Server-issued opaque cursor; clients replay it without interpreting it. */
export const GithubCatalogueCursor = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9_-]{1,600}$/.test(value)),
);
export type GithubCatalogueCursor = typeof GithubCatalogueCursor.Type;

export const GithubCataloguePageSize = Schema.Int.pipe(Schema.between(1, 100));
export type GithubCataloguePageSize = typeof GithubCataloguePageSize.Type;

export const GithubRepositoryVisibility = Schema.Literal("public", "private", "internal");
export type GithubRepositoryVisibility = typeof GithubRepositoryVisibility.Type;

export const GithubViewerPermission = Schema.Literal(
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
);
export type GithubViewerPermission = typeof GithubViewerPermission.Type;

const isoTimestamp = Schema.String.pipe(
  Schema.filter((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)),
);

// Row URLs are display-only conveniences; pin them to github.com and reject
// userinfo so a crafted URL can never smuggle credential material.
const githubUrl = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.filter(
    (value) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.\-/#?=&%]*$/.test(value) && !SECRETISH.test(value),
  ),
);

const branchName = safeText(255).pipe(
  Schema.filter((value) => !/\s/.test(value) && !value.includes("..")),
);

export const GithubCatalogueStaleReason = Schema.Literal(
  "rate-limited",
  "refresh-failed",
  "authentication-changed",
  "disconnected",
);
export type GithubCatalogueStaleReason = typeof GithubCatalogueStaleReason.Type;

export const GithubCatalogueFreshness = Schema.Struct({
  status: Schema.Literal("fresh", "stale"),
  staleReason: Schema.optional(GithubCatalogueStaleReason),
}).annotations(strict);
export type GithubCatalogueFreshness = typeof GithubCatalogueFreshness.Type;

export const GithubRepositoryRow = Schema.Struct({
  nodeId: GithubRepositoryNodeId,
  owner: GithubRepositoryOwner,
  name: GithubRepositoryName,
  visibility: GithubRepositoryVisibility,
  defaultBranch: Schema.optional(branchName),
  viewerPermission: GithubViewerPermission,
  capabilities: Schema.Array(GithubCapability).pipe(Schema.maxItems(4)),
}).annotations(strict);
export type GithubRepositoryRow = typeof GithubRepositoryRow.Type;

export const GithubIssueRow = Schema.Struct({
  number: Schema.Int.pipe(Schema.positive()),
  title: safeText(256),
  state: Schema.Literal("open", "closed"),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
}).annotations(strict);
export type GithubIssueRow = typeof GithubIssueRow.Type;

export const GithubIssueComment = Schema.Struct({
  author: safeText(128),
  createdAt: isoTimestamp,
  body: boundedBody(COMMENT_BODY_MAX_BYTES),
  truncated: Schema.Boolean,
}).annotations(strict);
export type GithubIssueComment = typeof GithubIssueComment.Type;

export const GithubIssueDetail = Schema.Struct({
  number: Schema.Int.pipe(Schema.positive()),
  title: safeText(256),
  state: Schema.Literal("open", "closed"),
  author: safeText(128),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  url: githubUrl,
  labels: Schema.Array(safeText(50)).pipe(Schema.maxItems(20)),
  body: boundedBody(ISSUE_BODY_MAX_BYTES),
  bodyTruncated: Schema.Boolean,
  comments: Schema.Array(GithubIssueComment).pipe(Schema.maxItems(10)),
}).annotations(strict);
export type GithubIssueDetail = typeof GithubIssueDetail.Type;

export const GithubPullRequestRow = Schema.Struct({
  number: Schema.Int.pipe(Schema.positive()),
  title: safeText(256),
  state: Schema.Literal("open", "draft", "merged", "closed"),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
  baseBranch: Schema.optional(branchName),
  headBranch: Schema.optional(branchName),
}).annotations(strict);
export type GithubPullRequestRow = typeof GithubPullRequestRow.Type;

export const GithubProjectRow = Schema.Struct({
  number: Schema.Int.pipe(Schema.positive()),
  title: safeText(256),
  closed: Schema.Boolean,
  updatedAt: isoTimestamp,
  url: githubUrl,
}).annotations(strict);
export type GithubProjectRow = typeof GithubProjectRow.Type;

const pageFields = {
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optional(GithubCatalogueCursor),
  freshness: GithubCatalogueFreshness,
};

export const GithubRepositoryPage = Schema.Struct({
  rows: Schema.Array(GithubRepositoryRow).pipe(Schema.maxItems(100)),
  sort: Schema.Literal("pushed-desc"),
  ...pageFields,
}).annotations(strict);
export type GithubRepositoryPage = typeof GithubRepositoryPage.Type;

export const GithubIssuePage = Schema.Struct({
  rows: Schema.Array(GithubIssueRow).pipe(Schema.maxItems(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
}).annotations(strict);
export type GithubIssuePage = typeof GithubIssuePage.Type;

export const GithubPullRequestPage = Schema.Struct({
  rows: Schema.Array(GithubPullRequestRow).pipe(Schema.maxItems(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
}).annotations(strict);
export type GithubPullRequestPage = typeof GithubPullRequestPage.Type;

export const GithubProjectPage = Schema.Struct({
  rows: Schema.Array(GithubProjectRow).pipe(Schema.maxItems(100)),
  sort: Schema.Literal("updated-desc"),
  ...pageFields,
}).annotations(strict);
export type GithubProjectPage = typeof GithubProjectPage.Type;

export const GithubIssueStateFilter = Schema.Literal("open", "closed", "all");
export type GithubIssueStateFilter = typeof GithubIssueStateFilter.Type;

export const GithubAssignedWorkCategory = Schema.Literal("issue", "pull-request", "review-request");
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
  number: Schema.Int.pipe(Schema.positive()),
  title: safeText(256),
  author: safeText(128),
  updatedAt: isoTimestamp,
  url: githubUrl,
}).annotations(strict);
export type GithubAssignedWorkItem = typeof GithubAssignedWorkItem.Type;

/**
 * A bounded snapshot, not a pageable catalogue: the inbox answers "what is
 * waiting on me right now", and anything beyond this cap belongs in the
 * repository catalogues, which do page.
 */
export const GithubAssignedWorkPage = Schema.Struct({
  items: Schema.Array(GithubAssignedWorkItem).pipe(Schema.maxItems(90)),
  freshness: GithubCatalogueFreshness,
}).annotations(strict);
export type GithubAssignedWorkPage = typeof GithubAssignedWorkPage.Type;

/**
 * The only reads a client may request. There is no field, header, endpoint,
 * GraphQL, CLI-flag, host, or mutation selection surface.
 */
export const GithubCatalogueReadRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    search: Schema.optional(safeText(160)),
    refresh: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("recent-repositories"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("issues"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    state: Schema.optional(GithubIssueStateFilter),
    search: Schema.optional(safeText(160)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    number: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
    state: Schema.optional(GithubIssueStateFilter),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    owner: GithubRepositoryOwner,
    name: GithubRepositoryName,
    pageSize: GithubCataloguePageSize,
    cursor: Schema.optional(GithubCatalogueCursor),
  }).annotations(strict),
  // The viewer is implied by the server's own gh authentication; a client
  // cannot ask for anyone else's assigned work.
  Schema.Struct({
    kind: Schema.Literal("assigned-work"),
  }).annotations(strict),
);
export type GithubCatalogueReadRequest = typeof GithubCatalogueReadRequest.Type;

export const GithubCatalogueUnavailableReason = Schema.Literal(
  "unauthorized",
  "scope-limited",
  "rate-limited",
  "insecure-storage",
  "external-token",
  "invalid-cursor",
  "unavailable",
);
export type GithubCatalogueUnavailableReason = typeof GithubCatalogueUnavailableReason.Type;

export const GithubCatalogueUnavailable = Schema.Struct({
  kind: Schema.Literal("unavailable"),
  capability: GithubCapabilityKind,
  reason: GithubCatalogueUnavailableReason,
  remediation: Schema.optional(safeText(256)),
  retryAfterSeconds: Schema.optional(Schema.Int.pipe(Schema.between(0, 86_400))),
}).annotations(strict);
export type GithubCatalogueUnavailable = typeof GithubCatalogueUnavailable.Type;

export const GithubCatalogueReadResponse = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("repositories"),
    page: GithubRepositoryPage,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("recent-repositories"),
    rows: Schema.Array(GithubRepositoryRow).pipe(Schema.maxItems(20)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("issues"),
    page: GithubIssuePage,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    issue: GithubIssueDetail,
    freshness: GithubCatalogueFreshness,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pull-requests"),
    page: GithubPullRequestPage,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("projects"),
    page: GithubProjectPage,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("assigned-work"),
    page: GithubAssignedWorkPage,
  }).annotations(strict),
  GithubCatalogueUnavailable,
);
export type GithubCatalogueReadResponse = typeof GithubCatalogueReadResponse.Type;

/**
 * Records one explicit repository selection into the host-local recents list.
 * The server resolves the row from its own observations; a client cannot
 * inject invented repository facts.
 */
export const GithubRecentRepositoryCommand = Schema.Struct({
  kind: Schema.Literal("record-recent-repository"),
  nodeId: GithubRepositoryNodeId,
}).annotations(strict);
export type GithubRecentRepositoryCommand = typeof GithubRecentRepositoryCommand.Type;

export const decodeGithubCatalogueReadRequest = Schema.decodeUnknownSync(
  GithubCatalogueReadRequest,
);
export const decodeGithubCatalogueReadResponse = Schema.decodeUnknownSync(
  GithubCatalogueReadResponse,
);
export const decodeGithubRecentRepositoryCommand = Schema.decodeUnknownSync(
  GithubRecentRepositoryCommand,
);
