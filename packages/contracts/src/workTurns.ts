import { AnyAttachmentMediaType, NATIVE_IMAGE_ATTACHMENT_MEDIA_TYPES } from "./attachmentMediaType";
import {
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import {
  ConversationInputReceipt,
  ConversationInputPolicy,
  ConversationInputReference,
} from "./conversationInputs";
import { SideChatDraftReturnReferences } from "./sideChatReturn";
import { HarnessRetryEventFields } from "./harnessRetry";
import { ProviderChildObservationState } from "./providers";
import { Effect, Schema } from "effect";
import { AgentResultsSteeredIntoTurn } from "./agentRun";
import { ThreadDeliveryMark } from "./sideTasks";
import { ThreadMessagesSteeredIntoTurn } from "./threadMessageSteering";
import { ContextCompactionSettledRecord } from "./context";
import {
  ContextHandoffMessages,
  ContextHandoffOmissions,
  AccountMoveSessionHandoff,
  ProviderSwitchConversationHandoff,
  RewindConversationHandoff,
} from "./contextHandoff";
import { ExtensionSelection } from "./extensions";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { BindingRevisionId, ProjectId } from "./projects";
import {
  GuardrailLevel,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSessionId,
  ProviderResumeCursor,
  ProviderUsageLimit,
} from "./providers";
import { ThreadWorkingDirectory, ProjectWorkingFolderId } from "./workingDirectory";
import { FileMentionPathInput, MAX_FILE_MENTIONS_PER_TURN } from "./fileMention";
import { ThreadMentionIds } from "./threadMentionIdentity";
import { TrackerMentions } from "./trackerMention";
import { ThreadTaskProgressList } from "./threadTasks";
import { ThreadToolStep, ThreadToolStepList } from "./threadToolStepList";
import { ThreadWindowBoundsFields } from "./threadWindow";
import { DescribedTurnImages } from "./imageDescription";
import { WorkThreadId } from "./workThreads";
import { StrictKeptProtections } from "./strictNotice";
import {
  TurnLoopNotice,
  TurnLoopNoticeCount,
  TurnLoopNoticeToolName,
  TurnStallNotice,
} from "./turnLoopNotice";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/**
 * The most of a Work reply the turn keeps: the 32 MiB streamed-output budget
 * Chat and Code turns have (maintainer decision, 2026-11-14), so a long Work
 * answer is no longer cut at 64 KiB. The reply is journaled once, when the
 * turn settles; a settled turn too heavy for one stream frame is read from
 * the transcript snapshot instead.
 */
export const MAX_WORK_TURN_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * The most one live Work stream frame may weigh. A client refuses a heavier
 * line, so the host sends a view to the transcript snapshot instead of a
 * settled turn that would not fit.
 */
export const MAX_WORK_TURN_STREAM_FRAME_BYTES = 160 * 1024;
export const MAX_WORK_TURN_FAILURE_BYTES = 8 * 1024;

/**
 * Idempotent request identity for one Work provider turn start. Retries and
 * reconnects reuse the same id so the prompt is accepted at most once.
 */
export const WorkTurnRequestId = brandedUuid("WorkTurnRequestId");
export type WorkTurnRequestId = typeof WorkTurnRequestId.Type;

export const WorkTurnId = brandedUuid("WorkTurnId");
export type WorkTurnId = typeof WorkTurnId.Type;
export const WorkAttachmentId = brandedUuid("WorkAttachmentId");
export type WorkAttachmentId = typeof WorkAttachmentId.Type;

/**
 * Work attachments are files of any type (maintainer decision, 2026-11-16). An
 * image in {@link WORK_ATTACHMENT_MEDIA_TYPES} goes to a model that reads images
 * as a picture; any other file stays in the thread's attachments folder, which
 * the session reads at every level and never writes, and the turn names its
 * path for the agent to open with its own tools.
 */
export const WORK_ATTACHMENT_MEDIA_TYPES = NATIVE_IMAGE_ATTACHMENT_MEDIA_TYPES;
export const WorkAttachmentMediaType = AnyAttachmentMediaType;
export type WorkAttachmentMediaType = typeof WorkAttachmentMediaType.Type;
export const MAX_WORK_ATTACHMENT_BYTES = 10_485_760;
export const MAX_WORK_TURN_ATTACHMENTS = 8;
export const MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;
const WorkAttachmentDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/**
 * What the host kept for one image: the id the renderer chose, and the name,
 * media type, size, and digest this process measured from the bytes it wrote.
 */
export const WorkAttachmentReference = Schema.Struct({
  attachmentId: WorkAttachmentId,
  displayName: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH),
  ),
  mediaType: WorkAttachmentMediaType,
  byteLength: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_WORK_ATTACHMENT_BYTES }),
  ),
  digest: WorkAttachmentDigest,
  source: Schema.optional(ConversationInputReference.fields.source),
});
export type WorkAttachmentReference = typeof WorkAttachmentReference.Type;

