import { Schema } from "effect";
import { ContextManifestId } from "./context";
import { AggregateVersion, GlobalSequence, UtcTimestamp } from "./events";
import { ExtensionSelection } from "./extensions";
import { HostId } from "./host";
import { MultiModelPool, MultiModelRouteDecisionReceipt } from "./multiModelPool";
import { ProjectId } from "./projects";
import {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOptionValues,
  ProviderResumeCursor,
  ProviderSessionId,
} from "./providers";
import { PreviewContextSelection } from "./previews";
import { CanvasContextSelection, MAX_CHAT_TURN_CANVAS_SELECTIONS } from "./canvasContext";
import { GithubIssueContextRequest } from "./githubIssueContext";
import { LinearIssueContextRequest } from "./linearIssueContext";
import { MAX_THREAD_MENTIONS_PER_TURN, MentionableThreadId } from "./threadMentionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
const PositiveInt = Schema.Int.pipe(Schema.positive());
const ContentDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

export const ChatThreadId = brandedUuid("ChatThreadId");
export type ChatThreadId = typeof ChatThreadId.Type;
export const ChatTurnId = brandedUuid("ChatTurnId");
export type ChatTurnId = typeof ChatTurnId.Type;
export const ChatSubmissionId = brandedUuid("ChatSubmissionId");
export type ChatSubmissionId = typeof ChatSubmissionId.Type;
export const ChatAttemptId = brandedUuid("ChatAttemptId");
export type ChatAttemptId = typeof ChatAttemptId.Type;
export const ChatContentId = brandedUuid("ChatContentId");
export type ChatContentId = typeof ChatContentId.Type;
export const ChatAttachmentId = brandedUuid("ChatAttachmentId");
export type ChatAttachmentId = typeof ChatAttachmentId.Type;
export const ChatCitationId = brandedUuid("ChatCitationId");
export type ChatCitationId = typeof ChatCitationId.Type;
export const ThreadWorkItemId = brandedUuid("ThreadWorkItemId");
export type ThreadWorkItemId = typeof ThreadWorkItemId.Type;

export const ChatResearchRouting = Schema.Literal("automatic", "searxng", "provider-native");
export type ChatResearchRouting = typeof ChatResearchRouting.Type;

export const CHAT_ATTACHMENT_MEDIA_TYPES = [
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
export const ChatAttachmentMediaType = Schema.Literal(...CHAT_ATTACHMENT_MEDIA_TYPES);
export type ChatAttachmentMediaType = typeof ChatAttachmentMediaType.Type;
export const MAX_CHAT_TURN_ATTACHMENTS = 16;
export const MAX_CHAT_TURN_PREVIEW_SELECTIONS = 16;

export const ChatAttemptOutcome = Schema.Literal(
  "queued",
  "streaming",
  "waiting",
  "interrupted",
  "failed",
  "cancelled",
  "completed",
);
export type ChatAttemptOutcome = typeof ChatAttemptOutcome.Type;

export const ChatContentReference = Schema.Struct({
  contentId: ChatContentId,
  digest: ContentDigest,
  byteLength: NonNegativeInt,
}).annotations(strict);
export type ChatContentReference = typeof ChatContentReference.Type;

export const ChatContentRole = Schema.Literal("user", "assistant", "research", "snippet");
export type ChatContentRole = typeof ChatContentRole.Type;

const ChatContentBodyText = Schema.String.pipe(Schema.maxLength(1_000_000));
const ChatMessagePartText = Schema.String.pipe(Schema.maxLength(1_000_000));

export const ChatToolPartStatus = Schema.Literal("running", "done", "failed");
export type ChatToolPartStatus = typeof ChatToolPartStatus.Type;

/** Octant structured message parts (optional on content). */
export const ChatMessagePart = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("reasoning"),
    text: ChatMessagePartText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
    status: ChatToolPartStatus,
    summary: ChatMessagePartText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("markdown"),
    text: ChatMessagePartText,
  }).annotations(strict),
);
export type ChatMessagePart = typeof ChatMessagePart.Type;

export const ChatContentBody = Schema.Struct({
  contentId: ChatContentId,
  role: ChatContentRole,
  body: ChatContentBodyText,
  digest: ContentDigest,
  byteLength: NonNegativeInt,
  /** Optional structured parts for Distilled clients; absent on legacy rows. */
  parts: Schema.optional(Schema.Array(ChatMessagePart).pipe(Schema.maxItems(64))),
}).annotations(strict);
export type ChatContentBody = typeof ChatContentBody.Type;

