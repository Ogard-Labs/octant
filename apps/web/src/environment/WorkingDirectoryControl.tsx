import { decodeThreadWorkingDirectory, type ThreadWorkingDirectory } from "@octant/contracts";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

/** The thread root is stored as "."; a person reads that as a typo, not a place. */
export function workingFolderLabel(value: ThreadWorkingDirectory | "." | string): string {
  return String(value) === "." ? "Repository root" : String(value);
}

export function ChangeWorkingFolder(props: {
  readonly value: ThreadWorkingDirectory | ".";
  readonly disabled?: boolean;
  readonly onApply: (workingDirectory: ThreadWorkingDirectory) => Promise<void>;
  /** The Working folder row, where an applied folder is read back. */
  readonly row?: RefObject<HTMLButtonElement | null>;
}) {
  const [editing, setEditing] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<"opener" | "row" | undefined>(undefined);
  // Applying or cancelling unmounts the field the person was in. Cancel hands
  // focus back to the control that opened it; Apply to the row that now shows
  // the new folder. Neither lets it fall to the page.
  useEffect(() => {
    if (editing || returnFocus.current === undefined) return;
    const target =
      returnFocus.current === "row" ? (props.row?.current ?? opener.current) : opener.current;
    returnFocus.current = undefined;
    target?.focus();
  }, [editing, props.row]);
  const finishEditing = (target: "opener" | "row") => {
    returnFocus.current = target;
    setEditing(false);
  };
  if (!editing) {
    return (
      <OctantButton
        className="environment-group__action"
        ref={opener}
        onClick={() => setEditing(true)}
        type="button"
        variant="ghost"
      >
        Change working folder
      </OctantButton>
    );
  }
  return (
    <div className="working-directory-change">
      <WorkingDirectoryControl
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        onApply={async (workingDirectory) => {
          await props.onApply(workingDirectory);
          finishEditing("row");
        }}
        value={props.value}
      />
      <OctantButton onClick={() => finishEditing("opener")} type="button" variant="ghost">
        Cancel
      </OctantButton>
    </div>
  );
}

export function WorkingDirectoryControl(props: {
  readonly value: ThreadWorkingDirectory | ".";
  readonly disabled?: boolean;
  readonly onApply: (workingDirectory: ThreadWorkingDirectory) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const [status, setStatus] = useState<"idle" | "saving" | "failed">("idle");
  const inputId = useId();
  const lastAuthoritativeValue = useRef(String(props.value));

  useEffect(() => {
    const nextValue = String(props.value);
    if (lastAuthoritativeValue.current === nextValue) return;
    lastAuthoritativeValue.current = nextValue;
    setDraft(nextValue);
  }, [props.value]);

  return (
    <form
      className="working-directory-control"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        let workingDirectory: ThreadWorkingDirectory;
        try {
          workingDirectory = decodeThreadWorkingDirectory(draft.trim());
        } catch {
          setStatus("failed");
          return;
        }
        setStatus("saving");
        void props
          .onApply(workingDirectory)
          .then(() => setStatus("idle"))
          .catch(() => setStatus("failed"));
      }}
    >
      <label htmlFor={inputId}>Working folder</label>
      <div className="working-directory-control__row">
        <OctantInput
          autoFocus
          id={inputId}
          value={draft}
          disabled={props.disabled === true || status === "saving"}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            if (status === "failed") setStatus("idle");
          }}
          placeholder="."
          spellCheck={false}
        />
        <OctantButton
          aria-label="Apply working folder"
          disabled={props.disabled === true || status === "saving" || draft === String(props.value)}
          type="submit"
          size="sm"
          variant="secondary"
        >
          Apply
        </OctantButton>
      </div>
      <small {...(status === "failed" ? { role: "alert" } : {})}>
        {status === "failed"
          ? "Choose an existing folder inside this Project."
          : "Relative to the bound Project or checkout. Use . for the root."}
      </small>
    </form>
  );
}
