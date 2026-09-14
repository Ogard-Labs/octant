import { useState } from "react";

import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProviderQuestionCardProps {
  readonly prompt: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  /** Where this question sits in a set the provider asked at once. */
  readonly questionIndex?: number | undefined;
  readonly questionCount?: number | undefined;
  readonly onAnswer: (response: string) => void;
  /** Ends the turn without answering; offered only when the host exposes one. */
  readonly onDismiss?: (() => void) | undefined;
  /** Extra class for the surface's own layout, e.g. a thread-column wrapper. */
  readonly className?: string | undefined;
}

const CUSTOM = "octant-question-custom";

/**
 * One question a running provider turn asked the person and is blocked on,
 * laid out so it can be answered without guessing: the question, each offered
 * answer with what it means, a text field for answers no option covers, and
 * the two ways out — dismiss the turn, or send this question's answer. When
 * the provider asked several questions at once the card names its place in
 * the set; each question is answered in order and the driver holds the set's
 * answers until the last one.
 */
export function ProviderQuestionCard(props: ProviderQuestionCardProps) {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [customAnswer, setCustomAnswer] = useState("");
  const custom = selected === CUSTOM;
  const count = props.questionCount ?? 1;
  const index = props.questionIndex ?? 1;
  const answer = custom
    ? customAnswer.trim()
    : (props.options.find((o) => o.label === selected)?.label ?? "");
  const last = index >= count;
  return (
    <section
      aria-label="Provider question"
      className={`provider-question-card${props.className === undefined ? "" : ` ${props.className}`}`}
    >
      <p className="provider-question-card__prompt">{props.prompt}</p>
      {count > 1 ? (
        <p className="provider-question-card__progress">{`Question ${String(index)} of ${String(count)}`}</p>
      ) : null}
      <div className="provider-question-card__choices" role="radiogroup">
        {props.options.map((option) => (
          <div
            className="provider-question-card__choice"
            {...(selected === option.label ? { "data-checked": "" } : {})}
            key={option.label}
          >
            <OctantButton
              aria-checked={selected === option.label}
              className="provider-question-card__option"
              onClick={() => setSelected(option.label)}
              role="radio"
              type="button"
              variant="ghost"
            >
              <span className="provider-question-card__option-label">{option.label}</span>
              {option.description === undefined ? null : (
                <span className="provider-question-card__option-description">
                  {option.description}
                </span>
              )}
            </OctantButton>
          </div>
        ))}
        <div className="provider-question-card__choice" {...(custom ? { "data-checked": "" } : {})}>
          <OctantButton
            aria-checked={custom}
            className="provider-question-card__option"
            onClick={() => setSelected(CUSTOM)}
            role="radio"
            type="button"
            variant="ghost"
          >
            <span className="provider-question-card__option-label">Type your own answer</span>
          </OctantButton>
          {custom ? (
            <OctantInput
              aria-label="Your answer"
              className="provider-question-card__custom"
              onChange={(event) => setCustomAnswer(event.target.value)}
              placeholder="Type your answer…"
              value={customAnswer}
            />
          ) : null}
        </div>
      </div>
      <footer className="provider-question-card__actions">
        {props.onDismiss === undefined ? null : (
          <OctantButton onClick={props.onDismiss} size="sm" type="button" variant="ghost">
            Dismiss
          </OctantButton>
        )}
        <OctantButton
          disabled={answer.length === 0}
          onClick={() => props.onAnswer(answer)}
          size="sm"
          type="button"
        >
          {last ? "Submit" : "Next"}
        </OctantButton>
      </footer>
    </section>
  );
}
