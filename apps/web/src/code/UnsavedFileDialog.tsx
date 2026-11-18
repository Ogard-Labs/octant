import { useId, useRef } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export type UnsavedFileChoice = "save" | "discard" | "cancel";

/**
 * Asks what to do with a file's unsaved edits as its tab closes. Cancel is the
 * default and the Escape answer, so closing the dialog never loses anything.
 * When a save already failed, `failure` says so before the question repeats.
 */
export function UnsavedFileDialog(props: {
  readonly name: string;
  readonly failure?: string;
  readonly onChoose: (choice: UnsavedFileChoice) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <OctantDialog
      className="octant-confirmation"
      describedBy={descriptionId}
      initialFocus={cancel}
      label={`Save changes to ${props.name}?`}
      labelledBy={titleId}
      onClose={() => props.onChoose("cancel")}
      open
    >
      <h2 className="octant-confirmation__title" id={titleId}>
        Save changes to {props.name}?
      </h2>
      <p className="octant-confirmation__description" id={descriptionId}>
        {"Your edits will be lost if you don't save them."}
      </p>
      {props.failure === undefined ? null : (
        <OctantAlert tone="warning">{props.failure}</OctantAlert>
      )}
      <div className="octant-dialog__actions">
        <OctantButton onClick={() => props.onChoose("discard")} type="button" variant="outline">
          {"Don't save"}
        </OctantButton>
        <OctantButton
          onClick={() => props.onChoose("cancel")}
          ref={cancel}
          type="button"
          variant="outline"
        >
          Cancel
        </OctantButton>
        <OctantButton onClick={() => props.onChoose("save")} type="button">
          Save
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