export const ChatAttachment = Schema.Struct({
  id: ChatAttachmentId,
  threadId: ChatThreadId,
  turnId: Schema.optional(ChatTurnId),
  displayName: Schema.NonEmptyTrimmedString,
  mediaType: ChatAttachmentMediaType,
  byteLength: NonNegativeInt,
  digest: ContentDigest,
  status: Schema.Literal("pending", "finalized", "purged"),
  createdAt: UtcTimestamp,
}).annotations(strict);
export type ChatAttachment = typeof ChatAttachment.Type;

export const ChatHandoffAttachmentOmission = Schema.Struct({
  attachmentId: ChatAttachmentId,
  displayName: Schema.NonEmptyTrimmedString,
  mediaType: Schema.NonEmptyTrimmedString,
  reason: Schema.Literal(
    "native-attachments-unsupported",
    "native-attachments-unavailable",
    "attachment-modality-unsupported",
  ),
}).annotations(strict);
export type ChatHandoffAttachmentOmission = typeof ChatHandoffAttachmentOmission.Type;

export const ChatHandoffWarning = Schema.Struct({
  targetProviderInstanceId: ProviderInstanceId,
  targetModelId: ProviderModelId,
  omittedAttachments: Schema.NonEmptyArray(ChatHandoffAttachmentOmission),
  createdAt: UtcTimestamp,
}).annotations(strict);
export type ChatHandoffWarning = typeof ChatHandoffWarning.Type;

export const ChatCitation = Schema.Struct({
  citationId: ChatCitationId,
  threadId: ChatThreadId,
  turnId: ChatTurnId,
  attemptId: ChatAttemptId,
  sourceTitle: Schema.NonEmptyTrimmedString,
  sourceUrl: Schema.NonEmptyTrimmedString,
  backend: Schema.Literal("searxng", "provider-native"),
  snippetRef: Schema.optional(ChatContentReference),
  retrievedAt: UtcTimestamp,
}).annotations(strict);
export type ChatCitation = typeof ChatCitation.Type;

const Usage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
}).annotations(strict);

