import type { Questionnaire, QuestionnaireResponse, WorkRequest } from "@octant/contracts";
import { validateQuestionnaireAnswer } from "@octant/domain";
import { levelChangePresentation, type LevelChangePresentation } from "./levelChangePresentation";

/**
 * Which card a pending Work request draws on the phone, with the desktop's
 * words: the Plan block for a level change, the provider approval for a tool
 * call, and the provider question as one question or a questionnaire.
 */
export type WorkRequestCard =
  | { readonly kind: "level-change"; readonly shown: LevelChangePresentation }
  | { readonly kind: "tool-approval"; readonly label: string; readonly summary: string }
  | {
      readonly kind: "question";
      readonly prompt: string;
      readonly options: ReadonlyArray<string>;
    }
  | {
      readonly kind: "questionnaire";
      readonly prompt: string;
      readonly questionnaire: Questionnaire;
    };

export function workRequestCard(request: WorkRequest): WorkRequestCard | undefined {
  if (request.status !== "pending") return undefined;
  const detail = request.detail;
  if (detail.kind === "approval") {
    const shown = levelChangePresentation(request);
    if (shown !== undefined) return { kind: "level-change", shown };
    return {
      kind: "tool-approval",
      label: "Provider approval",
      summary: `${detail.action}: ${detail.description}`,
    };
  }
  return detail.questionnaire === undefined
    ? { kind: "question", prompt: detail.prompt, options: detail.options }
    : { kind: "questionnaire", prompt: detail.prompt, questionnaire: detail.questionnaire };
}

/** The oldest ask first, as the turn met them. */
export function pendingWorkRequestsInOrder(
  requests: ReadonlyArray<WorkRequest>,
): ReadonlyArray<WorkRequest> {
  return requests
    .filter((request) => request.status === "pending")
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

/**
 * A questionnaire answer being written on the phone. A question in
 * `customIds` is answered in the person's own words instead of an option, as
 * the desktop's "Write another answer" does.
 */
export interface QuestionnaireDraft {
  readonly answers: ReadonlyArray<QuestionnaireResponse["answers"][number]>;
  readonly customIds: ReadonlyArray<string>;
  readonly comment: string;
}

export function emptyQuestionnaireDraft(questionnaire: Questionnaire): QuestionnaireDraft {
  return {
    answers: questionnaire.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [],
    })),
    customIds: [],
    comment: "",
  };
}

type Question = Questionnaire["questions"][number];

function replaceAnswer(
  draft: QuestionnaireDraft,
  answer: QuestionnaireResponse["answers"][number],
): QuestionnaireDraft {
  return {
    ...draft,
    answers: draft.answers.map((entry) =>
      entry.questionId === answer.questionId ? answer : entry,
    ),
  };
}

/** A tap on an option: one choice replaces the last, a multiple choice toggles within its limit. */
export function chooseQuestionnaireOption(
  draft: QuestionnaireDraft,
  question: Question,
  optionId: string,
): QuestionnaireDraft {
  const custom = draft.customIds.includes(question.id);
  const selected = custom
    ? []
    : (draft.answers.find((entry) => entry.questionId === question.id)?.selectedOptionIds ?? []);
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
  return replaceAnswer(
    { ...draft, customIds: draft.customIds.filter((value) => value !== question.id) },
    { questionId: question.id, selectedOptionIds: next },
  );
}

/** "Write another answer" on or off; either way the question's options are cleared. */
export function toggleQuestionnaireCustom(
  draft: QuestionnaireDraft,
  question: Question,
): QuestionnaireDraft {
  const custom = draft.customIds.includes(question.id);
  return replaceAnswer(
    {
      ...draft,
      customIds: custom
        ? draft.customIds.filter((value) => value !== question.id)
        : [...draft.customIds, question.id],
    },
    { questionId: question.id, selectedOptionIds: [] },
  );
}

export function writeQuestionnaireCustom(
  draft: QuestionnaireDraft,
  question: Question,
  text: string,
): QuestionnaireDraft {
  return replaceAnswer(draft, {
    questionId: question.id,
    selectedOptionIds: [],
    ...(text.trim() === "" ? {} : { customAnswer: text }),
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
    answers: draft.answers.map(({ customAnswer, ...answer }) => ({
      ...answer,
      ...(customAnswer === undefined || customAnswer.trim() === ""
        ? {}
        : { customAnswer: customAnswer.trim() }),
    })),
    ...(questionnaire.allowComment === false || comment === "" ? {} : { comment }),
  };
  const writtenWhereChosen = draft.customIds.every(
    (questionId) =>
      response.answers.find((answer) => answer.questionId === questionId)?.customAnswer !==
      undefined,
  );
  if (!writtenWhereChosen) return undefined;
  const validated = validateQuestionnaireAnswer(questionnaire, JSON.stringify(response));
  return validated.status === "valid" ? response : undefined;
}
