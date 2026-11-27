import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const SECRETISH =
  /(?:lin_api_[A-Za-z0-9_]+|bearer\s+[A-Za-z0-9._-]{20,}|(?:refresh_token|access_token)\s*[=:]|token=)/i;
const safeText = (limit: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(limit),
    Schema.filter((value) => !SECRETISH.test(value) && !value.includes("\0")),
  );

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const ISSUE_BODY_MAX_BYTES = 8 * 1024;

/** Empty bodies are valid; bound UTF-8 bytes rather than characters. */
const boundedBody = (maxBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) =>
        !SECRETISH.test(value) && !value.includes("\0") && utf8ByteLength(value) <= maxBytes,
    ),
  );

/**
 * Opaque Linear node identity. Names and public identifiers alone are never
 * identity on the wire.
 */
export const LinearNodeId = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)),
);
export type LinearNodeId = typeof LinearNodeId.Type;

/** Public Linear identifier such as ENG-12. */
export const LinearIssueIdentifier = Schema.String.pipe(
  Schema.filter((value) => /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/.test(value)),
);
export type LinearIssueIdentifier = typeof LinearIssueIdentifier.Type;

/** Server-issued opaque cursor; clients replay it without interpreting it. */
export const LinearIssueCursor = Schema.String.pipe(
  Schema.filter((value) => /^[A-Za-z0-9+/=_-]{1,600}$/.test(value)),
);
export type LinearIssueCursor = typeof LinearIssueCursor.Type;

export const LinearIssuePageSize = Schema.Int.pipe(Schema.between(1, 50));
export type LinearIssuePageSize = typeof LinearIssuePageSize.Type;

export const LINEAR_ISSUE_LIST_OPERATION = "list-issues";
export const LINEAR_ISSUE_GET_OPERATION = "get-issue";
export const LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION = "get-issue-by-identifier";
export const LINEAR_ISSUE_FILTERS_OPERATION = "list-issue-filters";

export function linearIssueBrowseAvailable(
  capabilities: ReadonlyArray<{ readonly operationId: string; readonly available: boolean }>,
): boolean {
  return capabilities.some(
    (capability) => capability.operationId === LINEAR_ISSUE_LIST_OPERATION && capability.available,
  );
}

export const LinearUnassignedAssigneeId = Schema.Literal("unassigned");
export type LinearUnassignedAssigneeId = typeof LinearUnassignedAssigneeId.Type;

/**
 * Resolves to whoever the connected Linear account is, server-side. Reserved
 * so a client can ask for "my issues" without ever learning or guessing the
 * viewer's node id; it happens to fit the node-id shape, so the executor must
 * check for it before treating the value as an id.
 */
export const LINEAR_VIEWER_ASSIGNEE_ID = "me";
export const LinearViewerAssigneeId = Schema.Literal(LINEAR_VIEWER_ASSIGNEE_ID);
export type LinearViewerAssigneeId = typeof LinearViewerAssigneeId.Type;

export const LinearAssigneeFilterId = Schema.Union(
  LinearViewerAssigneeId,
  LinearNodeId,
  LinearUnassignedAssigneeId,
);
export type LinearAssigneeFilterId = typeof LinearAssigneeFilterId.Type;

/** A Linear issue page on linear.app, with nothing secret-shaped in it. */
export const LinearIssueUrl = Schema.String.pipe(
  Schema.maxLength(512),
  Schema.filter(
    (value) =>
      /^https:\/\/linear\.app\/[A-Za-z0-9_.\-/]*$/.test(value) &&
      !SECRETISH.test(value) &&
      !value.includes("@"),
  ),
);

export const LinearIssueState = Schema.Struct({
  name: safeText(64),
  type: safeText(32),
}).annotations(strict);
export type LinearIssueState = typeof LinearIssueState.Type;

