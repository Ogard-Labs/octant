import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { BundledWhatsNewAnnouncement } from "../shell/hostBridge";
import { ApertureArt } from "../shell/ApertureArt";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";

export interface WhatsNewAnnouncementDialogProps {
  /** Absent while there is nothing to announce; the dialog is then closed. */
  readonly announcements: ReadonlyArray<BundledWhatsNewAnnouncement> | undefined;
  readonly onNotNow: () => void;
  readonly onOpenNotes: () => void;
  readonly restoreFocus?: RefObject<HTMLElement | null>;
}

/** Arrow keys belong to these when focus is in one of them. */
const ARROW_KEY_CONTROLS =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='slider'], [role='spinbutton'], [role='listbox'], [role='tablist'], [role='menu']";

/**
 * The features a release chose to announce, one at a time. The picture is a
 * bounded data URL from the bundle; without one the dialog wears the same
 * aperture art as the sidebar card. Any answer, at any step, closes the whole
 * set for good: the controller acknowledges it once.
 *
 * One announcement has no paging at all. With several, "Next" is the forward
 * action until the last, where the announcement's own button takes over.
 */
export function WhatsNewAnnouncementDialog(props: WhatsNewAnnouncementDialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const positionId = useId();
  // The dialog fades out after it is answered, and the answer clears the
  // announcements at once; keep the last set so the content does not empty
  // while it is still on screen.
  const last = useRef(props.announcements);
  if (props.announcements !== undefined) last.current = props.announcements;
  const announcements = props.announcements ?? last.current;
  const [paging, setPaging] = useState({ set: announcements, index: 0 });
  // A different set starts at its first entry.
  let index = paging.index;
  if (paging.set !== announcements && props.announcements !== undefined) {
    index = 0;
    setPaging({ set: announcements, index: 0 });
  }
  const count = announcements?.length ?? 0;
  const position = Math.min(index, Math.max(count - 1, 0));
  const announcement = announcements?.[position];
  const isFirst = position === 0;
  const isLast = position >= count - 1;
  const paged = count > 1;
  const open = props.announcements !== undefined;

  const go = (to: number) => {
    setPaging({ set: announcements, index: Math.min(Math.max(to, 0), count - 1) });
  };

  // The dialog opens on its one forward action, as an alert opens on its
  // default button; "Not now" is a Tab or an Escape away. After a step the
  // same button is where focus goes: Next while there is one, then the
  // announcement's own button once it has taken Next's place.
  const primary = useRef<HTMLButtonElement>(null);
  const stepped = useRef(false);
  useEffect(() => {
    if (!stepped.current) {
      stepped.current = true;
      return;
    }
    primary.current?.focus({ preventScroll: true });
  }, [position]);

  useEffect(() => {
    if (!open || !paged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.target instanceof Element && event.target.closest(ARROW_KEY_CONTROLS) !== null) {
        return;
      }
      event.preventDefault();
      setPaging((current) => {
        const next = current.index + (event.key === "ArrowRight" ? 1 : -1);
        return { set: current.set, index: Math.min(Math.max(next, 0), count - 1) };
      });
    };
    // In the capture phase: the dialog's own key handling stops arrow keys
    // before they bubble up to the document.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [count, open, paged]);

  const actionLabel = announcement?.actionLabel;
  return (
    <OctantDialog
      className="whats-new-announcement"
      describedBy={paged ? `${positionId} ${bodyId}` : bodyId}
      initialFocus={primary}
      label="What's new"
      labelledBy={titleId}
      onClose={props.onNotNow}
      open={open}
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
      {paged ? (
        // A polite status: the change of step is read out without moving
        // focus off the button that was pressed.
        <p className="whats-new-announcement__position" id={positionId} role="status">
          {`${position + 1} of ${count}`}
        </p>
      ) : null}
      <div className="whats-new-announcement__actions">
        {paged && !isFirst ? (
          <OctantButton onClick={() => go(position - 1)} type="button" variant="ghost">
            Back
          </OctantButton>
        ) : null}
        <OctantButton onClick={props.onNotNow} type="button" variant="secondary">
          Not now
        </OctantButton>
        {isLast ? (
          <OctantButton onClick={props.onOpenNotes} ref={primary} type="button">
            {actionLabel ?? "See what's new"}
          </OctantButton>
        ) : (
          <>
            {actionLabel === undefined ? null : (
              <OctantButton onClick={props.onOpenNotes} type="button" variant="ghost">
                {actionLabel}
              </OctantButton>
            )}
            <OctantButton onClick={() => go(position + 1)} ref={primary} type="button">
              Next
            </OctantButton>
          </>
        )}
      </div>
    </OctantDialog>
  );
}
