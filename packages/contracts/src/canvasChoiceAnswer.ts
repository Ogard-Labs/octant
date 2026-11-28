import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

const QuestionId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const OptionId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const SequenceNumber = NonNegativeInt;

/** What of a question's definition an answer was made against; see the domain's fingerprint. */
export const CanvasChoiceQuestionFingerprint = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(64),
);

const answerFields = {
  blockId: CanvasBlockId,
  questionId: QuestionId,
  questionFingerprint: CanvasChoiceQuestionFingerprint,
  /** Empty when the answer is written. */
  selectedOptionIds: Schema.Array(OptionId).check(Schema.isMaxLength(8)),
  customAnswer: Schema.optional(QuestionnaireAnswerText.check(Schema.isMaxLength(2_000))),
  note: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_CANVAS_CHOICE_NOTE_LENGTH)),
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
    Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))).check(
      Schema.isMaxLength(8),
    ),
  ),
  author: CanvasActor,
  answeredAt: UtcTimestamp,
});
export type CanvasChoiceAnswer = typeof CanvasChoiceAnswer.Type;

// ── Journal events ───────────────────────────────────────────────────────────

export const CANVAS_CHOICE_ANSWER_SET = "canvas.choice-answer-set@1";
export const CANVAS_CHOICE_ANSWER_CLEARED = "canvas.choice-answer-cleared@1";

export const CanvasChoiceAnswerSet = Schema.Struct({
  canvasId: CanvasId,
  answer: CanvasChoiceAnswer,
  sequence: PositiveInt,
});
export type CanvasChoiceAnswerSet = typeof CanvasChoiceAnswerSet.Type;

export const CanvasChoiceAnswerCleared = Schema.Struct({
  canvasId: CanvasId,
  blockId: CanvasBlockId,
  questionId: QuestionId,
  clearedBy: CanvasActor,
  clearedAt: UtcTimestamp,
  sequence: PositiveInt,
});
export type CanvasChoiceAnswerCleared = typeof CanvasChoiceAnswerCleared.Type;

export const CanvasChoiceAnswerEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("set"), event: CanvasChoiceAnswerSet }),
  Schema.Struct({
    kind: Schema.Literal("cleared"),
    event: CanvasChoiceAnswerCleared,
  }),
]);
export type CanvasChoiceAnswerEvent = typeof CanvasChoiceAnswerEvent.Type;

// ── Command ──────────────────────────────────────────────────────────────────

/** One change; the host names the author and the time, so a request never carries either. */
export const CanvasChoiceAnswerChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("set"), ...answerFields }),
  Schema.Struct({
    kind: Schema.Literal("clear"),
    blockId: CanvasBlockId,
    questionId: QuestionId,
    /** The question as the window drew it, so a window showing an old question cannot erase the answer to its revision. */
    questionFingerprint: CanvasChoiceQuestionFingerprint,
  }),
]);
export type CanvasChoiceAnswerChange = typeof CanvasChoiceAnswerChange.Type;

/**
 * Changes to a form's answers, applied together or not at all: one pick is a
 * list of one, and accepting every recommendation is a list of many.
 */
export const CanvasChoiceAnswersReviseCommand = Schema.Struct({
  kind: Schema.Literal("canvas-choice-answers-revise"),
  canvasId: CanvasId,
  expectedSequence: SequenceNumber,
  changes: Schema.Array(CanvasChoiceAnswerChange).check(Schema.isMinLength(1)),
});
export type CanvasChoiceAnswersReviseCommand = typeof CanvasChoiceAnswersReviseCommand.Type;

// ── Reads and results ────────────────────────────────────────────────────────

const Reason = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024));

/** The saved answers at one sequence; `unauthorized` carries none. */
export const CanvasChoiceAnswersOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    canvasId: CanvasId,
    sequence: SequenceNumber,
    answers: Schema.Array(CanvasChoiceAnswer),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: Reason,
  }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }),
]);
export type CanvasChoiceAnswersOutcome = typeof CanvasChoiceAnswersOutcome.Type;

export const CanvasChoiceAnswerDenialCode = Schema.Literals([
  "malformed-request",
  "stale-version",
  "unauthorized",
  "unavailable",
  "unknown-question",
  "question-changed",
  "invalid-answer",
]);
export type CanvasChoiceAnswerDenialCode = typeof CanvasChoiceAnswerDenialCode.Type;

export const CanvasChoiceAnswersReviseResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("accepted"),
    canvasId: CanvasId,
    sequence: PositiveInt,
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasChoiceAnswerDenialCode,
    message: Reason,
  }),
]);
export type CanvasChoiceAnswersReviseResult = typeof CanvasChoiceAnswersReviseResult.Type;

export const decodeCanvasChoiceAnswerEvent = Schema.decodeUnknownSync(
  CanvasChoiceAnswerEvent,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasChoiceAnswersOutcome = Schema.decodeUnknownSync(
  CanvasChoiceAnswersOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasChoiceAnswersReviseResult = Schema.decodeUnknownSync(
  CanvasChoiceAnswersReviseResult,
  STRICT_DECODE_OPTIONS,
);
