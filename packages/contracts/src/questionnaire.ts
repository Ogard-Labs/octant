import { Schema } from "effect";
import { personDecides } from "./hostAnswer";

const Id = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const ChoiceCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 }));
export const MAX_QUESTIONNAIRE_ANSWER_LENGTH = 16_384;
export const QuestionnaireAnswerText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_QUESTIONNAIRE_ANSWER_LENGTH),
);
/**
 * The longest answer to a provider question that asks for a secret the host
 * passes on, as a one-use credential card's token. Every surface's secret
 * answer is carried as a plain string the host checks against this, so a
 * decode failure never prints the value.
 */
export const MAX_SECRET_ANSWER_LENGTH = 4096;
const Option = Schema.Struct({
  id: Id,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  description: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512))),
  recommended: Schema.optional(Schema.Boolean),
});
const questionFields = {
  id: Id,
  prompt: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  selection: Schema.Literals(["single", "multiple"]),
  options: Schema.Array(Option).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
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
export const QuestionnaireQuestion = Schema.Struct(questionFields).check(
  Schema.makeFilter(questionHoldsItsLimits),
);

/** At most this long a note may be, on a Canvas question that takes one. */
export const MAX_CANVAS_CHOICE_NOTE_LENGTH = 2_000;

/**
 * One question of a Canvas choice block: the inline question plus `allowNote`,
 * which a Canvas form offers and an inline card does not.
 */
export const CanvasChoiceQuestion = Schema.Struct({
  ...questionFields,
  allowNote: Schema.optional(Schema.Boolean),
}).check(Schema.makeFilter(questionHoldsItsLimits));
export type CanvasChoiceQuestion = typeof CanvasChoiceQuestion.Type;

export type QuestionnaireQuestion = typeof QuestionnaireQuestion.Type;
export const MAX_QUESTIONNAIRE_QUESTIONS = 4;

/**
 * The questions of a Canvas choice block. A Canvas is a page, so a form on it
 * has no count of its own: a long decision list is the case it exists for.
 * Only the inline questionnaire, which interrupts a conversation, stays at
 * {@link MAX_QUESTIONNAIRE_QUESTIONS}.
 */
export const CanvasChoiceQuestions = Schema.Array(CanvasChoiceQuestion).check(
  Schema.isMinLength(1),
  Schema.makeFilter(
    (questions) => new Set(questions.map((question) => question.id)).size === questions.length,
    { message: "Question ids must be distinct." },
  ),
);

export const Questionnaire = Schema.Struct({
  /** Absent preserves the app-owned form's existing optional comment. */
  allowComment: Schema.optional(Schema.Boolean),
  questions: Schema.Array(QuestionnaireQuestion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_QUESTIONNAIRE_QUESTIONS),
  ),
})
  .check(
    Schema.makeFilter(
      ({ questions }) =>
        new Set(questions.map((question) => question.id)).size === questions.length,
    ),
  )
  .annotate(personDecides);
export type Questionnaire = typeof Questionnaire.Type;

const QuestionnaireAnswer = Schema.Struct({
  questionId: Id,
  selectedOptionIds: Schema.Array(Id).check(Schema.isMaxLength(8)),
  customAnswer: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  ),
});

const ResponseComment = Schema.optional(
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
);

export const QuestionnaireResponse = Schema.Struct({
  version: Schema.Literal(1),
  answers: Schema.Array(QuestionnaireAnswer).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  comment: ResponseComment,
});
export type QuestionnaireResponse = typeof QuestionnaireResponse.Type;

/** A Canvas choice answer: one entry per question, however many the block asks. */
export const CanvasChoiceResponse = Schema.Struct({
  version: Schema.Literal(1),
  answers: Schema.Array(QuestionnaireAnswer).check(Schema.isMinLength(1)),
  comment: ResponseComment,
});
