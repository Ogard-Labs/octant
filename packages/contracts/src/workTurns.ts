import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { BindingRevisionId, ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "./providers";
import { ThreadWorkingDirectory } from "./workingDirectory";
import { FileMentionPathInput, MAX_FILE_MENTIONS_PER_TURN } from "./fileMention";
import { MAX_THREAD_MENTIONS_PER_TURN, MentionableThreadId } from "./threadMentionIdentity";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

export const MAX_WORK_TURN_RESPONSE_BYTES = 64 * 1024;
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
 * Work attachments are images only. Everything the confined folder already
 * holds reaches a Work turn through the Project root, so the one thing a
 * path cannot carry is a picture the user is looking at — a screenshot, a
 * mockup, a photographed whiteboard.
 */
export const WORK_ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const WorkAttachmentMediaType = Schema.Literal(...WORK_ATTACHMENT_MEDIA_TYPES);
export type WorkAttachmentMediaType = typeof WorkAttachmentMediaType.Type;
export const MAX_WORK_ATTACHMENT_BYTES = 10_485_760;
export const MAX_WORK_TURN_ATTACHMENTS = 8;
export const MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH = 255;
const WorkAttachmentDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

/**
 * What the host kept for one image: the id the renderer chose, and the name,
 * media type, size, and digest this process measured from the bytes it wrote.
 */
export const WorkAttachmentReference = Schema.Struct({
  attachmentId: WorkAttachmentId,
  displayName: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(MAX_WORK_ATTACHMENT_DISPLAY_NAME_LENGTH),
  ),
  mediaType: WorkAttachmentMediaType,
  byteLength: Schema.Int.pipe(Schema.between(1, MAX_WORK_ATTACHMENT_BYTES)),
  digest: WorkAttachmentDigest,
}).annotations(strict);
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
  confinementPosture: Schema.Literal("project-root-confined"),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type WorkTurnAuthority = typeof WorkTurnAuthority.Type;

/**
 * Honest capability facts retained with every accepted Work turn. They make
 * the denied Code/shell/Git posture durable for reconnect and restart.
 */
export const WorkTurnCapabilityFacts = Schema.Struct({
  workspace: Schema.Literal("project-backed"),
  confinement: Schema.Literal("project-root-confined"),
  shell: Schema.Literal("denied"),
  git: Schema.Literal("denied"),
  worktree: Schema.Literal("denied"),
  pullRequest: Schema.Literal("denied"),
  code: Schema.Literal("denied"),
}).annotations(strict);
export type WorkTurnCapabilityFacts = typeof WorkTurnCapabilityFacts.Type;

export const WorkTurnLifecycleStatus = Schema.Literal(
  "accepted",
  "running",
  "completed",
  "cancelled",
  "failed",
  "waiting",
);
export type WorkTurnLifecycleStatus = typeof WorkTurnLifecycleStatus.Type;

export const WorkTurnFailure = Schema.Struct({
  category: Schema.Literal(
    "invalid",
    "unauthorized",
    "unavailable",
    "unsupported",
    "interrupted",
    "failed",
    "stale",
  ),
  message: boundedNonEmptyText(MAX_WORK_TURN_FAILURE_BYTES),
}).annotations(strict);
export type WorkTurnFailure = typeof WorkTurnFailure.Type;

/**
 * One durable transcript entry for a Work turn. User text is the accepted
 * prompt; assistant text accumulates provider deltas. Status is set only on
 * assistant entries when the turn is non-completed.
 */
export const WorkTranscriptEntry = Schema.Struct({
  role: Schema.Literal("user", "assistant"),
  text: boundedText(MAX_WORK_TURN_RESPONSE_BYTES),
  status: Schema.optional(
    Schema.Literal("running", "waiting", "completed", "cancelled", "failed", "interrupted"),
  ),
}).annotations(strict);
export type WorkTranscriptEntry = typeof WorkTranscriptEntry.Type;