/**
 * Exact server-validated authority for a Project-backed Work turn. The
 * renderer must name the host, Project, binding revision, working directory,
 * and confinement posture; Code, shell, Git, worktree, and PR authority are
 * never part of this snapshot and are rejected by excess-property decoding.
 */
export const WorkTurnAuthority = Schema.Struct({
  hostId: HostId,
  projectId: ProjectId,
  bindingRevisionId: BindingRevisionId,
  workingDirectory: ThreadWorkingDirectory,
  workingFolderId: Schema.optional(ProjectWorkingFolderId),
  confinementPosture: Schema.Literal("project-root-confined"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});
export type WorkTurnAuthority = typeof WorkTurnAuthority.Type;

/**
 * How a Work turn could run commands or Git: `denied` on a turn accepted
 * before Work shared Code's capability set, otherwise the guardrail level the
 * turn ran at, which decides who approved each command.
 */
export const WorkTurnShellAuthority = Schema.Union([Schema.Literal("denied"), GuardrailLevel]);
export type WorkTurnShellAuthority = typeof WorkTurnShellAuthority.Type;

/**
 * Honest capability facts retained with every accepted Work turn, so the
 * level a turn ran at survives reconnect and restart. `unconfined` is a turn
 * at Full access, which runs with no OS sandbox; worktrees, pull requests and
 * Code checkouts stay Code's.
 */
export const WorkTurnCapabilityFacts = Schema.Struct({
  workspace: Schema.Literal("project-backed"),
  confinement: Schema.Literals(["project-root-confined", "unconfined"]),
  shell: WorkTurnShellAuthority,
  git: WorkTurnShellAuthority,
  worktree: Schema.Literal("denied"),
  pullRequest: Schema.Literal("denied"),
  code: Schema.Literal("denied"),
});
export type WorkTurnCapabilityFacts = typeof WorkTurnCapabilityFacts.Type;

export const WorkTurnLifecycleStatus = Schema.Literals([
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "waiting",
]);
export type WorkTurnLifecycleStatus = typeof WorkTurnLifecycleStatus.Type;

export const WorkTurnFailure = Schema.Struct({
  category: Schema.Literals([
    "invalid",
    "unauthorized",
    "unavailable",
    "tools-changed",
    "unsupported",
    "interrupted",
    "failed",
    "stale",
    "rate-limited",
  ]),
  message: boundedNonEmptyText(MAX_WORK_TURN_FAILURE_BYTES),
  /**
   * The provider's own usage-limit signal, when stopping this turn was one.
   * Kept beside the message so a "temporary/exhausted/billing" truth survives
   * the category's coarse vocabulary.
   */
  usageLimit: Schema.optional(ProviderUsageLimit),
});
export type WorkTurnFailure = typeof WorkTurnFailure.Type;

/**
 * One durable transcript entry for a Work turn. User text is the accepted
 * prompt; assistant text accumulates provider deltas. Status is set only on
 * assistant entries when the turn is non-completed.
 */
export const WorkTranscriptEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: boundedText(MAX_WORK_TURN_RESPONSE_BYTES),
  status: Schema.optional(
    Schema.Literals(["running", "waiting", "completed", "cancelled", "failed", "interrupted"]),
  ),
});
export type WorkTranscriptEntry = typeof WorkTranscriptEntry.Type;

