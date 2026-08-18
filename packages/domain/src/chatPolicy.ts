import {
  decodeChatAttempt,
  decodeChatThread,
  decodeChatTurn,
  type ChatAttempt,
  type ChatAttemptOutcome,
  type ChatAttachmentId,
  type ChatContentReference,
  type ChatResearchRouting,
  type ChatThread,
  type ChatThreadBranchOrigin,
  type ChatThreadId,
  type ChatTurn,
  type ChatTurnId,
} from "@octant/contracts/chat";
import type { ContextManifestId } from "@octant/contracts/context";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import type { ExtensionSelection } from "@octant/contracts/extensions";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  ProviderInstanceId,
  ProviderModelId,
  ProviderModelOption,
  ProviderModelOptionValues,
  ProviderResumeCursor,
  ProviderSessionId,
} from "@octant/contracts/providers";

export type ChatPolicyRejectionCode =
  | "stale-version"
  | "thread-not-active"
  | "thread-not-archived"
  | "invalid-lifecycle"
  | "invalid-title"
  | "invalid-instructions"
  | "model-unavailable"
  | "invalid-model-option"
  | "retry-not-allowed"
  | "invalid-attempt-transition";

export class ChatPolicyRejected extends Error {
  override readonly name = "ChatPolicyRejected";

  constructor(
    readonly code: ChatPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ChatPolicyRejectionCode, message: string): never {
  throw new ChatPolicyRejected(code, message);
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function assertActive(thread: ChatThread): void {
  if (thread.lifecycle !== "active") {
    reject("thread-not-active", `Thread is ${thread.lifecycle}`);
  }
}

function assertExpectedVersion(thread: ChatThread, expectedVersion: AggregateVersion): void {
  if (thread.version !== expectedVersion) {
    reject("stale-version", `Expected thread version ${expectedVersion}, got ${thread.version}`);
  }
}

function normalizeTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    reject("invalid-title", "Thread title cannot be empty");
  }
  return normalized;
}

function normalizeInstructions(instructions: string): string {
  const normalized = instructions.trim();
  if (normalized.length === 0) {
    reject("invalid-instructions", "Personality instructions cannot be empty");
  }
  return normalized;
}

export interface CreateChatThreadInput {
  readonly id: ChatThreadId;
  readonly title: string;
  readonly projectId?: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly researchEnabled: boolean;
  readonly researchRouting: ChatResearchRouting;
  readonly personalityInstructions: string;
  /** Option values already validated against the selected model's options. */
  readonly modelOptionValues?: ProviderModelOptionValues;
  readonly branchedFrom?: ChatThreadBranchOrigin;
  readonly createdAt: UtcTimestamp;
}

