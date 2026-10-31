import type { ProjectSummary } from "@octant/contracts/projects";
import {
  THREAD_MOVE_REFUSALS,
  decideThreadMove,
  folderContains,
  type MovableThreadMode,
} from "@octant/domain/thread-project-move-policy";
import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export type MoveThreadOutcome =
  | { readonly status: "ok" }
  | { readonly status: "refused"; readonly message: string };

export interface MoveThreadToProjectDialogProps {
  readonly mode: MovableThreadMode;
  readonly threadTitle: string;
  /** The Project the thread is in now. */
  readonly currentProjectId: string;
  /** Every Project the window knows; the dialog picks the ones this thread may join. */
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly onMove: (projectId: string) => Promise<MoveThreadOutcome>;
  readonly onClose: () => void;
}

const CODE_SAME_FOLDER =
  "A Code thread can only move to a Project bound to the same repository folder.";

const KIND: Record<MovableThreadMode, { readonly noun: string; readonly project: string }> = {
  work: { noun: "task", project: "Work Project" },
  code: { noun: "thread", project: "Code Project" },
};

/**
 * Files a Work or Code thread into another Project of the same kind. The host
 * decides and refuses with a reason; the dialog applies the same rule to grey
 * out a Project the host would refuse, and names the reason beside it, so the
 * choice never reads as a dead button.
 */
export function MoveThreadToProjectDialog(props: MoveThreadToProjectDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const kind = KIND[props.mode];

  const bound = (project: ProjectSummary) =>
    project.type === "chat" ? undefined : project.binding.canonicalRoot;
  const current = props.projects.find((project) => String(project.id) === props.currentProjectId);
  const currentFolder = current === undefined ? undefined : bound(current);

  const candidates = props.projects.filter(
    (project) =>
      project.type === props.mode &&
      project.lifecycle === "active" &&
      String(project.id) !== props.currentProjectId,
  );

  function reasonFor(project: ProjectSummary): string | undefined {
    const folder = bound(project);
    if (folder === undefined || currentFolder === undefined) {
      return THREAD_MOVE_REFUSALS["destination-unavailable"];
    }
    const decision = decideThreadMove({
      thread: { lifecycle: "active", executing: false, awaitingInput: false },
      source: { id: props.currentProjectId, mode: props.mode, folder: currentFolder },
      destination: {
        id: String(project.id),
        mode: project.type,
        lifecycle: project.lifecycle,
        folder,
      },
    });
    if (decision.status === "refused") return THREAD_MOVE_REFUSALS[decision.reason];
    if (props.mode === "code" && !folderContains(currentFolder, folder)) return CODE_SAME_FOLDER;
    return undefined;
  }

  async function move(projectId: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const outcome = await props.onMove(projectId);
      if (outcome.status === "ok") props.onClose();
      else setRefusal(outcome.message);
    } catch {
      setRefusal("The thread could not be moved. Nothing changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Move to Project"
      labelledBy={titleId}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      open
      popupId="move-thread-to-project-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Move to Project</h1>
      </div>
      <p id={descriptionId}>
        &ldquo;{props.threadTitle}&rdquo; keeps its history and its access level, and stays a{" "}
        {props.mode === "work" ? "Work task" : "Code thread"}.{" "}
        {props.mode === "work"
          ? "It can move to another Work Project whose folder is the same as, or contains, the folder it works in."
          : "It can move to another Code Project bound to the same repository folder."}
      </p>
      {candidates.length === 0 ? (
        <p>
          There is no other {kind.project} to move this {kind.noun} into.
        </p>
      ) : (
        <ul aria-label={`${kind.project}s`} className="move-thread__list">
          {candidates.map((project) => {
            const reason = reasonFor(project);
            const reasonId = `${descriptionId}-${String(project.id)}`;
            return (
              <li key={String(project.id)}>
                <OctantButton
                  aria-describedby={reason === undefined ? undefined : reasonId}
                  className="move-thread__choice"
                  disabled={busy || reason !== undefined}
                  onClick={() => void move(String(project.id))}
                  type="button"
                  variant="outline"
                >
                  <span className="move-thread__name">{project.name}</span>
                  <span className="move-thread__folder">{bound(project)}</span>
                </OctantButton>
                {reason === undefined ? null : (
                  <span className="move-thread__reason" id={reasonId}>
                    {reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {refusal === undefined ? null : <OctantAlert tone="danger">{refusal}</OctantAlert>}
      <div className="project-dialog__actions">
        <OctantButton disabled={busy} onClick={() => props.onClose()} type="button" variant="ghost">
          Cancel
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
