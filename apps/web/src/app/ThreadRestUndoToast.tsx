import { useEffect, useRef } from "react";
import { isApplePlatform } from "../platform";
import { OctantToast } from "../ui/base/OctantToast";
import type { ThreadRestUndoNotice } from "./threadRestRowActions";

/** How long a sidebar state change can be taken back. */
export const THREAD_REST_UNDO_MS = 5_000;

/**
 * Whether a key press is the platform's undo chord and lands outside text.
 * The editor, a field and the terminal keep Mod+Z as their own undo, and no
 * remappable binding claims it, so the chord reaches the sidebar's Undo only
 * while the notice shows and focus is somewhere that has no undo of its own.
 */
export function takesThreadRestUndoChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target">,
  apple: boolean = isApplePlatform(),
): boolean {
  if (event.key.toLowerCase() !== "z" || event.shiftKey || event.altKey) return false;
  if (apple ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  return !(
    target.isContentEditable ||
    target.closest("input, textarea, select, [contenteditable='true'], .xterm") !== null
  );
}

/** The five-second Undo after a pin, settle, Mark done, reopen, snooze or wake. */
export function ThreadRestUndoToast(props: {
  readonly notice: ThreadRestUndoNotice;
  readonly onDismiss: () => void;
}) {
  const undo = useRef(() => {});
  undo.current = () => {
    props.onDismiss();
    props.notice.undo();
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !takesThreadRestUndoChord(event)) return;
      event.preventDefault();
      undo.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <OctantToast
      action={{ label: "Undo", onSelect: () => undo.current(), inPlace: true }}
      detail={props.notice.detail}
      leavesAfterMs={THREAD_REST_UNDO_MS}
      onDismiss={props.onDismiss}
      title={props.notice.title}
    />
  );
}
