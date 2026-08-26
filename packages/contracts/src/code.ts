import { Schema } from "effect";
import { AgentProfileId } from "./agentProfile";
import { AggregateVersion, GlobalSequence, UtcTimestamp } from "./events";
import { BindingRevisionId, ProjectId } from "./projects";
import { ThreadWorkingDirectory } from "./workingDirectory";
import {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderInstanceId,
  ProviderModelId,
  ThreadProviderHandoff,
} from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const brandedString = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

export const CodeThreadId = brandedUuid("CodeThreadId");
export type CodeThreadId = typeof CodeThreadId.Type;
export const CodeCheckoutId = brandedUuid("CodeCheckoutId");
export type CodeCheckoutId = typeof CodeCheckoutId.Type;
export const CodeFileId = brandedUuid("CodeFileId");
export type CodeFileId = typeof CodeFileId.Type;
export const CodeTerminalId = brandedUuid("CodeTerminalId");
export type CodeTerminalId = typeof CodeTerminalId.Type;
export const CodeTestRunId = brandedUuid("CodeTestRunId");
export type CodeTestRunId = typeof CodeTestRunId.Type;
export const CodeGitOperationId = brandedUuid("CodeGitOperationId");
export type CodeGitOperationId = typeof CodeGitOperationId.Type;
export const CodeReviewFindingId = brandedUuid("CodeReviewFindingId");
export type CodeReviewFindingId = typeof CodeReviewFindingId.Type;
export const ManagedRootGrantId = brandedUuid("ManagedRootGrantId");
export type ManagedRootGrantId = typeof ManagedRootGrantId.Type;
export const WorktreeReceiptId = brandedUuid("WorktreeReceiptId");
export type WorktreeReceiptId = typeof WorktreeReceiptId.Type;
export const CodeEvidenceContentId = brandedUuid("CodeEvidenceContentId");
export type CodeEvidenceContentId = typeof CodeEvidenceContentId.Type;
export const CodeRuntimeWorkId = brandedUuid("CodeRuntimeWorkId");
export type CodeRuntimeWorkId = typeof CodeRuntimeWorkId.Type;
export const CodeApprovalId = brandedUuid("CodeApprovalId");
export type CodeApprovalId = typeof CodeApprovalId.Type;
export const CodeAttachmentId = brandedUuid("CodeAttachmentId");
export type CodeAttachmentId = typeof CodeAttachmentId.Type;

/**
 * Code attachments are images only. Everything a repository holds already
 * reaches a Code turn through the checkout the thread is bound to, so the one
 * thing a path cannot carry is a picture the user is looking at — a screenshot,
 * a mockup, a photographed whiteboard.
 */
export const CODE_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const CodeAttachmentMediaType = Schema.Literal(...CODE_ATTACHMENT_MEDIA_TYPES);
export type CodeAttachmentMediaType = typeof CodeAttachmentMediaType.Type;
export const MAX_CODE_ATTACHMENT_BYTES = 10_485_760;
export const MAX_CODE_TURN_ATTACHMENTS = 8;
export const MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;

export const CodeRepositoryId = Schema.String.pipe(
  Schema.pattern(/^repo_[a-f0-9]{64}$/),
  Schema.brand("CodeRepositoryId"),
);
export type CodeRepositoryId = typeof CodeRepositoryId.Type;

const textEncoder = new TextEncoder();
export const MAX_CODE_RELATIVE_PATH_BYTES = 4_096;
export const CodeRelativePath = Schema.String.pipe(
  Schema.filter((value) => {
    if (
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      value.endsWith("/") ||
      value.normalize("NFC") !== value ||
      textEncoder.encode(value).byteLength > MAX_CODE_RELATIVE_PATH_BYTES
    ) {
      return false;
    }
    const components = value.split("/");
    return components.every(
      (component) => component !== "" && component !== "." && component !== "..",
    );
  }),
  Schema.brand("CodeRelativePath"),
);
export type CodeRelativePath = typeof CodeRelativePath.Type;

const GitObjectId = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/));
export const CodeCheckoutHead = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("branch"),
    name: brandedString("GitBranchName"),
    oid: GitObjectId,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("detached"), oid: GitObjectId }).annotations(strict),
);
export type CodeCheckoutHead = typeof CodeCheckoutHead.Type;

export const CodeCheckoutIdentity = Schema.Union(
  Schema.Struct({
    id: CodeCheckoutId,
    repositoryId: CodeRepositoryId,
    kind: Schema.Literal("existing-worktree"),
    availability: Schema.Literal("available", "unavailable", "waiting"),
    head: CodeCheckoutHead,
    observedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    id: CodeCheckoutId,
    repositoryId: CodeRepositoryId,
    kind: Schema.Literal("managed-worktree"),
    availability: Schema.Literal("available", "unavailable", "waiting"),
    head: CodeCheckoutHead,
    ownershipReceiptId: WorktreeReceiptId,
    observedAt: UtcTimestamp,
  }).annotations(strict),
);
export type CodeCheckoutIdentity = typeof CodeCheckoutIdentity.Type;

