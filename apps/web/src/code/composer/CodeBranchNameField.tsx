import { useId, useState } from "react";
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
  // Several composers can be on screen (a draft and the follow-up pane), so the
  // ids belong to this one.
  const base = useId();
  const inputId = `${base}-input`;
  const errorId = `${base}-error`;
  const hintId = `${base}-hint`;
  const describedBy =
    [error === undefined ? undefined : errorId, props.onSuggest === undefined ? undefined : hintId]
      .filter((id) => id !== undefined)
      .join(" ") || undefined;
  const shown = draft ?? props.value;
  const status =
    props.suggestion === "idle" || props.suggestion === "asking"
      ? undefined
      : STATUS_COPY[props.suggestion];
  return (
    <div>
      <label htmlFor={inputId}>Branch name</label>
      <OctantInput
        aria-describedby={describedBy}
        aria-invalid={error === undefined ? undefined : true}
        disabled={props.disabled === true}
        id={inputId}
        onBlur={() => {
          if (draft === undefined) return;
          const typed = draft.trim();
          const refused = props.onEdit(typed);
          // A refused name is not shown as if it would be used: the field goes
          // back to the name Send will create, and the reason names what was typed.
          setError(refused === undefined ? undefined : `"${typed}" was not used. ${refused}`);
          setDraft(undefined);
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError(undefined);
        }}
        spellCheck={false}
        type="text"
        value={shown}
      />
      {error === undefined ? null : <OctantFieldError id={errorId}>{error}</OctantFieldError>}
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
          <p className="code-where-dialog__lead" id={hintId}>
            {props.modelLabel === undefined
              ? "Asks the selected model for words from your message."
              : `Sends words from your message to ${props.modelLabel} to name the branch.`}{" "}
            Nothing after a password, token or key goes, and no path or address. Nothing is sent
            unless you press the button.
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
