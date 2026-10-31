import type { ProjectId } from "@octant/contracts/projects";
import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";

export interface MoveToProjectChoice {
  readonly id: ProjectId;
  readonly name: string;
}

export interface MoveToProjectDialogProps {
  /** The Chat Projects this thread may join. */
  readonly projects: ReadonlyArray<MoveToProjectChoice>;
  /** Moves the thread; resolves true when the host accepted the move. */
  readonly onMove: (projectId: ProjectId) => Promise<boolean>;
  /** Creates a Chat Project, resolving to its id; absent when this window cannot create one. */
  readonly onCreateProject?: (name: string) => Promise<ProjectId | undefined>;
  readonly onClose: () => void;
}

/**
 * Files a No-project Chat into a Chat Project, picked or created here. The
 * move changes which Project memory the thread's next messages read; it adds
 * no folder access, so the copy says so instead of leaving it to be assumed.
 */
export function MoveToProjectDialog(props: MoveToProjectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function run(move: () => Promise<boolean>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      if (await move()) props.onClose();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function requestClose() {
    if (!busy) props.onClose();
  }

  const trimmed = name.trim();
  const create = props.onCreateProject;
  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Move to Project"
      labelledBy={titleId}
      onClose={requestClose}
      open
      popupId="move-to-project-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Move to Project</h1>
      </div>
      <p id={descriptionId}>
        This conversation stays a Chat. It keeps its history and gains no folder access; the
        Project&rsquo;s memory applies to its next messages.
      </p>
      {props.projects.length === 0 ? null : (
        <ul aria-label="Chat Projects" className="move-to-project__list">
          {props.projects.map((project) => (
            <li key={String(project.id)}>
              <OctantButton
                disabled={busy}
                onClick={() => void run(() => props.onMove(project.id))}
                type="button"
                variant="ghost"
              >
                {project.name}
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
      {create === undefined ? null : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed === "") return;
            void run(async () => {
              const projectId = await create(trimmed);
              return projectId === undefined ? false : await props.onMove(projectId);
            });
          }}
        >
          <label>
            New Project name
            <OctantInput onChange={(event) => setName(event.target.value)} value={name} />
          </label>
          <div className="project-dialog__actions">
            <OctantButton disabled={busy} onClick={requestClose} type="button" variant="ghost">
              Cancel
            </OctantButton>
            <OctantButton disabled={busy || trimmed === ""} type="submit">
              Create and move
            </OctantButton>
          </div>
        </form>
      )}
      {failed ? (
        <p role="alert">The conversation could not be moved. Nothing changed; try again.</p>
      ) : null}
    </OctantDialog>
  );
}