/**
 * The user-confirmed delivery outcome a Code thread is objectively working
 * toward. Ordered from least to most ambitious: an investigation result, a
 * local implementation, an opened pull request, and a merged pull request.
 * The kind is suggested from the creation prompt but only ever set by explicit
 * user confirmation; agents may propose a change but never redefine it.
 */
export const CodeDeliveryOutcomeKind = Schema.Literal(
  "investigation-result",
  "local-implementation",
  "opened-pr",
  "merged-pr",
);
export type CodeDeliveryOutcomeKind = typeof CodeDeliveryOutcomeKind.Type;

/**
 * A pending, agent-authored proposal to change the confirmed outcome kind. It
 * is advisory only: it never mutates the confirmed outcome and is cleared once
 * the user confirms or rejects it.
 */
export const CodeDeliveryOutcomeProposal = Schema.Struct({
  outcomeKind: CodeDeliveryOutcomeKind,
  rationale: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))),
  proposedAt: UtcTimestamp,
}).annotations(strict);
export type CodeDeliveryOutcomeProposal = typeof CodeDeliveryOutcomeProposal.Type;

export const CodeDeliveryTarget = Schema.Struct({
  branchIntent: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  remoteName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  proposedBaseRepository: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  proposedBaseBranch: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  outcomeKind: CodeDeliveryOutcomeKind,
  confirmedAt: UtcTimestamp,
  proposedOutcome: Schema.optional(CodeDeliveryOutcomeProposal),
}).annotations(strict);
export type CodeDeliveryTarget = typeof CodeDeliveryTarget.Type;

/**
 * Delivery outcome kinds were introduced after Code threads already persisted
 * delivery targets, so historical `code.thread-created@1` / `code.thread-updated@1`
 * events embed a target with no `outcomeKind`. Replaying those journals must
 * never fail. We default the missing kind to `local-implementation` — the
 * neutral outcome the suggestion policy also falls back to — so a pre-outcome
 * thread decodes as targeting the committed work it already carried a branch
 * and remote for, without ever fabricating a PR-level outcome the user never
 * confirmed. This default only applies on replay of pre-outcome events: every
 * new write always stamps an explicitly confirmed `outcomeKind`, and the live
 * `CodeDeliveryTarget` contract keeps the field required.
 */
export const CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT =
  "local-implementation" as const satisfies CodeDeliveryOutcomeKind;

/**
 * Backward-compatible decode of a persisted delivery target. Identical to
 * {@link CodeDeliveryTarget} except that a missing `outcomeKind` is filled with
 * {@link CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT} instead of being rejected. It is
 * used only on the persistence replay path, never for validating new writes.
 */
export const PersistedCodeDeliveryTarget = Schema.Struct({
  ...CodeDeliveryTarget.fields,
  outcomeKind: Schema.optionalWith(CodeDeliveryOutcomeKind, {
    default: () => CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT,
  }),
}).annotations(strict);
export type PersistedCodeDeliveryTarget = typeof PersistedCodeDeliveryTarget.Type;

/**
 * Bound on a thread title the user types. A title is a sidebar row, not a
 * document; anything longer would be truncated on screen anyway, and bounding
 * it here keeps the journal from carrying a paragraph as an identity.
 */
export const MAX_CODE_THREAD_TITLE_LENGTH = 200;

export const CodeThreadLifecycle = Schema.Literal("active", "archived", "waiting", "interrupted");
export type CodeThreadLifecycle = typeof CodeThreadLifecycle.Type;

/**
 * Where a forked thread branched from: the thread it came out of, and the last
 * turn of that thread it inherits.
 *
 * A fork carries the source conversation through this turn as read-only context
 * on its own first turn, so its provider genuinely knows the history the
 * transcript implies rather than only appearing to. The operation id is a plain
 * UUID rather than the branded `CodeOperationId` because operations import
 * threads, not the other way round; every comparison against it is by string.
 */
export const CodeThreadForkOrigin = Schema.Struct({
  threadId: CodeThreadId,
  throughOperationId: Schema.UUID,
}).annotations(strict);
export type CodeThreadForkOrigin = typeof CodeThreadForkOrigin.Type;

