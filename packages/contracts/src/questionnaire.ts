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
const Question = Schema.Struct({
  id: Id,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024)),
  selection: Schema.Literal("single", "multiple"),
  options: Schema.Array(Option).pipe(Schema.minItems(1), Schema.maxItems(8)),
  minSelections: Schema.optional(ChoiceCount),
  maxSelections: Schema.optional(ChoiceCount),
  allowCustom: Schema.optional(Schema.Boolean),
})
  .annotations(strict)
  .pipe(
    Schema.filter((question) => {
      const min = question.minSelections ?? 1;
      const max =
        question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length);
      return (
        new Set(question.options.map((option) => option.id)).size === question.options.length &&
        min <= max &&
        max <= question.options.length &&
        (question.selection !== "single" || max === 1)
      );
    }),
  );

export const Questionnaire = Schema.Struct({
  /** Absent preserves the app-owned form's existing optional comment. */
  allowComment: Schema.optional(Schema.Boolean),
  questions: Schema.Array(Question).pipe(Schema.minItems(1), Schema.maxItems(4)),
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

export const QuestionnaireResponse = Schema.Struct({
  version: Schema.Literal(1),
  answers: Schema.Array(
    Schema.Struct({
      questionId: Id,
      selectedOptionIds: Schema.Array(Id).pipe(Schema.maxItems(8)),
      customAnswer: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
    }).annotations(strict),
  ).pipe(Schema.minItems(1), Schema.maxItems(4)),
  comment: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
}).annotations(strict);
export type QuestionnaireResponse = typeof QuestionnaireResponse.Type;