/**
 * Bound on how many written paths one turn names. Past this the record says
 * `truncated` and the surface re-reads the folder, which is cheaper and more
 * honest than naming a thousand files in a transcript.
 */
export const MAX_WORK_TURN_WRITTEN_PATHS = 32;

/**
 * The files in the bound folder that changed while one turn ran.
 *
 * This is an observation, not a claim about authorship. Work runs the provider
 * inside the folder and the provider writes with its own tools, so the host
 * cannot be told what was written — it can only watch. Anything else changing
 * the folder during the turn is recorded here too, which is why the vocabulary
 * is "changed while this ran" and never "the assistant created".
 *
 * `truncated` is authoritative: a turn that touched more paths than the record
 * holds says so, and the surface refreshes wholesale rather than presenting a
 * partial list as everything that happened.
 */
export const WorkTurnWrittenFiles = Schema.Struct({
  paths: Schema.Array(NonEmptyTrimmedString).check(Schema.isMaxLength(MAX_WORK_TURN_WRITTEN_PATHS)),
  truncated: Schema.Boolean,
});
export type WorkTurnWrittenFiles = typeof WorkTurnWrittenFiles.Type;

/**
 * A fork's first own turn on a provider that keeps its conversation in a
 * session of its own: the source's turns through the fork point, carried into
 * the fork, go to a new session as bounded, attributed text.
 */
export const WorkForkConversationHandoff = Schema.Struct({
  reason: Schema.Literal("fork"),
  messages: ContextHandoffMessages,
  omissions: ContextHandoffOmissions,
  /** Whether the fork had taken in outside content when the handoff was read. */
  externalContentIngested: Schema.Boolean,
  nativeSessionTransferred: Schema.Literal(false),
  hiddenReasoningTransferred: Schema.Literal(false),
  inputReceipt: Schema.optional(ConversationInputReceipt),
});
export type WorkForkConversationHandoff = typeof WorkForkConversationHandoff.Type;

/** What a Work turn started its session with that it did not write itself, by cause. */
export const WorkTurnHandoff = Schema.Union([
  ProviderSwitchConversationHandoff,
  AccountMoveSessionHandoff,
  RewindConversationHandoff,
  WorkForkConversationHandoff,
]);
export type WorkTurnHandoff = typeof WorkTurnHandoff.Type;

/**
 * The source turn a fork's carried copy came from. A carried turn ran in the
 * source, never in the fork, so no session it names is the fork's to resume.
 */
export const WorkTurnCarriedFrom = Schema.Struct({
  threadId: WorkThreadId,
  requestId: WorkTurnRequestId,
});
export type WorkTurnCarriedFrom = typeof WorkTurnCarriedFrom.Type;