export const CodeThread = Schema.Struct({
  id: CodeThreadId,
  projectId: ProjectId,
  bindingRevisionId: BindingRevisionId,
  repositoryId: CodeRepositoryId,
  checkoutId: CodeCheckoutId,
  title: Schema.NonEmptyTrimmedString,
  /**
   * Whether the user has pinned this thread to the top of the sidebar. Optional
   * so a journal written before pinning existed replays as "not pinned" rather
   * than being rejected; absent and `false` mean the same thing.
   */
  pinned: Schema.optional(Schema.Boolean),
  /**
   * Set only on a thread that was forked from another one. Optional so a
   * journal written before forking existed replays unchanged; absent means this
   * thread started on its own.
   */
  forkedFrom: Schema.optional(CodeThreadForkOrigin),
  lifecycle: CodeThreadLifecycle,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  providerHandoff: Schema.optional(ThreadProviderHandoff),
  executionPolicy: ProviderExecutionPolicy,
  permissionPersistence: PermissionPersistence,
  /**
   * The profile this thread runs under, recorded so the thread can say which
   * working mode produced its posture. Optional so a journal written before
   * profiles bound threads replays as "no profile" rather than being rejected.
   * The posture itself is already in `executionPolicy`: a profile narrows it at
   * creation and is never consulted again for authority, so a profile edited
   * afterwards cannot change what a running thread may do.
   */
  profileId: Schema.optional(AgentProfileId),
  /**
   * Display name of the profile that produced this thread's posture and tool
   * allowlist. Snapshotted so a later refusal can name the profile without
   * reloading it. Optional for the same replay reason as `profileId`.
   */
  profileDisplayName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255))),
  /**
   * The profile's tool allowlist, snapshotted at creation so a later profile
   * edit cannot change what this thread may call. Absent or empty means no
   * constraint, matching how an empty model constraint list allows every model.
   * Optional so a journal written before this field existed replays as "no
   * constraint" rather than being rejected. The live profile is never consulted
   * for this list.
   */
  toolConstraints: Schema.optional(
    Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
  ),
  workingDirectory: Schema.optional(ThreadWorkingDirectory),
  deliveryTarget: CodeDeliveryTarget,
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeThread = typeof CodeThread.Type;

/**
 * Backward-compatible decode of a persisted thread. Identical to
 * {@link CodeThread} except that its delivery target tolerates a missing
 * `outcomeKind` on pre-outcome journals (see
 * {@link CODE_DELIVERY_OUTCOME_REPLAY_DEFAULT}). Used only on replay.
 */
export const PersistedCodeThread = Schema.Struct({
  ...CodeThread.fields,
  deliveryTarget: PersistedCodeDeliveryTarget,
}).annotations(strict);
export type PersistedCodeThread = typeof PersistedCodeThread.Type;

export const CodeExternalEditor = Schema.Struct({
  executable: Schema.NonEmptyTrimmedString.pipe(Schema.filter((value) => value.startsWith("/"))),
  arguments: Schema.Array(Schema.String.pipe(Schema.maxLength(1_024))).pipe(
    Schema.filter((arguments_) => arguments_.length <= 32),
  ),
}).annotations(strict);
export type CodeExternalEditor = typeof CodeExternalEditor.Type;

export const CodeSettings = Schema.Struct({
  defaultExecutionPolicy: ProviderExecutionPolicy,
  defaultPermissionPersistence: PermissionPersistence,
  externalEditor: Schema.optional(CodeExternalEditor),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeSettings = typeof CodeSettings.Type;

export const CodeWorktreeSourcePreviewFailureReason = Schema.Literal(
  "remote-unavailable",
  "fetch-rejected",
  "cancelled",
  "ambiguous-ref",
  "ref-unavailable",
  "unavailable",
);
export type CodeWorktreeSourcePreviewFailureReason =
  typeof CodeWorktreeSourcePreviewFailureReason.Type;

const WorktreeSourceBranch = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
const WorktreeSourceRemote = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255));

export const CodeWorktreeSourcePreview = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("origin"),
    remoteName: WorktreeSourceRemote,
    branch: WorktreeSourceBranch,
    resolvedHead: GitObjectId,
    fetchedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("local"),
    branch: WorktreeSourceBranch,
    resolvedHead: GitObjectId,
    remoteName: Schema.optional(WorktreeSourceRemote),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    reason: CodeWorktreeSourcePreviewFailureReason,
  }).annotations(strict),
);
export type CodeWorktreeSourcePreview = typeof CodeWorktreeSourcePreview.Type;