export const ChatAttempt = Schema.Struct({
  id: ChatAttemptId,
  turnId: ChatTurnId,
  threadId: ChatThreadId,
  providerInstanceId: ProviderInstanceId,
  providerSessionId: ProviderSessionId,
  modelId: ProviderModelId,
  contextManifestId: ContextManifestId,
  outcome: ChatAttemptOutcome,
  responseRefs: Schema.Array(ChatContentReference),
  researchRef: Schema.optional(ChatContentReference),
  citationIds: Schema.Array(ChatCitationId),
  usage: Schema.optional(Usage),
  resumeCursor: Schema.optional(ProviderResumeCursor),
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ChatAttempt = typeof ChatAttempt.Type;

export const ChatTurn = Schema.Struct({
  id: ChatTurnId,
  threadId: ChatThreadId,
  /** Stable client submission identity used to reconcile an unknown response. */
  submissionId: Schema.optional(ChatSubmissionId),
  sequence: PositiveInt,
  userMessageRef: ChatContentReference,
  attachmentIds: Schema.Array(ChatAttachmentId),
  extensionSelections: Schema.optional(Schema.Array(ExtensionSelection).pipe(Schema.maxItems(32))),
  attempts: Schema.Array(ChatAttempt),
  /**
   * Set when this turn re-runs the thread from an edited earlier message. The
   * journal is append-only, so an edit never rewrites the turn it revises: it
   * appends a new turn that names the revised turn here. The superseded turn
   * and everything that followed it stay journaled and recoverable; they are
   * simply no longer part of the active conversation, which `activeChatTurns`
   * in `@octant/domain` derives from this field.
   */
  supersedes: Schema.optional(ChatTurnId),
  createdAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((turn) => turn.supersedes === undefined || turn.supersedes !== turn.id));
export type ChatTurn = typeof ChatTurn.Type;

/**
 * Provenance for a Chat thread created by branching another Chat thread at one
 * turn. The branch is an ordinary, independent thread: it carries a copy of the
 * source conversation through `turnId` and then diverges. `sourceVersion` is
 * the source aggregate version the copy was taken at, so a reader can tell
 * exactly how much of the source the branch reflects.
 *
 * `carriedTurnCount` and `omittedAttachmentCount` are stated rather than
 * implied: a branch carries message text only, so attachments referenced by the
 * carried turns stay with the source thread and are counted here instead of
 * being silently dropped.
 */
export const ChatThreadBranchOrigin = Schema.Struct({
  threadId: ChatThreadId,
  turnId: ChatTurnId,
  sourceVersion: AggregateVersion,
  carriedTurnCount: NonNegativeInt,
  omittedAttachmentCount: NonNegativeInt,
  branchedAt: UtcTimestamp,
}).annotations(strict);
export type ChatThreadBranchOrigin = typeof ChatThreadBranchOrigin.Type;

export const ChatThread = Schema.Struct({
  id: ChatThreadId,
  projectId: Schema.optional(ProjectId),
  title: Schema.NonEmptyTrimmedString,
  lifecycle: Schema.Literal("active", "archived", "deleting", "deleted"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  /**
   * Chosen values for options the selected model declares (effort, reasoning,
   * speed tier). Absent or empty means provider defaults. The server keeps only
   * values valid for the current model and hands them to the provider harness
   * on session start.
   */
  modelOptionValues: Schema.optional(ProviderModelOptionValues),
  researchEnabled: Schema.Boolean,
  researchRouting: ChatResearchRouting,
  personalityInstructions: Schema.NonEmptyTrimmedString,
  handoffWarning: Schema.optional(ChatHandoffWarning),
  /**
   * Server-authoritative opt-in multi-model pool for this thread's parent
   * turns. Absent means single-model routing via
   * providerInstanceId/modelId above, unchanged.
   */
  multiModelPool: Schema.optional(MultiModelPool),
  /** Present only on threads created by branching another Chat thread. */
  branchedFrom: Schema.optional(ChatThreadBranchOrigin),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(Schema.filter((thread) => thread.branchedFrom?.threadId !== thread.id));
export type ChatThread = typeof ChatThread.Type;

/**
 * The route a turn may take when its own provider cannot serve it.
 *
 * Opt-in: absent means a turn refuses on the thread's own provider instead of
 * moving the conversation to another one.
 */
export const ChatProviderFallback = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type ChatProviderFallback = typeof ChatProviderFallback.Type;

export const ChatSettings = Schema.Struct({
  defaultProviderInstanceId: Schema.optional(ProviderInstanceId),
  defaultModelId: Schema.optional(ProviderModelId),
  defaultResearchEnabled: Schema.Boolean,
  defaultResearchRouting: ChatResearchRouting,
  searxngBaseUrl: Schema.optional(Schema.NonEmptyTrimmedString),
  defaultPersonalityInstructions: Schema.NonEmptyTrimmedString,
  providerFallback: Schema.optional(ChatProviderFallback),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (settings) =>
        (settings.defaultProviderInstanceId === undefined) ===
        (settings.defaultModelId === undefined),
    ),
  );
export type ChatSettings = typeof ChatSettings.Type;

const ChatThreadCommandFields = {
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
} as const;

const PromptText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_000_000));

export const CreateChatThreadCommand = Schema.Struct({
  kind: Schema.Literal("create-chat-thread"),
  threadId: Schema.optional(ChatThreadId),
  title: Schema.NonEmptyTrimmedString,
  // The authenticated transport owns host identity. Keep this optional for
  // internal callers while browser requests omit client-supplied identity.
  hostId: Schema.optional(HostId),
  projectId: Schema.optional(ProjectId),
  issueContext: Schema.optional(GithubIssueContextRequest),
  linearIssueContext: Schema.optional(LinearIssueContextRequest),
}).annotations(strict);

export const MAX_CHAT_NDJSON_LINE_BYTES = 1_048_576;

export const RenameChatThreadCommand = Schema.Struct({
  kind: Schema.Literal("rename-chat-thread"),
  ...ChatThreadCommandFields,
  title: Schema.NonEmptyTrimmedString,
}).annotations(strict);

export const MoveChatThreadCommand = Schema.Struct({
  kind: Schema.Literal("move-chat-thread"),
  ...ChatThreadCommandFields,
  projectId: Schema.optional(ProjectId),
}).annotations(strict);

export const ChangeChatThreadLifecycleCommand = Schema.Struct({
  kind: Schema.Literal("change-chat-thread-lifecycle"),
  ...ChatThreadCommandFields,
  lifecycle: Schema.Literal("active", "archived"),
}).annotations(strict);

/**
 * Selects the thread's provider/model and, optionally, its model option values.
 * When `modelOptionValues` is present it replaces the thread's values and every
 * entry must name an option and value the selected model declares; when it is
 * absent the server carries over the current values that still apply to the
 * selected model and drops the rest.
 */
export const ChangeChatProviderCommand = Schema.Struct({
  kind: Schema.Literal("change-chat-provider"),
  ...ChatThreadCommandFields,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  modelOptionValues: Schema.optional(ProviderModelOptionValues),
}).annotations(strict);

/**
 * Server-authoritative selection/clearing of a thread's multi-model pool
 * This is a data-layer seam only: it adds no Composer/Settings UI.
 * Omitting `pool` clears pool mode and restores ordinary
 * single-model routing via the thread's providerInstanceId/modelId.
 */
export const SelectChatMultiModelPoolCommand = Schema.Struct({
  kind: Schema.Literal("select-chat-multi-model-pool"),
  ...ChatThreadCommandFields,
  pool: Schema.optional(MultiModelPool),
}).annotations(strict);

export const ChangeChatResearchCommand = Schema.Struct({
  kind: Schema.Literal("change-chat-research"),
  ...ChatThreadCommandFields,
  researchEnabled: Schema.Boolean,
  researchRouting: ChatResearchRouting,
}).annotations(strict);

export const ChangeChatInstructionsCommand = Schema.Struct({
  kind: Schema.Literal("change-chat-instructions"),
  ...ChatThreadCommandFields,
  personalityInstructions: Schema.NonEmptyTrimmedString,
}).annotations(strict);

export const SendChatTurnCommand = Schema.Struct({
  kind: Schema.Literal("send-chat-turn"),
  ...ChatThreadCommandFields,
  prompt: PromptText,
  /** Optional for older clients; new clients preserve it across retry after an unknown outcome. */
  submissionId: Schema.optional(ChatSubmissionId),
  attachmentIds: Schema.optional(
    Schema.Array(ChatAttachmentId).pipe(
      Schema.filter((attachmentIds) => attachmentIds.length <= MAX_CHAT_TURN_ATTACHMENTS),
    ),
  ),
  previewSelections: Schema.optional(
    Schema.Array(PreviewContextSelection).pipe(
      Schema.filter((selections) => selections.length <= MAX_CHAT_TURN_PREVIEW_SELECTIONS),
    ),
  ),
  canvasSelections: Schema.optional(
    Schema.Array(CanvasContextSelection).pipe(
      Schema.filter((selections) => selections.length <= MAX_CHAT_TURN_CANVAS_SELECTIONS),
    ),
  ),
  extensionSelections: Schema.optional(Schema.Array(ExtensionSelection).pipe(Schema.maxItems(32))),
  /**
   * `#thread` mentions this turn points at. Ids only: the server
   * re-derives the sender's Open authority over each thread and reads its
   * bounded transcript at turn time, so a mention contributes read-only
   * context to this turn alone and never becomes part of the user's message.
   * A transcript the browser resolved is never trusted, and never sent.
   */
  threadMentionIds: Schema.optional(
    Schema.Array(MentionableThreadId).pipe(Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN)),
  ),
}).annotations(strict);

/**
 * Revise an earlier user message and re-run the thread from that point.
 *
 * This never rewrites or deletes a journaled event. The server appends a new
 * turn carrying `prompt` and naming `turnId` in its `supersedes` field; the
 * revised turn and everything that followed it remain in the journal and stay
 * fully recoverable. `expectedVersion` is required, so an edit computed against
 * a stale view is refused rather than applied. Provider, model, and Project
 * scope always come from the server's copy of the thread, never from this
 * command, so an edit can neither widen authority nor silently re-route.
 */
export const EditChatTurnCommand = Schema.Struct({
  kind: Schema.Literal("edit-chat-turn"),
  ...ChatThreadCommandFields,
  turnId: ChatTurnId,
  prompt: PromptText,
}).annotations(strict);

/**
 * Start a second Chat thread that carries this thread's conversation through
 * `turnId` and then diverges. The branch inherits the source thread's Project
 * scope, provider, and model verbatim from the server's copy of the thread;
 * this command cannot choose them. `expectedVersion` pins the exact source
 * revision the branch is taken from.
 */
export const BranchChatThreadCommand = Schema.Struct({
  kind: Schema.Literal("branch-chat-thread"),
  ...ChatThreadCommandFields,
  turnId: ChatTurnId,
  title: Schema.NonEmptyTrimmedString,
  /** Optional caller-chosen id for the created branch; the server allocates one otherwise. */
  branchThreadId: Schema.optional(ChatThreadId),
}).annotations(strict);

export const RetryChatTurnCommand = Schema.Struct({
  kind: Schema.Literal("retry-chat-turn"),
  ...ChatThreadCommandFields,
  turnId: ChatTurnId,
  attemptId: ChatAttemptId,
}).annotations(strict);

export const ResumeChatTurnCommand = Schema.Struct({
  kind: Schema.Literal("resume-chat-turn"),
  ...ChatThreadCommandFields,
  turnId: ChatTurnId,
  attemptId: ChatAttemptId,
}).annotations(strict);

export const InterruptChatTurnCommand = Schema.Struct({
  kind: Schema.Literal("interrupt-chat-turn"),
  ...ChatThreadCommandFields,
  turnId: ChatTurnId,
  attemptId: ChatAttemptId,
}).annotations(strict);

export const DeleteChatThreadCommand = Schema.Struct({
  kind: Schema.Literal("delete-chat-thread"),
  ...ChatThreadCommandFields,
}).annotations(strict);

export const UpdateChatSettingsCommand = Schema.Struct({
  kind: Schema.Literal("update-chat-settings"),
  expectedVersion: AggregateVersion,
  defaultProviderInstanceId: Schema.optional(ProviderInstanceId),
  defaultModelId: Schema.optional(ProviderModelId),
  defaultResearchEnabled: Schema.Boolean,
  defaultResearchRouting: ChatResearchRouting,
  searxngBaseUrl: Schema.optional(Schema.NonEmptyTrimmedString),
  defaultPersonalityInstructions: Schema.NonEmptyTrimmedString,
  providerFallback: Schema.optional(ChatProviderFallback),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (settings) =>
        (settings.defaultProviderInstanceId === undefined) ===
        (settings.defaultModelId === undefined),
    ),
  );

export const AddChatWorkItemCommand = Schema.Struct({
  kind: Schema.Literal("add-chat-work-item"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemId: ThreadWorkItemId,
  title: Schema.NonEmptyTrimmedString,
  detail: Schema.optional(Schema.NonEmptyTrimmedString),
  status: Schema.Literal("pending", "in-progress", "blocked", "completed", "cancelled"),
  position: NonNegativeInt,
  origin: Schema.Literal("user", "agent", "provider"),
}).annotations(strict);

export const EditChatWorkItemCommand = Schema.Struct({
  kind: Schema.Literal("edit-chat-work-item"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemId: ThreadWorkItemId,
  title: Schema.optional(Schema.NonEmptyTrimmedString),
  detail: Schema.optional(Schema.NonEmptyTrimmedString),
  position: Schema.optional(NonNegativeInt),
}).annotations(strict);

export const CompleteChatWorkItemCommand = Schema.Struct({
  kind: Schema.Literal("complete-chat-work-item"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemId: ThreadWorkItemId,
}).annotations(strict);

export const CancelChatWorkItemCommand = Schema.Struct({
  kind: Schema.Literal("cancel-chat-work-item"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemId: ThreadWorkItemId,
}).annotations(strict);

export const ReopenChatWorkItemCommand = Schema.Struct({
  kind: Schema.Literal("reopen-chat-work-item"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemId: ThreadWorkItemId,
}).annotations(strict);

export const ReorderChatWorkItemsCommand = Schema.Struct({
  kind: Schema.Literal("reorder-chat-work-items"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  itemIds: Schema.Array(ThreadWorkItemId).pipe(
    Schema.filter((ids) => new Set(ids).size === ids.length),
  ),
}).annotations(strict);

export const OpenChatFollowUpCommand = Schema.Struct({
  kind: Schema.Literal("open-chat-follow-up"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  reason: Schema.NonEmptyTrimmedString,
  origin: Schema.Literal("manual", "automatic"),
  triggerSequence: NonNegativeInt,
}).annotations(strict);

export const CompleteChatFollowUpCommand = Schema.Struct({
  kind: Schema.Literal("complete-chat-follow-up"),
  threadId: ChatThreadId,
  expectedVersion: AggregateVersion,
  acknowledgedThroughSequence: NonNegativeInt,
}).annotations(strict);

export const ThreadWorkCommand = Schema.Union(
  AddChatWorkItemCommand,
  EditChatWorkItemCommand,
  CompleteChatWorkItemCommand,
  CancelChatWorkItemCommand,
  ReopenChatWorkItemCommand,
  ReorderChatWorkItemsCommand,
);
export type ThreadWorkCommand = typeof ThreadWorkCommand.Type;

export const ThreadFollowUpCommand = Schema.Union(
  OpenChatFollowUpCommand,
  CompleteChatFollowUpCommand,
);
export type ThreadFollowUpCommand = typeof ThreadFollowUpCommand.Type;

export const ChatCommand = Schema.Union(
  CreateChatThreadCommand,
  RenameChatThreadCommand,
  MoveChatThreadCommand,
  ChangeChatThreadLifecycleCommand,
  ChangeChatProviderCommand,
  SelectChatMultiModelPoolCommand,
  ChangeChatResearchCommand,
  ChangeChatInstructionsCommand,
  SendChatTurnCommand,
  EditChatTurnCommand,
  BranchChatThreadCommand,
  RetryChatTurnCommand,
  ResumeChatTurnCommand,
  InterruptChatTurnCommand,
  DeleteChatThreadCommand,
  UpdateChatSettingsCommand,
  ThreadWorkCommand,
  ThreadFollowUpCommand,
);
export type ChatCommand = typeof ChatCommand.Type;

export const ChatFailureCategory = Schema.Literal(
  "unavailable",
  "unauthorized",
  "unsupported",
  "waiting",
  "interrupted",
  "failed",
  "disconnected",
  "stale",
  "invalid",
);
export type ChatFailureCategory = typeof ChatFailureCategory.Type;

export const ChatFailure = Schema.Struct({
  category: ChatFailureCategory,
  message: Schema.NonEmptyTrimmedString,
  retryAfterMs: Schema.optional(PositiveInt),
}).annotations(strict);
export type ChatFailure = typeof ChatFailure.Type;

export const ThreadWorkItemStatus = Schema.Literal(
  "pending",
  "in-progress",
  "blocked",
  "completed",
  "cancelled",
);
export type ThreadWorkItemStatus = typeof ThreadWorkItemStatus.Type;

export const ThreadWorkItem = Schema.Struct({
  id: ThreadWorkItemId,
  threadId: ChatThreadId,
  title: Schema.NonEmptyTrimmedString,
  detail: Schema.optional(Schema.NonEmptyTrimmedString),
  status: ThreadWorkItemStatus,
  position: NonNegativeInt,
  origin: Schema.Literal("user", "agent", "provider"),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type ThreadWorkItem = typeof ThreadWorkItem.Type;

export const ThreadFollowUp = Schema.Struct({
  threadId: ChatThreadId,
  state: Schema.Literal("open", "completed"),
  origin: Schema.Literal("manual", "automatic"),
  reason: Schema.NonEmptyTrimmedString,
  triggerSequence: NonNegativeInt,
  acknowledgedThroughSequence: NonNegativeInt,
  createdAt: UtcTimestamp,
  completedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ThreadFollowUp = typeof ThreadFollowUp.Type;

/**
 * Immutable, durably persisted multi-model route decision for one parent
 * chat turn. Recorded once per turnId before provider execution
 * starts (or in place of it, for a Waiting decision); retry/resume of that
 * turn's attempts never re-derives or overwrites this receipt.
 */
export const ChatTurnRouteDecision = Schema.Struct({
  threadId: ChatThreadId,
  turnId: ChatTurnId,
  decision: MultiModelRouteDecisionReceipt,
  decidedAt: UtcTimestamp,
}).annotations(strict);
export type ChatTurnRouteDecision = typeof ChatTurnRouteDecision.Type;

export const ChatThreadView = Schema.Struct({
  thread: ChatThread,
  turns: Schema.Array(ChatTurn),
  lastSequence: GlobalSequence,
  contents: Schema.Array(ChatContentBody),
  attachments: Schema.Array(ChatAttachment),
  citations: Schema.Array(ChatCitation),
  workItems: Schema.Array(ThreadWorkItem),
  workListVersion: AggregateVersion,
  followUpVersion: AggregateVersion,
  followUp: Schema.optional(ThreadFollowUp),
  /** Present only for threads that have decided at least one turn route. */
  routeDecisions: Schema.optional(Schema.Array(ChatTurnRouteDecision)),
}).annotations(strict);
export type ChatThreadView = typeof ChatThreadView.Type;

export const ChatBootstrap = Schema.Struct({
  settings: ChatSettings,
  threads: Schema.Array(ChatThread),
}).annotations(strict);
export type ChatBootstrap = typeof ChatBootstrap.Type;

/**
 * The bounded read used to keep the Chat sidebar current. It deliberately
 * carries only row metadata and aggregate activity; transcript turns,
 * attachments, citations, and work items belong to the thread read.
 *
 * `executing` is the same run-state signal the thread board reasons from: a
 * turn attempt is queued or streaming. Optional with a false default so a
 * remote client that sees an older host still paints an idle row rather than
 * refusing the whole navigation payload.
 */
export const ChatNavigationThread = Schema.Struct({
  id: ChatThreadId,
  projectId: Schema.optional(ProjectId),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  providerInstanceId: ProviderInstanceId,
  updatedAt: UtcTimestamp,
  lastSequence: GlobalSequence,
  followUpOpen: Schema.Boolean,
  executing: Schema.optionalWith(Schema.Boolean, { default: () => false }),
}).annotations(strict);
export type ChatNavigationThread = typeof ChatNavigationThread.Type;

/** Keep a pathological number of archived/recent rows from becoming a hot read payload. */
export const MAX_CHAT_NAVIGATION_THREADS = 1_000;
export const ChatNavigation = Schema.Struct({
  threads: Schema.Array(ChatNavigationThread).pipe(Schema.maxItems(MAX_CHAT_NAVIGATION_THREADS)),
}).annotations(strict);
export type ChatNavigation = typeof ChatNavigation.Type;

export const ChatSettingsUpdated = Schema.Struct({
  kind: Schema.Literal("settings-updated"),
  settings: ChatSettings,
}).annotations(strict);
export type ChatSettingsUpdated = typeof ChatSettingsUpdated.Type;

export const ChatThreadCreated = Schema.Struct({
  kind: Schema.Literal("thread-created"),
  thread: ChatThread,
}).annotations(strict);
export type ChatThreadCreated = typeof ChatThreadCreated.Type;

export const ChatThreadUpdated = Schema.Struct({
  kind: Schema.Literal("thread-updated"),
  thread: ChatThread,
}).annotations(strict);
export type ChatThreadUpdated = typeof ChatThreadUpdated.Type;

export const ChatTurnCreated = Schema.Struct({
  kind: Schema.Literal("turn-created"),
  turn: ChatTurn,
}).annotations(strict);
export type ChatTurnCreated = typeof ChatTurnCreated.Type;

export const ChatAttemptUpdated = Schema.Struct({
  kind: Schema.Literal("attempt-updated"),
  attempt: ChatAttempt,
}).annotations(strict);
export type ChatAttemptUpdated = typeof ChatAttemptUpdated.Type;

export const ChatTurnRouteDecided = Schema.Struct({
  kind: Schema.Literal("turn-route-decided"),
  decision: ChatTurnRouteDecision,
}).annotations(strict);
export type ChatTurnRouteDecided = typeof ChatTurnRouteDecided.Type;

export const ChatAttachmentUpdated = Schema.Struct({
  kind: Schema.Literal("attachment-updated"),
  attachment: ChatAttachment,
}).annotations(strict);
export type ChatAttachmentUpdated = typeof ChatAttachmentUpdated.Type;

export const ChatCitationRecorded = Schema.Struct({
  kind: Schema.Literal("citation-recorded"),
  citation: ChatCitation,
}).annotations(strict);
export type ChatCitationRecorded = typeof ChatCitationRecorded.Type;

export const ThreadWorkUpdated = Schema.Struct({
  kind: Schema.Literal("work-updated"),
  workItem: ThreadWorkItem,
}).annotations(strict);
export type ThreadWorkUpdated = typeof ThreadWorkUpdated.Type;

export const ThreadFollowUpUpdated = Schema.Struct({
  kind: Schema.Literal("follow-up-updated"),
  followUp: ThreadFollowUp,
}).annotations(strict);
export type ThreadFollowUpUpdated = typeof ThreadFollowUpUpdated.Type;

export const ChatDeletionRequested = Schema.Struct({
  kind: Schema.Literal("deletion-requested"),
  threadId: ChatThreadId,
  requestedAt: UtcTimestamp,
}).annotations(strict);
export type ChatDeletionRequested = typeof ChatDeletionRequested.Type;

export const ChatDeleted = Schema.Struct({
  kind: Schema.Literal("deleted"),
  threadId: ChatThreadId,
  deletedAt: UtcTimestamp,
}).annotations(strict);
export type ChatDeleted = typeof ChatDeleted.Type;

export const ChatPublicEvent = Schema.Union(
  ChatSettingsUpdated,
  ChatThreadCreated,
  ChatThreadUpdated,
  ChatTurnCreated,
  ChatAttemptUpdated,
  ChatTurnRouteDecided,
  ChatAttachmentUpdated,
  ChatCitationRecorded,
  ThreadWorkUpdated,
  ThreadFollowUpUpdated,
  ChatDeletionRequested,
  ChatDeleted,
);
export type ChatPublicEvent = typeof ChatPublicEvent.Type;

export const ChatCommandResult = ChatPublicEvent;
export type ChatCommandResult = typeof ChatCommandResult.Type;

export const ChatEventFrame = Schema.Struct({
  threadId: ChatThreadId,
  sequence: GlobalSequence.pipe(Schema.positive()),
  event: ChatPublicEvent,
}).annotations(strict);
export type ChatEventFrame = typeof ChatEventFrame.Type;

export const CHAT_EVENT_NAMES = [
  "chat.settings-updated@1",
  "chat.thread-created@1",
  "chat.thread-updated@1",
  "chat.turn-created@1",
  "chat.attempt-updated@1",
  "chat.turn-route-decided@1",
  "chat.attachment-updated@1",
  "chat.citation-recorded@1",
  "thread.work-updated@1",
  "thread.follow-up-updated@1",
  "chat.deletion-requested@1",
  "chat.deleted@1",
] as const;

export const decodeChatThreadId = Schema.decodeUnknownSync(ChatThreadId);
export const decodeChatSubmissionId = Schema.decodeUnknownSync(ChatSubmissionId);
export const decodeChatTurnId = Schema.decodeUnknownSync(ChatTurnId);
export const decodeChatAttemptId = Schema.decodeUnknownSync(ChatAttemptId);
export const decodeChatContentId = Schema.decodeUnknownSync(ChatContentId);
export const decodeChatAttachmentId = Schema.decodeUnknownSync(ChatAttachmentId);
export const decodeChatCitationId = Schema.decodeUnknownSync(ChatCitationId);
export const decodeThreadWorkItemId = Schema.decodeUnknownSync(ThreadWorkItemId);

export const decodeChatResearchRouting = Schema.decodeUnknownSync(ChatResearchRouting);
export const decodeChatAttemptOutcome = Schema.decodeUnknownSync(ChatAttemptOutcome);
export const decodeChatContentReference = Schema.decodeUnknownSync(ChatContentReference);
export const decodeChatContentBody = Schema.decodeUnknownSync(ChatContentBody);
export const decodeChatMessagePart = Schema.decodeUnknownSync(ChatMessagePart);
export const decodeChatToolPartStatus = Schema.decodeUnknownSync(ChatToolPartStatus);
export const decodeChatAttachmentMediaType = Schema.decodeUnknownSync(ChatAttachmentMediaType);
export const decodeChatContentRole = Schema.decodeUnknownSync(ChatContentRole);
export const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment);
export const decodeChatCitation = Schema.decodeUnknownSync(ChatCitation);
export const decodeChatAttempt = Schema.decodeUnknownSync(ChatAttempt);
export const decodeChatTurn = Schema.decodeUnknownSync(ChatTurn);
export const decodeChatThread = Schema.decodeUnknownSync(ChatThread);
export const decodeChatThreadBranchOrigin = Schema.decodeUnknownSync(ChatThreadBranchOrigin);
export const decodeChatThreadView = Schema.decodeUnknownSync(ChatThreadView);
export const decodeChatBootstrap = Schema.decodeUnknownSync(ChatBootstrap);
export const decodeChatNavigationThread = Schema.decodeUnknownSync(ChatNavigationThread);
export const decodeChatNavigation = Schema.decodeUnknownSync(ChatNavigation);
export const decodeChatSettings = Schema.decodeUnknownSync(ChatSettings);
export const decodeChatCommand = Schema.decodeUnknownSync(ChatCommand);
export const decodeChatFailure = Schema.decodeUnknownSync(ChatFailure);
export const decodeChatPublicEvent = Schema.decodeUnknownSync(ChatPublicEvent);
export const decodeChatCommandResult = Schema.decodeUnknownSync(ChatCommandResult);
export const decodeChatEventFrame = Schema.decodeUnknownSync(ChatEventFrame);

export const decodeChatSettingsUpdated = Schema.decodeUnknownSync(ChatSettingsUpdated);
export const decodeChatThreadCreated = Schema.decodeUnknownSync(ChatThreadCreated);
export const decodeChatThreadUpdated = Schema.decodeUnknownSync(ChatThreadUpdated);
export const decodeChatTurnCreated = Schema.decodeUnknownSync(ChatTurnCreated);
export const decodeChatAttemptUpdated = Schema.decodeUnknownSync(ChatAttemptUpdated);
export const decodeChatTurnRouteDecision = Schema.decodeUnknownSync(ChatTurnRouteDecision);
export const decodeChatTurnRouteDecided = Schema.decodeUnknownSync(ChatTurnRouteDecided);
export const decodeChatAttachmentUpdated = Schema.decodeUnknownSync(ChatAttachmentUpdated);
export const decodeChatCitationRecorded = Schema.decodeUnknownSync(ChatCitationRecorded);
export const decodeThreadWorkUpdated = Schema.decodeUnknownSync(ThreadWorkUpdated);
export const decodeThreadFollowUpUpdated = Schema.decodeUnknownSync(ThreadFollowUpUpdated);
export const decodeChatDeletionRequested = Schema.decodeUnknownSync(ChatDeletionRequested);
export const decodeChatDeleted = Schema.decodeUnknownSync(ChatDeleted);
