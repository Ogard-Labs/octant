import type { KeyboardEvent } from "react";

const STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Arrow-key movement for a `role="radiogroup"` built from `role="radio"`
 * buttons. A radio group is one place to arrive and the arrows move through it:
 * focus lands on the neighbour and selects it, wrapping past either end, and
 * Home and End jump to the ends. Put it on the group, not on the buttons, so
 * the choices stay ordinary buttons for pointer and assistive technology.
 */
export function moveWithinRadioGroup(event: KeyboardEvent<HTMLElement>): void {
  moveWithinRole(event, "radio");
}

/**
 * The same movement for a bespoke `role="tablist"`: arrows, Home and End move
 * focus between its `role="tab"` buttons and select the one reached. Pair it
 * with a roving tabIndex (0 on the selected tab, -1 on the rest) so Tab
 * arrives once and leaves to the controls after the list.
 */
export function moveWithinTabList(event: KeyboardEvent<HTMLElement>): void {
  moveWithinRole(event, "tab");
}

function moveWithinRole(event: KeyboardEvent<HTMLElement>, role: "radio" | "tab"): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]`),
  ).filter((radio) => !radio.matches(':disabled, [aria-disabled="true"]'));
  const at = radios.findIndex((radio) => radio === document.activeElement);
  if (at === -1) return;
  const last = radios.length - 1;
  const step = STEP[event.key];
  let next: number | undefined;
  if (step !== undefined) next = (at + step + radios.length) % radios.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = last;
  const radio = next === undefined ? undefined : radios[next];
  if (radio === undefined) return;
  event.preventDefault();
  radio.focus();
  radio.click();
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
  const choices = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"], input[type="checkbox"]',
    ),
  ).filter((choice) => !choice.matches(':disabled, [aria-disabled="true"]'));
  const choice = choices[Number(event.key) - 1];
  if (choice === undefined) return;
  event.preventDefault();
  choice.focus();
  choice.click();
}

/** Arrow-key movement and number keys together, for a single-choice group. */
export function moveOrChooseInRadioGroup(event: KeyboardEvent<HTMLElement>): void {
  chooseByNumber(event);
  if (!event.defaultPrevented) moveWithinRadioGroup(event);
}
