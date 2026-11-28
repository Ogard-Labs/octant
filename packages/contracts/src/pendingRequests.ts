import { personDecides } from "./hostAnswer";
import { GuidString, NonEmptyTrimmedString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

export const TurnDecisionAskText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TURN_DECISION_ASK_LENGTH),
);
export const TurnDecisionOptionText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TURN_DECISION_OPTION_LENGTH),
);
export const TurnDecisionWhyText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TURN_DECISION_WHY_LENGTH),
);
export const TurnDecisionOptionDetailText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TURN_DECISION_OPTION_DETAIL_LENGTH),
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
  }),
).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_TURN_DECISION_OPTIONS),
  Schema.makeFilter(
    (options) =>
      options.filter((option) => option.recommended).length === 1 &&
      new Set(options.map((option) => option.label)).size === options.length,
    { message: "A decision recommends exactly one of its distinct options." },
  ),
);
export type TurnDecisionOptions = typeof TurnDecisionOptions.Type;

/** A reviewer's reason is one short sentence beside the option it backs. */
export const MAX_TURN_DECISION_REVIEW_REASON_LENGTH = 100;
export const TurnDecisionReviewReasonText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_TURN_DECISION_REVIEW_REASON_LENGTH),
  Schema.isPattern(/^[^\r\n]+$/),
);

/** The model that asked: the asking turn's provider account and model. */
export const TurnDecisionAskedBy = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
});
export type TurnDecisionAskedBy = typeof TurnDecisionAskedBy.Type;

/**
 * A second opinion on one decision, from the model the person chose. It is
 * advisory: it never answers the decision or changes its options. `pending`
 * is queued or running; the other non-reviewed states say the opinion will not
 * come, so a card can stop waiting. Absent when no second opinion is chosen or
 * the chosen account cannot be asked right now.
 */
export const TurnDecisionReview = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("reviewed"),
    providerInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    providerName: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    ),
    /** The reviewer account's driver, so a card can draw its provider mark. */
    driverKind: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64))),
    backs: TurnDecisionOptionText,
    reason: TurnDecisionReviewReasonText,
    reviewedAt: UtcTimestamp,
  }),
  Schema.Struct({ status: Schema.Literal("withheld") }),
  Schema.Struct({ status: Schema.Literal("failed") }),
  Schema.Struct({ status: Schema.Literal("not-allowed") }),
]);
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
  deferralKey: Schema.optional(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  deferredUntil: Schema.optional(UtcTimestamp),
  threadTitle: NonEmptyTrimmedString,
  requestedAt: UtcTimestamp,
} as const;

/** `resolve-work-request` / `cancel-work-request` take these two fields. */
export const WorkPendingRequestAnswer = Schema.Struct({
  requestId: WorkRequestId,
  expectedVersion: AggregateVersion,
});
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
});
export type CodePendingApprovalAnswer = typeof CodePendingApprovalAnswer.Type;

/** `answer-provider-input` takes these beside its fresh operation id and response evidence. */
export const CodePendingQuestionAnswer = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  requestId: CodeProviderRequestId,
});
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
});
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
});
export type WorkPendingDecisionAnswer = typeof WorkPendingDecisionAnswer.Type;

/** `answer-chat-turn-question` takes these beside the answer text. */
export const ChatPendingQuestionAnswer = Schema.Struct({
  threadId: AnswerChatTurnQuestionCommand.fields.threadId,
  expectedVersion: AnswerChatTurnQuestionCommand.fields.expectedVersion,
  turnId: AnswerChatTurnQuestionCommand.fields.turnId,
  attemptId: AnswerChatTurnQuestionCommand.fields.attemptId,
  requestId: AnswerChatTurnQuestionCommand.fields.requestId,
});
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
  mode: Schema.Literals(["work", "code"]),
  projectId: Schema.optional(ProjectId),
  /** The parent thread the subagent works under. */
  threadId: AgentRunParentThreadId,
  child: Schema.Struct({
    runId: AgentRunId,
    role: AgentRunRole,
    task: Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(MAX_CHILD_PENDING_REQUEST_TASK_LENGTH),
    ),
    providerName: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
    ),
    modelId: Schema.optional(ProviderModelId),
  }),
  text: NonEmptyTrimmedString,
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
  mode: Schema.Literals(["chat", "work", "code"]),
  kind: Schema.Literal("lead-approval"),
  /** Absent for a Chat thread filed under no Project. */
  projectId: Schema.optional(ProjectId),
  threadId: AgentRunParentThreadId,
  text: NonEmptyTrimmedString,
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

