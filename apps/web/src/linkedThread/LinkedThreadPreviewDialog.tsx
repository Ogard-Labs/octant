import type { LinkedThreadPreview } from "@octant/contracts";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export interface LinkedThreadPreviewDialogProps {
  readonly open: boolean;
  readonly preview: LinkedThreadPreview;
  readonly skillName?: string | undefined;
  readonly notice?: string | undefined;
  readonly submitting?: boolean | undefined;
  readonly error?: string | undefined;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function LinkedThreadPreviewDialog(props: LinkedThreadPreviewDialogProps) {
  const preview = props.preview;
  return (
    <OctantDialog
      className="linked-thread-preview-dialog"
      label="Confirm parallel review"
      onClose={props.submitting ? () => {} : props.onClose}
      open={props.open}
      popupId="linked-thread-preview-dialog"
    >
      <div className="linked-thread-preview-dialog__header">
        <div>
          <span className="linked-thread-preview-dialog__eyebrow">Linked threads</span>
          <h2>Confirm parallel review</h2>
        </div>
        <OctantButton
          aria-label="Close linked-thread preview"
          disabled={props.submitting}
          onClick={props.onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>

      {props.skillName === undefined ? null : (
        <p className="linked-thread-preview-dialog__skill">
          Skill <strong>{props.skillName}</strong>
        </p>
      )}

      <p className="linked-thread-preview-dialog__prompt">{preview.prompt}</p>

      {props.notice === undefined ? null : (
        <p className="linked-thread-preview-dialog__notice" role="note">
          {props.notice}
        </p>
      )}

      <p className="linked-thread-preview-dialog__authority" role="note">
        Read-only plan authority applies to every peer thread. No approvals, credentials, or
        authority are transferred.
      </p>

      <ul aria-label="Planned linked threads" className="linked-thread-preview-dialog__threads">
        {preview.threads.map((thread) => (
          <li key={thread.targetIndex}>
            <strong>{thread.label}</strong>
            <span>{String(thread.modelId)}</span>
          </li>
        ))}
      </ul>

      {props.submitting ? (
        <p
          aria-label="Creating linked threads"
          className="linked-thread-preview-dialog__loading"
          role="status"
        >
          Creating linked threads…
        </p>
      ) : null}

      {props.error === undefined ? null : (
        <p className="linked-thread-preview-dialog__error" role="alert">
          {props.error}
        </p>
      )}

      <div className="linked-thread-preview-dialog__actions">
        <OctantButton
          className="linked-thread-preview-dialog__confirm"
          disabled={props.submitting}
          onClick={props.onConfirm}
          type="button"
          variant="secondary"
        >
          Confirm fan-out
        </OctantButton>
        <OctantButton
          className="linked-thread-preview-dialog__cancel"
          disabled={props.submitting}
          onClick={props.onClose}
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
