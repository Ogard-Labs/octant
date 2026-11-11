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

/**
 * True when focus is somewhere the dialog did not leave it: on a control the
 * person pressed, or one a command they ran from the dialog moved it to.
 */
function focusHasMovedOn(popup: HTMLElement | null): boolean {
  const focused = document.activeElement;
  return focused !== null && focused !== document.body && popup?.contains(focused) !== true;
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

  // Focus goes back the moment the dialog starts to leave. The library hands
  // it back only once the exit has finished, which left the keyboard pointing
  // at nothing while the dialog faded and then took focus away from wherever
  // the person, or the command they ran, had put it in the meantime. It moves
  // when this effect runs and not in a cleanup: React puts focus back on the
  // element that held it before a commit, and a cleanup runs inside one.
  const popup = useRef<HTMLDivElement>(null);
  const focusedBefore = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const restoreFocus = useRef(props.restoreFocus);
  restoreFocus.current = props.restoreFocus;
  useLayoutEffect(() => {
    if (open) {
      const before = document.activeElement;
      focusedBefore.current = before instanceof HTMLElement ? before : null;
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // The library calls an exit finished from an animation frame on the popup.
    // A window nobody can see runs no frames, and a popup that never mounted
    // has none to wait on, so there the hold would outlive the dialog: it is
    // given up at once, and there is no exit to miss.
    if (popup.current === null || document.visibilityState === "hidden") {
      release.current?.();
      release.current = undefined;
    }
    if (focusHasMovedOn(popup.current)) return;
    (restoreFocus.current?.current ?? focusedBefore.current)?.focus({ preventScroll: true });
  }, [open]);
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
            // Asked once the exit has finished. Focus is already back unless
            // its target could not take it then, and it stays where it has
            // moved to since.
            finalFocus={() =>
              focusHasMovedOn(popup.current) ? false : (props.restoreFocus?.current ?? true)
            }
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
