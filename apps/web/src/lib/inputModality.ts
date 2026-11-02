// `:focus-visible` cannot tell a person who pressed Tab from a dialog handing
// focus back to its trigger, so the stylesheet asks this attribute which of the
// two is true. Typing does not count: a person typing in a field is still not
// moving focus by keyboard, and Escape only closes what the pointer opened.

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** Whether this key edits text where it was pressed rather than moving focus. */
function movesCaret(key: string, target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === "TEXTAREA") return true;
  // Up and Down do nothing in a one-line field except leave it for its list.
  return target.tagName === "INPUT" && key !== "ArrowUp" && key !== "ArrowDown";
}

/** Publishes how focus last moved on the document element. Returns a function that stops. */
export function followInputModality(): () => void {
  const root = document.documentElement;
  const onPointerDown = () => {
    root.dataset.octantInput = "pointer";
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === "Tab" ||
      (NAVIGATION_KEYS.has(event.key) && !movesCaret(event.key, event.target))
    ) {
      root.dataset.octantInput = "keyboard";
    }
  };
  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}
