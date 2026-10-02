import { useId, useRef, type ReactNode, type RefObject } from "react";
import { OctantButton } from "./OctantButton";
import { OctantDialog } from "./OctantDialog";

/** Ordinary confirmation only; callers retain their existing authority checks. */
export function OctantConfirmDialog(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly details?: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  // The popup renders through a portal that mounts after this component, so
  // Cancel is not in the document during this component's first commit. The
  // dialog's initialFocus moves focus there on the next animation frame.
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <OctantDialog
      open
      className="octant-confirmation"
      label={props.title}
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocus={cancel}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
      onClose={() => {
        if (!props.pending) {
          props.onCancel();
          queueMicrotask(() => props.restoreFocus?.current?.focus());
        }
      }}
    >
      <h2 className="octant-confirmation__title" id={titleId}>
        {props.title}
      </h2>
      <p className="octant-confirmation__description" id={descriptionId}>
        {props.children}
      </p>
      {props.details === undefined ? null : (
        <div className="octant-confirmation__details">{props.details}</div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <OctantButton
          ref={cancel}
          disabled={props.pending}
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
          variant={props.destructive ? "destructive" : "default"}
        >
          {props.confirmLabel}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