export const CodeWorktreeSourceProvenance = Schema.Struct({
  receiptId: WorktreeReceiptId,
  mode: Schema.Literal("origin", "local"),
  branch: WorktreeSourceBranch,
  resolvedHead: GitObjectId,
  remoteName: Schema.optional(WorktreeSourceRemote),
  fetchedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CodeWorktreeSourceProvenance = typeof CodeWorktreeSourceProvenance.Type;

const CodeThreadCommandFields = {
  threadId: CodeThreadId,
  expectedVersion: AggregateVersion,
} as const;

export const CodeWorktreeRemoteFacts = Schema.Struct({
  remotes: Schema.Array(WorktreeSourceRemote),
  upstreamRemote: Schema.optional(WorktreeSourceRemote),
  defaultRemote: Schema.optional(WorktreeSourceRemote),
}).annotations(strict);
export type CodeWorktreeRemoteFacts = typeof CodeWorktreeRemoteFacts.Type;

/** One selectable git ref for the composer's branch/worktree selector. */
export const CodeWorktreeRef = Schema.Struct({
  /** Short ref name, e.g. `development` or `origin/development`. */
  name: WorktreeSourceBranch,
  kind: Schema.Literal("local", "remote"),
  remoteName: Schema.optional(WorktreeSourceRemote),
  /** True when this ref is the current checkout head. */
  isCurrent: Schema.optional(Schema.Boolean),
  /** True when a linked worktree currently has this branch checked out. */
  hasWorktree: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type CodeWorktreeRef = typeof CodeWorktreeRef.Type;

export const CodeCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("prepare-code-project-checkout"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("get-worktree-remote-facts"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("list-code-worktree-refs"),
    projectId: ProjectId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("preview-code-worktree-source"),
    projectId: ProjectId,
    bindingRevisionId: BindingRevisionId,
    repositoryId: CodeRepositoryId,
    refIntent: WorktreeSourceBranch,
    startFromOrigin: Schema.Boolean,
    remoteName: Schema.optional(WorktreeSourceRemote),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-managed-code-thread"),
    threadId: CodeThreadId,
    projectId: ProjectId,
    bindingRevisionId: BindingRevisionId,
    title: Schema.NonEmptyTrimmedString,
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    executionPolicy: ProviderExecutionPolicy,
    permissionPersistence: PermissionPersistence,
    deliveryTarget: CodeDeliveryTarget,
    sourceBranch: WorktreeSourceBranch,
    startFromOrigin: Schema.Boolean,
    remoteName: Schema.optional(WorktreeSourceRemote),
    /**
     * Start the worktree from this exact revision instead of the tip of
     * `sourceBranch`. Present when the thread is taking up a recorded point in
     * another thread's history, where the branch tip has since moved on and
     * only the revision names what the user asked to return to. A revision
     * source never fetches: the object is already in the repository, or the
     * creation fails closed.
     */
    sourceRevision: Schema.optional(GitObjectId),
    /**
     * The thread and turn this one continues, so the new thread's first turn
     * carries that history as read-only context. The source thread is never
     * touched.
     */
    forkedFrom: Schema.optional(CodeThreadForkOrigin),
    /**
     * The profile the thread starts under. Optional because a thread may run
     * with no profile at all; when present it narrows the requested posture
     * before any authority gate runs.
     */
    profileId: Schema.optional(AgentProfileId),
    approvalId: Schema.optional(CodeApprovalId),
  })
    .annotations(strict)
    .pipe(
      Schema.filter((command) => command.sourceRevision === undefined || !command.startFromOrigin),
    ),
  Schema.Struct({
    kind: Schema.Literal("update-code-settings"),
    expectedVersion: AggregateVersion,
    defaultExecutionPolicy: ProviderExecutionPolicy,
    defaultPermissionPersistence: PermissionPersistence,
    externalEditor: Schema.optional(CodeExternalEditor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("create-code-thread"),
    thread: CodeThread,
    approvalId: Schema.optional(CodeApprovalId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-thread-lifecycle"),
    ...CodeThreadCommandFields,
    lifecycle: Schema.Literal("active", "archived"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename-code-thread"),
    ...CodeThreadCommandFields,
    title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_CODE_THREAD_TITLE_LENGTH)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pin-code-thread"),
    ...CodeThreadCommandFields,
    pinned: Schema.Boolean,
  }).annotations(strict),
  /**
   * Move a thread onto the checkout its Project binds now.
   *
   * A thread's checkout id is derived from the binding revision it was created
   * against, so rebinding the Project supersedes it and no later observation
   * can produce the thread's own id again. Without this the thread is
   * fail-closed for good, which 0032 refuses as a resting state. The act is
   * the user's, never inferred from a matching filesystem root: what authority
   * a thread holds only changes because someone asked.
   */
  Schema.Struct({
    kind: Schema.Literal("rebind-code-thread-checkout"),
    ...CodeThreadCommandFields,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-thread-access"),
    ...CodeThreadCommandFields,
    executionPolicy: ProviderExecutionPolicy,
    permissionPersistence: PermissionPersistence,
    approvalId: Schema.optional(CodeApprovalId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-thread-provider"),
    ...CodeThreadCommandFields,
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change-code-thread-working-directory"),
    ...CodeThreadCommandFields,
    workingDirectory: ThreadWorkingDirectory,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("propose-code-delivery-outcome"),
    ...CodeThreadCommandFields,
    outcomeKind: CodeDeliveryOutcomeKind,
    rationale: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("confirm-code-delivery-outcome"),
    ...CodeThreadCommandFields,
    outcomeKind: CodeDeliveryOutcomeKind,
  }).annotations(strict),
);
export type CodeCommand = typeof CodeCommand.Type;

export const CodeFailure = Schema.Struct({
  category: Schema.Literal(
    "unavailable",
    "unauthorized",
    "unsupported",
    "waiting",
    "interrupted",
    "failed",
    "disconnected",
    "stale",
    "invalid",
    "conflict",
  ),
  message: Schema.NonEmptyTrimmedString,
  retryAfterMs: Schema.optional(PositiveInt),
}).annotations(strict);
export type CodeFailure = typeof CodeFailure.Type;

export const CodeDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
export type CodeDigest = typeof CodeDigest.Type;

/**
 * What the journal keeps about one attached image: enough to name it, to read
 * its bytes back out of the managed attachment store, and to prove they are the
 * bytes the turn was sent. The image itself never enters the event journal.
 */
export const CodeAttachmentReference = Schema.Struct({
  attachmentId: CodeAttachmentId,
  displayName: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_CODE_ATTACHMENT_DISPLAY_NAME_LENGTH),
  ),
  mediaType: CodeAttachmentMediaType,
  byteLength: Schema.Int.pipe(Schema.between(1, MAX_CODE_ATTACHMENT_BYTES)),
  digest: CodeDigest,
}).annotations(strict);
export type CodeAttachmentReference = typeof CodeAttachmentReference.Type;

export const CodeFileMetadata = Schema.Struct({
  identity: Schema.Struct({
    device: Schema.NonEmptyTrimmedString,
    inode: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  modifiedNanoseconds: Schema.NonEmptyTrimmedString,
  digest: CodeDigest,
}).annotations(strict);
export type CodeFileMetadata = typeof CodeFileMetadata.Type;

export const CodeFileSaveFailure = Schema.Struct({
  category: Schema.Literal("conflict", "failed", "invalid", "unavailable"),
  code: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type CodeFileSaveFailure = typeof CodeFileSaveFailure.Type;

export const CodeFileSavePublicResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("completed"), metadata: CodeFileMetadata }).annotations(
    strict,
  ),
  Schema.Struct({ status: Schema.Literal("conflict"), failure: CodeFileSaveFailure }).annotations(
    strict,
  ),
  Schema.Struct({
    status: Schema.Literal("interrupted"),
    rescanRequired: Schema.Literal(true),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("failed"), failure: CodeFileSaveFailure }).annotations(
    strict,
  ),
);
export type CodeFileSavePublicResult = typeof CodeFileSavePublicResult.Type;

export const CodeFileSaveResultEnvelope = Schema.Struct({
  kind: Schema.Literal("code-file-save-result"),
  result: CodeFileSavePublicResult,
}).annotations(strict);
export type CodeFileSaveResultEnvelope = typeof CodeFileSaveResultEnvelope.Type;

export const CodeFileLifecycle = Schema.Literal(
  "available",
  "read-only",
  "saving",
  "completed",
  "conflict",
  "interrupted",
  "failed",
  "deleted",
  "rescan-required",
);
export type CodeFileLifecycle = typeof CodeFileLifecycle.Type;

export const CodeFileReference = Schema.Struct({
  id: CodeFileId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  relativePath: Schema.optional(CodeRelativePath),
  contentId: Schema.optional(CodeEvidenceContentId),
  digest: CodeDigest,
  byteLength: Schema.Int.pipe(Schema.nonNegative()),
  state: CodeFileLifecycle,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CodeFileReference = typeof CodeFileReference.Type;

export const CodeRuntimeWorkKind = Schema.Literal(
  "provider-turn",
  "file",
  "terminal",
  "test",
  "git",
  "delivery",
  "review",
);
export type CodeRuntimeWorkKind = typeof CodeRuntimeWorkKind.Type;

export const CodeRuntimeWorkState = Schema.Literal(
  "running",
  "ambiguous",
  "waiting",
  "interrupted",
  "completed",
  "failed",
);
export type CodeRuntimeWorkState = typeof CodeRuntimeWorkState.Type;

const CodeRuntimeWorkFields = {
  id: CodeRuntimeWorkId,
  threadId: CodeThreadId,
  kind: CodeRuntimeWorkKind,
  state: CodeRuntimeWorkState,
  updatedAt: UtcTimestamp,
} as const;
export const CodeRuntimeWork = Schema.Union(
  Schema.Struct(CodeRuntimeWorkFields).annotations(strict),
  Schema.Struct({
    ...CodeRuntimeWorkFields,
    evidenceContentId: CodeEvidenceContentId,
    digest: CodeDigest,
    byteLength: Schema.Int.pipe(Schema.nonNegative()),
  }).annotations(strict),
);
export type CodeRuntimeWork = typeof CodeRuntimeWork.Type;

export const CodeSettingsUpdated = Schema.Struct({
  kind: Schema.Literal("settings-updated"),
  settings: CodeSettings,
}).annotations(strict);
export type CodeSettingsUpdated = typeof CodeSettingsUpdated.Type;

export const CodeThreadCreated = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  thread: CodeThread,
}).annotations(strict);
export type CodeThreadCreated = typeof CodeThreadCreated.Type;

export const CodeThreadUpdated = Schema.Struct({
  kind: Schema.Literal("thread-updated"),
  thread: CodeThread,
}).annotations(strict);
export type CodeThreadUpdated = typeof CodeThreadUpdated.Type;

/**
 * Replay-only variants of the `code.thread-*@1` events. They embed a
 * {@link PersistedCodeThread} so historical journals written before delivery
 * outcomes existed still decode, defaulting the missing `outcomeKind`. New
 * events are always emitted with the strict {@link CodeThreadCreated} /
 * {@link CodeThreadUpdated} shapes carrying a confirmed outcome.
 */
export const PersistedCodeThreadCreated = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  thread: PersistedCodeThread,
}).annotations(strict);
export type PersistedCodeThreadCreated = typeof PersistedCodeThreadCreated.Type;

export const PersistedCodeThreadUpdated = Schema.Struct({
  kind: Schema.Literal("thread-updated"),
  thread: PersistedCodeThread,
}).annotations(strict);
export type PersistedCodeThreadUpdated = typeof PersistedCodeThreadUpdated.Type;

export const CodeCheckoutObserved = Schema.Struct({
  kind: Schema.Literal("checkout-observed"),
  checkout: CodeCheckoutIdentity,
}).annotations(strict);
export type CodeCheckoutObserved = typeof CodeCheckoutObserved.Type;

export const CodeCheckoutRemoved = Schema.Struct({
  kind: Schema.Literal("checkout-removed"),
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type CodeCheckoutRemoved = typeof CodeCheckoutRemoved.Type;

export const CodeFileReferenceUpdated = Schema.Struct({
  kind: Schema.Literal("file-reference-updated"),
  file: CodeFileReference,
}).annotations(strict);
export type CodeFileReferenceUpdated = typeof CodeFileReferenceUpdated.Type;

export const CodeRuntimeWorkUpdated = Schema.Struct({
  kind: Schema.Literal("runtime-work-updated"),
  work: CodeRuntimeWork,
}).annotations(strict);
export type CodeRuntimeWorkUpdated = typeof CodeRuntimeWorkUpdated.Type;

export const CODE_EVENT_SCHEMAS = {
  "code.settings-updated@1": CodeSettingsUpdated,
  "code.thread-created@1": CodeThreadCreated,
  "code.thread-updated@1": CodeThreadUpdated,
  "code.checkout-observed@1": CodeCheckoutObserved,
  "code.checkout-removed@1": CodeCheckoutRemoved,
  "code.file-reference-updated@1": CodeFileReferenceUpdated,
  "code.runtime-work-updated@1": CodeRuntimeWorkUpdated,
} as const;

export type CodePersistenceEventName = keyof typeof CODE_EVENT_SCHEMAS;
export const CODE_EVENT_NAMES = Object.freeze(
  Object.keys(CODE_EVENT_SCHEMAS) as Array<CodePersistenceEventName>,
);

export const CodePublicEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("thread-created"), thread: CodeThread }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("thread-updated"), thread: CodeThread }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("thread-lifecycle-changed"),
    threadId: CodeThreadId,
    lifecycle: Schema.Literal("active", "archived"),
    version: AggregateVersion,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("settings-updated"), settings: CodeSettings }).annotations(
    strict,
  ),
);
export type CodePublicEvent = typeof CodePublicEvent.Type;
export const CodeCheckoutPrepared = Schema.Struct({
  kind: Schema.Literal("checkout-prepared"),
  bindingRevisionId: BindingRevisionId,
  checkout: CodeCheckoutIdentity,
}).annotations(strict);
export type CodeCheckoutPrepared = typeof CodeCheckoutPrepared.Type;
export const CodeWorktreeSourcePreviewed = Schema.Struct({
  kind: Schema.Literal("worktree-source-previewed"),
  preview: CodeWorktreeSourcePreview,
}).annotations(strict);
export type CodeWorktreeSourcePreviewed = typeof CodeWorktreeSourcePreviewed.Type;
export const CodeManagedThreadCreated = Schema.Struct({
  kind: Schema.Literal("managed-thread-created"),
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
  provenance: CodeWorktreeSourceProvenance,
}).annotations(strict);
export type CodeManagedThreadCreated = typeof CodeManagedThreadCreated.Type;
export const CodeWorktreeRemoteFactsRetrieved = Schema.Struct({
  kind: Schema.Literal("worktree-remote-facts-retrieved"),
  projectId: ProjectId,
  facts: CodeWorktreeRemoteFacts,
}).annotations(strict);
export type CodeWorktreeRemoteFactsRetrieved = typeof CodeWorktreeRemoteFactsRetrieved.Type;
export const CodeWorktreeRefsListed = Schema.Struct({
  kind: Schema.Literal("worktree-refs-listed"),
  projectId: ProjectId,
  refs: Schema.Array(CodeWorktreeRef),
}).annotations(strict);
export type CodeWorktreeRefsListed = typeof CodeWorktreeRefsListed.Type;
/**
 * Why a checkout rebind was refused.
 *
 * `already-bound` means the thread is on the checkout its Project binds, so
 * there is nothing to recover. `managed-worktree` means the thread owns its own
 * worktree: that checkout is the thread's, not the Project's, and moving it
 * would hand the thread a tree it never asked for. `checkout-unavailable` means
 * the Project's own checkout could not be observed, so there is no destination
 * to name.
 */
