import type { CoordinatorBounds, CoordinatorWorkerLevel } from "@octant/contracts";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { COORDINATOR_BOUND_FIELDS, COORDINATOR_WORKER_LEVELS } from "./coordinatorChoices";
import "./coordinator-bounds-dialog.css";

/** The worker level choice, offered only while the coordinator is being created. */
export interface CoordinatorWorkerLevelChoice {
  readonly level: CoordinatorWorkerLevel | undefined;
}

/**
 * A coordinator's limits: how often it and its workers may be woken in an
 * hour, how many rounds they may answer each other, and how many workers it
 * may start in an hour (docs/design/coordinator-threads.md § Bounds). Saving
 * hands back all three; a bound left at its default is not sent, so it keeps
 * following the default.
 *
 * The New coordinator draft opens the same dialog with `workerLevel`, since
 * the host takes the workers' level only on the command that makes the thread
 * a coordinator; a running coordinator's dialog never offers it.
 */
export function CoordinatorBoundsDialog(props: {
  readonly title: string;
  readonly bounds: CoordinatorBounds | undefined;
  readonly workerLevel?: CoordinatorWorkerLevelChoice;
  readonly onSave: (bounds: CoordinatorBounds, workerLevel?: CoordinatorWorkerLevelChoice) => void;
  readonly onClose: () => void;
}) {
  const [values, setValues] = useState<CoordinatorBounds>(props.bounds ?? {});
  const [level, setLevel] = useState(props.workerLevel?.level);
  const cancel = useRef<HTMLButtonElement>(null);
  const label = props.workerLevel === undefined ? "Coordinator limits" : "Coordinator settings";
  const save = () => {
    const chosen: { -readonly [Bound in keyof CoordinatorBounds]: number } = {};
    for (const field of COORDINATOR_BOUND_FIELDS) {
      const value = values[field.bound];
      if (value !== undefined && value !== field.default) chosen[field.bound] = value;
    }
    if (props.workerLevel === undefined) props.onSave(chosen);
    else props.onSave(chosen, { level });
  };
  return (
    <OctantDialog
      className="coordinator-bounds-dialog"
      describedBy="coordinator-bounds-dialog-detail"
      initialFocus={cancel}
      label={label}
      labelledBy="coordinator-bounds-dialog-title"
      onClose={props.onClose}
      open
    >
      <h2 className="coordinator-bounds-dialog__title" id="coordinator-bounds-dialog-title">
        {label}
      </h2>
      <p className="oct-row-detail" id="coordinator-bounds-dialog-detail">
        {props.workerLevel === undefined
          ? `${props.title}: how often this coordinator and its workers wake for each other, and how many workers it starts. Changes apply from the next wake or start.`
          : "What its workers may do, and how often this coordinator and its workers wake for each other."}
      </p>
      {props.workerLevel === undefined ? null : (
        <div className="coordinator-bounds-dialog__row coordinator-bounds-dialog__row--level">
          <span>Workers start at</span>
          <OctantSelectField
            aria-label="Workers start at"
            className="coordinator-bounds-dialog__level"
            onValueChange={(value) =>
              setLevel(COORDINATOR_WORKER_LEVELS.find((entry) => entry.id === value)?.level)
            }
            options={COORDINATOR_WORKER_LEVELS.map((entry) => ({
              id: entry.id,
              label: entry.menuLabel,
            }))}
            value={level ?? ""}
          />
        </div>
      )}
      {COORDINATOR_BOUND_FIELDS.map((field) => (
        <div className="coordinator-bounds-dialog__row" key={field.bound}>
          <span>
            {field.label}
            <span className="oct-meta"> · default {String(field.default)}</span>
            <span className="oct-row-detail coordinator-bounds-dialog__detail">{field.detail}</span>
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
