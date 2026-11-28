import type { KeyboardEvent } from "react";

const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Arrow-key movement for a bespoke `role="tablist"`: arrows, Home and End move
 * focus between its `role="tab"` buttons and select the one reached. Pair it
 * with a roving tabIndex (0 on the selected tab, -1 on the rest) so Tab
 * arrives once and leaves to the controls after the list.
 */
export function moveWithinTabList(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')).filter(
    (tab) => !tab.matches(':disabled, [aria-disabled="true"]'),
  );
  const at = tabs.findIndex((tab) => tab === document.activeElement);
  if (at === -1) return;
  const last = tabs.length - 1;
  const step = STEP[event.key];
  let next: number | undefined;
  if (step !== undefined) next = (at + step + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  const tab = next === undefined ? undefined : tabs[next];
  if (tab === undefined) return;
  event.preventDefault();
  tab.focus();
  tab.click();
}

/**
 * Number keys for a group of choices: 1–9 pick the matching option, as a click
 * would, and move focus to it. Only a key pressed inside the group counts, and
 * never one typed into a text field there, so digits stay text in an answer
 * field and the composer. A key picks; it never sends.
 */
export function chooseByNumber(event: KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!/^[1-9]$/.test(event.key)) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.matches('input:not([type="checkbox"]), textarea, [contenteditable="true"]')
  ) {
    return;
  }
  // Count every choice, disabled ones included, so a key always means the
  // number printed beside it; a disabled choice's key does nothing rather
  // than landing on the next enabled one.
  const choices = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"], input[type="checkbox"]',
    ),
  );
  const choice = choices[Number(event.key) - 1];
  if (choice === undefined || choice.matches(':disabled, [aria-disabled="true"]')) return;
  event.preventDefault();
  choice.focus();
  choice.click();
}