/** Host-computed framed input accepted with this turn, never a public start-command claim. */
export const WorkExternalInputReceipt = Schema.Struct({
  referenceId: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type WorkExternalInputReceipt = typeof WorkExternalInputReceipt.Type;

export const WorkTurnState = Schema.Struct({
  toolCatalogHandoff: Schema.optional(Schema.Boolean),
  externalInput: Schema.optional(WorkExternalInputReceipt),
  inputReceipt: Schema.optional(ConversationInputReceipt),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  projectId: ProjectId,
  authority: WorkTurnAuthority,
  providerSessionId: Schema.optional(ProviderSessionId),
  resumeCursor: Schema.optional(ProviderResumeCursor),
  /**
   * The conversation text this turn's new provider session was started with,
   * when the provider changed and the new one keeps its history in a session.
   * Journaled with the turn's acceptance, before the provider is sent anything.
   */
  handoff: Schema.optional(WorkTurnHandoff),
  /**
   * What Strict kept for the provider launch this turn ran on, as the host
   * decided it at launch. Absent when the launch was not Strict.
   */
  strictKept: Schema.optional(StrictKeptProtections),
  /** Repeated identical tool call notice or Strict stop recorded on this turn. */
  loopNotice: Schema.optional(TurnLoopNotice),
  /** Silent-turn notice recorded outside Strict when the stalled-turn limit elapsed. */
  stallNotice: Schema.optional(TurnStallNotice),
  /** Present on a fork's copy of one of its source's turns. */
  carriedFrom: Schema.optional(WorkTurnCarriedFrom),
  status: WorkTurnLifecycleStatus,
  prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
  extensionSelections: Schema.optional(
    Schema.Array(ExtensionSelection).check(Schema.isMaxLength(32)),
  ),
  response: Schema.optional(boundedText(MAX_WORK_TURN_RESPONSE_BYTES)),
  transcript: Schema.Array(WorkTranscriptEntry).check(Schema.isMaxLength(8)),
  attachments: Schema.optional(
    Schema.Array(WorkAttachmentReference).check(Schema.isMaxLength(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  /** The attached images a Sees images model described, and which model. */
  describedImages: Schema.optional(DescribedTurnImages),
  failure: Schema.optional(WorkTurnFailure),
  /** Files that changed in the bound folder while this turn ran. */
  wroteFiles: Schema.optional(WorkTurnWrittenFiles),
  /** The provider's own task list for this turn, restated whole as it moves. */
  tasks: Schema.optional(ThreadTaskProgressList),
  /**
   * The tool calls this turn made, in arrival order: name, state, and a
   * bounded progress or result message. A call's input and output are kept
   * apart from the turn, as its tool-call record.
   */
  toolSteps: Schema.optional(ThreadToolStepList),
  /** Whether the turn called more tools than `toolSteps` keeps. */
  toolStepsTruncated: Schema.optional(Schema.Boolean),
  /**
   * The turn's cumulative time in private reasoning, measured from the
   * provider's own event stamps and restated as the running total. A re-read
   * never sees reasoning text — only the number.
   */
  reasoningMs: Schema.optional(NonNegativeInt),
  childObservations: Schema.optional(ProviderChildObservationState),
  /**
   * Set only on a turn the host started to deliver owed reports — a finished
   * subagent run's result or a side task's report; journaled with the turn's
   * acceptance so replay keeps the mark.
   */
  delivery: Schema.optional(ThreadDeliveryMark),
  /** Finished children's results steered into this turn while it ran, in arrival order. */
  steeredResults: Schema.optional(AgentResultsSteeredIntoTurn),
  /** The person's messages steered into this turn while it ran, in arrival order. */
  steeredMessages: Schema.optional(ThreadMessagesSteeredIntoTurn),
  capabilities: WorkTurnCapabilityFacts,
  sideChatReturns: Schema.optional(SideChatDraftReturnReferences),
  /** The threads this turn's message mentioned; absent when it mentioned none. */
  threadMentionIds: Schema.optional(ThreadMentionIds),
  /** The pull requests and issues this turn's message mentioned; absent when it mentioned none. */
  trackerMentions: Schema.optional(TrackerMentions),
  version: AggregateVersion,
  acceptedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
});
export type WorkTurnState = typeof WorkTurnState.Type;

export const StartWorkThreadTurnCommand = Schema.Struct({
  kind: Schema.Literal("start-work-thread-turn"),
  /** Explicit consent to a fresh native session with a bounded conversation handoff. */
  toolCatalogHandoff: Schema.optional(Schema.Boolean),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
  /**
   * The person typed (pasted, or dictated) this message into a composer. Only
   * a composer sets it; a button, template, routine, side task, delivery, or
   * outside agent does not. The host honours it on the person's own routes
   * alone and ignores it everywhere else.
   */
  typedByPerson: Schema.optional(Schema.Literal(true)),
  computerUseSelection: Schema.optional(ExtensionSelection),
  extensionSelections: Schema.optional(
    Schema.Array(ExtensionSelection).check(Schema.isMaxLength(32)),
  ),
  authority: WorkTurnAuthority,
  /**
   * Images already staged for this thread. Ids only: the host reads the bytes
   * it staged itself, so a renderer cannot send the provider an image the host
   * never accepted, and the journal records the attachment by name and digest
   * rather than by content.
   */
  contextInputPolicy: Schema.optional(ConversationInputPolicy),
  attachmentIds: Schema.optional(
    Schema.Array(WorkAttachmentId).check(Schema.isMaxLength(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  /**
   * `#thread` mentions this turn points at. Ids only: the host re-derives the
   * sender's Open authority over each thread and reads its bounded transcript
   * at turn time, so a mention contributes read-only context to this turn
   * alone and never enters the prompt the journal records as the user's
   * message.
   */
  sideChatReturns: Schema.optional(SideChatDraftReturnReferences),
  threadMentionIds: Schema.optional(ThreadMentionIds),
  /**
   * `@file` mentions this turn points at. Relative paths only: the host
   * classifies each path against the thread's bound Project root and reads
   * the file itself. A path that escapes is refused before any read.
   */
  fileMentionPaths: Schema.optional(
    Schema.Array(FileMentionPathInput).check(Schema.isMaxLength(MAX_FILE_MENTIONS_PER_TURN)),
  ),
  /**
   * Set only by the host's own delivery of owed reports — a finished
   * subagent run's result or a side task's report: the turn carries them
   * into this thread and the mark is verified against the journaled records
   * before the turn is admitted, so a caller cannot claim a delivery the
   * journal does not record.
   */
  delivery: Schema.optional(ThreadDeliveryMark),
});
export type StartWorkThreadTurnCommand = typeof StartWorkThreadTurnCommand.Type;

export const CancelWorkTurnCommand = Schema.Struct({
  kind: Schema.Literals(["cancel-work-turn", "force-stop-work-turn"]),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
});
export type CancelWorkTurnCommand = typeof CancelWorkTurnCommand.Type;

export const WorkTurnLookupResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    turn: WorkTurnState,
  }),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    requestId: WorkTurnRequestId,
    threadId: WorkThreadId,
    turnId: WorkTurnId,
    prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
    capabilities: WorkTurnCapabilityFacts,
    message: NonEmptyTrimmedString,
    acceptedAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("not-created"),
    requestId: WorkTurnRequestId,
    message: NonEmptyTrimmedString,
  }),
]);
export type WorkTurnLookupResult = typeof WorkTurnLookupResult.Type;

export const WorkTurnCancelResult = Schema.Struct({
  kind: Schema.Literals(["turn-cancelled", "turn-already-terminal", "stop-requested"]),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  status: WorkTurnLifecycleStatus,
});
export type WorkTurnCancelResult = typeof WorkTurnCancelResult.Type;

/**
 * The most turns one transcript answer carries. A thread may hold more; the
 * answer then holds its newest turns, because a client that cannot decode the
 * answer cannot open the thread at all.
 */
export const MAX_WORK_TRANSCRIPT_TURNS = 64;

/**
 * Thread-scoped transcript bootstrap for reconnect. Returns the newest
 * `MAX_WORK_TRANSCRIPT_TURNS` turns, oldest first, of the exact Work thread
 * the window is authorized to read.
 */
export const WorkThreadTranscript = Schema.Struct({
  threadId: WorkThreadId,
  turns: Schema.Array(WorkTurnState).check(Schema.isMaxLength(MAX_WORK_TRANSCRIPT_TURNS)),
  liveCursor: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultType(Effect.succeed(0)),
  ),
});
export type WorkThreadTranscript = typeof WorkThreadTranscript.Type;

/**
 * One page of a Work thread: a contiguous run of at most
 * `MAX_WORK_TRANSCRIPT_TURNS` turns, oldest first, that may stop short of the
 * limit to keep the answer's text bounded. Without an anchor it is the newest
 * turns; with `before` it is the turns just before the named one, so a client
 * walks back by naming its oldest loaded turn. `liveCursor` is the stream
 * position this page was read at.
 */
export const WorkThreadTranscriptWindow = Schema.Struct({
  version: Schema.Literal(1),
  threadId: WorkThreadId,
  turns: Schema.Array(WorkTurnState).check(Schema.isMaxLength(MAX_WORK_TRANSCRIPT_TURNS)),
  liveCursor: NonNegativeInt,
  ...ThreadWindowBoundsFields,
});
export type WorkThreadTranscriptWindow = typeof WorkThreadTranscriptWindow.Type;

/** What a window read asks for: a page size and at most one anchor turn. */
export const WorkThreadTranscriptWindowRequest = Schema.Struct({
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WORK_TRANSCRIPT_TURNS })),
  before: Schema.optional(WorkTurnRequestId),
});
export type WorkThreadTranscriptWindowRequest = typeof WorkThreadTranscriptWindowRequest.Type;