export const LinearIssueRow = Schema.Struct({
  id: LinearNodeId,
  identifier: LinearIssueIdentifier,
  title: safeText(256),
  state: LinearIssueState,
  assignee: Schema.optional(safeText(128)),
  teamId: Schema.optional(LinearNodeId),
  teamKey: Schema.optional(safeText(16)),
  projectId: Schema.optional(LinearNodeId),
  url: LinearIssueUrl,
}).annotations(strict);
export type LinearIssueRow = typeof LinearIssueRow.Type;

const COMMENT_BODY_MAX_BYTES = 2 * 1024;

export const LinearIssueComment = Schema.Struct({
  author: safeText(128),
  createdAt: safeText(64),
  body: boundedBody(COMMENT_BODY_MAX_BYTES),
  truncated: Schema.Boolean,
}).annotations(strict);
export type LinearIssueComment = typeof LinearIssueComment.Type;

export const LinearIssueDetail = Schema.Struct({
  id: LinearNodeId,
  identifier: LinearIssueIdentifier,
  title: safeText(256),
  state: LinearIssueState,
  assignee: Schema.optional(safeText(128)),
  teamId: Schema.optional(LinearNodeId),
  teamKey: Schema.optional(safeText(16)),
  projectId: Schema.optional(LinearNodeId),
  url: LinearIssueUrl,
  description: boundedBody(ISSUE_BODY_MAX_BYTES),
  descriptionTruncated: Schema.Boolean,
  comments: Schema.Array(LinearIssueComment).pipe(Schema.maxItems(10)),
}).annotations(strict);
export type LinearIssueDetail = typeof LinearIssueDetail.Type;

export const LinearIssueStateCategory = Schema.Literal("open", "closed", "all");
export type LinearIssueStateCategory = typeof LinearIssueStateCategory.Type;

export const LinearIssueListFilter = Schema.Struct({
  teamId: Schema.optional(LinearNodeId),
  stateId: Schema.optional(LinearNodeId),
  stateCategory: Schema.optional(LinearIssueStateCategory),
  assigneeId: Schema.optional(LinearAssigneeFilterId),
  projectId: Schema.optional(LinearNodeId),
}).annotations(strict);
export type LinearIssueListFilter = typeof LinearIssueListFilter.Type;

export const LinearIssueListInput = Schema.Struct({
  search: Schema.optional(safeText(128)),
  /** Lists only the issue this public key names, whatever other titles hold it. */
  identifier: Schema.optional(LinearIssueIdentifier),
  filter: Schema.optional(LinearIssueListFilter),
  pageSize: Schema.optional(LinearIssuePageSize),
  cursor: Schema.optional(LinearIssueCursor),
}).annotations(strict);
export type LinearIssueListInput = typeof LinearIssueListInput.Type;

export const LinearIssueGetInput = Schema.Struct({
  id: LinearNodeId,
}).annotations(strict);
export type LinearIssueGetInput = typeof LinearIssueGetInput.Type;

export const LinearIssueGetByIdentifierInput = Schema.Struct({
  identifier: LinearIssueIdentifier,
}).annotations(strict);
export type LinearIssueGetByIdentifierInput = typeof LinearIssueGetByIdentifierInput.Type;

export const LinearIssueListPage = Schema.Struct({
  rows: Schema.Array(LinearIssueRow).pipe(Schema.maxItems(50)),
  hasNextPage: Schema.Boolean,
  endCursor: Schema.optional(LinearIssueCursor),
}).annotations(strict);
export type LinearIssueListPage = typeof LinearIssueListPage.Type;

export const LinearIssueFilterOption = Schema.Struct({
  id: Schema.Union(LinearNodeId, LinearUnassignedAssigneeId),
  label: safeText(128),
  key: Schema.optional(safeText(16)),
  name: Schema.optional(safeText(128)),
}).annotations(strict);
export type LinearIssueFilterOption = typeof LinearIssueFilterOption.Type;

export const LinearIssueFilterOptions = Schema.Struct({
  teams: Schema.Array(LinearIssueFilterOption).pipe(Schema.maxItems(50)),
  states: Schema.Array(LinearIssueFilterOption).pipe(Schema.maxItems(100)),
  assignees: Schema.Array(LinearIssueFilterOption).pipe(Schema.maxItems(50)),
  projects: Schema.Array(LinearIssueFilterOption).pipe(Schema.maxItems(50)),
}).annotations(strict);
export type LinearIssueFilterOptions = typeof LinearIssueFilterOptions.Type;

