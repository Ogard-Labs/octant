import { useId, useState } from "react";
import type { LinkedIssueRef, ThreadLinkedIssue } from "@octant/contracts";
import { linkedIssueLabel } from "@octant/domain/tracker-issue-write-policy";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";

export interface LinkedIssuesDialogProps {
  readonly linkedIssues: ReadonlyArray<ThreadLinkedIssue>;
  /** Links one issue; answers the refusal to show, or undefined once linked. */
  readonly onLink: (reference: string) => Promise<string | undefined>;
  readonly onUnlink: (issue: LinkedIssueRef) => Promise<string | undefined>;
  readonly onClose: () => void;
}

/**
 * The issues this thread works on. A linked issue is the only one its agent
 * may update, and the one Octant keeps current when the Project asks; the
 * dialog says so, since linking is what grants that reach.
 */
export function LinkedIssuesDialog(props: LinkedIssuesDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const referenceId = useId();
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  async function run(change: () => Promise<string | undefined>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const refusal = await change();
      setMessage(refusal);
      if (refusal === undefined) setReference("");
    } catch {
      setMessage("Octant could not change this thread's issues.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <OctantDialog
      className="project-dialog"
      describedBy={descriptionId}
      label="Linked issues"
      labelledBy={titleId}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      open
      popupId="linked-issues-dialog"
    >
      <div className="project-dialog__header">
        <h1 id={titleId}>Linked issues</h1>
      </div>
      <p id={descriptionId}>
        The agent may update only the issues linked here, and a pull request this task opens names
        them as fixed. When the Project keeps linked issues up to date, Octant moves them to In
        Progress, In Review and Done.
      </p>
      {props.linkedIssues.length === 0 ? (
        <p>No issue is linked to this task.</p>
      ) : (
        <ul className="environment-thread-prs__list">
          {props.linkedIssues.map((entry) => {
            const label = linkedIssueLabel(entry.issue);
            return (
              <li className="environment-thread-pr" key={label}>
                <span className="environment-thread-pr__text">
                  <span className="environment-thread-pr__title">{label}</span>
                  {entry.source === "created-from" ? (
                    <span className="environment-thread-pr__meta">Task started from it</span>
                  ) : null}
                </span>
                <OctantButton
                  aria-label={`Unlink ${label}`}
                  disabled={busy}
                  onClick={() => void run(() => props.onUnlink(entry.issue))}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Unlink
                </OctantButton>
              </li>
            );
          })}
        </ul>
      )}
      <label className="project-dialog__field" htmlFor={referenceId}>
        Link an issue
        <OctantInput
          disabled={busy}
          id={referenceId}
          onChange={(event) => setReference(event.target.value)}
          placeholder="#12, owner/repo#12 or ENG-12"
          type="text"
          value={reference}
        />
      </label>
      {message === undefined ? null : <OctantAlert tone="danger">{message}</OctantAlert>}
      <div className="project-dialog__actions">
        <OctantButton
          disabled={busy || reference.trim() === ""}
          onClick={() => void run(() => props.onLink(reference.trim()))}
          type="button"
          variant="solid"
        >
          Link
        </OctantButton>
        <OctantButton disabled={busy} onClick={props.onClose} type="button" variant="outline">
          Close
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
