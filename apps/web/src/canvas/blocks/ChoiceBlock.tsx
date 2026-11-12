import type { CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { QuestionnaireResponse } from "@octant/contracts";
import { validateCanvasChoiceAnswer } from "@octant/domain";
import { QuestionnaireCard } from "../../transcript/QuestionnaireCard";

export type CanvasChoiceSendResult =
  | { readonly status: "sent" }
  | { readonly status: "refused"; readonly message: string };

/**
 * Whether this surface can send a person's answer to the Canvas's own thread.
 * Sending is their ordinary message to that thread; the runtime grants
 * nothing, and the host admits or refuses the message like any other.
 */
export type CanvasChoiceRuntime =
  | {
      readonly kind: "can-send";
      /** Names where the answer goes, on the send button. */
      readonly threadLabel: string;
      readonly onSend: (
        block: CanvasChoiceBlock,
        response: QuestionnaireResponse,
      ) => Promise<CanvasChoiceSendResult>;
    }
  | { readonly kind: "read-only"; readonly reason: string };

/**
 * What a surface without a runtime says: the thread, a preview card, and an
 * export draw a Canvas without knowing whether its thread can take a message.
 */
export const CANVAS_CHOICE_DEFAULT_READ_ONLY_REASON =
  "Open this Canvas beside its thread to answer.";

export function ChoiceBlock(props: {
  readonly block: CanvasChoiceBlock;
  readonly runtime?: CanvasChoiceRuntime;
}) {
  const { block, runtime } = props;
  if (runtime?.kind !== "can-send") {
    return (
      <CanvasChoiceReadOnly
        block={block}
        reason={runtime?.reason ?? CANVAS_CHOICE_DEFAULT_READ_ONLY_REASON}
      />
    );
  }
  const questionnaire = { allowComment: false, questions: block.questions };
  return (
    <div className="canvas-choice" data-state="can-send">
      <QuestionnaireCard
        prompt={block.prompt}
        questionnaire={questionnaire}
        submitLabel={`Send to ${runtime.threadLabel}`}
        validateAnswer={validateCanvasChoiceAnswer}
        onAnswer={async (encoded) => {
          // The card only enables Send for an answer this same rule admits.
          const validated = validateCanvasChoiceAnswer(questionnaire, encoded);
          if (validated.status === "invalid") return { refused: validated.message };
          const result = await runtime.onSend(block, validated.response);
          return result.status === "sent" ? true : { refused: result.message };
        }}
      />
    </div>
  );
}

/** The questions and their options as text, with why nothing can be sent here. */
export function CanvasChoiceReadOnly(props: {
  readonly block: Pick<CanvasChoiceBlock, "prompt" | "questions">;
  readonly reason: string;
}) {
  return (
    <section className="canvas-choice provider-question-card" data-state="read-only">
      <p className="provider-question-card__prompt">{props.block.prompt}</p>
      {props.block.questions.map((question) => (
        <div className="canvas-choice__question" key={question.id}>
          <p className="canvas-choice__question-prompt">{question.prompt}</p>
          <ul className="canvas-choice__options">
            {question.options.map((option) => (
              <li key={option.id}>
                <span className="provider-question-card__option-label">{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="provider-question-card__option-description">
                    {" "}
                    {option.description}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="canvas-choice__note" role="note">
        {props.reason}
      </p>
    </section>
  );
}
