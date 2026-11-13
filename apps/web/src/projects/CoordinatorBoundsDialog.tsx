import type { CoordinatorBounds } from "@octant/contracts";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { COORDINATOR_BOUND_FIELDS } from "./coordinatorChoices";
import "./coordinator-bounds-dialog.css";

/**
 * The limits of a running coordinator: how often it and its workers may be
 * woken in an hour, how many rounds they may answer each other, and how many
 * workers it may start in an hour (docs/design/coordinator-threads.md
 * § Bounds). Saving replaces all three on the host; a bound left at its
 * default is not sent, so it keeps following the default.
 */
export function CoordinatorBoundsDialog(props: {
  readonly title: string;
  readonly bounds: CoordinatorBounds | undefined;
  readonly onSave: (bounds: CoordinatorBounds) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<CoordinatorBounds>(props.bounds ?? {});
  const cancel = useRef<HTMLButtonElement>(null);
  const save = () => {
    const chosen: { -readonly [Bound in keyof CoordinatorBounds]: number } = {};
    for (const field of COORDINATOR_BOUND_FIELDS) {
      const value = values[field.bound];
      if (value !== undefined && value !== field.default) chosen[field.bound] = value;
    }
    props.onSave(chosen);
  };
  return (
    <OctantDialog
      className="coordinator-bounds-dialog"
      describedBy="coordinator-bounds-dialog-detail"
      initialFocus={cancel}
      label="Coordinator limits"
      labelledBy="coordinator-bounds-dialog-title"
      onClose={props.onClose}
      open
    >
      <h2 className="coordinator-bounds-dialog__title" id="coordinator-bounds-dialog-title">
        Coordinator limits
      </h2>
      <p className="oct-row-detail" id="coordinator-bounds-dialog-detail">
        {props.title}: how often this coordinator and its workers wake for each other, and how many
        workers it starts. Changes apply from the next wake or start.
      </p>
      {COORDINATOR_BOUND_FIELDS.map((field) => (
        <div className="coordinator-bounds-dialog__row" key={field.bound}>
          <span>
            {field.label}
            <span className="oct-meta"> · default {String(field.default)}</span>
          </span>
          <OctantNumberStepper
            label={field.label}
            max={field.max}
            min={1}
            onChange={(value) => setValues((current) => ({ ...current, [field.bound]: value }))}
            value={values[field.bound] ?? field.default}
          />
        </div>
      ))}
      <footer className="coordinator-bounds-dialog__actions">
        <OctantButton onClick={props.onClose} ref={cancel} type="button" variant="outline">
          Cancel
        </OctantButton>
        <OctantButton onClick={save} type="button">
          Save
        </OctantButton>
      </footer>
    </OctantDialog>
  );
}
