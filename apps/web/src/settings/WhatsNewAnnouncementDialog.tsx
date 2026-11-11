import { useId, useRef, type RefObject } from "react";
import type { BundledWhatsNewAnnouncement } from "../shell/hostBridge";
import { ApertureArt } from "../shell/ApertureArt";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export interface WhatsNewAnnouncementDialogProps {
  /** Absent while there is nothing to announce; the dialog is then closed. */
  readonly announcement: BundledWhatsNewAnnouncement | undefined;
  readonly onNotNow: () => void;
  readonly onOpenNotes: () => void;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/**
 * The one feature a release chose to announce. The picture is a bounded data
 * URL from the bundle; without one the dialog wears the same aperture art as
 * the sidebar card. Any answer closes it for good.
 */
export function WhatsNewAnnouncementDialog(props: WhatsNewAnnouncementDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  // The dialog fades out after it is answered, and the answer clears the
  // announcement at once; keep the last one so the content does not empty
  // while it is still on screen.
  // The dialog opens on its one forward action, as an alert opens on its
  // default button; "Not now" is a Tab or an Escape away.
  const primary = useRef<HTMLButtonElement>(null);
  const last = useRef(props.announcement);
  if (props.announcement !== undefined) last.current = props.announcement;
  const announcement = props.announcement ?? last.current;
  return (
    <OctantDialog
      className="whats-new-announcement"
      describedBy={bodyId}
      initialFocus={primary}
      label="What's new"
      labelledBy={titleId}
      onClose={props.onNotNow}
      open={props.announcement !== undefined}
      {...(props.restoreFocus === undefined ? {} : { restoreFocus: props.restoreFocus })}
    >
      {announcement?.picture === undefined ? (
        <ApertureArt className="whats-new-announcement__art" />
      ) : (
        <img
          alt={announcement.picture.alt ?? ""}
          className="whats-new-announcement__picture"
          src={announcement.picture.dataUrl}
        />
      )}
      <h2 className="octant-dialog__title" id={titleId}>
        {announcement?.title}
      </h2>
      <p className="whats-new-announcement__body" id={bodyId}>
        {announcement?.body}
      </p>
      <div className="whats-new-announcement__actions">
        <OctantButton onClick={props.onNotNow} type="button" variant="secondary">
          Not now
        </OctantButton>
        <OctantButton onClick={props.onOpenNotes} ref={primary} type="button">
          {announcement?.actionLabel ?? "See what's new"}
        </OctantButton>
      </div>
    </OctantDialog>
  );
}
