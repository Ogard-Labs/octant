import { Schema } from "effect";
import { AnswerChatTurnQuestionCommand, ChatAttemptQuestion, ChatThreadId } from "./chat";
import { CodeApprovalId, CodeCheckoutId, CodeThreadId } from "./code";
import {
  CodeApprovalSummaryText,
  CodeOperationId,
  CodeProviderRequestId,
  CodeQuestionOptionText,
  CodeQuestionPromptText,
  MAX_CODE_QUESTION_OPTIONS,
} from "./codeOperations";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { MAX_WORK_REQUEST_OPTIONS, WorkRequestId, WorkRequestSanitizedText } from "./workRequests";
import { WorkThreadId } from "./workThreads";
import { WorkTurnAuthority, WorkTurnId } from "./workTurns";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * The fenced block a Work or Code reply closes with when it hands the person a
 * decision. The host reads it from the normalized reply text alone, so every
 * provider raises a decision the same way and none can raise one any other way.
 */
export const TURN_DECISION_BLOCK_LANGUAGE = "octant-decision";

/** One sentence: it has to fit two lines of a card. */
export const MAX_TURN_DECISION_ASK_LENGTH = 110;
/** An option is words the person would send, short enough for one button. */
export const MAX_TURN_DECISION_OPTION_LENGTH = 60;
export const MAX_TURN_DECISION_OPTIONS = 4;

export const TurnDecisionAskText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_ASK_LENGTH),
);
export const TurnDecisionOptionText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_OPTION_LENGTH),
);

/**
 * The options a decision offers, in the order the agent gave them, exactly one
 * of them recommended. An option is the text of the next turn, never an
 * action: picking one sends it to the agent and does nothing else.
 */
export const TurnDecisionOptions = Schema.Array(
  Schema.Struct({ label: TurnDecisionOptionText, recommended: Schema.Boolean }).annotations(strict),
).pipe(
  Schema.minItems(1),
  Schema.maxItems(MAX_TURN_DECISION_OPTIONS),
  Schema.filter(
    (options) =>
      options.filter((option) => option.recommended).length === 1 &&
      new Set(options.map((option) => option.label)).size === options.length,
    { message: () => "A decision recommends exactly one of its distinct options." },
  ),
);
export type TurnDecisionOptions = typeof TurnDecisionOptions.Type;

/**
 * One approval, question, or decision waiting on the person, in a thread the reading
 * window can already open, in a mode it can already use. Each mode keeps its
 * own text bounds and sanitization: an item is never looser than the record it
 * was read from. `answer` carries exactly what that mode's existing answer
 * command needs beyond the person's answer itself (and, for Code, a fresh
 * operation id), so answering never goes through a new route. A decision is
 * the ask a finished turn closed with; its answer is the thread's ordinary
 * next turn, sent through the mode's own send command.
 */
const PendingRequestFields = {
  threadTitle: Schema.NonEmptyTrimmedString,
  requestedAt: UtcTimestamp,
} as const;

/** `resolve-work-request` / `cancel-work-request` take these two fields. */
export const WorkPendingRequestAnswer = Schema.Struct({
  requestId: WorkRequestId,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type WorkPendingRequestAnswer = typeof WorkPendingRequestAnswer.Type;

const WorkPendingRequestFields = {
  ...PendingRequestFields,
  mode: Schema.Literal("work"),
  projectId: ProjectId,
  threadId: WorkThreadId,
  text: WorkRequestSanitizedText,
  answer: WorkPendingRequestAnswer,
} as const;

/** `answer-provider-approval` takes these beside its fresh operation id and decision. */
export const CodePendingApprovalAnswer = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  approvalId: CodeApprovalId,
}).annotations(strict);
export type CodePendingApprovalAnswer = typeof CodePendingApprovalAnswer.Type;

/** `answer-provider-input` takes these beside its fresh operation id and response evidence. */
export const CodePendingQuestionAnswer = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  requestId: CodeProviderRequestId,
}).annotations(strict);
export type CodePendingQuestionAnswer = typeof CodePendingQuestionAnswer.Type;

const CodePendingRequestFields = {
  ...PendingRequestFields,
  mode: Schema.Literal("code"),
  projectId: ProjectId,
  threadId: CodeThreadId,
} as const;

/**
 * `start-provider-turn` takes these beside its fresh operation and session ids
 * and the option's text as prompt evidence. `operationId` names the turn that
 * asked, so the same decision keeps one identity across reads.
 */
