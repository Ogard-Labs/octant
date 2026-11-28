import { Schema } from "effect";
import {
  CanvasChoiceResponse,
  MAX_QUESTIONNAIRE_ANSWER_LENGTH,
  QuestionnaireResponse,
  type Questionnaire,
} from "@octant/contracts";

export type QuestionnaireAnswerValidation =
  | { readonly status: "valid"; readonly response: QuestionnaireResponse }
  | { readonly status: "invalid"; readonly message: string };

/** Validate against the exact ask before any answer can settle its request. */
export function validateQuestionnaireAnswer(
  questionnaire: Questionnaire,
  text: string,
): QuestionnaireAnswerValidation {
  return validateAnswer(
    questionnaire,
    text,
    QuestionnaireResponse,
    MAX_QUESTIONNAIRE_ANSWER_LENGTH,
  );
}

/**
 * Validate a Canvas choice answer under the same per-question rules. The
 * inline ask's answer-count and text-size ceilings belong to a conversation
 * interruption; a Canvas form of any length is answered whole, and the thread's
 * own message limit is what bounds what can be sent.
 */
export function validateCanvasChoiceAnswer(
  questionnaire: Questionnaire,
  text: string,
): QuestionnaireAnswerValidation {
  return validateAnswer(questionnaire, text, CanvasChoiceResponse, undefined);
}

function validateAnswer(
  questionnaire: Questionnaire,
  text: string,
  schema: typeof QuestionnaireResponse | typeof CanvasChoiceResponse,
  maxLength: number | undefined,
): QuestionnaireAnswerValidation {
  const invalid = {
    status: "invalid" as const,
    message:
      "Answer each question using its offered choices or a written alternative, within the selection limits.",
  };
  if (maxLength !== undefined && text.length > maxLength) return invalid;
  let response: QuestionnaireResponse;
  try {
    response = Schema.decodeUnknownSync(schema)(JSON.parse(text));
  } catch {
    return invalid;
  }
  if (
    (questionnaire.allowComment === false && response.comment !== undefined) ||
    response.answers.length !== questionnaire.questions.length ||
    new Set(response.answers.map((answer) => answer.questionId)).size !== response.answers.length
  )
    return invalid;
  for (const question of questionnaire.questions) {
    const answer = response.answers.find((entry) => entry.questionId === question.id);
    if (answer === undefined || !questionAnswerIsAllowed(question, answer)) return invalid;
  }
  return { status: "valid", response };
}

/**
 * Whether one answer obeys its question's own rule: only offered options, each
 * once, at least `minSelections` (default one) and at most `maxSelections`, and
 * a written answer only where the question allows one, standing in for every
 * selection. The inline questionnaire and a Canvas decision form share it.
 */
export function questionAnswerIsAllowed(
  question: Questionnaire["questions"][number],
  answer: {
    readonly selectedOptionIds: ReadonlyArray<string>;
    readonly customAnswer?: string | undefined;
  },
): boolean {
  const selected = answer.selectedOptionIds;
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !question.options.some((option) => option.id === id))
  )
    return false;
  if (answer.customAnswer !== undefined) {
    return question.allowCustom !== false && selected.length === 0;
  }
  return (
    selected.length >= (question.minSelections ?? 1) &&
    selected.length <=
      (question.maxSelections ?? (question.selection === "single" ? 1 : question.options.length))
  );
}

const RECOMMENDED_MARK = "(recommended)";

/**
 * A provider's option label with its recommendation read out. Claude, Codex
 * and OpenCode tell their models to mark the option they recommend by adding
 * "(Recommended)" to its label; the card shows that as its own quiet mark, so
 * the words stay the option's own. A label that is only the mark is kept.
 */
export function optionRecommendation(label: string): {
  readonly label: string;
  readonly recommended: boolean;
} {
  // Plain prefix and suffix checks: a label is model output, and a pattern
  // with whitespace on both sides of the mark took seconds on a label padded
  // with a long run of spaces and tabs.
  const trimmed = label.trim();
  let stripped = trimmed;
  if (stripped.toLowerCase().startsWith(RECOMMENDED_MARK))
    stripped = stripped.slice(RECOMMENDED_MARK.length).trimStart();
  if (stripped.toLowerCase().endsWith(RECOMMENDED_MARK))
    stripped = stripped.slice(0, -RECOMMENDED_MARK.length).trimEnd();
  return stripped.length === 0 || stripped === trimmed
    ? { label, recommended: false }
    : { label: stripped, recommended: true };
}

/**
 * Each question's answer as the words a provider offered, in question order:
 * the chosen options' labels, or the written answer alone. Every provider
 * whose own reply names answers by their text (Claude, Codex, OpenCode, an
 * ACP form) answers a whole set from one validated response with this.
 * `providerValues[question][option]`, when given, is the provider's own word
 * for an option (its label before the card read a recommendation out of it),
 * so the provider gets back exactly the choice it offered.
 */
export function questionnaireAnswerValues(
  questionnaire: Questionnaire,
  response: QuestionnaireResponse,
  providerValues?: ReadonlyArray<ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> {
  return questionnaire.questions.map((question, questionIndex) => {
    const answer = response.answers.find((entry) => entry.questionId === question.id);
    if (answer === undefined) return [];
    if (answer.customAnswer !== undefined) return [answer.customAnswer];
    return question.options.flatMap((option, optionIndex) =>
      answer.selectedOptionIds.includes(option.id)
        ? [providerValues?.[questionIndex]?.[optionIndex] ?? option.label]
        : [],
    );
  });
}
