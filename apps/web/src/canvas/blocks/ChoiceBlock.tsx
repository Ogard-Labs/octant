import type { CanvasChoiceBlock } from "@octant/contracts/canvas";
import type { CanvasChoiceAnswer, QuestionnaireResponse } from "@octant/contracts";
import { validateCanvasChoiceAnswer } from "@octant/domain";
import { QuestionnaireCard } from "../../transcript/QuestionnaireCard";
import { DecisionForm } from "./DecisionForm";
import { useCanvasChoiceAnswers, type CanvasChoiceAnswersPort } from "./useCanvasChoiceAnswers";

export type { CanvasChoiceAnswersPort } from "./useCanvasChoiceAnswers";

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
      /**
       * Where the person's answers are saved. A host that offers it draws the
       * choice as a decision form, which saves as the person answers and sends
       * the saved answers with `onSendForm`; without it the block keeps the
       * draft in this view and sends it whole.
       */
      readonly answers?: CanvasChoiceAnswersPort;
      readonly onSendForm?: (
        block: CanvasChoiceBlock,
        answers: ReadonlyArray<CanvasChoiceAnswer>,
      ) => Promise<CanvasChoiceSendResult>;
    }
  | {
      readonly kind: "read-only";
      readonly reason: string;
      /** Saved answers are still shown, read only, where the host serves them. */
      readonly answers?: CanvasChoiceAnswersPort;
    };

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
  if (runtime?.answers !== undefined) {
    return <SavedChoiceForm block={block} runtime={runtime} port={runtime.answers} />;
  }
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

function SavedChoiceForm(props: {
  readonly block: CanvasChoiceBlock;
  readonly runtime: CanvasChoiceRuntime;
  readonly port: CanvasChoiceAnswersPort;
}) {
  const { block, runtime } = props;
  const { state, save } = useCanvasChoiceAnswers(props.port);
  if (state.status === "unavailable") {
    return <CanvasChoiceReadOnly block={block} reason={state.reason} />;
  }
  const sender =
    runtime.kind === "can-send" && runtime.onSendForm !== undefined ? runtime : undefined;
  const onSendForm = sender?.onSendForm;
  return (
    <DecisionForm
      block={block}
      answers={state.status === "ready" ? state.answers : []}
      save={save}
      editable={sender !== undefined && state.status === "ready"}
      note={runtime.kind === "read-only" ? runtime.reason : undefined}
      send={
        sender === undefined || onSendForm === undefined
          ? undefined
          : {
              label: `Send to ${sender.threadLabel}`,
              onSend: (answers) =>
                sender.onSendForm?.(block, answers) ??
                Promise.resolve({
                  status: "refused" as const,
                  message: "This window cannot send.",
                }),
            }
      }
    />
  );
}

/** The questions and their options as text, with why nothing can be sent here. */
export function CanvasChoiceReadOnly(props: {
  readonly block: Pick<CanvasChoiceBlock, "prompt" | "questions" | "sections">;
  readonly reason: string;
}) {
  const groups = props.block.sections ?? [
    {
      id: "all",
      title: undefined,
      intro: undefined,
      questionIds: props.block.questions.map((q) => q.id),
    },
  ];
  return (
    <section className="canvas-choice provider-question-card" data-state="read-only">
      <p className="provider-question-card__prompt">{props.block.prompt}</p>
      {groups.map((group) => (
        <div className="decision-form__section" key={group.id}>
          {group.title === undefined ? null : (
            <h3 className="decision-form__section-title">{group.title}</h3>
          )}
          {group.intro === undefined ? null : (
            <p className="decision-form__section-intro">{group.intro}</p>
          )}
          {group.questionIds.flatMap((questionId) => {
            const question = props.block.questions.find((candidate) => candidate.id === questionId);
            return question === undefined
              ? []
              : [
                  <div className="canvas-choice__question" key={question.id}>
                    <p className="canvas-choice__question-prompt">{question.prompt}</p>
                    <ul className="canvas-choice__options">
                      {question.options.map((option) => (
                        <li key={option.id}>
                          <span className="provider-question-card__option-label">
                            {option.label}
                          </span>
                          {option.description === undefined ? null : (
                            <span className="provider-question-card__option-description">
                              {" "}
                              {option.description}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>,
                ];
          })}
        </div>
      ))}
      <p className="canvas-choice__note" role="note">
        {props.reason}
      </p>
    </section>
  );
}