export const CodeThreadCheckoutRebindRefusal = Schema.Literal(
  "already-bound",
  "managed-worktree",
  "checkout-unavailable",
);
export type CodeThreadCheckoutRebindRefusal = typeof CodeThreadCheckoutRebindRefusal.Type;

export const CodeThreadCheckoutRebindOutcome = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("rebound"),
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeThreadCheckoutRebindRefusal,
  }).annotations(strict),
);
export type CodeThreadCheckoutRebindOutcome = typeof CodeThreadCheckoutRebindOutcome.Type;

/**
 * A refusal here is an expected answer, not a fault: the Project may be
 * unreadable or the thread may already be where it belongs. Carrying it as a
 * value keeps every caller handling it instead of catching it.
 */
export const CodeThreadCheckoutRebound = Schema.Struct({
  kind: Schema.Literal("thread-checkout-rebind"),
  threadId: CodeThreadId,
  outcome: CodeThreadCheckoutRebindOutcome,
}).annotations(strict);
export type CodeThreadCheckoutRebound = typeof CodeThreadCheckoutRebound.Type;

export const CodeCommandResult = Schema.Union(
  CodePublicEvent,
  CodeCheckoutPrepared,
  CodeWorktreeSourcePreviewed,
  CodeManagedThreadCreated,
  CodeWorktreeRemoteFactsRetrieved,
  CodeWorktreeRefsListed,
  CodeThreadCheckoutRebound,
);
export type CodeCommandResult = typeof CodeCommandResult.Type;