export const WorkTurnState = Schema.Struct({
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  projectId: ProjectId,
  authority: WorkTurnAuthority,
  providerSessionId: Schema.optional(ProviderSessionId),
  status: WorkTurnLifecycleStatus,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  response: Schema.optional(boundedText(MAX_WORK_TURN_RESPONSE_BYTES)),
  transcript: Schema.Array(WorkTranscriptEntry).pipe(Schema.maxItems(8)),
  attachments: Schema.optional(
    Schema.Array(WorkAttachmentReference).pipe(Schema.maxItems(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  failure: Schema.optional(WorkTurnFailure),
  capabilities: WorkTurnCapabilityFacts,
  version: AggregateVersion,
  acceptedAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type WorkTurnState = typeof WorkTurnState.Type;

export const StartWorkThreadTurnCommand = Schema.Struct({
  kind: Schema.Literal("start-work-thread-turn"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  authority: WorkTurnAuthority,
  /**
   * Images already staged for this thread. Ids only: the host reads the bytes
   * it staged itself, so a renderer cannot send the provider an image the host
   * never accepted, and the journal records the attachment by name and digest
   * rather than by content.
   */
  attachmentIds: Schema.optional(
    Schema.Array(WorkAttachmentId).pipe(Schema.maxItems(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  /**
   * `#thread` mentions this turn points at. Ids only: the host re-derives the
   * sender's Open authority over each thread and reads its bounded transcript
   * at turn time, so a mention contributes read-only context to this turn
   * alone and never enters the prompt the journal records as the user's
   * message.
   */
  threadMentionIds: Schema.optional(
    Schema.Array(MentionableThreadId).pipe(Schema.maxItems(MAX_THREAD_MENTIONS_PER_TURN)),
  ),
  /**
   * `@file` mentions this turn points at. Relative paths only: the host
   * classifies each path against the thread's bound Project root and reads
   * the file itself. A path that escapes is refused before any read.
   */
  fileMentionPaths: Schema.optional(
    Schema.Array(FileMentionPathInput).pipe(Schema.maxItems(MAX_FILE_MENTIONS_PER_TURN)),
  ),
}).annotations(strict);
export type StartWorkThreadTurnCommand = typeof StartWorkThreadTurnCommand.Type;

export const CancelWorkTurnCommand = Schema.Struct({
  kind: Schema.Literal("cancel-work-turn"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
}).annotations(strict);
export type CancelWorkTurnCommand = typeof CancelWorkTurnCommand.Type;

export const WorkTurnLookupResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    turn: WorkTurnState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    requestId: WorkTurnRequestId,
    threadId: WorkThreadId,
    turnId: WorkTurnId,
    prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
    capabilities: WorkTurnCapabilityFacts,
    message: Schema.NonEmptyTrimmedString,
    acceptedAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-created"),
    requestId: WorkTurnRequestId,
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
);
export type WorkTurnLookupResult = typeof WorkTurnLookupResult.Type;

export const WorkTurnCancelResult = Schema.Struct({
  kind: Schema.Literal("turn-cancelled", "turn-already-terminal"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  status: WorkTurnLifecycleStatus,
}).annotations(strict);
export type WorkTurnCancelResult = typeof WorkTurnCancelResult.Type;

/**
 * Thread-scoped transcript bootstrap for reconnect. Returns every retained
 * turn for the exact Work thread the window is authorized to read.
 */
export const WorkThreadTranscript = Schema.Struct({
  threadId: WorkThreadId,
  turns: Schema.Array(WorkTurnState).pipe(Schema.maxItems(64)),
  liveCursor: Schema.optionalWith(Schema.Int.pipe(Schema.nonNegative()), { default: () => 0 }),
}).annotations(strict);
export type WorkThreadTranscript = typeof WorkThreadTranscript.Type;

/** Process-local Work response updates after a durable transcript snapshot. */
export const WorkTurnStreamFrame = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("response-delta"),
    sequence: Schema.Int.pipe(Schema.positive()),
    threadId: WorkThreadId,
    requestId: WorkTurnRequestId,
    text: boundedText(MAX_WORK_TURN_RESPONSE_BYTES),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("turn-settled"),
    sequence: Schema.Int.pipe(Schema.positive()),
    threadId: WorkThreadId,
    turn: WorkTurnState,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("snapshot-required"),
    sequence: Schema.Int.pipe(Schema.nonNegative()),
    threadId: WorkThreadId,
  }).annotations(strict),
);
export type WorkTurnStreamFrame = typeof WorkTurnStreamFrame.Type;

export const WorkTurnAccepted = Schema.Struct({
  kind: Schema.Literal("turn-accepted"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  projectId: ProjectId,
  authority: WorkTurnAuthority,
  providerSessionId: ProviderSessionId,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200_000)),
  attachments: Schema.optional(
    Schema.Array(WorkAttachmentReference).pipe(Schema.maxItems(MAX_WORK_TURN_ATTACHMENTS)),
  ),
  capabilities: WorkTurnCapabilityFacts,
  acceptedAt: UtcTimestamp,
}).annotations(strict);
export type WorkTurnAccepted = typeof WorkTurnAccepted.Type;

export const WorkTurnUpdated = Schema.Struct({
  kind: Schema.Literal("turn-updated"),
  requestId: WorkTurnRequestId,
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  status: Schema.Literal("running", "completed", "cancelled", "failed", "waiting"),
  response: Schema.optional(boundedText(MAX_WORK_TURN_RESPONSE_BYTES)),
  transcript: Schema.optional(Schema.Array(WorkTranscriptEntry).pipe(Schema.maxItems(8))),
  failure: Schema.optional(WorkTurnFailure),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type WorkTurnUpdated = typeof WorkTurnUpdated.Type;

export const WORK_TURN_EVENT_NAMES = ["work.turn-accepted@1", "work.turn-updated@1"] as const;
export type WorkTurnEventName = (typeof WORK_TURN_EVENT_NAMES)[number];

export const WORK_TURN_CAPABILITIES: WorkTurnCapabilityFacts = {
  workspace: "project-backed",
  confinement: "project-root-confined",
  shell: "denied",
  git: "denied",
  worktree: "denied",
  pullRequest: "denied",
  code: "denied",
};

export const decodeWorkTurnRequestId = Schema.decodeUnknownSync(WorkTurnRequestId);
export const decodeWorkTurnId = Schema.decodeUnknownSync(WorkTurnId);
export const decodeWorkAttachmentId = Schema.decodeUnknownSync(WorkAttachmentId);
export const decodeWorkAttachmentMediaType = Schema.decodeUnknownSync(WorkAttachmentMediaType);
export const decodeWorkAttachmentReference = Schema.decodeUnknownSync(WorkAttachmentReference);
export const decodeWorkTurnAuthority = Schema.decodeUnknownSync(WorkTurnAuthority);
export const decodeWorkTurnCapabilityFacts = Schema.decodeUnknownSync(WorkTurnCapabilityFacts);
export const decodeWorkTurnFailure = Schema.decodeUnknownSync(WorkTurnFailure);
export const decodeWorkTranscriptEntry = Schema.decodeUnknownSync(WorkTranscriptEntry);
export const decodeWorkTurnState = Schema.decodeUnknownSync(WorkTurnState);
export const decodeStartWorkThreadTurnCommand = Schema.decodeUnknownSync(
  StartWorkThreadTurnCommand,
);
export const decodeCancelWorkTurnCommand = Schema.decodeUnknownSync(CancelWorkTurnCommand);
export const decodeWorkTurnLookupResult = Schema.decodeUnknownSync(WorkTurnLookupResult);
export const decodeWorkTurnCancelResult = Schema.decodeUnknownSync(WorkTurnCancelResult);
export const decodeWorkThreadTranscript = Schema.decodeUnknownSync(WorkThreadTranscript);
export const decodeWorkTurnStreamFrame = Schema.decodeUnknownSync(WorkTurnStreamFrame);
export const decodeWorkTurnAccepted = Schema.decodeUnknownSync(WorkTurnAccepted);
export const decodeWorkTurnUpdated = Schema.decodeUnknownSync(WorkTurnUpdated);