export const CodePendingDecisionAnswer = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  operationId: CodeOperationId,
}).annotations(strict);
export type CodePendingDecisionAnswer = typeof CodePendingDecisionAnswer.Type;

/**
 * `start-work-thread-turn` takes these beside its fresh request and turn ids
 * and the option's text as prompt. `authority` is the thread's current one as
 * the composer would send it; the host checks it again when the turn starts.
 * `turnId` names the turn that asked.
 */
export const WorkPendingDecisionAnswer = Schema.Struct({
  threadId: WorkThreadId,
  turnId: WorkTurnId,
  authority: WorkTurnAuthority,
}).annotations(strict);
export type WorkPendingDecisionAnswer = typeof WorkPendingDecisionAnswer.Type;

/** `answer-chat-turn-question` takes these beside the answer text. */
export const ChatPendingQuestionAnswer = Schema.Struct({
  threadId: AnswerChatTurnQuestionCommand.fields.threadId,
  expectedVersion: AnswerChatTurnQuestionCommand.fields.expectedVersion,
  turnId: AnswerChatTurnQuestionCommand.fields.turnId,
  attemptId: AnswerChatTurnQuestionCommand.fields.attemptId,
  requestId: AnswerChatTurnQuestionCommand.fields.requestId,
}).annotations(strict);
export type ChatPendingQuestionAnswer = typeof ChatPendingQuestionAnswer.Type;

const sameThread = (request: {
  readonly threadId: unknown;
  readonly answer: { readonly threadId: unknown };
}): boolean => String(request.threadId) === String(request.answer.threadId);

export const PendingRequest = Schema.Union(
  Schema.Struct({ ...WorkPendingRequestFields, kind: Schema.Literal("approval") }).annotations(
    strict,
  ),
  Schema.Struct({
    ...WorkPendingRequestFields,
    kind: Schema.Literal("question"),
    options: Schema.Array(
      Schema.Struct({ label: WorkRequestSanitizedText }).annotations(strict),
    ).pipe(Schema.maxItems(MAX_WORK_REQUEST_OPTIONS)),
  }).annotations(strict),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("approval"),
    text: CodeApprovalSummaryText,
    answer: CodePendingApprovalAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("question"),
    text: CodeQuestionPromptText,
    options: Schema.Array(
      Schema.Struct({ label: CodeQuestionOptionText }).annotations(strict),
    ).pipe(Schema.maxItems(MAX_CODE_QUESTION_OPTIONS)),
    answer: CodePendingQuestionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...PendingRequestFields,
    mode: Schema.Literal("work"),
    kind: Schema.Literal("decision"),
    projectId: ProjectId,
    threadId: WorkThreadId,
    text: TurnDecisionAskText,
    options: TurnDecisionOptions,
    answer: WorkPendingDecisionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("decision"),
    text: TurnDecisionAskText,
    options: TurnDecisionOptions,
    answer: CodePendingDecisionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...PendingRequestFields,
    mode: Schema.Literal("chat"),
    kind: Schema.Literal("question"),
    /** Absent for a Chat thread filed under no Project. */
    projectId: Schema.optional(ProjectId),
    threadId: ChatThreadId,
    text: ChatAttemptQuestion.from.fields.prompt,
    options: ChatAttemptQuestion.from.fields.options,
    answer: ChatPendingQuestionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
);
export type PendingRequest = typeof PendingRequest.Type;

export const MAX_PENDING_REQUESTS = 128;

/**
 * Every pending request the window can answer, oldest waiting first. A
 * decision waits from the moment its turn ended. A host
 * holding more than the bound returns the oldest ones and says so with
 * `truncated`, so a reader never mistakes a cut list for the whole.
 */
export const PendingRequestList = Schema.Struct({
  requests: Schema.Array(PendingRequest).pipe(Schema.maxItems(MAX_PENDING_REQUESTS)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type PendingRequestList = typeof PendingRequestList.Type;

export const PendingRequestFailure = Schema.Struct({
  code: Schema.Literal("invalid", "unauthorized", "unavailable"),
  message: Schema.NonEmptyTrimmedString,
}).annotations(strict);
export type PendingRequestFailure = typeof PendingRequestFailure.Type;

export const decodePendingRequest = Schema.decodeUnknownSync(PendingRequest);
export const decodePendingRequestList = Schema.decodeUnknownSync(PendingRequestList);
export const decodePendingRequestFailure = Schema.decodeUnknownSync(PendingRequestFailure);
