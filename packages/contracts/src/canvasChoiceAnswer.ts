import { Schema } from "effect";
import { CanvasActor, CanvasBlockId, CanvasId } from "./canvasIdentity";
import { UtcTimestamp } from "./events";
import { MAX_CANVAS_CHOICE_NOTE_LENGTH, QuestionnaireAnswerText } from "./questionnaire";

// ── Saved answers to a Canvas decision form ──────────────────────────────────
//
// A person's answers to a choice block are journaled facts of one
// `canvas-choice-answers` aggregate per Canvas, never part of a Canvas
// version: a version for each pick would put dozens of versions in the history
// of one sitting and would race an agent's revision for the head sequence. The
// block still holds only the questions.

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const QuestionId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const OptionId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const SequenceNumber = Schema.Int.pipe(Schema.nonNegative());

/** What of a question's definition an answer was made against; see the domain's fingerprint. */
export const CanvasChoiceQuestionFingerprint = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
);

const answerFields = {
  blockId: CanvasBlockId,
  questionId: QuestionId,
  questionFingerprint: CanvasChoiceQuestionFingerprint,
  /** Empty when the answer is written. */
  selectedOptionIds: Schema.Array(OptionId).pipe(Schema.maxItems(8)),
  customAnswer: Schema.optional(QuestionnaireAnswerText.pipe(Schema.maxLength(2_000))),
  note: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_CANVAS_CHOICE_NOTE_LENGTH)),
  ),
  /** Set when the person accepted the agent's recommendation; cleared by changing the answer. */
  acceptedRecommendation: Schema.optional(Schema.Boolean),
};

/** One saved answer, as stored and as the form reads it back. */
export const CanvasChoiceAnswer = Schema.Struct({
  ...answerFields,
  /**
   * The labels of the chosen options as the person saw them, in the question's
   * order. The host writes them when it admits the answer, so an option an
   * agent later rewords never puts new words in the person's mouth.
   */
  selectedLabels: Schema.optional(
    Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))).pipe(Schema.maxItems(8)),
  ),
  author: CanvasActor,
  answeredAt: UtcTimestamp,
}).annotations(strict);
export type CanvasChoiceAnswer = typeof CanvasChoiceAnswer.Type;

// ── Journal events ───────────────────────────────────────────────────────────

export const CANVAS_CHOICE_ANSWER_SET = "canvas.choice-answer-set@1";
export const CANVAS_CHOICE_ANSWER_CLEARED = "canvas.choice-answer-cleared@1";

export const CanvasChoiceAnswerSet = Schema.Struct({
  canvasId: CanvasId,
  answer: CanvasChoiceAnswer,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasChoiceAnswerSet = typeof CanvasChoiceAnswerSet.Type;

export const CanvasChoiceAnswerCleared = Schema.Struct({
  canvasId: CanvasId,
  blockId: CanvasBlockId,
  questionId: QuestionId,
  clearedBy: CanvasActor,
  clearedAt: UtcTimestamp,
  sequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type CanvasChoiceAnswerCleared = typeof CanvasChoiceAnswerCleared.Type;

export const CanvasChoiceAnswerEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("set"), event: CanvasChoiceAnswerSet }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cleared"),
    event: CanvasChoiceAnswerCleared,
  }).annotations(strict),
);
export type CanvasChoiceAnswerEvent = typeof CanvasChoiceAnswerEvent.Type;

// ── Command ──────────────────────────────────────────────────────────────────

/** One change; the host names the author and the time, so a request never carries either. */
export const CanvasChoiceAnswerChange = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("set"), ...answerFields }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("clear"),
    blockId: CanvasBlockId,
    questionId: QuestionId,
    /** The question as the window drew it, so a window showing an old question cannot erase the answer to its revision. */
    questionFingerprint: CanvasChoiceQuestionFingerprint,
  }).annotations(strict),
);
export type CanvasChoiceAnswerChange = typeof CanvasChoiceAnswerChange.Type;

/**
 * Changes to a form's answers, applied together or not at all: one pick is a
 * list of one, and accepting every recommendation is a list of many.
 */
export const CanvasChoiceAnswersReviseCommand = Schema.Struct({
  kind: Schema.Literal("canvas-choice-answers-revise"),
  canvasId: CanvasId,
  expectedSequence: SequenceNumber,
  changes: Schema.Array(CanvasChoiceAnswerChange).pipe(Schema.minItems(1)),
}).annotations(strict);
export type CanvasChoiceAnswersReviseCommand = typeof CanvasChoiceAnswersReviseCommand.Type;

// ── Reads and results ────────────────────────────────────────────────────────

const Reason = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024));

/** The saved answers at one sequence; `unauthorized` carries none. */
export const CanvasChoiceAnswersOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    canvasId: CanvasId,
    sequence: SequenceNumber,
    answers: Schema.Array(CanvasChoiceAnswer),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: Reason,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }).annotations(strict),
);
export type CanvasChoiceAnswersOutcome = typeof CanvasChoiceAnswersOutcome.Type;

export const CanvasChoiceAnswerDenialCode = Schema.Literal(
  "malformed-request",
  "stale-version",
  "unauthorized",
  "unavailable",
  /** The block or question is not in the Canvas's head version. */
  "unknown-question",
  /** The question was revised since the window drew it. */
  "question-changed",
  /** The answer breaks the question's own selection or note rule. */
  "invalid-answer",
);
export type CanvasChoiceAnswerDenialCode = typeof CanvasChoiceAnswerDenialCode.Type;

export const CanvasChoiceAnswersReviseResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    canvasId: CanvasId,
    sequence: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasChoiceAnswerDenialCode,
    message: Reason,
  }).annotations(strict),
);
export type CanvasChoiceAnswersReviseResult = typeof CanvasChoiceAnswersReviseResult.Type;

export const decodeCanvasChoiceAnswerEvent = Schema.decodeUnknownSync(CanvasChoiceAnswerEvent);
export const decodeCanvasChoiceAnswersOutcome = Schema.decodeUnknownSync(
  CanvasChoiceAnswersOutcome,
);
export const decodeCanvasChoiceAnswersReviseResult = Schema.decodeUnknownSync(
  CanvasChoiceAnswersReviseResult,
);
