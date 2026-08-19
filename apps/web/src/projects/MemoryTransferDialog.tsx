import type { ActiveMemoryEntry, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantNativeSelect } from "../ui/base/OctantSelect";

export interface MemoryTransferDialogProps {
  readonly busy: boolean;
  readonly destinations: ReadonlyArray<ProjectSummary>;
  readonly entry: ActiveMemoryEntry;
  readonly onClose: () => void;
  readonly onTransfer: (
    entryId: ActiveMemoryEntry["id"],
    destinationId: ProjectId,
  ) => Promise<boolean>;
}

export function MemoryTransferDialog(props: MemoryTransferDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [destination, setDestination] = useState<ProjectId | "">("");

  function requestClose() {
    if (props.busy) return;
    props.onClose();
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (destination === "" || props.busy) return;
    if (await props.onTransfer(props.entry.id, destination)) props.onClose();
  }

  return (
    <OctantDialog
      className="project-dialog memory-transfer-dialog"
      label="Transfer Project memory"
      onClose={requestClose}
      open
      popupId="memory-transfer-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <span>Independent copy</span>
          <h1 id={titleId}>Transfer Project memory</h1>
        </div>
        <OctantButton
          aria-label="Close Transfer Project memory"
          disabled={props.busy}
          onClick={requestClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p id={descriptionId}>
        The destination receives the selected content with immutable source provenance. Later source
        changes do not alter it.
      </p>
      <blockquote className="memory-entry-dialog__original">{props.entry.content}</blockquote>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Destination Project
          <OctantNativeSelect
            autoFocus
            onChange={(event) => setDestination(event.target.value as ProjectId)}
            required
            value={destination}
          >
            <option value="">Choose an active Project</option>
            {props.destinations.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </OctantNativeSelect>
        </label>
        {props.destinations.length === 0 ? (
          <p className="project-dialog__status">No other active Projects can receive this entry.</p>
        ) : null}
        <div className="project-dialog__actions">
          <OctantButton
            disabled={props.busy}
            onClick={requestClose}
            type="button"
            className="project-button project-button--quiet"
            variant="ghost"
          >
            Cancel
          </OctantButton>
          <OctantButton
            disabled={props.busy || destination === ""}
            type="submit"
            className="project-button project-button--primary"
            variant="ghost"
          >
            Transfer memory
          </OctantButton>
        </div>
      </form>
    </OctantDialog>
  );
}
