import { Schema } from "effect";
import {
  MAX_QUESTIONNAIRE_ANSWER_LENGTH,
  QuestionnaireResponse,
  type Questionnaire,
} from "@octant/contracts";

/** Validate against the exact ask before any answer can settle its request. */
export function validateQuestionnaireAnswer(
  questionnaire: Questionnaire,
  text: string,
):
  | { readonly status: "valid"; readonly response: QuestionnaireResponse }
  | { readonly status: "invalid"; readonly message: string } {
  const invalid = {
    status: "invalid" as const,
    message:
      "Answer each question using its offered choices or a written alternative, within the selection limits.",
  };
  if (text.length > MAX_QUESTIONNAIRE_ANSWER_LENGTH) return invalid;
  let response: QuestionnaireResponse;
  try {
    response = Schema.decodeUnknownSync(QuestionnaireResponse)(JSON.parse(text));
  } catch {
    return invalid;
  }
  if (
    response.answers.length !== questionnaire.questions.length ||
    new Set(response.answers.map((answer) => answer.questionId)).size !== response.answers.length
  )
    return invalid;
  for (const question of questionnaire.questions) {
    const answer = response.answers.find((entry) => entry.questionId === question.id);
    if (answer === undefined) return invalid;
    const selected = answer.selectedOptionIds;
    if (
      new Set(selected).size !== selected.length ||
      selected.some((id) => !question.options.some((option) => option.id === id))
    )
      return invalid;
    if (answer.customAnswer !== undefined) {
      if (question.allowCustom === false || selected.length !== 0) return invalid;
    } else if (
      selected.length < (question.minSelections ?? 1) ||
      selected.length >
        (question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length))
    )
      return invalid;
  }
  return { status: "valid", response };
}
