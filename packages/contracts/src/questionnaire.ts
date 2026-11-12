import { Schema } from "effect";
import { personDecides } from "./hostAnswer";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const Id = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64));
const ChoiceCount = Schema.Int.pipe(Schema.between(0, 8));
export const MAX_QUESTIONNAIRE_ANSWER_LENGTH = 16_384;
export const QuestionnaireAnswerText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_QUESTIONNAIRE_ANSWER_LENGTH),
);
const Option = Schema.Struct({
  id: Id,
  label: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  description: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512))),
  recommended: Schema.optional(Schema.Boolean),
}).annotations(strict);
const questionFields = {
  id: Id,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  selection: Schema.Literal("single", "multiple"),
  options: Schema.Array(Option).pipe(Schema.minItems(1), Schema.maxItems(8)),
  minSelections: Schema.optional(ChoiceCount),
  maxSelections: Schema.optional(ChoiceCount),
  allowCustom: Schema.optional(Schema.Boolean),
};

/** The selection limits and distinct options every question keeps, inline or on a Canvas. */
const questionHoldsItsLimits = (question: {
  readonly selection: "single" | "multiple";
  readonly options: ReadonlyArray<{ readonly id: string }>;
  readonly minSelections?: number | undefined;
  readonly maxSelections?: number | undefined;
}): boolean => {
  const min = question.minSelections ?? 1;
  const max =
    question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length);
  return (
    new Set(question.options.map((option) => option.id)).size === question.options.length &&
    min <= max &&
    max <= question.options.length &&
    (question.selection !== "single" || max === 1)
  );
};

/** One question of the inline `ask-user` questionnaire. */
export const QuestionnaireQuestion = Schema.Struct(questionFields)
  .annotations(strict)
  .pipe(Schema.filter(questionHoldsItsLimits));

/** At most this long a note may be, on a Canvas question that takes one. */
export const MAX_CANVAS_CHOICE_NOTE_LENGTH = 2_000;

/**
 * One question of a Canvas choice block: the inline question plus `allowNote`,
 * which a Canvas form offers and an inline card does not.
 */
export const CanvasChoiceQuestion = Schema.Struct({
  ...questionFields,
  allowNote: Schema.optional(Schema.Boolean),
})
  .annotations(strict)
  .pipe(Schema.filter(questionHoldsItsLimits));
export type CanvasChoiceQuestion = typeof CanvasChoiceQuestion.Type;

export type QuestionnaireQuestion = typeof QuestionnaireQuestion.Type;
export const MAX_QUESTIONNAIRE_QUESTIONS = 4;

/**
 * The questions of a Canvas choice block. A Canvas is a page, so a form on it
 * has no count of its own: a long decision list is the case it exists for.
 * Only the inline questionnaire, which interrupts a conversation, stays at
 * {@link MAX_QUESTIONNAIRE_QUESTIONS}.
 */
export const CanvasChoiceQuestions = Schema.Array(CanvasChoiceQuestion).pipe(
  Schema.minItems(1),
  Schema.filter(
    (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
    { message: () => "Question ids must be distinct." },
  ),
);

export const Questionnaire = Schema.Struct({
  /** Absent preserves the app-owned form's existing optional comment. */
  allowComment: Schema.optional(Schema.Boolean),
  questions: Schema.Array(QuestionnaireQuestion).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_QUESTIONNAIRE_QUESTIONS),
  ),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      ({ questions }) =>
        new Set(questions.map((question) => question.id)).size === questions.length,
    ),
  )
  .annotations(personDecides);
export type Questionnaire = typeof Questionnaire.Type;

const QuestionnaireAnswer = Schema.Struct({
  questionId: Id,
  selectedOptionIds: Schema.Array(Id).pipe(Schema.maxItems(8)),
  customAnswer: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
}).annotations(strict);

const ResponseComment = Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)));

export const QuestionnaireResponse = Schema.Struct({
  version: Schema.Literal(1),
  answers: Schema.Array(QuestionnaireAnswer).pipe(Schema.minItems(1), Schema.maxItems(4)),
  comment: ResponseComment,
}).annotations(strict);
export type QuestionnaireResponse = typeof QuestionnaireResponse.Type;

/** A Canvas choice answer: one entry per question, however many the block asks. */
export const CanvasChoiceResponse = Schema.Struct({
  version: Schema.Literal(1),
  answers: Schema.Array(QuestionnaireAnswer).pipe(Schema.minItems(1)),
  comment: ResponseComment,
}).annotations(strict);
