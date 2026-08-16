import { Schema } from "effect";
import { DiagnosticFailureCode } from "./diagnostics";
import { UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "./providers";
import { HostId } from "./shell";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

export const MAX_ROOTLESS_TURN_RESPONSE_BYTES = 64 * 1024;
export const MAX_ROOTLESS_TURN_FAILURE_BYTES = 8 * 1024;

export const RootlessThreadId = brandedUuid("RootlessThreadId");
export type RootlessThreadId = typeof RootlessThreadId.Type;

export const FolderAttachmentId = brandedUuid("FolderAttachmentId");
export type FolderAttachmentId = typeof FolderAttachmentId.Type;

export const RootlessTurnRequestId = brandedUuid("RootlessTurnRequestId");
export type RootlessTurnRequestId = typeof RootlessTurnRequestId.Type;

export const RootlessTurnId = brandedUuid("RootlessTurnId");
export type RootlessTurnId = typeof RootlessTurnId.Type;

/**
 * A rootless thread workspace variant. The thread has no Project, no bound
 * root, no repository identity, and no Project memory. It may later be
 * attached to a saved Project through an explicit audited transition.
 */
export const RootlessThreadWorkspace = Schema.Struct({
  kind: Schema.Literal("rootless"),
  scratchDirectory: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096))),
}).annotations(strict);
export type RootlessThreadWorkspace = typeof RootlessThreadWorkspace.Type;

/**
 * A project-backed thread workspace variant.
 */
export const ProjectBackedThreadWorkspace = Schema.Struct({
  kind: Schema.Literal("project-backed"),
  projectId: ProjectId,
}).annotations(strict);
export type ProjectBackedThreadWorkspace = typeof ProjectBackedThreadWorkspace.Type;

/**
 * The workspace variant for a thread — either rootless or project-backed.
 */
export const ThreadWorkspaceVariant = Schema.Union(
  RootlessThreadWorkspace,
  ProjectBackedThreadWorkspace,
);
export type ThreadWorkspaceVariant = typeof ThreadWorkspaceVariant.Type;

/**
 * Rootless thread creation context. Work and Code threads may start
 * without a Project, receiving no implicit filesystem or execution authority.
 */
