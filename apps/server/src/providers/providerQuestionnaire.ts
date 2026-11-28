import { Schema } from "effect";
import {
  MAX_QUESTION_HEADER_LENGTH,
  MAX_QUESTION_OPTIONS,
  MAX_QUESTIONNAIRE_QUESTIONS,
  Questionnaire,
} from "@octant/contracts";
import {
  optionRecommendation,
  questionnaireAnswerValues,
  validateQuestionnaireAnswer,
} from "@octant/domain";

/** One question as a provider asked it, before Octant shapes it into its questionnaire. */
export interface ProviderQuestion {
  readonly header?: string | undefined;
  readonly prompt: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  readonly multiple: boolean;
  /** The provider takes a written answer in place of a choice. */
  readonly allowCustom: boolean;
}

/**
 * A provider's question set as one questionnaire the person answers once,
 * with what the driver needs to answer the provider in its own words.
 */
export interface ProviderQuestionnaire {
  /** What the card is titled with: the one question, or what the set decides. */
  readonly prompt: string;
  readonly questionnaire: Questionnaire;
  /** `providerValues[question][option]`: each option's label exactly as the provider offered it. */
  readonly providerValues: ReadonlyArray<ReadonlyArray<string>>;
}

const PROMPT_MAX = 1_024;
const LABEL_MAX = 256;
const DESCRIPTION_MAX = 512;

/**
 * The set as one questionnaire, or undefined when it cannot be one: more than
 * four questions, a question with no choices or more than twenty, or text
 * that is empty once trimmed. A set that cannot be one keeps the provider's
 * question-by-question path, so nothing it asked is cut or reworded.
 *
 * Question ids are `q0`, `q1`, ... and option ids `o0`, `o1`, ... by
 * position, so an answer maps back to the provider's own option without a
 * lookup table. A "(Recommended)" mark in a label becomes the option's flag.
 * A question set asked through a provider's own tool returns no comment, so
 * the card offers none.
 */
export function providerQuestionnaire(
  questions: ReadonlyArray<ProviderQuestion>,
): ProviderQuestionnaire | undefined {
  if (questions.length === 0 || questions.length > MAX_QUESTIONNAIRE_QUESTIONS) return undefined;
  if (
    questions.some(
      (question) => question.options.length === 0 || question.options.length > MAX_QUESTION_OPTIONS,
    )
  )
    return undefined;
  const shaped = questions.map((question, questionIndex) => {
    const header = bounded(question.header, MAX_QUESTION_HEADER_LENGTH, true);
    return {
      id: `q${questionIndex}`,
      ...(header === undefined ? {} : { header }),
      prompt: bounded(question.prompt, PROMPT_MAX) ?? "",
      selection: question.multiple ? ("multiple" as const) : ("single" as const),
      options: question.options.map((option, optionIndex) => {
        const read = optionRecommendation(option.label);
        const description = bounded(option.description, DESCRIPTION_MAX);
        return {
          id: `o${optionIndex}`,
          label: bounded(read.label, LABEL_MAX, true) ?? "",
          ...(description === undefined ? {} : { description }),
          ...(read.recommended ? { recommended: true } : {}),
        };
      }),
      allowCustom: question.allowCustom,
    };
  });
  let questionnaire: Questionnaire;
  try {
    questionnaire = Schema.decodeUnknownSync(Questionnaire)({
      allowComment: false,
      questions: shaped,
    });
  } catch {
    return undefined;
  }
  const first = questionnaire.questions[0];
  if (first === undefined) return undefined;
  const headers = questionnaire.questions.flatMap((question) =>
    question.header === undefined ? [] : [question.header],
  );
  const prompt =
    questionnaire.questions.length === 1
      ? first.prompt
      : headers.length === questionnaire.questions.length
        ? headers.join(" · ")
        : `${questionnaire.questions.length} questions`;
  return {
    prompt: bounded(prompt, PROMPT_MAX) ?? first.prompt,
    questionnaire,
    providerValues: questions.map((question) => question.options.map((option) => option.label)),
  };
}

/**
 * The person's one answer to the set, as each question's answer in the
 * provider's own words, or invalid when it does not answer the set. A set of
 * one question also takes a plain written answer, which is what a surface
 * that sends only text (an older client, a terminal line) can give.
 */
export function answerProviderQuestionnaire(
  asked: Pick<ProviderQuestionnaire, "questionnaire" | "providerValues">,
  text: string,
):
  | { readonly status: "valid"; readonly answers: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly status: "invalid" } {
  const validated = validateQuestionnaireAnswer(asked.questionnaire, text);
  if (validated.status === "valid") {
    return {
      status: "valid",
      answers: questionnaireAnswerValues(
        asked.questionnaire,
        validated.response,
        asked.providerValues,
      ),
    };
  }
  const only = asked.questionnaire.questions[0];
  const written = text.trim();
  if (
    asked.questionnaire.questions.length !== 1 ||
    only === undefined ||
    only.allowCustom === false ||
    written.length === 0 ||
    written.startsWith("{")
  )
    return { status: "invalid" };
  return { status: "valid", answers: [[written]] };
}

/** Trimmed and bounded; a header or label is also kept to one line, a prompt keeps its lines. */
function bounded(value: string | undefined, maximum: number, oneLine = false): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = (oneLine ? value.replace(/\s+/g, " ") : value).trim();
  if (trimmed.length === 0) return undefined;
  const characters = Array.from(trimmed);
  return characters.length <= maximum
    ? trimmed
    : `${characters
        .slice(0, maximum - 1)
        .join("")
        .trimEnd()}…`;
}
