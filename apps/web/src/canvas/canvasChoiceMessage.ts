import type { CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { CanvasChoiceAnswer, QuestionnaireResponse } from "@octant/contracts";
import { canvasChoiceFormState } from "@octant/domain";

/**
 * The message a person's answer to a choice block becomes in the Canvas's
 * thread. It is their own message, so it speaks for them; it names the Canvas
 * and the block so the agent can match the answer to what it asked, and lists
 * the labels the person saw rather than option ids alone.
 */
export function canvasChoiceMessage(input: {
  readonly canvasTitle: string;
  readonly canvasId: string;
  readonly block: Pick<CanvasChoiceBlock, "blockId" | "prompt" | "questions">;
  readonly response: QuestionnaireResponse;
}): string {
  const lines = input.block.questions.map((question) => {
    const answer = input.response.answers.find((entry) => entry.questionId === question.id);
    if (answer?.customAnswer !== undefined) {
      return `- ${question.prompt}: written answer: ${answer.customAnswer}`;
    }
    const labels = question.options
      .filter((option) => answer?.selectedOptionIds.includes(option.id) === true)
      .map((option) => option.label);
    return `- ${question.prompt}: ${labels.length === 0 ? "nothing chosen" : labels.join(", ")}`;
  });
  return [
    `My answer to "${input.block.prompt}" in the Canvas "${input.canvasTitle}" (canvasId ${input.canvasId}, choice block "${String(input.block.blockId)}"):`,
    ...lines,
  ].join("\n");
}

/** A form's answers that fit a message; a longer list is read from the Canvas instead. */
export const CANVAS_DECISION_FORM_MESSAGE_LIST_LIMIT = 20_000;

/**
 * The message a person's Send on a decision form becomes in the Canvas's
 * thread. It is their own message: it names the Canvas and the block, counts
 * the answers, and lists each question under its section with the labels the
 * person saw, their written answer, their note, and whether they accepted the
 * agent's own recommendation. A list too long for a message is left to the
 * agent to read from the Canvas, where the answers are authoritative.
 */
export function canvasDecisionFormMessage(input: {
  readonly canvasTitle: string;
  readonly canvasId: string;
  readonly block: Pick<CanvasChoiceBlock, "blockId" | "prompt" | "questions" | "sections">;
  readonly answers: ReadonlyArray<CanvasChoiceAnswer>;
}): string {
  const form = canvasChoiceFormState(input.block, input.answers);
  const line = (entry: (typeof form.questions)[number]) => {
    const { question, answer } = entry;
    if (answer === undefined) return `- ${question.prompt}: skipped`;
    const labels = question.options
      .filter((option) => answer.selectedOptionIds.includes(option.id))
      .map((option) => option.label);
    const chosen =
      answer.customAnswer !== undefined
        ? `written answer: ${answer.customAnswer}`
        : labels.join(", ");
    return [
      `- ${question.prompt}: ${chosen}`,
      answer.acceptedRecommendation === true ? " (accepted your recommendation)" : "",
      answer.note === undefined ? "" : ` (note: ${answer.note})`,
    ].join("");
  };
  const groups = input.block.sections ?? [
    {
      id: "all",
      title: undefined,
      questionIds: input.block.questions.map((question) => question.id),
    },
  ];
  const lines = groups.flatMap((group) => [
    ...(group.title === undefined ? [] : [`${group.title}:`]),
    ...group.questionIds.flatMap((questionId) => {
      const entry = form.questions.find((candidate) => candidate.question.id === questionId);
      return entry === undefined ? [] : [line(entry)];
    }),
  ]);
  const header = `My answers to "${input.block.prompt}" in the Canvas "${input.canvasTitle}" (canvasId ${input.canvasId}, choice block "${String(input.block.blockId)}"): ${String(form.answered)} of ${String(form.total)} answered.`;
  const list = lines.join("\n");
  return list.length > CANVAS_DECISION_FORM_MESSAGE_LIST_LIMIT
    ? `${header}\nThe list is too long to send here. Read the answers from the Canvas with the Canvas tool's read operation.`
    : `${header}\n${list}`;
}