export const RootlessThreadCreationContext = Schema.Struct({
  hostId: HostId,
  mode: Schema.Literal("work", "code"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  workspace: RootlessThreadWorkspace,
}).annotations(strict);
export type RootlessThreadCreationContext = typeof RootlessThreadCreationContext.Type;

/**
 * Server-authoritative creation command for a Work or Code thread without a
 * Project. The renderer supplies context identity but never a root or
 * authority grant.
 */
export const CreateRootlessThreadCommand = Schema.Struct({
  kind: Schema.Literal("create-rootless-thread"),
  threadId: RootlessThreadId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  context: RootlessThreadCreationContext,
}).annotations(strict);
export type CreateRootlessThreadCommand = typeof CreateRootlessThreadCommand.Type;

export const RootlessThreadCreateResult = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  threadId: RootlessThreadId,
  mode: Schema.Literal("work", "code"),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  workspace: RootlessThreadWorkspace,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type RootlessThreadCreateResult = typeof RootlessThreadCreateResult.Type;

export const ROOTLESS_ATTACH_FOLDER_REASON =
  "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.";

export const RootlessCapabilityFacts = Schema.Struct({
  workspace: Schema.Literal("rootless"),
  rootBackedTools: Schema.Struct({
    availability: Schema.Literal("unavailable"),
    reason: Schema.Literal(ROOTLESS_ATTACH_FOLDER_REASON),
  }).annotations(strict),
}).annotations(strict);
export type RootlessCapabilityFacts = typeof RootlessCapabilityFacts.Type;

export const RootlessFirstTurnContext = Schema.Struct({
  hostId: HostId,
  mode: Schema.Literal("work", "code"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  workspace: Schema.Struct({ kind: Schema.Literal("rootless") }).annotations(strict),
}).annotations(strict);
export type RootlessFirstTurnContext = typeof RootlessFirstTurnContext.Type;

export const StartRootlessThreadTurnCommand = Schema.Struct({
  kind: Schema.Literal("start-rootless-thread-turn"),
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  context: RootlessFirstTurnContext,
}).annotations(strict);
export type StartRootlessThreadTurnCommand = typeof StartRootlessThreadTurnCommand.Type;

export const RootlessTurnLifecycleStatus = Schema.Literal(
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "waiting",
);
export type RootlessTurnLifecycleStatus = typeof RootlessTurnLifecycleStatus.Type;

export const RootlessTurnFailure = Schema.Struct({
  category: Schema.Literal(
    "invalid",
    "unauthorized",
    "unavailable",
    "unsupported",
    "interrupted",
    "failed",
  ),
  /** The original provider failure category, when a provider emitted one. */
  code: Schema.optional(DiagnosticFailureCode),
  message: boundedNonEmptyText(MAX_ROOTLESS_TURN_FAILURE_BYTES),
}).annotations(strict);
export type RootlessTurnFailure = typeof RootlessTurnFailure.Type;

export const RootlessTurnState = Schema.Struct({
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
  providerSessionId: Schema.optional(ProviderSessionId),
  status: RootlessTurnLifecycleStatus,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  response: Schema.optional(boundedText(MAX_ROOTLESS_TURN_RESPONSE_BYTES)),
  failure: Schema.optional(RootlessTurnFailure),
  capabilities: RootlessCapabilityFacts,
  acceptedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessTurnState = typeof RootlessTurnState.Type;

export const RootlessTurnLookupResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    turn: RootlessTurnState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    requestId: RootlessTurnRequestId,
    threadId: RootlessThreadId,
    turnId: RootlessTurnId,
    prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
    capabilities: RootlessCapabilityFacts,
    message: Schema.NonEmptyTrimmedString,
    acceptedAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-created"),
    requestId: RootlessTurnRequestId,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type RootlessTurnLookupResult = typeof RootlessTurnLookupResult.Type;

export const CancelRootlessTurnCommand = Schema.Struct({
  kind: Schema.Literal("cancel-rootless-turn"),
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
}).annotations(strict);
export type CancelRootlessTurnCommand = typeof CancelRootlessTurnCommand.Type;

export const RootlessTurnCancelResult = Schema.Struct({
  kind: Schema.Literal("turn-cancelled", "turn-already-terminal"),
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
  status: RootlessTurnLifecycleStatus,
}).annotations(strict);
export type RootlessTurnCancelResult = typeof RootlessTurnCancelResult.Type;

/**
 * Folder attachment request — an explicit audited authority transition.
 * Applies only after any active turn ends and is re-evaluated by server policy.
 */
export const FolderAttachmentRequest = Schema.Struct({
  attachmentId: FolderAttachmentId,
  threadId: RootlessThreadId,
  projectId: ProjectId,
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type FolderAttachmentRequest = typeof FolderAttachmentRequest.Type;

/**
 * Folder attachment result from the server.
 */
export const FolderAttachmentResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("attached"),
    attachmentId: FolderAttachmentId,
    threadId: RootlessThreadId,
    projectId: ProjectId,
    attachedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    attachmentId: FolderAttachmentId,
    threadId: RootlessThreadId,
    reason: Schema.Literal(
      "wrong-mode",
      "unavailable",
      "archived",
      "stale-binding",
      "disconnected-host",
      "concurrent-turn",
      "cancelled",
      "policy-denied",
    ),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type FolderAttachmentResult = typeof FolderAttachmentResult.Type;

/**
 * Composer folder selector entry — a saved Project compatible with the
 * current mode/host, or a sentinel for "Add folder" / "No folder".
 */
export const ComposerFolderEntry = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("saved-project"),
    projectId: ProjectId,
    displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
    rootPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("add-folder"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("no-folder"),
  }).annotations(strict),
);
export type ComposerFolderEntry = typeof ComposerFolderEntry.Type;

/**
 * The current folder selection state visible in the composer.
 */
export const ComposerFolderSelection = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("project"),
    projectId: ProjectId,
    displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("no-folder"),
  }).annotations(strict),
).annotations(strict);
export type ComposerFolderSelection = typeof ComposerFolderSelection.Type;

export const decodeRootlessThreadId = Schema.decodeUnknownSync(RootlessThreadId);
export const decodeFolderAttachmentId = Schema.decodeUnknownSync(FolderAttachmentId);
export const decodeRootlessTurnRequestId = Schema.decodeUnknownSync(RootlessTurnRequestId);
export const decodeRootlessTurnId = Schema.decodeUnknownSync(RootlessTurnId);
export const decodeRootlessThreadWorkspace = Schema.decodeUnknownSync(RootlessThreadWorkspace);
export const decodeProjectBackedThreadWorkspace = Schema.decodeUnknownSync(
  ProjectBackedThreadWorkspace,
);
export const decodeThreadWorkspaceVariant = Schema.decodeUnknownSync(ThreadWorkspaceVariant);
export const decodeRootlessThreadCreationContext = Schema.decodeUnknownSync(
  RootlessThreadCreationContext,
);
export const decodeCreateRootlessThreadCommand = Schema.decodeUnknownSync(
  CreateRootlessThreadCommand,
);
export const decodeRootlessThreadCreateResult = Schema.decodeUnknownSync(
  RootlessThreadCreateResult,
);
export const decodeRootlessCapabilityFacts = Schema.decodeUnknownSync(RootlessCapabilityFacts);
export const decodeRootlessFirstTurnContext = Schema.decodeUnknownSync(RootlessFirstTurnContext);
export const decodeStartRootlessThreadTurnCommand = Schema.decodeUnknownSync(
  StartRootlessThreadTurnCommand,
);
export const decodeRootlessTurnState = Schema.decodeUnknownSync(RootlessTurnState);
export const decodeRootlessTurnLookupResult = Schema.decodeUnknownSync(RootlessTurnLookupResult);
export const decodeCancelRootlessTurnCommand = Schema.decodeUnknownSync(CancelRootlessTurnCommand);
export const decodeRootlessTurnCancelResult = Schema.decodeUnknownSync(RootlessTurnCancelResult);
export const decodeFolderAttachmentRequest = Schema.decodeUnknownSync(FolderAttachmentRequest);
export const decodeFolderAttachmentResult = Schema.decodeUnknownSync(FolderAttachmentResult);
export const decodeComposerFolderEntry = Schema.decodeUnknownSync(ComposerFolderEntry);
export const decodeComposerFolderSelection = Schema.decodeUnknownSync(ComposerFolderSelection);

/**
 * Event payload for `rootless.thread-created@1`. Records the durable creation
 * of a rootless Work or Code thread. The aggregate is the rootless thread
 * and the aggregate version starts at 1. Carries the creation context so
 * projections can restore workspace variant, mode, host, and provider identity
 * after restart or reconnect without an implicit Project or root.
 */
export const RootlessThreadCreated = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  threadId: RootlessThreadId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  mode: Schema.Literal("work", "code"),
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  workspace: RootlessThreadWorkspace,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type RootlessThreadCreated = typeof RootlessThreadCreated.Type;

/**
 * Event payload for `rootless.folder-attached@1`. Records a server-authorized,
 * single-root, audited folder attachment that transitions a rootless thread to
 * a project-backed workspace. Capability state refreshes after this event and
 * Project memory activates only for subsequent turns. The aggregate is the
 * rootless thread.
 */
export const RootlessFolderAttached = Schema.Struct({
  kind: Schema.Literal("folder-attached"),
  attachmentId: FolderAttachmentId,
  threadId: RootlessThreadId,
  projectId: ProjectId,
  attachedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessFolderAttached = typeof RootlessFolderAttached.Type;

/**
 * Event payload for `rootless.folder-attachment-denied@1`. Records an explicit
 * audited denial of a folder attachment request with a typed actionable reason.
 * The thread remains rootless. The aggregate is the rootless thread.
 */
export const RootlessFolderAttachmentDenied = Schema.Struct({
  kind: Schema.Literal("folder-attachment-denied"),
  attachmentId: FolderAttachmentId,
  threadId: RootlessThreadId,
  reason: Schema.Literal(
    "wrong-mode",
    "unavailable",
    "archived",
    "stale-binding",
    "disconnected-host",
    "concurrent-turn",
    "cancelled",
    "policy-denied",
  ),
  message: Schema.NonEmptyTrimmedString,
  deniedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessFolderAttachmentDenied = typeof RootlessFolderAttachmentDenied.Type;

export const RootlessTurnAccepted = Schema.Struct({
  kind: Schema.Literal("turn-accepted"),
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
  providerSessionId: ProviderSessionId,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  capabilities: RootlessCapabilityFacts,
  acceptedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessTurnAccepted = typeof RootlessTurnAccepted.Type;

export const RootlessTurnUpdated = Schema.Struct({
  kind: Schema.Literal("turn-updated"),
  requestId: RootlessTurnRequestId,
  threadId: RootlessThreadId,
  turnId: RootlessTurnId,
  status: Schema.Literal("running", "completed", "cancelled", "failed", "waiting"),
  response: Schema.optional(boundedText(MAX_ROOTLESS_TURN_RESPONSE_BYTES)),
  failure: Schema.optional(RootlessTurnFailure),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessTurnUpdated = typeof RootlessTurnUpdated.Type;

export const ROOTLESS_EVENT_NAMES = [
  "rootless.thread-created@1",
  "rootless.turn-accepted@1",
  "rootless.turn-updated@1",
  "rootless.folder-attached@1",
  "rootless.folder-attachment-denied@1",
] as const;

export type RootlessEventName = (typeof ROOTLESS_EVENT_NAMES)[number];

export const decodeRootlessThreadCreated = Schema.decodeUnknownSync(RootlessThreadCreated);
export const decodeRootlessTurnAccepted = Schema.decodeUnknownSync(RootlessTurnAccepted);
export const decodeRootlessTurnUpdated = Schema.decodeUnknownSync(RootlessTurnUpdated);
export const decodeRootlessFolderAttached = Schema.decodeUnknownSync(RootlessFolderAttached);
export const decodeRootlessFolderAttachmentDenied = Schema.decodeUnknownSync(
  RootlessFolderAttachmentDenied,
);

/**
 * Request to list saved Projects compatible with a rootless thread for folder
 * attachment. The server filters by mode, host, and active lifecycle; the
 * renderer never receives archived or wrong-mode Projects through this path.
 */
export const CompatibleProjectLookupRequest = Schema.Struct({
  threadId: RootlessThreadId,
  mode: Schema.Literal("work", "code"),
  hostId: HostId,
}).annotations(strict);
export type CompatibleProjectLookupRequest = typeof CompatibleProjectLookupRequest.Type;

/**
 * One compatible saved Project entry returned by the lookup. Carries only
 * renderer-facing display fields — no host path beyond the canonical root,
 * no credential, no authority token.
 */
export const CompatibleProjectEntry = Schema.Struct({
  projectId: ProjectId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  rootPath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(4096)),
}).annotations(strict);
export type CompatibleProjectEntry = typeof CompatibleProjectEntry.Type;

export const CompatibleProjectLookupResult = Schema.Struct({
  entries: Schema.Array(CompatibleProjectEntry),
}).annotations(strict);
export type CompatibleProjectLookupResult = typeof CompatibleProjectLookupResult.Type;

/**
 * Server-authorized attach-folder command. The renderer sends the thread id,
 * the target saved Project, and a binding receipt from the Add-folder flow.
 * The server validates authority before side effects and journals an audited
 * event. Rejected during an active turn.
 */
export const AttachFolderCommand = Schema.Struct({
  threadId: RootlessThreadId,
  projectId: ProjectId,
  receiptId: Schema.NonEmptyTrimmedString,
  attachmentId: FolderAttachmentId,
}).annotations(strict);
export type AttachFolderCommand = typeof AttachFolderCommand.Type;

export const AttachFolderFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: Schema.NonEmptyTrimmedString,
    reason: Schema.Literal(
      "wrong-mode",
      "archived",
      "stale-binding",
      "disconnected-host",
      "concurrent-turn",
      "cancelled",
      "policy-denied",
    ),
  }).annotations(strict),
).annotations(strict);
export type AttachFolderFailure = typeof AttachFolderFailure.Type;

export const RootlessTurnConflictReason = Schema.Literal("request-reused", "thread-exists");
export type RootlessTurnConflictReason = typeof RootlessTurnConflictReason.Type;

export const RootlessTurnCommandFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid", "unauthorized", "unavailable", "not-found"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("conflict"),
    message: Schema.NonEmptyTrimmedString,
    reason: RootlessTurnConflictReason,
  }).annotations(strict),
).annotations(strict);
export type RootlessTurnCommandFailure = typeof RootlessTurnCommandFailure.Type;

export const RootlessThreadFailure = Schema.Union(
  AttachFolderFailure,
  RootlessTurnCommandFailure,
).annotations(strict);
export type RootlessThreadFailure = typeof RootlessThreadFailure.Type;

export const decodeCompatibleProjectLookupRequest = Schema.decodeUnknownSync(
  CompatibleProjectLookupRequest,
);
export const decodeCompatibleProjectLookupResult = Schema.decodeUnknownSync(
  CompatibleProjectLookupResult,
);
export const decodeCompatibleProjectEntry = Schema.decodeUnknownSync(CompatibleProjectEntry);
export const decodeAttachFolderCommand = Schema.decodeUnknownSync(AttachFolderCommand);
export const decodeAttachFolderFailure = Schema.decodeUnknownSync(AttachFolderFailure);
export const decodeRootlessTurnCommandFailure = Schema.decodeUnknownSync(
  RootlessTurnCommandFailure,
);
export const decodeRootlessThreadFailure = Schema.decodeUnknownSync(RootlessThreadFailure);

/**
 * Summary of a rootless or project-backed thread for list views. Exposes the
 * workspace variant so the renderer can classify into Recents, All, and
 * Unfiled groups. No host path, credential, or authority token.
 */
export const RootlessThreadSummary = Schema.Struct({
  threadId: RootlessThreadId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  mode: Schema.Literal("work", "code"),
  hostId: HostId,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  workspaceKind: Schema.Literal("rootless", "project-backed"),
  projectId: Schema.optional(ProjectId),
  initialTurn: Schema.optional(RootlessTurnState),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type RootlessThreadSummary = typeof RootlessThreadSummary.Type;

/**
 * Grouped rootless thread list result. `recents` is a time-limited slice of
 * the most recently updated threads across all classifications. `all` contains
 * every tracked thread. `unfiled` contains only threads still in the rootless
 * workspace variant (no Project attached).
 */
export const RootlessThreadListResult = Schema.Struct({
  recents: Schema.Array(RootlessThreadSummary),
  all: Schema.Array(RootlessThreadSummary),
  unfiled: Schema.Array(RootlessThreadSummary),
}).annotations(strict);
export type RootlessThreadListResult = typeof RootlessThreadListResult.Type;

export const decodeRootlessThreadSummary = Schema.decodeUnknownSync(RootlessThreadSummary);
export const decodeRootlessThreadListResult = Schema.decodeUnknownSync(RootlessThreadListResult);
