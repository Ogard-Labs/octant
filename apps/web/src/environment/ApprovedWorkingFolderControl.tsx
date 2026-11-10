import { OctantAlert } from "../ui/base/OctantAlert";
import {
  decodeThreadWorkingDirectory,
  type ApprovedWorkingFolder,
  type ThreadWorkingFolderChoice,
} from "@octant/contracts";
import { ChevronDown, FolderTree } from "lucide-react";
import { useId, useState, useEffect } from "react";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";

/**
 * Which approved folder a new task works in, and the subfolder inside it: one
 * chip in the start screen's context row that opens the two fields over the
 * page. Drawn as an open form in that row, it put a select, a labelled input
 * and a paragraph between the person and the prompt.
 */
export function ApprovedWorkingFolderControl(props: {
  readonly folders: ReadonlyArray<ApprovedWorkingFolder>;
  readonly value: ThreadWorkingFolderChoice;
  readonly onChange: (choice: ThreadWorkingFolderChoice) => void;
  readonly code: boolean;
  readonly onValidityChange?: (valid: boolean) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [valid, setValid] = useState(true);
  // A subfolder the host would refuse stays in the field and on the chip
  // until it is corrected: closing the popup must not quietly swap it for the
  // last accepted one and send the task somewhere the person did not type.
  const [rejected, setRejected] = useState<string>();
  useEffect(() => {
    props.onValidityChange?.(valid);
  }, [valid, props.onValidityChange]);
  const updateValidity = (next: boolean) => {
    setValid(next);
    props.onValidityChange?.(next);
  };
  const selected = props.folders.find((folder) => folder.id === props.value.workingFolderId);
  const subfolder = String(props.value.workingDirectory);
  const shown = rejected ?? subfolder;
  const chipLabel =
    selected === undefined
      ? "Folder unavailable"
      : shown === "."
        ? selected.label
        : `${selected.label} / ${shown}`;
  return (
    <OctantPopover
      className="working-folder-popover"
      onOpenChange={setOpen}
      open={open}
      title="Working folder"
      trigger={
        <>
          <FolderTree aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{chipLabel}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </>
      }
      triggerClassName="composer-tray__item working-folder-chip"
      {...(valid ? {} : { triggerDataAttributes: { "data-invalid": true } })}
      triggerLabel={
        valid
          ? `Working folder: ${chipLabel}`
          : `Working folder: ${chipLabel}, not a usable subfolder`
      }
    >
      <div className="working-directory-control">
        <OctantSelectField
          aria-label="Task working folder"
          value={props.value.workingFolderId}
          options={props.folders.map((folder) => ({ id: folder.id, label: folder.label }))}
          onValueChange={(value) => {
            const folder = props.folders.find((candidate) => candidate.id === value);
            if (folder === undefined) return;
            updateValidity(true);
            setRejected(undefined);
            props.onChange({
              workingFolderId: folder.id,
              workingDirectory: decodeThreadWorkingDirectory("."),
            });
          }}
        />
        <label htmlFor={id}>Subfolder within working folder</label>
        <OctantInput
          id={id}
          key={String(props.value.workingFolderId)}
          defaultValue={shown}
          onChange={(event) => {
            try {
              const directory = decodeThreadWorkingDirectory(event.currentTarget.value);
              props.onChange({ ...props.value, workingDirectory: directory });
              updateValidity(true);
              setRejected(undefined);
              event.currentTarget.setCustomValidity("");
            } catch {
              updateValidity(false);
              setRejected(event.currentTarget.value);
              event.currentTarget.setCustomValidity("Use . or a relative subfolder without ..");
            }
          }}
        />
        {!valid ? (
          <OctantAlert tone="danger">
            Use . or a relative subfolder without .. before starting this task.
          </OctantAlert>
        ) : null}
        <small>
          {selected === undefined
            ? "Working folder unavailable. Choose a current Project folder."
            : selected.kind === "extra" && props.code
              ? "Shared folder: outside the child worktree. Git, changed files and Review cover the Code checkout only."
              : "Provider, terminal, saved actions and new Work artifacts use this folder. Choose another root in a new task."}
        </small>
      </div>
    </OctantPopover>
  );
}