export const PendingRequest = Schema.Union([
  Schema.Struct({ ...WorkPendingRequestFields, kind: Schema.Literal("approval") }),
  Schema.Struct({
    ...WorkPendingRequestFields,
    kind: Schema.Literal("question"),
    options: Schema.Array(Schema.Struct({ label: WorkRequestSanitizedText })).check(
      Schema.isMaxLength(MAX_WORK_REQUEST_OPTIONS),
    ),
    /** The question asks for a secret; only the thread's masked field answers it. */
    secret: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("approval"),
    text: CodeApprovalSummaryText,
    /**
     * The site a Browser call is waiting to open. Present only on a Browser
     * site ask, so a client can tell it from a provider's own tool approval
     * and never offer a site answer for a more powerful action.
     */
    browserOrigin: Schema.optional(
      Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
    ),
    answer: CodePendingApprovalAnswer,
  }).check(Schema.makeFilter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...CodePendingRequestFields,
    kind: Schema.Literal("question"),
    text: CodeQuestionPromptText,
    options: Schema.Array(Schema.Struct({ label: CodeQuestionOptionText })).check(
      Schema.isMaxLength(MAX_CODE_QUESTION_OPTIONS),
    ),
    /**
     * The question asks for a secret. The row finds it and leaves the answer
     * to the thread's masked field, so no list answers it as evidence.
     */
    secret: Schema.optional(Schema.Literal(true)),
    answer: CodePendingQuestionAnswer,
  }).check(Schema.makeFilter(sameThread, { jsonSchema: {} })),
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
  }).check(Schema.makeFilter(sameThread, { jsonSchema: {} })),
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
  }).check(Schema.makeFilter(sameThread, { jsonSchema: {} })),
  Schema.Struct({
    ...ChildPendingRequestFields,
    kind: Schema.Literal("child-approval"),
  }).check(Schema.makeFilter(childTextKeepsModeBounds, { jsonSchema: {} })),
  Schema.Struct({
    ...ChildPendingRequestFields,
    kind: Schema.Literal("child-question"),
  }).check(Schema.makeFilter(childTextKeepsModeBounds, { jsonSchema: {} })),
  Schema.Struct(LeadApprovalFields).check(
    Schema.makeFilter(leadTextKeepsModeBounds, { jsonSchema: {} }),
  ),
  Schema.Struct(LeadQuestionFields),
  Schema.Struct({
    ...PendingRequestFields,
    mode: Schema.Literal("chat"),
    kind: Schema.Literal("question"),
    /** Absent for a Chat thread filed under no Project. */
    projectId: Schema.optional(ProjectId),
    threadId: ChatThreadId,
    text: ChatAttemptQuestion.fields.prompt,
    options: ChatAttemptQuestion.fields.options,
    /** The question asks for a secret; only the thread's masked field answers it. */
    secret: Schema.optional(Schema.Literal(true)),
    answer: ChatPendingQuestionAnswer,
  }).check(Schema.makeFilter(sameThread, { jsonSchema: {} })),
]).annotate(personDecides);
export type PendingRequest = typeof PendingRequest.Type;

export const MAX_PENDING_REQUESTS = 128;

/** One line a row shows for a waiting ask. */
export const MAX_WAITING_ASK_TEXT_LENGTH = 300;
/** What the ask's own card shows under that line, when all of it fits. */
export const MAX_WAITING_ASK_DETAIL_LENGTH = 4_000;

/**
 * Which host service holds the ask, and so which of its own routes answers
 * it: an MCP or connector tool approval, a Project memory proposal, a routine
 * proposal or change request, a service offer, a Browser
 * site, upload, download or script approval, or the Browser sign-in card.
 */
export const WaitingAskKind = Schema.Literals([
  "tool-approval",
  "memory-proposal",
  "routine-proposal",
  "image-offer",
  "service-offer",
  "browser-approval",
  "browser-sign-in",
]);
export type WaitingAskKind = typeof WaitingAskKind.Type;

/** Opt in to shared offer rows without breaking older clients' closed ask-kind list. */
export const PENDING_REQUEST_SERVICE_OFFERS_MEDIA_TYPE =
  "application/vnd.octant.service-offers+json";

