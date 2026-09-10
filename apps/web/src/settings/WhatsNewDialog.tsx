import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import type { BundledWhatsNewView } from "../shell/hostBridge";

export interface WhatsNewDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly document: BundledWhatsNewView | undefined;
}

/**
 * Local notes for the running build. Never a network fetch — a missing
 * document is an empty state.
 */
export function WhatsNewDialog(props: WhatsNewDialogProps) {
  return (
    <OctantDialog
      className="whats-new__dialog"
      label="What's new"
      onClose={props.onClose}
      open={props.open}
    >
      <h2 className="h4">What's new</h2>
      {props.document === undefined ? (
        <p className="whats-new__empty" role="status">
          Loading…
        </p>
      ) : props.document.kind === "empty" ? (
        <p className="whats-new__empty" role="status">
          There are no notes for this build.
        </p>
      ) : (
        <>
          <p className="whats-new__version">Octant {props.document.version}</p>
          <pre className="whats-new__body">{props.document.text}</pre>
        </>
      )}
      <OctantButton onClick={props.onClose} type="button" variant="secondary">
        Close
      </OctantButton>
    </OctantDialog>
  );
}
