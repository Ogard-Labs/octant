import { useEffect, useRef } from "react";

/**
 * Focuses an element that replaced the control the person used: Review opens
 * the card, Back returns to the list, Start shows the session, Stop shows why
 * it ended. Without it focus fell to the page at each step (DESIGN.md §
 * Accessibility and reliability). It moves focus only when focus has fallen
 * to the page or is still in the panel, so a session that ends on its own
 * never pulls the keyboard out of the editor.
 */
export function useFocusWhenShown<T extends HTMLElement>(enabled = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || element === null) return;
    const active = element.ownerDocument.activeElement;
    const panel = element.closest(".run-debug");
    if (
      active === null ||
      active === element.ownerDocument.body ||
      (panel !== null && panel.contains(active))
    ) {
      element.focus();
    }
  }, [enabled]);
  return ref;
}