/** Process-local Work response updates after a durable transcript snapshot. */
export const WorkTurnStreamFrame = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("response-delta"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    text: boundedText(MAX_WORK_TURN_RESPONSE_BYTES),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-tasks"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    tasks: ThreadTaskProgressList,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-tools"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    toolSteps: ThreadToolStepList,
    toolStepsTruncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-tool-step"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    toolStep: Schema.optional(ThreadToolStep),
    toolStepsTruncated: Schema.Boolean,
    /** The turn's cumulative reasoning total, restated; never reasoning text. */
    reasoningMs: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-settled"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    turn: WorkTurnState,
  }),
  Schema.Struct({
    ...HarnessRetryEventFields,
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
  }).check(Schema.makeFilter((frame) => frame.attempt <= frame.maxAttempts)),
  Schema.Struct({
    kind: Schema.Literal("provider-retry-cleared"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
  }),
  Schema.Struct({
    kind: Schema.Literal("compaction-settled"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    compaction: ContextCompactionSettledRecord,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-loop-noticed"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    notice: TurnLoopNotice,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-loop-stopped"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    notice: TurnLoopNotice,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-stall-noticed"),
    sequence: PositiveInt,
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    notice: TurnStallNotice,
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot-required"),
    sequence: NonNegativeInt,
    threadId: WorkThreadId,
  }),
]);
export type WorkTurnStreamFrame = typeof WorkTurnStreamFrame.Type;

