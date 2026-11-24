import type { QuestionnaireDraftIdentity } from "./questionnaireDrafts";
import type { Questionnaire } from "@octant/contracts";
import { QuestionnaireCard } from "./QuestionnaireCard";
import { useState } from "react";

import { Eye, EyeOff } from "../ui/icons";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { chooseByNumber, moveWithinRadioGroup } from "../ui/base/radioGroupKeys";
import { OptionKey } from "./OptionKey";

export interface ProviderQuestionCardProps {
  readonly draftIdentity?: QuestionnaireDraftIdentity | undefined;
  readonly questionnaire?: Questionnaire | undefined;
  readonly prompt: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description?: string | undefined;
  }>;
  /** Where this question sits in a set the provider asked at once. */
  readonly questionIndex?: number | undefined;
  readonly questionCount?: number | undefined;
  readonly onAnswer: (response: string) => void | boolean | Promise<void | boolean>;
  /** Ends the turn without answering; offered only when the host exposes one. */
  readonly onDismiss?: (() => void) | undefined;
  /** Extra class for the surface's own layout, e.g. a thread-column wrapper. */
  readonly className?: string | undefined;
  /**
   * The provider asks for a secret: the typed answer is masked until the
   * person reveals it, and the host passes it on without recording it.
   */
  readonly secret?: boolean | undefined;
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
  // A secret is only ever typed into the masked field, never kept as a draft.
  if (props.questionnaire !== undefined && props.secret !== true)
    return <QuestionnaireCard {...props} questionnaire={props.questionnaire} />;
  return <SingleQuestionCard {...props} />;
}

function SingleQuestionCard(props: ProviderQuestionCardProps) {
  const secret = props.secret === true;
  // A secret is typed, so its field is open from the start.
  const [selected, setSelected] = useState<string | undefined>(secret ? CUSTOM : undefined);
  const [customAnswer, setCustomAnswer] = useState("");
  const [revealed, setRevealed] = useState(false);
  const custom = selected === CUSTOM;
  const count = props.questionCount ?? 1;
  const index = props.questionIndex ?? 1;
  // A secret goes to the agent exactly as typed: spaces at either end can be
  // part of a passphrase, so only a plain answer is trimmed. Either way a
  // blank answer cannot be sent.
  const answer = custom
    ? secret
      ? customAnswer
      : customAnswer.trim()
    : (props.options.find((o) => o.label === selected)?.label ?? "");
  const blank = custom ? customAnswer.trim().length === 0 : answer.length === 0;
  const last = index >= count;
  return (
    <section
      aria-label="Provider question"
      // Numbers pick from anywhere in the card, Submit included; arrows stay
      // on the choice group.
      onKeyDown={chooseByNumber}
      className={`provider-question-card${props.className === undefined ? "" : ` ${props.className}`}`}
    >
      <p className="provider-question-card__prompt">{props.prompt}</p>
      {count > 1 ? (
        <p className="provider-question-card__progress">{`Question ${String(index)} of ${String(count)}`}</p>
      ) : null}
      <div
        className="provider-question-card__choices"
        onKeyDown={moveWithinRadioGroup}
        role="radiogroup"
      >
        {props.options.map((option, index) => (
          <div
            className="provider-question-card__choice"
            {...(selected === option.label ? { "data-checked": "" } : {})}
            key={option.label}
          >
            <OctantButton
              aria-checked={selected === option.label}
              className="provider-question-card__option"
              onClick={() => setSelected(option.label)}
              size={null}
              role="radio"
              type="button"
              variant="ghost"
            >
              <span className="provider-question-card__option-label">
                {option.label}
                <OptionKey index={index} />
              </span>
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
            size={null}
            role="radio"
            type="button"
            variant="ghost"
          >
            <span className="provider-question-card__option-label">
              Type your own answer
              <OptionKey index={props.options.length} />
            </span>
          </OctantButton>
          {custom && !secret ? (
            <OctantInput
              aria-label="Your answer"
              className="provider-question-card__custom"
              onChange={(event) => setCustomAnswer(event.target.value)}
              placeholder="Type your answer…"
              value={customAnswer}
            />
          ) : null}
          {custom && secret ? (
            <div className="provider-question-card__secret">
              <OctantInput
                aria-label="Your secret answer"
                autoCapitalize="off"
                autoComplete="off"
                className="provider-question-card__custom"
                onChange={(event) => setCustomAnswer(event.target.value)}
                placeholder="Type the secret…"
                spellCheck={false}
                type={revealed ? "text" : "password"}
                value={customAnswer}
              />
              <OctantIconButton
                aria-pressed={revealed}
                disabled={customAnswer.length === 0}
                label={revealed ? "Hide answer" : "Show answer"}
                onClick={() => setRevealed(!revealed)}
                type="button"
              >
                {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </OctantIconButton>
            </div>
          ) : null}
        </div>
      </div>
      {secret ? (
        <p className="provider-question-card__progress">
          Sent only to the agent. Octant does not save it or add it to the thread.
        </p>
      ) : null}
      <footer className="provider-question-card__actions">
        {props.onDismiss === undefined ? null : (
          <OctantButton onClick={props.onDismiss} size="sm" type="button" variant="ghost">
            Dismiss
          </OctantButton>
        )}
        <OctantButton
          disabled={blank}
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
