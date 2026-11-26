import { useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";

/** What the host answered for one move, as this dialog shows it. */
export type MoveToWorktreeAnswer =
  | { readonly status: "moved"; readonly branch: string }
  | { readonly status: "refused"; readonly message: string };

export interface MoveToWorktreeDialogProps {
  /** Where the thread works now: the checkout it shares with the Project. */
  readonly sourceLabel: string;
  readonly onMove: (branchName: string | undefined) => Promise<MoveToWorktreeAnswer>;
  readonly onClose: () => void;
}

/**
 * Moves this thread off the checkout it shares onto a worktree of its own.
 * The host copies the uncommitted changes and leaves the source as it was, so
 * the dialog says so before and after: the move is never silent, and nothing
 * is discarded here. The branch name is optional; the host names one when it
 * is left empty.
 */
export function MoveToWorktreeDialog(props: MoveToWorktreeDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const branchId = useId();
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<MoveToWorktreeAnswer>();

  async function move(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const trimmed = branch.trim();
      setAnswer(await props.onMove(trimmed === "" ? undefined : trimmed));
    } catch {
      setAnswer({ status: "refused", message: "The move could not be started." });
    } finally {
      setBusy(false);
    }
  }

  const moved = answer?.status === "moved" ? answer : undefined;
  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Move to a new worktree"
      labelledBy={titleId}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      open
      popupId="move-to-worktree-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Move to a new worktree</h1>
      </div>
      {moved === undefined ? (
        <>
          <p id={descriptionId}>
            This task gets a worktree of its own on a new branch. Its uncommitted changes are copied
            there, and {props.sourceLabel} keeps them as they are. The current session ends; the
            next message continues with this conversation.
          </p>
          <label className="project-dialog__field" htmlFor={branchId}>
            Branch (optional)
            <OctantInput
              disabled={busy}
              id={branchId}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="Named for you when left empty"
              type="text"
              value={branch}
            />
          </label>
          {answer?.status === "refused" ? (
            <OctantAlert tone="danger">{answer.message}</OctantAlert>
          ) : null}
        </>
      ) : (
        <p id={descriptionId} role="status">
          Moved to worktree {moved.branch}. Your changes were copied; {props.sourceLabel} still has
          them, and Octant does not remove them there.
        </p>
      )}
      <div className="project-dialog__actions">
        {moved === undefined ? (
          <OctantButton disabled={busy} onClick={() => void move()} type="button" variant="solid">
            Move
          </OctantButton>
        ) : null}
        <OctantButton disabled={busy} onClick={props.onClose} type="button" variant="outline">
          {moved === undefined ? "Cancel" : "Close"}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
