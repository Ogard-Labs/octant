import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import { AgentRunId, AgentRunParentThreadId, AgentRunRole } from "./agentRun";
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
import { ProviderInstanceId, ProviderModelId } from "./providers";
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
/** One line of context the person needs to choose; a card shows it as a short paragraph. */
export const MAX_TURN_DECISION_WHY_LENGTH = 240;
/** The consequence or tradeoff of one option, one line under its button. */
export const MAX_TURN_DECISION_OPTION_DETAIL_LENGTH = 80;

export const TurnDecisionAskText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_ASK_LENGTH),
);
export const TurnDecisionOptionText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_OPTION_LENGTH),
);
export const TurnDecisionWhyText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_WHY_LENGTH),
);
export const TurnDecisionOptionDetailText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_OPTION_DETAIL_LENGTH),
);

/**
 * The options a decision offers, in the order the agent gave them, exactly one
 * of them recommended. An option is the text of the next turn, never an
 * action: picking one sends it to the agent and does nothing else.
 */
export const TurnDecisionOptions = Schema.Array(
  Schema.Struct({
    label: TurnDecisionOptionText,
    recommended: Schema.Boolean,
    detail: Schema.optional(TurnDecisionOptionDetailText),
  }).annotations(strict),
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

/** A reviewer's reason is one short sentence beside the option it backs. */
export const MAX_TURN_DECISION_REVIEW_REASON_LENGTH = 100;
export const TurnDecisionReviewReasonText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_TURN_DECISION_REVIEW_REASON_LENGTH),
  Schema.pattern(/^[^\r\n]+$/),
);

/** The model that asked: the asking turn's provider account and model. */
export const TurnDecisionAskedBy = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
}).annotations(strict);
export type TurnDecisionAskedBy = typeof TurnDecisionAskedBy.Type;

/**
 * A second opinion on one decision, from the model the person chose. It is
 * advisory: it never answers the decision or changes its options. `pending`
 * is queued or running; the other non-reviewed states say the opinion will not
 * come, so a card can stop waiting. Absent when no second opinion is chosen or
 * the chosen account cannot be asked right now.
 */
export const TurnDecisionReview = Schema.Union(
  Schema.Struct({ status: Schema.Literal("pending") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("reviewed"),
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    providerName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    /** The reviewer account's driver, so a card can draw its provider mark. */
    driverKind: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64))),
    backs: TurnDecisionOptionText,
    reason: TurnDecisionReviewReasonText,
    reviewedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("withheld") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("failed") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("not-allowed") }).annotations(strict),
);
export type TurnDecisionReview = typeof TurnDecisionReview.Type;

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
  deferralKey: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))),
  deferredUntil: Schema.optional(UtcTimestamp),
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

/** A subagent's task, cut to what a row can name it by. */
export const MAX_CHILD_PENDING_REQUEST_TASK_LENGTH = 200;

/**
 * A subagent waiting on the person. It exists so the request can be found from
 * anywhere in the window, not so it can be answered there: there is no
 * `answer` and no `options`. The answer stays in the parent thread's Agents
 * tab, through the harness session's own route, which keeps an approval
 * covering that one request.
 */
const ChildPendingRequestFields = {
  ...PendingRequestFields,
  /**
   * Work or Code only: those are the modes whose threads have an Agents tab to
   * answer in. A Chat thread has no dock, so a row for its subagent would send
   * the person to a place with nothing to answer.
   */
  mode: Schema.Literal("work", "code"),
  projectId: Schema.optional(ProjectId),
  /** The parent thread the subagent works under. */
  threadId: AgentRunParentThreadId,
  child: Schema.Struct({
    runId: AgentRunId,
    role: AgentRunRole,
    task: Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(MAX_CHILD_PENDING_REQUEST_TASK_LENGTH),
    ),
    providerName: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128))),
    modelId: Schema.optional(ProviderModelId),
  }).annotations(strict),
  text: Schema.NonEmptyTrimmedString,
} as const;

const isWorkRequestText = Schema.is(WorkRequestSanitizedText);
const isCodeApprovalText = Schema.is(CodeApprovalSummaryText);
const isCodeQuestionText = Schema.is(CodeQuestionPromptText);

/**
 * A subagent row is never looser than the parent mode's own rows: Work text and
 * the delegated task are Work's sanitized request text, with no path or URL,
 * and Code text keeps the byte bound of a Code approval summary or question
 * prompt (a Code task is shown as written).
 */
const childTextKeepsModeBounds = (request: {
  readonly mode: "work" | "code";
  readonly kind: "child-approval" | "child-question";
  readonly text: string;
  readonly child: { readonly task: string };
}): boolean =>
  request.mode === "work"
    ? isWorkRequestText(request.text) && isWorkRequestText(request.child.task)
    : request.kind === "child-approval"
      ? isCodeApprovalText(request.text)
      : isCodeQuestionText(request.text);

/**
 * The lead's own native-harness approval waiting on the person. Like a
 * subagent's row it exists so the request can be found from anywhere in the
 * window, not so it can be answered there: there is no `answer` and no
 * `options`. The answer is the thread's inline approval card, through the
 * harness session's own route, which checks the window and the principal
 * before anything is decided.
 *
 * `lostInRestart` marks an approval the journal still holds as pending but no
 * running turn is waiting on, as after a host restart. Nothing can run for it;
 * resuming the session settles it, and the lead asks again if it still needs
 * the call.
 */
