import { useContext, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogPopup,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "../shadcn/dialog";
import { cn } from "../shadcn/utils";
import { DialogPresenceContext } from "./OctantDialogPresence";
import { useLeavingFocus } from "./useLeavingFocus";

export interface OctantDialogProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly label: string;
  /** Existing visible heading; omitting it retains the hidden title for specialized layouts. */
  readonly labelledBy?: string;
  readonly describedBy?: string;
  readonly onClose: () => void;
  readonly open: boolean;
  readonly popupId?: string;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/** Octant dialog adapter over the owned shadcn/Base UI Dialog recipe. */
export function OctantDialog(props: OctantDialogProps) {
  // Inside a presence the dialog is open only while the feature still renders
  // it. Once the feature stops, the dialog is told it has closed, and it holds
  // the presence's content until the library reports the exit finished, so
  // what is leaving is still there to be seen.
  const presence = useContext(DialogPresenceContext);
  const open = props.open && presence.open;
  const release = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => {
    if (open) release.current ??= presence.hold();
  }, [open, presence]);
  useLayoutEffect(
    () => () => {
      release.current?.();
      release.current = undefined;
    },
    [],
  );

  const { popup, finalFocus } = useLeavingFocus({
    open,
    restoreFocus: props.restoreFocus,
    // The library calls an exit finished from an animation frame on the popup.
    // A window nobody can see runs no frames, and a popup that never mounted
    // has none to wait on, so there the hold would outlive the dialog: it is
    // given up at once, and there is no exit to miss.
    onLeave: (mounted) => {
      if (mounted !== null && document.visibilityState !== "hidden") return;
      release.current?.();
      release.current = undefined;
    },
  });
  return (
    <Dialog
      modal
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (next) return;
        release.current?.();
        release.current = undefined;
      }}
      open={open}
    >
      <DialogPortal>
        {/* A dialog that is leaving is only there to be seen. Its scrim and its
            controls take no press and no key, so the page under it answers at
            once and a second press cannot repeat what the first one did. */}
        <DialogBackdrop
          className="octant-dialog__backdrop window-no-drag"
          data-testid="octant-dialog-backdrop"
          inert={!open}
        />
        <DialogViewport className="octant-dialog__viewport window-no-drag">
          <DialogPopup
            {...(props.labelledBy === undefined ? {} : { "aria-labelledby": props.labelledBy })}
            {...(props.describedBy === undefined ? {} : { "aria-describedby": props.describedBy })}
            className={cn("octant-dialog__popup window-no-drag", props.className)}
            finalFocus={finalFocus}
            id={props.popupId}
            inert={!open}
            initialFocus={props.initialFocus}
            ref={popup}
          >
            {props.labelledBy === undefined ? (
              <DialogTitle className="sr-only">{props.label}</DialogTitle>
            ) : null}
            {props.children}
          </DialogPopup>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
