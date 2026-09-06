import type { ReactNode, RefObject } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "../shadcn/dialog";
import { cn } from "../shadcn/utils";

export interface OctantDialogProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly label: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly popupId?: string;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/** Octant dialog adapter over the owned shadcn/Base UI Dialog recipe. */
export function OctantDialog(props: OctantDialogProps) {
  return (
    <Dialog
      modal
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      open={props.open}
    >
      <DialogPortal>
        <DialogBackdrop
          className="octant-dialog__backdrop window-no-drag"
          data-testid="octant-dialog-backdrop"
        />
        <DialogViewport className="octant-dialog__viewport window-no-drag">
          <DialogPopup
            className={cn("octant-dialog__popup window-no-drag", props.className)}
            finalFocus={props.restoreFocus}
            id={props.popupId}
            initialFocus={props.initialFocus}
          >
            <DialogTitle className="sr-only">{props.label}</DialogTitle>
            {props.children}
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
