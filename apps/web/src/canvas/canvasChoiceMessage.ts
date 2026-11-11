import type { CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { QuestionnaireResponse } from "@octant/contracts";

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