export function createChatThread(input: CreateChatThreadInput): ChatThread {
  const title = normalizeTitle(input.title);
  const instructions = normalizeInstructions(input.personalityInstructions);

  return decodeChatThread({
    id: input.id,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    title,
    lifecycle: "active",
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    researchEnabled: input.researchEnabled,
    researchRouting: input.researchRouting,
    personalityInstructions: instructions,
    ...(input.modelOptionValues === undefined || Object.keys(input.modelOptionValues).length === 0
      ? {}
      : { modelOptionValues: input.modelOptionValues }),
    ...(input.branchedFrom === undefined ? {} : { branchedFrom: input.branchedFrom }),
    version: 1 as AggregateVersion,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export interface ChangeChatProviderInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly expectedVersion: AggregateVersion;
  readonly updatedAt: UtcTimestamp;
  readonly availableModels?: ReadonlyArray<ProviderModelId>;
  /** Options the selected model declares; absent means it declares none. */
  readonly modelOptions?: ReadonlyArray<ProviderModelOption>;
  /**
   * Explicit replacement values. Every entry must name a declared selection
   * option and one of its values. Absent keeps the thread's current values
   * that the selected model still declares and drops the rest.
   */
  readonly modelOptionValues?: ProviderModelOptionValues;
}

function declaresModelOptionValue(
  options: ReadonlyArray<ProviderModelOption>,
  optionId: string,
  value: string,
): boolean {
  const option = options.find((candidate) => candidate.id === optionId);
  return option?.kind === "selection" && option.values.includes(value);
}

/** One persisted option value the model in hand no longer declares. */
export interface UnsupportedModelOptionValue {
  readonly optionId: string;
  readonly value: string;
}

/**
 * The persisted option values a model no longer declares.
 *
 * `changeChatProvider` validates a selection once, against the catalog
 * observed at the moment of the change. A provider can retire a reasoning
 * tier or an effort level after that, so a turn has to re-check the values it
 * is about to run on: drivers drop what a model does not declare, and an
 * unchecked stale value would run at the provider default while the picker
 * still shows the retired one.
 */
export function unsupportedModelOptionValues(
  values: ProviderModelOptionValues | undefined,
  options: ReadonlyArray<ProviderModelOption>,
): ReadonlyArray<UnsupportedModelOptionValue> {
  return Object.entries(values ?? {})
    .filter(([optionId, value]) => !declaresModelOptionValue(options, optionId, value))
    .map(([optionId, value]) => ({ optionId, value }));
}

function resolveModelOptionValues(
  thread: ChatThread,
  input: ChangeChatProviderInput,
): ProviderModelOptionValues | undefined {
  const declared = input.modelOptions ?? [];
  if (input.modelOptionValues !== undefined) {
    for (const [optionId, value] of Object.entries(input.modelOptionValues)) {
      if (!declaresModelOptionValue(declared, optionId, value)) {
        reject("invalid-model-option", `Selected model does not offer ${optionId}=${value}`);
      }
    }
    return Object.keys(input.modelOptionValues).length === 0 ? undefined : input.modelOptionValues;
  }
  const carried = Object.entries(thread.modelOptionValues ?? {}).filter(([optionId, value]) =>
    declaresModelOptionValue(declared, optionId, value),
  );
  return carried.length === 0 ? undefined : Object.fromEntries(carried);
}

export function changeChatProvider(thread: ChatThread, input: ChangeChatProviderInput): ChatThread {
  assertActive(thread);
  assertExpectedVersion(thread, input.expectedVersion);

  if (input.availableModels !== undefined && !input.availableModels.includes(input.modelId)) {
    reject("model-unavailable", "Selected model is not available");
  }
  const modelOptionValues = resolveModelOptionValues(thread, input);
  const { modelOptionValues: _previousValues, ...withoutValues } = thread;

  return decodeChatThread({
    ...withoutValues,
    providerInstanceId: input.providerInstanceId,
    modelId: input.modelId,
    ...(modelOptionValues === undefined ? {} : { modelOptionValues }),
    version: nextVersion(thread.version),
    updatedAt: input.updatedAt,
  });
}

export interface ChangeChatResearchInput {
  readonly researchEnabled: boolean;
  readonly researchRouting: ChatResearchRouting;
  readonly expectedVersion: AggregateVersion;
  readonly updatedAt: UtcTimestamp;
}

export function changeChatResearch(thread: ChatThread, input: ChangeChatResearchInput): ChatThread {
  assertActive(thread);
  assertExpectedVersion(thread, input.expectedVersion);

  return decodeChatThread({
    ...thread,
    researchEnabled: input.researchEnabled,
    researchRouting: input.researchRouting,
    version: nextVersion(thread.version),
    updatedAt: input.updatedAt,
  });
}

export interface BeginChatTurnInput {
  readonly turnId: ChatTurnId;
  readonly attemptId: ChatAttempt["id"];
  readonly providerSessionId: ProviderSessionId;
  readonly contextManifestId: ContextManifestId;
  readonly userMessageRef: ChatContentReference;
  readonly attachmentIds?: ReadonlyArray<ChatAttachmentId>;
  readonly extensionSelections?: ReadonlyArray<ExtensionSelection>;
  /**
   * The earlier turn this turn revises. Set only by an edit; the superseded
   * turn is never mutated or removed, so the journal stays append-only.
   */
  readonly supersedes?: ChatTurnId;
  readonly sequence: ChatTurn["sequence"];
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
}

export function beginChatTurn(thread: ChatThread, input: BeginChatTurnInput): ChatTurn {
  assertActive(thread);
  assertExpectedVersion(thread, input.expectedVersion);

  const attempt: ChatAttempt = decodeChatAttempt({
    id: input.attemptId,
    turnId: input.turnId,
    threadId: thread.id,
    providerInstanceId: thread.providerInstanceId,
    providerSessionId: input.providerSessionId,
    modelId: thread.modelId,
    contextManifestId: input.contextManifestId,
    outcome: "queued",
    responseRefs: [],
    citationIds: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });

  return decodeChatTurn({
    id: input.turnId,
    threadId: thread.id,
    sequence: input.sequence,
    userMessageRef: input.userMessageRef,
    attachmentIds: input.attachmentIds ?? [],
    ...(input.extensionSelections === undefined || input.extensionSelections.length === 0
      ? {}
      : { extensionSelections: input.extensionSelections }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
    attempts: [attempt],
    createdAt: input.createdAt,
  });
}

/**
 * Selects the turns that make up the active conversation.
 *
 * The Chat journal is append-only: revising a message appends a new turn that
 * names the revised one in `supersedes` rather than rewriting history. Reading
 * `turns` in sequence order and applying each `supersedes` marker in turn
 * yields the conversation as it now stands, while every superseded turn stays
 * journaled and recoverable. A `supersedes` marker naming a turn that is
 * already inactive changes nothing, so replaying an old event stream is
 * idempotent.
 */
export function activeChatTurns<T extends ChatTranscriptTurn>(
  turns: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const active: T[] = [];
  for (const turn of turns) {
    if (turn.supersedes !== undefined) {
      const superseded = active.findIndex(
        (candidate) => String(candidate.id) === String(turn.supersedes),
      );
      if (superseded >= 0) active.length = superseded;
    }
    active.push(turn);
  }
  return active;
}

/**
 * Whether this attempt produced the answer the conversation kept.
 *
 * The companion question to `activeChatTurns`. That fold asks which turns the
 * user replaced; this asks which of a turn's attempts actually finished. An
 * attempt that is still queued, streaming, or waiting has not written an answer
 * yet, and one that failed, was interrupted, or was cancelled abandoned the one
 * it had started — its text stays journaled and visible to the reader, who is
 * told plainly that it was cut short, but it is not what the thread answered.
 *
 * Everything that hands a Chat conversation to a model reads it through here.
 * None of those surfaces can mark text as partial, so an unanswered attempt
 * contributes nothing rather than an unlabelled fragment beside a real answer;
 * the turn's prompt is admitted either way, because the user did ask it.
 *
 * The parameter is structural so the contract's `ChatAttempt` and the narrower
 * shapes a projection view exposes both satisfy it.
 */
export function chatAttemptAnswered(attempt: { readonly outcome: string }): boolean {
  return attempt.outcome === "completed";
}

/**
 * The active conversation up to and including `turnId`, or `undefined` when
 * that turn is not part of the active conversation (it was superseded, or it
 * belongs to another thread).
 */
export function chatTurnsThrough<T extends ChatTranscriptTurn>(
  turns: ReadonlyArray<T>,
  turnId: ChatTurnId,
): ReadonlyArray<T> | undefined {
  const active = activeChatTurns(turns);
  const index = active.findIndex((turn) => String(turn.id) === String(turnId));
  return index < 0 ? undefined : active.slice(0, index + 1);
}

/** The minimum a turn must expose for transcript selection. */
export interface ChatTranscriptTurn {
  readonly id: string;
  readonly supersedes?: string | undefined;
}

export interface RetryChatTurnInput {
  readonly turnId: ChatTurnId;
  readonly attemptId: ChatAttempt["id"];
  readonly newAttemptId: ChatAttempt["id"];
  readonly newProviderSessionId: ProviderSessionId;
  readonly newContextManifestId: ContextManifestId;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
}

const retryEligibleOutcomes: ReadonlyArray<ChatAttemptOutcome> = ["failed", "interrupted"];

export function retryChatTurn(
  thread: ChatThread,
  attempt: ChatAttempt,
  input: RetryChatTurnInput,
): ChatAttempt {
  assertActive(thread);
  assertExpectedVersion(thread, input.expectedVersion);

  if (attempt.threadId !== thread.id) {
    reject("retry-not-allowed", "Attempt does not belong to this thread");
  }
  if (attempt.turnId !== input.turnId || attempt.id !== input.attemptId) {
    reject("retry-not-allowed", "Attempt identity does not match retry input");
  }
  if (!retryEligibleOutcomes.includes(attempt.outcome)) {
    reject("retry-not-allowed", `Cannot retry an attempt that is ${attempt.outcome}`);
  }

  return decodeChatAttempt({
    id: input.newAttemptId,
    turnId: attempt.turnId,
    threadId: attempt.threadId,
    providerInstanceId: attempt.providerInstanceId,
    providerSessionId: input.newProviderSessionId,
    modelId: attempt.modelId,
    contextManifestId: input.newContextManifestId,
    outcome: "queued",
    responseRefs: [],
    citationIds: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export interface ResumeChatTurnInput {
  readonly turnId: ChatTurnId;
  readonly attemptId: ChatAttempt["id"];
  readonly newAttemptId: ChatAttempt["id"];
  readonly newContextManifestId: ContextManifestId;
  readonly expectedVersion: AggregateVersion;
  readonly createdAt: UtcTimestamp;
}

const resumeEligibleOutcomes: ReadonlyArray<ChatAttemptOutcome> = ["waiting", "interrupted"];

/**
 * Resume a provider session that ended in a resumable outcome (waiting or
 * interrupted) by creating a new attempt that preserves the exact provider
 * session id and provider-owned resume cursor. Unlike retry, resume never
 * allocates a fresh provider session; it reuses the persisted resume identity
 * so `ProviderConnection.resume` can continue the same session.
 */
export function resumeChatTurn(
  thread: ChatThread,
  attempt: ChatAttempt,
  input: ResumeChatTurnInput,
): ChatAttempt {
  assertActive(thread);
  assertExpectedVersion(thread, input.expectedVersion);

  if (attempt.threadId !== thread.id) {
    reject("retry-not-allowed", "Attempt does not belong to this thread");
  }
  if (attempt.turnId !== input.turnId || attempt.id !== input.attemptId) {
    reject("retry-not-allowed", "Attempt identity does not match resume input");
  }
  if (!resumeEligibleOutcomes.includes(attempt.outcome)) {
    reject("retry-not-allowed", `Cannot resume an attempt that is ${attempt.outcome}`);
  }
  if (attempt.resumeCursor === undefined) {
    reject("retry-not-allowed", "Attempt has no provider resume cursor");
  }

  return decodeChatAttempt({
    id: input.newAttemptId,
    turnId: attempt.turnId,
    threadId: attempt.threadId,
    providerInstanceId: attempt.providerInstanceId,
    providerSessionId: attempt.providerSessionId,
    modelId: attempt.modelId,
    contextManifestId: input.newContextManifestId,
    outcome: "queued",
    responseRefs: [],
    citationIds: [],
    resumeCursor: attempt.resumeCursor,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

export interface TransitionChatAttemptInput {
  readonly outcome: ChatAttemptOutcome;
  readonly updatedAt: UtcTimestamp;
}

const terminalOutcomes: ReadonlyArray<ChatAttemptOutcome> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

const transitions = new Map<ChatAttemptOutcome, ReadonlyArray<ChatAttemptOutcome>>([
  ["queued", ["streaming", "waiting", "interrupted", "failed", "cancelled"]],
  ["streaming", ["waiting", "interrupted", "failed", "cancelled", "completed"]],
  ["waiting", ["interrupted", "failed", "cancelled", "completed"]],
]);

function isValidTransition(from: ChatAttemptOutcome, to: ChatAttemptOutcome): boolean {
  if (from === to) return false;
  if (terminalOutcomes.includes(from)) return false;
  const valid = transitions.get(from);
  return valid !== undefined && valid.includes(to);
}

export function transitionChatAttempt(
  attempt: ChatAttempt,
  input: TransitionChatAttemptInput,
): ChatAttempt {
  if (!isValidTransition(attempt.outcome, input.outcome)) {
    reject(
      "invalid-attempt-transition",
      `Cannot transition attempt from ${attempt.outcome} to ${input.outcome}`,
    );
  }

  return decodeChatAttempt({
    ...attempt,
    outcome: input.outcome,
    updatedAt: input.updatedAt,
  });
}

export interface ArchiveChatThreadInput {
  readonly expectedVersion: AggregateVersion;
  readonly updatedAt: UtcTimestamp;
}

export function archiveChatThread(thread: ChatThread, input: ArchiveChatThreadInput): ChatThread {
  if (thread.lifecycle !== "active") {
    reject("thread-not-active", `Cannot archive thread that is ${thread.lifecycle}`);
  }
  assertExpectedVersion(thread, input.expectedVersion);

  return decodeChatThread({
    ...thread,
    lifecycle: "archived",
    version: nextVersion(thread.version),
    updatedAt: input.updatedAt,
  });
}

export interface RequestChatThreadDeletionInput {
  readonly expectedVersion: AggregateVersion;
  readonly updatedAt: UtcTimestamp;
}

export function requestChatThreadDeletion(
  thread: ChatThread,
  input: RequestChatThreadDeletionInput,
): ChatThread {
  if (thread.lifecycle === "deleting" || thread.lifecycle === "deleted") {
    reject("invalid-lifecycle", `Thread is already ${thread.lifecycle}`);
  }
  assertExpectedVersion(thread, input.expectedVersion);

  return decodeChatThread({
    ...thread,
    lifecycle: "deleting",
    version: nextVersion(thread.version),
    updatedAt: input.updatedAt,
  });
}