/**
 * An ask a thread's agent raised outside its provider's own approvals and
 * questions, waiting on the person with no expiry. The row finds it and names
 * its thread; `askId` is the id the ask's own decide route takes, and that
 * route alone checks who may answer. Listing an ask grants nothing.
 *
 * `text` and `detail` are the host's own words about the ask, built from the
 * view the ask's card in the thread already shows the same reader, so a row
 * holds nothing its thread does not. `inPlace` says `text` and `detail`
 * together are everything that card shows, so a list may offer the card's
 * plain approve and decline; without it the person must open the thread,
 * because approving from less than the ask means is never offered.
 */
export const WaitingAsk = Schema.Struct({
  kind: WaitingAskKind,
  askId: GuidString,
  mode: Schema.Literals(["chat", "work", "code"]),
  /** Absent for a Chat thread filed under no Project. */
  projectId: Schema.optional(ProjectId),
  threadId: GuidString,
  threadTitle: NonEmptyTrimmedString,
  requestedAt: UtcTimestamp,
  text: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_WAITING_ASK_TEXT_LENGTH)),
  detail: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_WAITING_ASK_DETAIL_LENGTH)),
  ),
  inPlace: Schema.optional(Schema.Literal(true)),
}).annotate(personDecides);
export type WaitingAsk = typeof WaitingAsk.Type;

/**
 * Every pending request the window can answer, oldest waiting first. A
 * decision waits from the moment its turn ended. A host
 * holding more than the bound returns the oldest ones and says so with
 * `truncated`, so a reader never mistakes a cut list for the whole.
 *
 * `asks` is every other waiting ask the reader could answer, oldest first. It
 * is its own optional field, not more members of `requests`, so a client
 * built before it keeps decoding the list and simply shows no such rows. The
 * services that hold asks cap them at 32 each, well inside the bound.
 */
export const PendingRequestList = Schema.Struct({
  requests: Schema.Array(PendingRequest).check(Schema.isMaxLength(MAX_PENDING_REQUESTS)),
  truncated: Schema.Boolean,
  asks: Schema.optional(Schema.Array(WaitingAsk).check(Schema.isMaxLength(MAX_PENDING_REQUESTS))),
  offerHostRun: Schema.optional(GuidString),
});
export type PendingRequestList = typeof PendingRequestList.Type;

export const PendingRequestFailure = Schema.Struct({
  code: Schema.Literals(["invalid", "unauthorized", "unavailable"]),
  message: NonEmptyTrimmedString,
});
export type PendingRequestFailure = typeof PendingRequestFailure.Type;

export const decodePendingRequest = Schema.decodeUnknownSync(PendingRequest, STRICT_DECODE_OPTIONS);
export const decodePendingRequestList = Schema.decodeUnknownSync(
  PendingRequestList,
  STRICT_DECODE_OPTIONS,
);
export const decodeWaitingAsk = Schema.decodeUnknownSync(WaitingAsk, STRICT_DECODE_OPTIONS);
export const decodePendingRequestFailure = Schema.decodeUnknownSync(
  PendingRequestFailure,
  STRICT_DECODE_OPTIONS,
);

/** Attention only. No answer, authority or question text is journaled here. */
export const PendingQuestionDeferral = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  until: Schema.NullOr(UtcTimestamp),
});
export type PendingQuestionDeferral = typeof PendingQuestionDeferral.Type;

/**
 * What a decision's second opinion settled on, as journaled. An account that
 * could not be asked (off, at its limit, removed) or a call that timed out is
 * never journaled: nothing was learned, so a later read asks again.
 */
export const DecisionReviewOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reviewed"),
    backs: TurnDecisionOptionText,
    reason: TurnDecisionReviewReasonText,
  }),
  Schema.Struct({ kind: Schema.Literal("withheld") }),
  Schema.Struct({ kind: Schema.Literal("failed") }),
  Schema.Struct({ kind: Schema.Literal("not-allowed") }),
]);
export type DecisionReviewOutcome = typeof DecisionReviewOutcome.Type;

/** `decision-review.recorded@1`: keyed like a decision's deferral, so it names the turn that asked. */
export const DecisionReviewRecorded = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  reviewedAt: UtcTimestamp,
  outcome: DecisionReviewOutcome,
});
export type DecisionReviewRecorded = typeof DecisionReviewRecorded.Type;
