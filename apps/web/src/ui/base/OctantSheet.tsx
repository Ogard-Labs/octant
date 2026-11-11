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

export interface OctantSheetProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  /** Names the sheet for assistive technology; the sheet draws its own head. */
  readonly label: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/**
 * A surface as large as a page that floats over the window instead of
 * replacing it: the window stays drawn behind a light scrim, so a change made
 * in the sheet can be seen where it lands. It is the dialog's behaviour
 * (focus kept inside, Escape and a press outside close it, focus returns) with
 * a sheet's size and no padding of its own, because what it holds lays itself
 * out to the edges.
 */
export function OctantSheet(props: OctantSheetProps) {
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
          className="octant-sheet__backdrop window-no-drag"
          data-testid="octant-sheet-backdrop"
        />
        <DialogViewport className="octant-sheet__viewport window-no-drag">
          <DialogPopup
            className={cn("octant-sheet__popup window-no-drag", props.className)}
            finalFocus={props.restoreFocus}
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