export const CodeThreadView = Schema.Struct({
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
  lastSequence: GlobalSequence,
}).annotations(strict);
export type CodeThreadView = typeof CodeThreadView.Type;

/**
 * How far a thread's own activity has advanced, as a journal position.
 *
 * A thread's aggregate version cannot answer this. Provider turns are journaled
 * on the `code-operation` aggregate, so a turn that runs and finishes moves
 * nothing on the `code-thread` aggregate: version and `updatedAt` both stand
 * still. A client comparing those would report a thread that worked for an hour
 * as untouched. This sequence moves with the operation events themselves, so it
 * is the one a read cursor can be compared against.
 */
export const CodeThreadActivity = Schema.Struct({
  threadId: CodeThreadId,
  lastSequence: GlobalSequence,
}).annotations(strict);
export type CodeThreadActivity = typeof CodeThreadActivity.Type;

export const CodeBootstrap = Schema.Struct({
  settings: CodeSettings,
  threads: Schema.Array(CodeThread),
  checkouts: Schema.Array(CodeCheckoutIdentity),
  /**
   * One entry per thread in `threads` that has journaled operation activity.
   * A thread with none is absent rather than reported at zero, so "nothing has
   * happened yet" and "the host did not say" stay distinguishable.
   *
   * The field itself is optional because a paired remote client and its host
   * update on their own schedules. Requiring it would make an updated client
   * refuse Code bootstrap from a host that predates this field, which fails the
   * whole surface rather than the one thing the field feeds; an empty list
   * degrades to the unread behavior that host already had.
   */
  activity: Schema.optionalWith(Schema.Array(CodeThreadActivity), { default: () => [] }),
}).annotations(strict);
export type CodeBootstrap = typeof CodeBootstrap.Type;