/** Decodes an unknown value as a Linear issue list request. */
export const decodeLinearIssueListInput = Schema.decodeUnknownSync(LinearIssueListInput);

/** Decodes an unknown value as a Linear issue detail request. */
export const decodeLinearIssueGetInput = Schema.decodeUnknownSync(LinearIssueGetInput);

/** Decodes an unknown value as a Linear issue lookup by public identifier. */
export const decodeLinearIssueGetByIdentifierInput = Schema.decodeUnknownSync(
  LinearIssueGetByIdentifierInput,
);

/** Decodes an unknown value as a Linear issue list page. */
export const decodeLinearIssueListPage = Schema.decodeUnknownSync(LinearIssueListPage);

/** Decodes an unknown value as a Linear issue detail. */
export const decodeLinearIssueDetail = Schema.decodeUnknownSync(LinearIssueDetail);

/** Decodes an unknown value as Linear issue filter options. */
export const decodeLinearIssueFilterOptions = Schema.decodeUnknownSync(LinearIssueFilterOptions);

/**
 * Write operations. They reach Linear only through the plugin's operation
 * port, and only with a token Linear granted the `write` scope; a read-only
 * token is refused with {@link LINEAR_MISSING_WRITE_SCOPE} before any call.
 */
export const LINEAR_ISSUE_WORKFLOW_OPERATION = "read-issue-workflow";
export const LINEAR_ISSUE_SET_STATE_OPERATION = "set-issue-state";
export const LINEAR_ISSUE_COMMENT_OPERATION = "comment-issue";
/**
 * The writes the host alone makes, for a thread's linked issues and with
 * its checks. The integration route refuses them from every client.
 */
export const LINEAR_HOST_ONLY_OPERATIONS: ReadonlyArray<string> = [
  LINEAR_ISSUE_SET_STATE_OPERATION,
  LINEAR_ISSUE_COMMENT_OPERATION,
];

/** The refusal a write answers when the stored Linear token may only read. */
export const LINEAR_MISSING_WRITE_SCOPE =
  "Linear lets Octant read only. Reconnect Linear in Settings › Integrations to allow updates.";

/** The most UTF-8 bytes of a comment Octant posts on an issue. */
export const MAX_TRACKER_COMMENT_BYTES = 4 * 1024;

export const LinearWorkflowState = Schema.Struct({
  id: LinearNodeId,
  name: safeText(64),
  type: safeText(32),
  position: Schema.Number,
}).annotations(strict);
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

/** An issue's current state and every state of its team, for choosing where it moves. */
export const LinearIssueWorkflow = Schema.Struct({
  id: LinearNodeId,
  identifier: LinearIssueIdentifier,
  url: LinearIssueUrl,
  state: LinearWorkflowState,
  teamStates: Schema.Array(LinearWorkflowState).pipe(Schema.maxItems(100)),
}).annotations(strict);
export type LinearIssueWorkflow = typeof LinearIssueWorkflow.Type;

export const LinearIssueSetStateInput = Schema.Struct({
  id: LinearNodeId,
  stateId: LinearNodeId,
}).annotations(strict);
export type LinearIssueSetStateInput = typeof LinearIssueSetStateInput.Type;

export const LinearIssueCommentInput = Schema.Struct({
  id: LinearNodeId,
  body: Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => utf8ByteLength(value) <= MAX_TRACKER_COMMENT_BYTES),
  ),
}).annotations(strict);
export type LinearIssueCommentInput = typeof LinearIssueCommentInput.Type;

export const decodeLinearIssueWorkflow = Schema.decodeUnknownSync(LinearIssueWorkflow);
export const decodeLinearIssueSetStateInput = Schema.decodeUnknownSync(LinearIssueSetStateInput);
export const decodeLinearIssueCommentInput = Schema.decodeUnknownSync(LinearIssueCommentInput);