export const WorkTurnAccepted = Schema.Struct({
  externalInput: Schema.optional(WorkExternalInputReceipt),
  inputReceipt: Schema.optional(ConversationInputReceipt),
  kind: Schema.Literal("turn-accepted"),
  toolCatalogHandoff: Schema.optional(Schema.Boolean),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  projectId: ProjectId,
  authority: WorkTurnAuthority,
  providerSessionId: ProviderSessionId,
  resumeCursor: Schema.optional(ProviderResumeCursor),
  handoff: Schema.optional(WorkTurnHandoff),
  carriedFrom: Schema.optional(WorkTurnCarriedFrom),
  sideChatReturns: Schema.optional(SideChatDraftReturnReferences),
  /** The threads this turn's message mentioned; absent when it mentioned none. */
  threadMentionIds: Schema.optional(ThreadMentionIds),
  /** The pull requests and issues this turn's message mentioned; absent when it mentioned none. */
  trackerMentions: Schema.optional(TrackerMentions),
  prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
  attachments: Schema.optional(
    Schema.Array(WorkAttachmentReference).check(Schema.isMaxLength(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  /** The attached images a Sees images model described, and which model. */
  describedImages: Schema.optional(DescribedTurnImages),
  extensionSelections: Schema.optional(
    Schema.Array(ExtensionSelection).check(Schema.isMaxLength(32)),
  ),
  capabilities: WorkTurnCapabilityFacts,
  /**
   * Present only on a turn the host itself accepted to deliver owed reports —
   * a finished subagent run's result or a side task's report — journaled so
   * the delivery's idempotency mark survives replay.
   */
  delivery: Schema.optional(ThreadDeliveryMark),
  acceptedAt: UtcTimestamp,
});
export type WorkTurnAccepted = typeof WorkTurnAccepted.Type;

export const WorkTurnUpdated = Schema.Struct({
  resumeCursor: Schema.optional(ProviderResumeCursor),
  /**
   * The settled state a fork copied from its source turn. Nothing ran in the
   * fork, so observers of finished turns (notifications, the message queue)
   * pass it by.
   */
  carried: Schema.optional(Schema.Literal(true)),
  kind: Schema.Literal("turn-updated"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  status: Schema.Literals(["running", "completed", "cancelled", "failed", "waiting"]),
  response: Schema.optional(boundedText(MAX_WORK_TURN_RESPONSE_BYTES)),
  transcript: Schema.optional(Schema.Array(WorkTranscriptEntry).check(Schema.isMaxLength(8))),
  wroteFiles: Schema.optional(WorkTurnWrittenFiles),
  failure: Schema.optional(WorkTurnFailure),
  tasks: Schema.optional(ThreadTaskProgressList),
  toolSteps: Schema.optional(ThreadToolStepList),
  toolStepsTruncated: Schema.optional(Schema.Boolean),
  /** The turn's cumulative reasoning total, restated; never reasoning text. */
  reasoningMs: Schema.optional(NonNegativeInt),
  childObservations: Schema.optional(ProviderChildObservationState),
  /** What Strict kept for this turn's launch; journaled once, as the launch starts. */
  strictKept: Schema.optional(StrictKeptProtections),
  updatedAt: UtcTimestamp,
});
export type WorkTurnUpdated = typeof WorkTurnUpdated.Type;

/**
 * Rewind a Work thread in place to just before one of its turns. Work takes no
 * file checkpoints, so only the conversation is taken back; the files stay as
 * they are. `rewindId` names the journaled removal, so a retry answers from it.
 */
export const RewindWorkThreadCommand = Schema.Struct({
  kind: Schema.Literal("rewind-work-thread"),
  rewindId: WorkTurnRequestId,
  threadId: WorkThreadId,
  /** The first turn the rewind removes; every later turn goes with it. */
  fromRequestId: WorkTurnRequestId,
});
export type RewindWorkThreadCommand = typeof RewindWorkThreadCommand.Type;

/** The most turns one rewind names; a longer tail is refused rather than half removed. */
export const MAX_WORK_REWOUND_TURNS = 10_000;

/**
 * The journaled removal: the turns a rewind took out of the thread, in thread
 * order. The removed turns stay in the journal under their own requests; this
 * record is what keeps them out of the thread and away from the model.
 */
export const WorkThreadRewound = Schema.Struct({
  kind: Schema.Literal("thread-rewound"),
  rewindId: WorkTurnRequestId,
  threadId: WorkThreadId,
  fromRequestId: WorkTurnRequestId,
  removedRequestIds: Schema.NonEmptyArray(WorkTurnRequestId).check(
    Schema.isMaxLength(MAX_WORK_REWOUND_TURNS),
  ),
  rewoundAt: UtcTimestamp,
});
export type WorkThreadRewound = typeof WorkThreadRewound.Type;

/** What a rewind did; the first removed turn's prompt goes back to the composer. */
export const WorkThreadRewindResult = Schema.Struct({
  kind: Schema.Literal("thread-rewound"),
  threadId: WorkThreadId,
  fromRequestId: WorkTurnRequestId,
  removedTurns: PositiveInt,
  prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(200_000)),
});
export type WorkThreadRewindResult = typeof WorkThreadRewindResult.Type;

export const WorkTurnLoopNoticed = Schema.Struct({
  kind: Schema.Literal("turn-loop-noticed"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  toolName: TurnLoopNoticeToolName,
  count: TurnLoopNoticeCount,
  occurredAt: UtcTimestamp,
});
export type WorkTurnLoopNoticed = typeof WorkTurnLoopNoticed.Type;

export const WorkTurnLoopStopped = Schema.Struct({
  kind: Schema.Literal("turn-loop-stopped"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  toolName: TurnLoopNoticeToolName,
  count: TurnLoopNoticeCount,
  occurredAt: UtcTimestamp,
});
export type WorkTurnLoopStopped = typeof WorkTurnLoopStopped.Type;

export const WorkTurnStallNoticed = Schema.Struct({
  kind: Schema.Literal("turn-stall-noticed"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  idleMs: PositiveInt,
  occurredAt: UtcTimestamp,
});
export type WorkTurnStallNoticed = typeof WorkTurnStallNoticed.Type;

export const WORK_TURN_EVENT_NAMES = [
  "work.turn-accepted@1",
  "work.turn-updated@1",
  "work.turn-loop-noticed@1",
  "work.turn-loop-stopped@1",
  "work.turn-stall-noticed@1",
  "work.thread-rewound@1",
] as const;
export type WorkTurnEventName = (typeof WORK_TURN_EVENT_NAMES)[number];

/**
 * What a Work turn accepted before Work shared Code's capability set ran
 * with; a turn journaled without facts replays as these.
 */
export const WORK_TURN_CAPABILITIES: WorkTurnCapabilityFacts = {
  workspace: "project-backed",
  confinement: "project-root-confined",
  shell: "denied",
  git: "denied",
  worktree: "denied",
  pullRequest: "denied",
  code: "denied",
};

export const decodeWorkTurnRequestId = Schema.decodeUnknownSync(
  WorkTurnRequestId,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnId = Schema.decodeUnknownSync(WorkTurnId, STRICT_DECODE_OPTIONS);
export const decodeWorkAttachmentId = Schema.decodeUnknownSync(
  WorkAttachmentId,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkAttachmentMediaType = Schema.decodeUnknownSync(
  WorkAttachmentMediaType,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkAttachmentReference = Schema.decodeUnknownSync(
  WorkAttachmentReference,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnAuthority = Schema.decodeUnknownSync(
  WorkTurnAuthority,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnCapabilityFacts = Schema.decodeUnknownSync(
  WorkTurnCapabilityFacts,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnFailure = Schema.decodeUnknownSync(
  WorkTurnFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTranscriptEntry = Schema.decodeUnknownSync(
  WorkTranscriptEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnState = Schema.decodeUnknownSync(WorkTurnState, STRICT_DECODE_OPTIONS);
export const decodeStartWorkThreadTurnCommand = Schema.decodeUnknownSync(
  StartWorkThreadTurnCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeCancelWorkTurnCommand = Schema.decodeUnknownSync(
  CancelWorkTurnCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnLookupResult = Schema.decodeUnknownSync(
  WorkTurnLookupResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnCancelResult = Schema.decodeUnknownSync(
  WorkTurnCancelResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkThreadTranscript = Schema.decodeUnknownSync(
  WorkThreadTranscript,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkThreadTranscriptWindow = Schema.decodeUnknownSync(
  WorkThreadTranscriptWindow,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkThreadTranscriptWindowRequest = Schema.decodeUnknownSync(
  WorkThreadTranscriptWindowRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnStreamFrame = Schema.decodeUnknownSync(
  WorkTurnStreamFrame,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnAccepted = Schema.decodeUnknownSync(
  WorkTurnAccepted,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnUpdated = Schema.decodeUnknownSync(
  WorkTurnUpdated,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnLoopNoticed = Schema.decodeUnknownSync(
  WorkTurnLoopNoticed,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnLoopStopped = Schema.decodeUnknownSync(
  WorkTurnLoopStopped,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnStallNoticed = Schema.decodeUnknownSync(
  WorkTurnStallNoticed,
  STRICT_DECODE_OPTIONS,
);
export const decodeRewindWorkThreadCommand = Schema.decodeUnknownSync(
  RewindWorkThreadCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkThreadRewound = Schema.decodeUnknownSync(
  WorkThreadRewound,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkThreadRewindResult = Schema.decodeUnknownSync(
  WorkThreadRewindResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeWorkTurnWrittenFiles = Schema.decodeUnknownSync(
  WorkTurnWrittenFiles,
  STRICT_DECODE_OPTIONS,
);

export const decodeWorkExternalInputReceipt = Schema.decodeUnknownSync(
  WorkExternalInputReceipt,
  STRICT_DECODE_OPTIONS,
);