export const CodeEventFrame = Schema.Struct({
  threadId: CodeThreadId,
  sequence: GlobalSequence.pipe(Schema.positive()),
  event: CodePublicEvent,
}).annotations(strict);
export type CodeEventFrame = typeof CodeEventFrame.Type;

export const decodeCodeRepositoryId = Schema.decodeUnknownSync(CodeRepositoryId);
export const decodeCodeThreadId = Schema.decodeUnknownSync(CodeThreadId);
export const decodeCodeCheckoutId = Schema.decodeUnknownSync(CodeCheckoutId);
export const decodeWorktreeReceiptId = Schema.decodeUnknownSync(WorktreeReceiptId);
export const decodeCodeTerminalId = Schema.decodeUnknownSync(CodeTerminalId);
export const decodeCodeFileId = Schema.decodeUnknownSync(CodeFileId);
export const decodeCodeReviewFindingId = Schema.decodeUnknownSync(CodeReviewFindingId);
export const decodeCodeEvidenceContentId = Schema.decodeUnknownSync(CodeEvidenceContentId);
export const decodeCodeAttachmentId = Schema.decodeUnknownSync(CodeAttachmentId);
export const decodeCodeAttachmentMediaType = Schema.decodeUnknownSync(CodeAttachmentMediaType);
export const decodeCodeAttachmentReference = Schema.decodeUnknownSync(CodeAttachmentReference);
export const decodeCodeRuntimeWorkId = Schema.decodeUnknownSync(CodeRuntimeWorkId);
export const decodeCodeRelativePath = Schema.decodeUnknownSync(CodeRelativePath);
export const decodeCodeCheckoutHead = Schema.decodeUnknownSync(CodeCheckoutHead);
export const decodeCodeCheckoutIdentity = Schema.decodeUnknownSync(CodeCheckoutIdentity);
export const decodeCodeThread = Schema.decodeUnknownSync(CodeThread);
export const decodeCodeDeliveryOutcomeKind = Schema.decodeUnknownSync(CodeDeliveryOutcomeKind);
export const decodeCodeDeliveryTarget = Schema.decodeUnknownSync(CodeDeliveryTarget);
export const decodeCodeSettings = Schema.decodeUnknownSync(CodeSettings);
export const decodeCodeCommand = Schema.decodeUnknownSync(CodeCommand);
export const decodeCodeCommandResult = Schema.decodeUnknownSync(CodeCommandResult);
export const decodeCodeWorktreeSourcePreview = Schema.decodeUnknownSync(CodeWorktreeSourcePreview);
export const decodeCodeWorktreeSourcePreviewed = Schema.decodeUnknownSync(
  CodeWorktreeSourcePreviewed,
);
export const decodeCodeWorktreeSourceProvenance = Schema.decodeUnknownSync(
  CodeWorktreeSourceProvenance,
);
export const decodeCodeManagedThreadCreated = Schema.decodeUnknownSync(CodeManagedThreadCreated);
export const decodeCodeWorktreeRemoteFacts = Schema.decodeUnknownSync(CodeWorktreeRemoteFacts);
export const decodeCodeWorktreeRemoteFactsRetrieved = Schema.decodeUnknownSync(
  CodeWorktreeRemoteFactsRetrieved,
);
export const decodeCodeWorktreeRef = Schema.decodeUnknownSync(CodeWorktreeRef);
export const decodeCodeWorktreeRefsListed = Schema.decodeUnknownSync(CodeWorktreeRefsListed);
export const decodeCodeFailure = Schema.decodeUnknownSync(CodeFailure);
export const decodeCodeBootstrap = Schema.decodeUnknownSync(CodeBootstrap);
export const decodeCodeThreadActivity = Schema.decodeUnknownSync(CodeThreadActivity);
export const decodeCodeThreadView = Schema.decodeUnknownSync(CodeThreadView);
export const decodeCodeFileMetadata = Schema.decodeUnknownSync(CodeFileMetadata);
export const decodeCodeFileSavePublicResult = Schema.decodeUnknownSync(CodeFileSavePublicResult);
export const decodeCodeFileSaveResultEnvelope = Schema.decodeUnknownSync(
  CodeFileSaveResultEnvelope,
);
export const decodeCodeFileReference = Schema.decodeUnknownSync(CodeFileReference);
export const decodeCodeRuntimeWork = Schema.decodeUnknownSync(CodeRuntimeWork);
export const decodeCodeSettingsUpdated = Schema.decodeUnknownSync(CodeSettingsUpdated);
export const decodeCodeThreadCreated = Schema.decodeUnknownSync(CodeThreadCreated);
export const decodeCodeThreadUpdated = Schema.decodeUnknownSync(CodeThreadUpdated);
export const decodePersistedCodeDeliveryTarget = Schema.decodeUnknownSync(
  PersistedCodeDeliveryTarget,
);
export const decodePersistedCodeThread = Schema.decodeUnknownSync(PersistedCodeThread);
export const decodePersistedCodeThreadCreated = Schema.decodeUnknownSync(
  PersistedCodeThreadCreated,
);
export const decodePersistedCodeThreadUpdated = Schema.decodeUnknownSync(
  PersistedCodeThreadUpdated,
);
export const decodeCodeCheckoutObserved = Schema.decodeUnknownSync(CodeCheckoutObserved);
export const decodeCodeCheckoutRemoved = Schema.decodeUnknownSync(CodeCheckoutRemoved);
export const decodeCodeFileReferenceUpdated = Schema.decodeUnknownSync(CodeFileReferenceUpdated);
export const decodeCodeRuntimeWorkUpdated = Schema.decodeUnknownSync(CodeRuntimeWorkUpdated);
export const decodeCodeEventFrame = Schema.decodeUnknownSync(CodeEventFrame);

export function decodeCodePersistenceEventPayload(
  eventName: CodePersistenceEventName | string,
  payload: unknown,
): unknown {
  switch (eventName) {
    case "code.settings-updated@1":
      return decodeCodeSettingsUpdated(payload);
    case "code.thread-created@1":
      // Replay must tolerate pre-outcome journals: decode through the
      // persisted variant, which defaults a missing delivery `outcomeKind`.
      return decodePersistedCodeThreadCreated(payload);
    case "code.thread-updated@1":
      return decodePersistedCodeThreadUpdated(payload);
    case "code.checkout-observed@1":
      return decodeCodeCheckoutObserved(payload);
    case "code.checkout-removed@1":
      return decodeCodeCheckoutRemoved(payload);
    case "code.file-reference-updated@1":
      return decodeCodeFileReferenceUpdated(payload);
    case "code.runtime-work-updated@1":
      return decodeCodeRuntimeWorkUpdated(payload);
    default:
      throw new Error("Unknown Code persistence event");
  }
}
