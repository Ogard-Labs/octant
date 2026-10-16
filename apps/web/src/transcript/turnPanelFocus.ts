import { useEffect, type RefObject } from "react";

/**
 * The More actions control of the turn that holds `element`: where focus goes
 * when an inline panel that control's menu opened is dismissed or finished.
 */
export function turnMenuTrigger(element: Element | null): HTMLElement | null {
  return (
    element
      ?.closest(".turn-action-menu")
      ?.querySelector<HTMLElement>(".turn-action-menu__more button") ?? null
  );
}

/**
 * Moves focus into a panel a turn's menu has just opened. The menu hands focus
 * back to its own trigger as it closes, a frame or two after the panel mounts,
 * and the panel sits ahead of that trigger in tab order: focusing at once
 * loses to the hand-back, and not focusing at all leaves a keyboard user on the
 * trigger with the panel behind them.
 */
export function useFocusAfterTurnMenuCloses(
  root: RefObject<HTMLElement | null>,
  selector: string,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        root.current?.querySelector<HTMLElement>(selector)?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
  }, [root, selector, active]);
}
