import { Schema } from "effect";
import { AnswerChatTurnQuestionCommand, ChatAttemptQuestion, ChatThreadId } from "./chat";
import { CodeApprovalId, CodeCheckoutId, CodeThreadId } from "./code";
import {
  CodeApprovalSummaryText,
  CodeProviderRequestId,
  CodeQuestionOptionText,
  CodeQuestionPromptText,
  MAX_CODE_QUESTION_OPTIONS,
} from "./codeOperations";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ProjectId } from "./projects";
import { MAX_WORK_REQUEST_OPTIONS, WorkRequestId, WorkRequestSanitizedText } from "./workRequests";
import { WorkThreadId } from "./workThreads";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * One approval or question a provider is waiting on, in a thread the reading
 * window can already open, in a mode it can already use. Each mode keeps its
 * own text bounds and sanitization: an item is never looser than the record it
 * was read from. `answer` carries exactly what that mode's existing answer
 * command needs beyond the person's answer itself (and, for Code, a fresh
 * operation id), so answering never goes through a new route.
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
    /**
     * The site a Browser call is waiting to open. Present only on a Browser
     * site ask, so a client can tell it from a provider's own tool approval
     * and never offer a site answer for a more powerful action.
     */
    browserOrigin: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2048))),
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
 * Every pending request the window can answer, oldest waiting first. A host
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
