import { useId, useRef, type ReactNode } from "react";
import { OctantButton } from "./OctantButton";
import { OctantDialog } from "./OctantDialog";

/** Ordinary confirmation only; callers retain their existing authority checks. */
export function OctantConfirmDialog(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <OctantDialog
      open
      className="octant-confirmation"
      label={props.title}
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocus={cancel}
      onClose={props.onCancel}
    >
      <h2 className="octant-confirmation__title" id={titleId}>
        {props.title}
      </h2>
      <p className="octant-confirmation__description" id={descriptionId}>
        {props.children}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <OctantButton
          ref={cancel}
          onClick={props.onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          {props.cancelLabel ?? "Cancel"}
        </OctantButton>
        <OctantButton
          disabled={props.pending}
          onClick={props.onConfirm}
          size="sm"
          type="button"
          variant={props.destructive === false ? "default" : "destructive"}
        >
          {props.confirmLabel}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
