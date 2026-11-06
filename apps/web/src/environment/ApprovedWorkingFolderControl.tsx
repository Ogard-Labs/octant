import { OctantAlert } from "../ui/base/OctantAlert";
import {
  decodeThreadWorkingDirectory,
  type ApprovedWorkingFolder,
  type ThreadWorkingFolderChoice,
} from "@octant/contracts";
import { useId, useState, useEffect } from "react";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantInput } from "../ui/base/OctantInput";
export function ApprovedWorkingFolderControl(props: {
  readonly folders: ReadonlyArray<ApprovedWorkingFolder>;
  readonly value: ThreadWorkingFolderChoice;
  readonly onChange: (choice: ThreadWorkingFolderChoice) => void;
  readonly code: boolean;
  readonly onValidityChange?: (valid: boolean) => void;
}) {
  const id = useId();
  const [valid, setValid] = useState(true);
  useEffect(() => {
    props.onValidityChange?.(valid);
  }, [valid, props.onValidityChange]);
  const updateValidity = (next: boolean) => {
    setValid(next);
    props.onValidityChange?.(next);
  };
  const selected = props.folders.find((folder) => folder.id === props.value.workingFolderId);
  return (
    <div className="working-directory-control">
      <OctantSelectField
        aria-label="Task working folder"
        value={props.value.workingFolderId}
        options={props.folders.map((folder) => ({ id: folder.id, label: folder.label }))}
        onValueChange={(value) => {
          const folder = props.folders.find((candidate) => candidate.id === value);
          if (folder === undefined) return;
          updateValidity(true);
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
        defaultValue={props.value.workingDirectory}
        onChange={(event) => {
          try {
            const directory = decodeThreadWorkingDirectory(event.currentTarget.value);
            props.onChange({ ...props.value, workingDirectory: directory });
            updateValidity(true);
            event.currentTarget.setCustomValidity("");
          } catch {
            updateValidity(false);
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
  );
}
