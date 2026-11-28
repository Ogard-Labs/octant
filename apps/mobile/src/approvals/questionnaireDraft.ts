import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import { optionRecommendation, validateQuestionnaireAnswer } from "@octant/domain";

type Question = Questionnaire["questions"][number];

/**
 * A questionnaire answer being written on the phone. Every question keeps its
 * chosen options and its written answer side by side; a written answer, once
 * it has words, stands in for the options, as the contract requires.
 */
export interface QuestionnaireDraft {
  readonly answers: ReadonlyArray<{
    readonly questionId: string;
    readonly selectedOptionIds: ReadonlyArray<string>;
    readonly written: string;
  }>;
  readonly comment: string;
}

export function emptyQuestionnaireDraft(questionnaire: Questionnaire): QuestionnaireDraft {
  return {
    answers: questionnaire.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [],
      written: "",
    })),
    comment: "",
  };
}

function answerOf(draft: QuestionnaireDraft, question: Question) {
  return (
    draft.answers.find((entry) => entry.questionId === question.id) ?? {
      questionId: question.id,
      selectedOptionIds: [],
      written: "",
    }
  );
}

function replaceAnswer(
  draft: QuestionnaireDraft,
  answer: QuestionnaireDraft["answers"][number],
): QuestionnaireDraft {
  return {
    ...draft,
    answers: draft.answers.map((entry) =>
      entry.questionId === answer.questionId ? answer : entry,
    ),
  };
}

/** Whether the question is answered in the person's own words right now. */
export function writtenAnswerTakesOver(draft: QuestionnaireDraft, question: Question): boolean {
  return answerOf(draft, question).written.trim() !== "";
}

/**
 * A tap on an option: one choice replaces the last, a multiple choice toggles
 * within its limit. Choosing an option clears that question's written answer,
 * since the host takes one or the other, never both.
 */
export function chooseQuestionnaireOption(
  draft: QuestionnaireDraft,
  question: Question,
  optionId: string,
): QuestionnaireDraft {
  const current = answerOf(draft, question);
  const selected = current.written.trim() === "" ? current.selectedOptionIds : [];
  const max = question.maxSelections ?? question.options.length;
  const checked = selected.includes(optionId);
  const next =
    question.selection === "single"
      ? [optionId]
      : checked
        ? selected.filter((value) => value !== optionId)
        : selected.length >= max
          ? selected
          : [...selected, optionId];
  return replaceAnswer(draft, { questionId: question.id, selectedOptionIds: next, written: "" });
}

/** Words in the written field; once there are any, the question's options are let go. */
export function writeQuestionnaireAnswer(
  draft: QuestionnaireDraft,
  question: Question,
  text: string,
): QuestionnaireDraft {
  const current = answerOf(draft, question);
  return replaceAnswer(draft, {
    questionId: question.id,
    selectedOptionIds: text.trim() === "" ? current.selectedOptionIds : [],
    written: text,
  });
}

/**
 * The response the draft would send, or undefined while it does not meet the
 * questionnaire's own limits. The same rule the desktop card and the host
 * apply decides it, so the phone never offers to send what the host refuses.
 */
export function questionnaireResponseOf(
  questionnaire: Questionnaire,
  draft: QuestionnaireDraft,
): QuestionnaireResponse | undefined {
  const comment = draft.comment.trim();
  const response: QuestionnaireResponse = {
    version: 1,
    answers: questionnaire.questions.map((question) => {
      const answer = answerOf(draft, question);
      const written = answer.written.trim();
      return written === ""
        ? { questionId: question.id, selectedOptionIds: answer.selectedOptionIds }
        : { questionId: question.id, selectedOptionIds: [], customAnswer: written };
    }),
    ...(questionnaire.allowComment === false || comment === "" ? {} : { comment }),
  };
  const validated = validateQuestionnaireAnswer(questionnaire, JSON.stringify(response));
  return validated.status === "valid" ? response : undefined;
}

/**
 * A question asked with plain options and no questionnaire, drawn the same
 * way: one question, one choice, a written answer, no comment. Its answer is
 * the chosen option's words or the written ones (see `plainAnswerOf`).
 */
export function plainQuestionnaire(prompt: string, options: ReadonlyArray<string>): Questionnaire {
  return {
    allowComment: false,
    questions: [
      {
        id: "q0",
        prompt,
        selection: "single",
        options: options.map((words, index) => {
          // A provider marks its pick in the label; the card shows it as its own pill.
          const { label, recommended } = optionRecommendation(words);
          return { id: `o${index}`, label, ...(recommended ? { recommended: true } : {}) };
        }),
        // A plain question with no options is answered in words alone.
        ...(options.length === 0 ? { minSelections: 0 } : {}),
      },
    ],
  };
}

/**
 * The words a plain question's answer sends: the written answer, or the
 * chosen option exactly as the provider offered it.
 */
export function plainAnswerOf(
  options: ReadonlyArray<string>,
  draft: QuestionnaireDraft,
): string | undefined {
  const [answer] = draft.answers;
  if (answer === undefined) return undefined;
  const written = answer.written.trim();
  if (written !== "") return written;
  const [chosen] = answer.selectedOptionIds;
  return chosen === undefined ? undefined : options[Number(chosen.slice(1))];
}

/**
 * Unsent questionnaire answers, kept in this process's memory only so they
 * survive leaving the thread and coming back. Each is bound to the exact
 * request and the question definition it was written against: a changed
 * definition starts empty, and submitting or the request settling forgets it.
 * Nothing here is written to storage, and closing the app drops it.
 */
const drafts = new Map<
  string,
  { readonly definition: string; readonly draft: QuestionnaireDraft }
>();

function definitionOf(questionnaire: Questionnaire): string {
  return JSON.stringify(questionnaire);
}

export function heldQuestionnaireDraft(
  key: string,
  questionnaire: Questionnaire,
): QuestionnaireDraft | undefined {
  const held = drafts.get(key);
  if (held === undefined) return undefined;
  if (held.definition !== definitionOf(questionnaire)) {
    drafts.delete(key);
    return undefined;
  }
  return held.draft;
}

export function holdQuestionnaireDraft(
  key: string,
  questionnaire: Questionnaire,
  draft: QuestionnaireDraft,
): void {
  drafts.set(key, { definition: definitionOf(questionnaire), draft });
}

export function forgetQuestionnaireDraft(key: string): void {
  drafts.delete(key);
}

/**
 * Forgets every draft under `scope` (one thread on one host) whose request is
 * no longer waiting, so a settled, cancelled or replaced ask never comes back
 * with old answers.
 */
export function forgetSettledQuestionnaireDrafts(
  scope: string,
  waitingKeys: ReadonlyArray<string>,
): void {
  const waiting = new Set(waitingKeys);
  for (const key of drafts.keys()) {
    if (key.startsWith(`${scope}|`) && !waiting.has(key)) drafts.delete(key);
  }
}

/** The key a draft is held under: the thread's scope, then the request's own identity. */
export function questionnaireDraftKey(scope: string, ...identity: ReadonlyArray<string>): string {
  return [scope, ...identity].join("|");
}
