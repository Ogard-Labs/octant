import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** What a dialog reads from the presence it is rendered inside. */
export interface DialogPresence {
  /** False once the feature has stopped rendering the dialog: it should leave. */
  readonly open: boolean;
  /** Keeps the dialog's content mounted until the returned release is called. */
  readonly hold: () => () => void;
}

const releaseNothing = (): void => undefined;

/** Outside a presence a dialog is as open as its own `open` says, and nothing holds it. */
export const DialogPresenceContext = createContext<DialogPresence>({
  open: true,
  hold: () => releaseNothing,
});

function isRendered(children: ReactNode): boolean {
  return children !== null && children !== undefined && children !== false;
}

/**
 * Lets a dialog that a feature renders only while it is open leave with the
 * overlay motion instead of vanishing.
 *
 * The library plays a dialog's exit only while the dialog stays mounted and is
 * told it has closed; a feature that stops rendering its dialog takes it out of
 * the document in the same frame. Wrapped here, the last thing the feature
 * rendered stays mounted, the dialog inside is told it has closed, and the
 * content is dropped when the library reports the exit finished. What stays is
 * the element the feature last rendered, so a confirmation keeps the name it
 * was asking about after the feature has cleared the state that name came from.
 *
 * Each opening is still a dialog of its own, as it was when closing unmounted
 * it: a feature that renders a dialog again while the last one is leaving gets
 * a fresh one, and the one that was leaving goes at once, so nothing a person
 * typed into the first is found in the second.
 *
 * A feature that renders nothing dialog-shaped here, or whose dialog was
 * already closed, holds nothing and is dropped at once. A presence inside a
 * dialog that is itself leaving leaves with it, and holds it until both are
 * gone, so a dialog opened from a dialog never outlives the one under it.
 */
export function OctantDialogPresence(props: { readonly children: ReactNode }) {
  const outer = useContext(DialogPresenceContext);
  const rendered = isRendered(props.children);
  const [last, setLast] = useState<ReactNode>(null);
  const [holds, setHolds] = useState(0);
  const [wasRendered, setWasRendered] = useState(rendered);
  const [opening, setOpening] = useState(0);
  if (rendered) {
    if (last !== props.children) setLast(props.children);
  } else if (last !== null && holds === 0) {
    setLast(null);
  }
  if (wasRendered !== rendered) {
    setWasRendered(rendered);
    if (rendered) setOpening((count) => count + 1);
  }

  const holdOuter = outer.hold;
  const hold = useCallback(() => {
    let released = false;
    const releaseOuter = holdOuter();
    setHolds((count) => count + 1);
    return () => {
      if (released) return;
      released = true;
      setHolds((count) => count - 1);
      releaseOuter();
    };
  }, [holdOuter]);
  const open = rendered && outer.open;
  const presence = useMemo<DialogPresence>(() => ({ open, hold }), [open, hold]);

  return (
    <DialogPresenceContext value={presence}>
      <Fragment key={opening}>{rendered ? props.children : last}</Fragment>
    </DialogPresenceContext>
  );
}