const LeadApprovalFields = {
  ...PendingRequestFields,
  mode: Schema.Literal("chat", "work", "code"),
  kind: Schema.Literal("lead-approval"),
  /** Absent for a Chat thread filed under no Project. */
  projectId: Schema.optional(ProjectId),
  threadId: AgentRunParentThreadId,
  text: Schema.NonEmptyTrimmedString,
  lostInRestart: Schema.optional(Schema.Literal(true)),
} as const;

/** A harness approval summary is at most this long, in every mode. */
const MAX_LEAD_APPROVAL_TEXT_LENGTH = 240;

/**
 * A lead approval row is never looser than the mode's own rows: Work text is
 * Work's sanitized request text, with no path or URL, Code keeps the byte
 * bound of a Code approval summary, and Chat keeps the harness summary bound.
 */
const leadTextKeepsModeBounds = (request: {
  readonly mode: "chat" | "work" | "code";
  readonly text: string;
}): boolean =>
  request.mode === "work"
    ? isWorkRequestText(request.text)
    : request.mode === "code"
      ? isCodeApprovalText(request.text)
      : request.text.length <= MAX_LEAD_APPROVAL_TEXT_LENGTH;

/**
 * A Work thread's lead waiting on its own `ask-user` question. Like the lead's
 * approval, the row finds the question and cannot answer it: there is no
 * `answer` and no `options`. The thread's inline question card answers it
 * through the harness session's own route, which checks the window and the
 * principal first. Work only: a Code lead's question goes through Code's inline
 * question path and is listed as a Code question, and a Chat lead's question
 * parks the Chat attempt and is listed as a Chat question, each with its own
 * answer handle. A question a restart left behind reaches no turn and is never
 * listed, so there is no `lostInRestart`. The text is Work's sanitized request
 * text, with no path or URL.
 */
const LeadQuestionFields = {
  ...PendingRequestFields,
  mode: Schema.Literal("work"),
  kind: Schema.Literal("lead-question"),
  projectId: ProjectId,
  threadId: WorkThreadId,
  text: WorkRequestSanitizedText,
} as const;

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
    mode: Schema.Literal("work"),
    kind: Schema.Literal("decision"),
    projectId: ProjectId,
    threadId: WorkThreadId,
    text: TurnDecisionAskText,
    why: Schema.optional(TurnDecisionWhyText),
    urgent: Schema.optional(Schema.Boolean),
    options: TurnDecisionOptions,
    askedBy: Schema.optional(TurnDecisionAskedBy),
    review: Schema.optional(TurnDecisionReview),
    answer: WorkPendingDecisionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("decision"),
    text: TurnDecisionAskText,
    why: Schema.optional(TurnDecisionWhyText),
    urgent: Schema.optional(Schema.Boolean),
    options: TurnDecisionOptions,
    askedBy: Schema.optional(TurnDecisionAskedBy),
    review: Schema.optional(TurnDecisionReview),
    answer: CodePendingDecisionAnswer,
  })
    .annotations(strict)
    .pipe(Schema.filter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...ChildPendingRequestFields,
    kind: Schema.Literal("child-approval"),
  })
    .annotations(strict)
    .pipe(Schema.filter(childTextKeepsModeBounds, { jsonSchema: {} })),
  Schema.Struct({
    ...ChildPendingRequestFields,
    kind: Schema.Literal("child-question"),
  })
    .annotations(strict)
    .pipe(Schema.filter(childTextKeepsModeBounds, { jsonSchema: {} })),
  Schema.Struct(LeadApprovalFields)
    .annotations(strict)
    .pipe(Schema.filter(leadTextKeepsModeBounds, { jsonSchema: {} })),
  Schema.Struct(LeadQuestionFields).annotations(strict),
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
).annotations(personDecides);
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

/** Attention only. No answer, authority or question text is journaled here. */
export const PendingQuestionDeferral = Schema.Struct({
  key: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  until: Schema.NullOr(UtcTimestamp),
}).annotations(strict);
export type PendingQuestionDeferral = typeof PendingQuestionDeferral.Type;

/**
 * What a decision's second opinion settled on, as journaled. An account that
 * could not be asked (off, at its limit, removed) or a call that timed out is
 * never journaled: nothing was learned, so a later read asks again.
 */
export const DecisionReviewOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("reviewed"),
    backs: TurnDecisionOptionText,
    reason: TurnDecisionReviewReasonText,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("withheld") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("failed") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("not-allowed") }).annotations(strict),
);
export type DecisionReviewOutcome = typeof DecisionReviewOutcome.Type;

/** `decision-review.recorded@1`: keyed like a decision's deferral, so it names the turn that asked. */
export const DecisionReviewRecorded = Schema.Struct({
  key: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  reviewedAt: UtcTimestamp,
  outcome: DecisionReviewOutcome,
}).annotations(strict);
export type DecisionReviewRecorded = typeof DecisionReviewRecorded.Type;
