import { useState } from "react";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantFieldError } from "../../ui/base/OctantField";
import { OctantInput } from "../../ui/base/OctantInput";

export type BranchSuggestionStatus = "idle" | "asking" | "dropped" | "declined";

export interface CodeBranchNameFieldProps {
  /** The name the new worktree gets if the person sends now. */
  readonly value: string;
  /** Whether the person chose or edited this name rather than it being derived. */
  readonly chosen: boolean;
  /** Returns why a typed name was refused; undefined when it was taken. An empty name returns to the derived one. */
  readonly onEdit: (name: string) => string | undefined;
  /** Absent when no model is selected or the host cannot ask one. */
  readonly onSuggest?: () => void;
  readonly suggestion: BranchSuggestionStatus;
  /** The model a suggestion would be asked of, named so the person knows where the draft goes. */
  readonly modelLabel?: string;
  readonly suggestDisabled: boolean;
  readonly disabled?: boolean;
}

const STATUS_COPY: Record<Exclude<BranchSuggestionStatus, "idle" | "asking">, string> = {
  dropped:
    "Your message or choices changed while the model was answering, so its name was not used.",
  declined: "The model could not suggest a name. The name above stays.",
};

/**
 * The branch name a new worktree gets, shown before Send and editable. A name
 * is derived on this computer; a model is asked for words only when the person
 * presses Suggest name, and a failed or outdated answer changes nothing.
 */
export function CodeBranchNameField(props: CodeBranchNameFieldProps) {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const shown = draft ?? props.value;
  const status =
    props.suggestion === "idle" || props.suggestion === "asking"
      ? undefined
      : STATUS_COPY[props.suggestion];
  return (
    <div>
      <label htmlFor="code-branch-name-input">Branch name</label>
      <OctantInput
        aria-invalid={error === undefined ? undefined : true}
        disabled={props.disabled === true}
        id="code-branch-name-input"
        onBlur={() => {
          if (draft === undefined) return;
          const refused = props.onEdit(draft.trim());
          setError(refused);
          if (refused === undefined) setDraft(undefined);
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(undefined);
        }}
        spellCheck={false}
        type="text"
        value={shown}
      />
      {error === undefined ? null : <OctantFieldError>{error}</OctantFieldError>}
      {props.onSuggest === undefined ? null : (
        <div>
          <OctantButton
            disabled={
              props.suggestDisabled || props.suggestion === "asking" || props.disabled === true
            }
            onClick={props.onSuggest}
            type="button"
          >
            {props.suggestion === "asking" ? "Asking…" : "Suggest name"}
          </OctantButton>
          <p className="code-where-dialog__lead">
            {props.modelLabel === undefined
              ? "Asks the selected model for words from your message."
              : `Sends your message to ${props.modelLabel} for words to name the branch.`}{" "}
            Nothing is sent unless you press the button.
          </p>
        </div>
      )}
      {status === undefined ? null : (
        <p aria-live="polite" className="code-where-dialog__lead">
          {status}
        </p>
      )}
      {props.chosen ? (
        <p className="code-where-dialog__lead">Clear the field to return to the derived name.</p>
      ) : null}
    </div>
  );
}
