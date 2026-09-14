import { CirclePause } from "lucide-react";
import { useState } from "react";

import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ProviderQuestionRowProps {
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
  readonly onAnswer: (response: string) => void;
  /** Extra class for the surface's own layout, e.g. a thread-column wrapper. */
  readonly className?: string;
}

/**
 * One question a running provider turn asked the person and is blocked on:
 * the prompt, one control per option the provider offered, and a text field
 * for everything else. Answering sends the choice verbatim — the provider
 * interprets it, so the row never paraphrases an option into a value.
 */
export function ProviderQuestionRow(props: ProviderQuestionRowProps) {
  const [answer, setAnswer] = useState("");
  const trimmed = answer.trim();
  return (
    <form
      aria-label="Provider question"
      className={`approval-row approval-row--request${props.className === undefined ? "" : ` ${props.className}`}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed.length > 0) props.onAnswer(trimmed);
      }}
    >
      <CirclePause aria-hidden="true" size={14} strokeWidth={1.8} />
      <span className="approval-row__text">{props.prompt}</span>
      <div className="approval-row__actions">
        {props.options.map((option) => (
          <OctantButton
            key={option}
            onClick={() => props.onAnswer(option)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {option}
          </OctantButton>
        ))}
      </div>
      <OctantInput
        aria-label="Answer"
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Type an answer"
        value={answer}
      />
      <OctantButton disabled={trimmed.length === 0} size="sm" type="submit">
        Send answer
      </OctantButton>
    </form>
  );
}
